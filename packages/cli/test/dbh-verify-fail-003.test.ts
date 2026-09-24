// DBH FAIL-003 verification. Production entry: importFile (packages/cli/src/commands/import.ts:67),
// the same function bin.ts:530-536 dispatches `agnes import` to. A real Host is used and only one
// Session.append call fails, modelling the storage/IO boundary. The tests prove the compensation
// removes an operation-owned target but refuses to remove a target that existed before the import.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Host, type HostSession, scanAll } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { importFile } from '../src/commands/import.js'
import { memoryAdmission, openAdmittedSession } from './import-admission.js'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A pi-cli transcript long enough to need more than one 500-event import batch. */
function transcript(pairs: number): Uint8Array {
  const rows: unknown[] = [
    { type: 'session', version: 3, id: 'pi-cli', timestamp: '2026-09-07T00:00:00Z', cwd: '/old' },
  ]
  let parent: string | null = null
  for (let i = 0; i < pairs; i++) {
    const user = `u${i}`
    const assistant = `a${i}`
    rows.push({
      type: 'message',
      id: user,
      parentId: parent,
      timestamp: '2026-09-07T00:00:01Z',
      message: { role: 'user', content: `hello ${i}` },
    })
    rows.push({
      type: 'message',
      id: assistant,
      parentId: user,
      timestamp: '2026-09-07T00:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `hi ${i}` }], stopReason: 'stop' },
    })
    parent = assistant
  }
  return new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join('\n'))
}

/** Wraps a real Host so that the `failOn`-th Session.append rejects. */
function flakyHost(
  host: Host,
  failOn: number,
  failure: Error = new Error('injected storage failure'),
): { host: Host; appends: () => number } {
  let appends = 0
  const wrapped = new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === 'createSession')
        return async (options: Parameters<Host['createSession']>[0]) => {
          const session = await target.createSession(options)
          return new Proxy(session, {
            get(st, sp, sr) {
              if (sp === 'append')
                return async (batch: Parameters<HostSession['append']>[0]) => {
                  appends += 1
                  if (appends === failOn) throw failure
                  return st.append(batch)
                }
              const value = Reflect.get(st, sp, sr)
              return typeof value === 'function' ? value.bind(st) : value
            },
          })
        }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { host: wrapped, appends: () => appends }
}

async function scenario(failOn: number, failure?: Error) {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-fail-003-'))
  tmp.push(dir)
  const file = join(dir, 'pi.jsonl')
  writeFileSync(file, transcript(400))
  const { host } = await createTestHost({ dataDir: dir })
  const flaky = flakyHost(host, failOn, failure)
  const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined } }
  const admission = await memoryAdmission(host, dir)
  const key = 'agnes:local:default:import:dm:dbh-fail-003'
  const args = parseArgs(['import', file, '--key', key])
  const attempt = (h: Host): Promise<{ ok: boolean; message: string }> =>
    importFile(args, { env: {}, cwd: dir, host: h, admission, io })
      .then(() => ({ ok: true, message: '' }))
      .catch((error: Error) => ({ ok: false, message: error.message }))

  const first = await attempt(flaky.host)
  // The retry runs against the same real Host with no injected failure at all.
  const retry = await attempt(host)
  const session = await openAdmittedSession(host, admission, key, dir)
  try {
    // Every row: a single scan stops at one page, and the checks below are about the whole ledger.
    const events = await scanAll((q) => session.scan(q), { toSeq: session.lastSeq })
    return {
      first,
      retry,
      batches: flaky.appends(),
      eventCount: events.length,
      sequences: events.map((event) => event.seq),
      uniqueIds: new Set(events.map((event) => event.id)).size,
    }
  } finally {
    await session.close()
    await host.close()
  }
}

describe('DBH FAIL-003: a failed import must leave the target session importable again', () => {
  it('[control] a failure on the FIRST batch leaves nothing behind and the retry succeeds', async () => {
    const r = await scenario(1)
    expect({ first: r.first.ok, retry: r.retry.ok }, JSON.stringify(r)).toEqual({
      first: false,
      retry: true,
    })
  }, 60_000)

  it('a failure on a LATER batch must not strand the session half-written', async () => {
    const r = await scenario(2)
    expect(
      {
        first: r.first.ok,
        batches: r.batches > 1,
        retryRefusedAsNotFresh: /is not fresh/.test(r.retry.message),
        noDuplicateOrMissingEvents:
          r.eventCount === r.uniqueIds && r.sequences.every((seq, index) => seq === index + 1),
      },
      JSON.stringify(r),
    ).toEqual({
      first: false,
      batches: true,
      retryRefusedAsNotFresh: false,
      noDuplicateOrMissingEvents: true,
    })
  }, 60_000)

  it('compensates a later append cancellation before allowing the same key to retry', async () => {
    const r = await scenario(2, new DOMException('import cancelled', 'AbortError'))
    expect(
      {
        first: r.first.ok,
        batches: r.batches > 1,
        retry: r.retry.ok,
      },
      JSON.stringify(r),
    ).toEqual({ first: false, batches: true, retry: true })
  }, 60_000)

  it('refuses an already imported session without changing its existing events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbh-fail-003-existing-'))
    tmp.push(dir)
    const file = join(dir, 'pi.jsonl')
    writeFileSync(file, transcript(4))
    const key = 'agnes:local:default:import:dm:dbh-fail-003-existing'
    const { host } = await createTestHost({ dataDir: dir })
    const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined } }
    const admission = await memoryAdmission(host, dir)
    const args = parseArgs(['import', file, '--key', key])
    await expect(importFile(args, { env: {}, cwd: dir, host, admission, io })).resolves.toBe(0)
    const beforeSession = await openAdmittedSession(host, admission, key, dir)
    const before = await beforeSession.scan({ limit: 100 })
    await beforeSession.close()
    await expect(importFile(args, { env: {}, cwd: dir, host, admission, io })).rejects.toThrow(/is not fresh/)
    const afterSession = await openAdmittedSession(host, admission, key, dir)
    try {
      expect(await afterSession.scan({ limit: 100 })).toEqual(before)
    } finally {
      await afterSession.close()
      await host.close()
    }
  }, 60_000)

  it('does not delete an import target that existed before this import, even when it is still fresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbh-fail-003-fresh-existing-'))
    tmp.push(dir)
    const file = join(dir, 'pi.jsonl')
    writeFileSync(file, transcript(4))
    const key = 'agnes:local:default:import:dm:dbh-fail-003-fresh-existing'
    const { host } = await createTestHost({ dataDir: dir })
    const admission = await memoryAdmission(host, dir)
    const existing = await openAdmittedSession(host, admission, key, dir)
    await existing.close()
    const flaky = flakyHost(host, 1)
    const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined } }
    const args = parseArgs(['import', file, '--key', key])
    await expect(importFile(args, { env: {}, cwd: dir, host: flaky.host, admission, io })).rejects.toThrow(
      /could not roll back the new target/,
    )
    const reopened = await openAdmittedSession(host, admission, key, dir)
    try {
      expect(reopened.lastSeq).toBe(1)
      expect(await reopened.scan({ limit: 10 })).toHaveLength(1)
    } finally {
      await reopened.close()
      await host.close()
    }
  }, 60_000)
})
