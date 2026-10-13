import { DatabaseSync } from 'node:sqlite'
import type { HostSession } from '@agnes/host'
import { afterEach, expect, it, vi } from 'vitest'
import { realHosted } from './real-hosted.js'

type StorageAdapter = HostSession['d']['log']['storage']

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Record = { kind: string; detail: { outcome?: string; seq?: number; session?: string } }
const records = (sent: Array<{ kind: string }>, kind: string): Record[] =>
  sent.flatMap((f) => {
    const record = (f as { record?: Record }).record
    return f.kind === 'record' && record?.kind === kind ? [record] : []
  })

async function closedWithHistory(key: string) {
  const t = await realHosted()
  cleanups.push(t.close)
  await t.hosted.open(t.openFrame(key))
  await t.prompt(key, 'hello')
  await t.run(key)
  const storage = t.host.kernel.get(key)?.d.log.storage as unknown as StorageAdapter & { file: string }
  await t.hosted.close(key)
  return { t, file: storage.file, storage }
}

/** Holds the background verification (the second read from the first row) until released. */
function holdBackgroundVerify(storage: StorageAdapter): () => void {
  const scan = storage.scanIntegrity
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let folded = false
  storage.scanIntegrity = async (key, q) => {
    if (q.fromSeq === 1 && folded) await gate
    if (q.fromSeq === 1) folded = true
    return scan.call(storage, key, q)
  }
  return () => {
    storage.scanIntegrity = scan
    release()
  }
}

it('reopens from the verified head and records the background verification', async () => {
  const key = 'verify-ok'
  const { t } = await closedWithHistory(key)
  await t.hosted.open(t.openFrame(key))
  const open = records(t.sent, 'session.open').at(-1) as unknown as { detail: { checkpoint: unknown } }
  expect(open.detail.checkpoint).toMatchObject({ used: true })
  await vi.waitFor(() => expect(records(t.sent, 'session.verify_full')).toHaveLength(1))
  expect(records(t.sent, 'session.verify_full')[0]?.detail).toMatchObject({ outcome: 'ok' })
  await expect(t.hosted.dispatch(t.command(key, 'verifyHistory'))).resolves.toEqual({})
  await t.prompt(key, 'again')
  await t.run(key)
})

it('reports a history that fails the background verification and refuses new input', async () => {
  const key = 'verify-failed'
  const { t, file, storage } = await closedWithHistory(key)
  const db = new DatabaseSync(file)
  db.prepare(
    `UPDATE events SET data = json_set(data, '$.agnesVersion', 'tampered') WHERE session_key = ? AND seq = 1`,
  ).run(key)
  db.close()
  const release = holdBackgroundVerify(storage)
  await t.hosted.open(t.openFrame(key))
  await t.hosted.tail(key, 1)
  expect(t.sent.some((f) => f.kind === 'session.interrupted')).toBe(false)
  // What export asks before it reads: answered only once the verification has run.
  let answered = false
  const verified = t.hosted.dispatch(t.command(key, 'verifyHistory')).finally(() => {
    answered = true
  })
  await new Promise((r) => setTimeout(r, 20))
  expect(answered).toBe(false)
  release()
  await expect(verified).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
  await vi.waitFor(() => expect(records(t.sent, 'session.verify_full')).toHaveLength(1))
  expect(records(t.sent, 'session.verify_full')[0]?.detail).toMatchObject({ outcome: 'failed', seq: 1 })
  await vi.waitFor(() =>
    expect(t.sent.filter((f) => f.kind === 'session.interrupted' && f.sessionKey === key)).toHaveLength(1),
  )
  // The code travels with the frame, so the supervisor knows a reopen would fail the same way.
  expect(t.sent.find((f) => f.kind === 'session.interrupted')).toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
  await expect(t.prompt(key, 'after the failure')).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
  await t.hosted.close(key)
  await expect(t.hosted.open(t.openFrame(key))).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
})

it('an open that the background verification fails before it settles leaves no session or lease behind', async () => {
  const key = 'verify-during-open'
  const { t, file, storage } = await closedWithHistory(key)
  const db = new DatabaseSync(file)
  db.prepare(
    `UPDATE events SET data = json_set(data, '$.agnesVersion', 'tampered') WHERE session_key = ? AND seq = 1`,
  ).run(key)
  db.close()
  // Every read the open makes after the log is up waits until the verification has failed.
  const scan = storage.scan
  storage.scan = async (k, q) => {
    await vi.waitFor(() => expect(records(t.sent, 'session.verify_full')).toHaveLength(1))
    return scan.call(storage, k, q)
  }
  try {
    await expect(t.hosted.open(t.openFrame(key))).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
  } finally {
    storage.scan = scan
  }
  expect(t.host.kernel.get(key)).toBeUndefined()
  await expect(storage.open(key, { writerRunId: 'probe', ttlMs: 1_000 })).resolves.toBeDefined()
  await storage.release(key, 'probe')
})

it('logs a history that ends before its verified checkpoint', async () => {
  const key = 'verify-truncated'
  const t = await realHosted()
  cleanups.push(t.close)
  await t.hosted.open(t.openFrame(key))
  await t.prompt(key, 'hello')
  await t.run(key)
  // A queued prompt is the last row, and removing it leaves a history that still opens.
  await t.prompt(key, 'queued')
  const file = (t.host.kernel.get(key)?.d.log.storage as unknown as { file: string }).file
  await t.hosted.close(key)
  const db = new DatabaseSync(file)
  const { last } = db.prepare('SELECT MAX(seq) AS last FROM events WHERE session_key = ?').get(key) as {
    last: number
  }
  db.prepare('DELETE FROM events WHERE session_key = ? AND seq = ?').run(key, last)
  db.close()
  await t.hosted.open(t.openFrame(key))
  const open = records(t.sent, 'session.open').at(-1) as unknown as { detail: { checkpoint: unknown } }
  expect(open.detail.checkpoint).toEqual({ used: false, reason: 'beyond-head' })
  expect(t.sent).toContainEqual(
    expect.objectContaining({
      kind: 'log',
      sessionKey: key,
      level: 'warn',
      message: expect.stringContaining('before its verified checkpoint'),
    }),
  )
})
