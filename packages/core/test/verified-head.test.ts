import { describe, expect, it, vi } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { replacePageYieldForTest } from '../src/log/fork-seed.js'
import { LEDGER_INTEGRITY_ALGORITHM } from '../src/log/integrity.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { type FullVerifyReport, type OpenLogOptions, SessionLogImpl } from '../src/log/session-log.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { decideCheckpoint, makeVerifiedHead } from '../src/log/verified-head.js'
import type { Event, Seq } from '../src/types.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const input = (text: string) => ({
  actor,
  origin: 'principal' as const,
  trust: 'trusted' as const,
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})
const options = (storage: StorageAdapter, writerRunId = 'w'): OpenLogOptions => ({
  storage,
  key: 'k',
  writerRunId,
  ttlMs: 60_000,
  ids: defaultIds(),
  clock: () => 0,
  timers,
})

async function seeded(rows: number) {
  const storage = new MemoryStorage()
  const log = await SessionLogImpl.open(options(storage))
  for (let i = 0; i < rows; i++) await log.append([input(`m${i}`)])
  await log.close()
  return storage
}

describe('verified head checkpoint', () => {
  it('is written after a full verify and reused on the next open without hashing the prefix', async () => {
    const storage = await seeded(1200)
    const first = await SessionLogImpl.open(options(storage, 'a'))
    await first.fullVerified()
    await first.close()
    const head = await storage.readVerifiedHead('k')
    expect(head?.throughSeq).toBe(1200)
    const second = await SessionLogImpl.open(options(storage, 'b'))
    expect(second.openStats.checkpoint).toEqual({ used: true, throughSeq: 1200 })
    await second.fullVerified()
    await second.close()
  })

  it('refuses a self-inconsistent, row-mismatched or too-far checkpoint', async () => {
    const storage = await seeded(10)
    const log = await SessionLogImpl.open(options(storage, 'a'))
    await log.fullVerified()
    await log.close()
    const head = (await storage.readVerifiedHead('k'))!
    await storage.writeVerifiedHead({ ...head, checkpointDigest: '0'.repeat(64) }, { force: true })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'self-check' })
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: 'f'.repeat(64) }), {
      force: true,
    })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'row-mismatch' })
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, throughSeq: 15 }), { force: true })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'beyond-head' })
    await storage.writeVerifiedHead(
      makeVerifiedHead({ ...head, algorithm: 'other' as typeof LEDGER_INTEGRITY_ALGORITHM }),
      { force: true },
    )
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'algorithm' })
  })

  it('holds non-input writes until the background verify passes, and lets user input through', async () => {
    const storage = await seeded(600)
    const first = await SessionLogImpl.open(options(storage, 'a'))
    await first.fullVerified()
    await first.close()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow: StorageAdapter = Object.create(storage)
    let backgroundStarted = false
    slow.scanIntegrity = async (key, q) => {
      if (q.fromSeq === 1 && backgroundStarted) await gate
      backgroundStarted = true
      return storage.scanIntegrity(key, q)
    }
    const log = await SessionLogImpl.open(options(slow, 'b'))
    const userInput = log.append([input('typed while verifying')], { beforeFullVerify: 'allow' })
    const turn = log.append([input('a model-side write')])
    await expect(userInput).resolves.toMatchObject({ firstSeq: 601 })
    expect(log.lastSeq).toBe(601)
    release()
    await expect(turn).resolves.toMatchObject({ firstSeq: 602 })
    await log.close()
  })

  it('seals the log and drops the checkpoint when the background verify fails', async () => {
    const storage = await seeded(20)
    const first = await SessionLogImpl.open(options(storage, 'a'))
    await first.fullVerified()
    await first.close()
    const tampered: StorageAdapter = Object.create(storage)
    tampered.scanIntegrity = async (key, q) =>
      (await storage.scanIntegrity(key, q)).map((row) =>
        row.event.seq === 5
          ? { ...row, event: { ...row.event, data: { content: [{ type: 'text', text: 'changed' }] } } }
          : row,
      )
    const log = await SessionLogImpl.open(options(tampered, 'b'))
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await expect(log.append([input('x')], { beforeFullVerify: 'allow' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
    await log.close()
    await expect(SessionLogImpl.open(options(tampered, 'c'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('never moves the checkpoint backwards and advances it on close and at turn end', async () => {
    const storage = await seeded(5)
    const log = await SessionLogImpl.open(options(storage, 'a'))
    await log.fullVerified()
    await log.append([
      { ...input('end'), type: 'turn/end', data: { reason: 'completed', lastAssistantSeq: null } } as never,
    ])
    await new Promise((r) => setTimeout(r, 0))
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(6)
    await log.append([input('more')])
    await log.close()
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(7)
    const head = (await storage.readVerifiedHead('k'))!
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, throughSeq: 3 }))
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(7)
  })
})

type Books = { books: Map<string, { events: Event[] }> }
/** Rewrites one stored row in place, the way another process editing the file would. */
function tamper(storage: MemoryStorage, key: string, seq: Seq, text = 'tampered'): void {
  const events = (storage as unknown as Books).books.get(key)?.events ?? []
  const at = events.findIndex((e) => e.seq === seq)
  events[at] = { ...(events[at] as Event), data: { content: [{ type: 'text', text }] } }
}

/** A storage whose background verification (the second read from row 1) waits for `release`. */
function held(storage: MemoryStorage): {
  storage: StorageAdapter
  release: () => void
  reached: Promise<void>
} {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let arrive!: () => void
  const reached = new Promise<void>((r) => {
    arrive = r
  })
  let folded = false
  const wrapped: StorageAdapter = Object.create(storage)
  wrapped.scanIntegrity = async (key, q) => {
    if (q.fromSeq === 1 && folded) {
      arrive()
      await gate
    }
    if (q.fromSeq === 1) folded = true
    return storage.scanIntegrity(key, q)
  }
  return { storage: wrapped, release, reached }
}

describe('the background verification', () => {
  it('reads small pages and gives the event loop a turn between rows', async () => {
    const storage = await seeded(100)
    const limits: number[] = []
    const counted: StorageAdapter = Object.create(storage)
    counted.scanIntegrity = async (key, q) => {
      limits.push(q.limit)
      return storage.scanIntegrity(key, q)
    }
    let yields = 0
    const log = await SessionLogImpl.open(options(counted, 'b'))
    const restore = replacePageYieldForTest(() => {
      yields++
    })
    try {
      await log.fullVerified()
    } finally {
      restore()
    }
    // The open folded in one page; the verification read the same rows in pages of at most 32.
    expect(limits[0]).toBe(500)
    expect(limits.slice(1).every((limit) => limit <= 32)).toBe(true)
    expect(yields).toBeGreaterThanOrEqual(100)
    await log.close()
  })
})

describe('verified head checkpoint under attack', () => {
  it('a row changed in storage before the checkpoint is folded unverified, then refused before any other write', async () => {
    const storage = await seeded(30)
    tamper(storage, 'k', 12)
    const reports: FullVerifyReport[] = []
    const log = await SessionLogImpl.open({ ...options(storage, 'b'), onFullVerify: (r) => reports.push(r) })
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 30 })
    const write = log.append([input('model-side')])
    await expect(write).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY', detail: { seq: 12 } })
    expect(log.lastSeq).toBe(30)
    expect(log.faulted).toBe(true)
    expect(reports).toEqual([expect.objectContaining({ outcome: 'failed', seq: 12 })])
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
    await log.close()
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
  })

  it('a row changed after the checkpoint fails the open itself', async () => {
    const storage = await seeded(10)
    const log = await SessionLogImpl.open(options(storage, 'a'))
    await log.fullVerified()
    await log.append([input('tail')])
    // Killed without close: the checkpoint stays at 10.
    tamper(storage, 'k', 11)
    await expect(SessionLogImpl.open(options(storage, 'a'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
      detail: { seq: 11 },
    })
  })

  it('a forged checkpoint naming a real row digest does not let a changed prefix through', async () => {
    const storage = await seeded(10)
    await storage.deleteVerifiedHead('k')
    tamper(storage, 'k', 3)
    const [last] = await storage.scanIntegrity('k', { fromSeq: 10, toSeq: 10, limit: 1 })
    await storage.writeVerifiedHead(
      makeVerifiedHead({
        sessionKey: 'k',
        throughSeq: 10,
        headDigest: last!.integrity!.digest,
        legacyThroughSeq: 0,
        algorithm: LEDGER_INTEGRITY_ALGORITHM,
        verifiedFullAtMs: 0,
        writtenAtMs: 0,
      }),
    )
    const log = await SessionLogImpl.open(options(storage, 'b'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 10 })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY', detail: { seq: 3 } })
    await log.close()
    await expect(SessionLogImpl.open(options(storage, 'c'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('a self-consistent checkpoint with a wrong legacy boundary is refused by the background verify', async () => {
    const storage = await seeded(10)
    const head = (await storage.readVerifiedHead('k'))!
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, legacyThroughSeq: 4 }), { force: true })
    const log = await SessionLogImpl.open(options(storage, 'b'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 10 })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await log.close()
    // Nothing was wrong with the ledger itself: the next open verifies all of it and succeeds.
    const next = await SessionLogImpl.open(options(storage, 'c'))
    expect(next.openStats.checkpoint).toEqual({ used: false, reason: 'absent' })
    await next.close()
  })

  it('a checkpoint that names no protected row, or another session, is not used', async () => {
    const storage = await seeded(10)
    const head = (await storage.readVerifiedHead('k'))!
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, legacyThroughSeq: 10 }), { force: true })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'self-check' })
    // Another session's checkpoint copied under this key: its digest binds the other key.
    const foreign = makeVerifiedHead({ ...head, sessionKey: 'other' })
    await storage.writeVerifiedHead({ ...foreign, sessionKey: 'k' }, { force: true })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'self-check' })
  })

  it('a checkpoint that cannot be read is not used, and the open verifies everything', async () => {
    const storage = await seeded(10)
    const failing: StorageAdapter = Object.create(storage)
    failing.readVerifiedHead = async () => {
      throw new Error('disk error')
    }
    const log = await SessionLogImpl.open(options(failing, 'b'))
    expect(log.openStats.checkpoint).toEqual({ used: false, reason: 'unsupported' })
    expect(log.historyVerified).toBe(true)
    await log.close()
  })

  it('a deleted row fails the open with or without a checkpoint', async () => {
    const storage = await seeded(10)
    const book = (storage as unknown as Books).books.get('k')!
    book.events.splice(4, 1)
    await expect(SessionLogImpl.open(options(storage, 'b'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    await storage.deleteVerifiedHead('k')
    await expect(SessionLogImpl.open(options(storage, 'c'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })

  it('a fork waits for the background verify and is refused when it fails', async () => {
    const storage = await seeded(10)
    tamper(storage, 'k', 2)
    const { storage: slow, release } = held(storage)
    const log = await SessionLogImpl.open(options(slow, 'b'))
    const fork = log.forkInto(5, 'child', {
      actor,
      agnesVersion: '0.0.1',
      preset: 'standard',
      resolvedProfileHash: null,
      writerRunId: 'child-run',
      lane: 'main',
    })
    await new Promise((r) => setTimeout(r, 5))
    expect((storage as unknown as Books).books.has('child')).toBe(false)
    release()
    await expect(fork).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect((storage as unknown as Books).books.has('child')).toBe(false)
    await log.close()
  })

  it('a write queued behind a pending verify is refused, not written, when the log closes first', async () => {
    const storage = await seeded(10)
    const { storage: slow, release } = held(storage)
    const log = await SessionLogImpl.open(options(slow, 'b'))
    await log.append([input('typed')], { beforeFullVerify: 'allow' })
    const waiting = log.append([input('model-side')])
    await log.close()
    release()
    await expect(waiting).rejects.toMatchObject({ code: 'E_CLOSED' })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect((await storage.scan('k', { fromSeq: 1, limit: 100 })).length).toBe(11)
    // The verification never finished, so the checkpoint did not move past what was verified.
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(10)
  })

  it('a write that waited is refused when the log closes while the verification passes', async () => {
    const storage = await seeded(10)
    const { storage: slow, release, reached } = held(storage)
    const log = await SessionLogImpl.open(options(slow, 'b'))
    await reached
    const waiting = log.append([input('model-side')])
    const closing = log.close()
    release()
    await closing
    await expect(waiting).rejects.toMatchObject({ code: 'E_CLOSED' })
    await new Promise((r) => setTimeout(r, 5))
    expect((await storage.scan('k', { fromSeq: 1, limit: 100 })).length).toBe(10)
  })

  it('a verification still running when the log closes writes no checkpoint afterwards', async () => {
    // One page: once released, the verification has no page boundary left to notice the close at.
    const storage = await seeded(10)
    const before = await storage.readVerifiedHead('k')
    const { storage: slow, release, reached } = held(storage)
    const log = await SessionLogImpl.open({ ...options(slow, 'b'), clock: () => 99 })
    await reached
    await log.close()
    release()
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
    await new Promise((r) => setTimeout(r, 5))
    expect(await storage.readVerifiedHead('k')).toEqual(before)
  })

  it('no step starts before the history is verified, and none after it fails', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    tamper(storage, 'k', 1)
    const { storage: slow, release } = held(storage)
    // Step-level host code (the model snapshot wraps every step) stands in for any extension code.
    const snapshots: number[] = []
    const second = await openSession({
      storage: slow as MemoryStorage,
      provider: fakeProvider([]),
      writerRunId: 'r2',
      withModelSnapshot: <T>(fn: () => Promise<T>) => {
        snapshots.push(1)
        return fn()
      },
    })
    let settled = false
    // Nothing is queued, so this step would write nothing: only the step itself can hold it.
    const step = second.session.step().finally(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    release()
    await expect(step).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    // Once the verification has failed, a step is refused before any of it runs.
    await expect(second.session.step()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(snapshots).toEqual([])
    await second.session.close()
  })

  it('every UI projection of a history that failed verification is refused with the integrity code', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    tamper(storage, 'k', 1)
    const { storage: slow, release } = held(storage)
    const second = await openSession({
      storage: slow as MemoryStorage,
      provider: fakeProvider([]),
      writerRunId: 'r2',
    })
    // Shown while the verification runs: the opening is what the history looks like so far.
    await expect(second.session.projectUIOpening()).resolves.toBeDefined()
    release()
    await expect(second.log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    const integrity = { code: 'E_LEDGER_INTEGRITY' }
    await expect(second.session.projectUI()).rejects.toMatchObject(integrity)
    await expect(second.session.projectUIOpening()).rejects.toMatchObject(integrity)
    await expect(second.session.projectUIHistory(second.log.lastSeq, 1)).rejects.toMatchObject(integrity)
    await expect(second.session.projectUIPatch(0)).rejects.toMatchObject(integrity)
    await second.session.close()
  })

  it('a storage error during the background verify seals the log as a storage fault', async () => {
    const storage = await seeded(10)
    let folded = false
    const failing: StorageAdapter = Object.create(storage)
    failing.scanIntegrity = async (key, q) => {
      if (q.fromSeq === 1 && folded) throw new Error('disk error')
      folded = true
      return storage.scanIntegrity(key, q)
    }
    const log = await SessionLogImpl.open(options(failing, 'b'))
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    await expect(log.append([input('x')], { beforeFullVerify: 'allow' })).rejects.toMatchObject({
      code: 'E_STORAGE_FAULT',
    })
    await log.close()
  })

  it('keeps the checkpoint when the background verify fails on a storage error', async () => {
    const storage = await seeded(10)
    const first = await SessionLogImpl.open(options(storage, 'a'))
    await first.fullVerified()
    await first.close()
    const checkpoint = await storage.readVerifiedHead('k')
    expect(checkpoint).toBeDefined()
    let folded = false
    const failing: StorageAdapter = Object.create(storage)
    failing.scanIntegrity = async (key, q) => {
      if (q.fromSeq === 1 && folded) throw new Error('disk error')
      folded = true
      return storage.scanIntegrity(key, q)
    }
    const log = await SessionLogImpl.open(options(failing, 'b'))
    expect(log.historyVerified).toBe(false)
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    // Whether the history is intact is unknown, not bad: the next open can still start from the checkpoint.
    expect(await storage.readVerifiedHead('k')).toEqual(checkpoint)
    await log.close()
  })

  it('a turn on a session opened from a checkpoint sends nothing to the model until the history is verified', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    const { storage: slow, release } = held(storage)
    const provider = fakeProvider([textTurn('two')])
    const second = await openSession({ storage: slow as MemoryStorage, provider, writerRunId: 'r2' })
    expect(second.log.openStats.checkpoint).toMatchObject({ used: true })
    const before = second.log.lastSeq
    await second.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
    expect(second.log.lastSeq).toBe(before + 1)
    const run = second.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 10))
    expect(provider.calls).toBe(0)
    expect(second.log.lastSeq).toBe(before + 1)
    release()
    await run
    await vi.waitFor(() => expect(provider.calls).toBe(1))
    await second.session.close()
  })

  it('a turn on a session whose history fails the background verify never reaches the model', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    const userRow = (await storage.scan('k', { type: 'user/message', limit: 1 }))[0] as Event
    tamper(storage, 'k', userRow.seq)
    const { storage: slow, release } = held(storage)
    const provider = fakeProvider([textTurn('two')])
    const second = await openSession({ storage: slow as MemoryStorage, provider, writerRunId: 'r2' })
    await second.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
    const run = second.session.run({ until: 'turn-end', signal: new AbortController().signal })
    release()
    // The run reports the failure as its outcome; the model was never asked.
    await expect(run).resolves.toMatchObject({ reason: 'error', error: { code: 'E_LEDGER_INTEGRITY' } })
    expect(provider.calls).toBe(0)
    expect(second.log.faulted).toBe(true)
    await second.session.close()
  })
})
