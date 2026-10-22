import { defaultIds } from '@agnes/core-common/ids'
import type { Event, Seq } from '@agnes/core-common/types'
import { replacePageYieldForTest } from '@agnes/core-ledger/log/fork-seed'
import { LEDGER_INTEGRITY_ALGORITHM, prepareIntegrity } from '@agnes/core-ledger/log/integrity'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import {
  type FullVerifyReport,
  type OpenLogOptions,
  SessionLogImpl,
} from '@agnes/core-ledger/log/session-log'
import type { StorageAdapter } from '@agnes/core-ledger/log/storage'
import { decideCheckpoint, makeVerifiedHead, type VerifiedHead } from '@agnes/core-ledger/log/verified-head'
import type { ToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { openSession, readTool } from './helpers/open-session.js'

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

/** Exercise the automatic background prefix check and the explicit recheck through the same seam. */
async function openRehashed(o: OpenLogOptions): Promise<SessionLogImpl> {
  const log = await SessionLogImpl.open(o)
  await log.verifyHistory({ rehashPrefix: true })
  return log
}

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

  it('admits ordinary writes while evidence waits for background verification', async () => {
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
    const log = await openRehashed(options(slow, 'b'))
    const userInput = log.append([input('typed while verifying')], { beforeFullVerify: 'allow' })
    const turn = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }])
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
    const log = await openRehashed(options(tampered, 'b'))
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
function held(
  storage: MemoryStorage,
  holding = true,
): {
  storage: StorageAdapter
  release: () => void
  arm: () => void
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
    if (key === 'k' && q.fromSeq === 1 && folded && holding) {
      arrive()
      await gate
    }
    if (q.fromSeq === 1) folded = true
    return storage.scanIntegrity(key, q)
  }
  return {
    storage: wrapped,
    release,
    reached,
    arm: () => {
      holding = true
    },
  }
}

// A live log already hashed its prefix; these rechecks ask for it again (`rehashPrefix`), which hashes it
// in the background behind the execution gate, as a cold open does.
describe('warm checkpoint rechecks', () => {
  it.each(['tail', 'checkpoint'] as const)(
    'refuses a changed %s in the foreground and seals before admitting another write',
    async (changed) => {
      const storage = await seeded(10)
      const wrapped: StorageAdapter = Object.create(storage)
      const log = await SessionLogImpl.open(options(wrapped, 'warm'))
      await log.fullVerified()
      if (changed === 'tail') {
        await log.append([input('tail')])
        tamper(storage, 'k', 11)
      } else {
        const head = (await storage.readVerifiedHead('k'))!
        const forged = 'a'.repeat(64)
        await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: forged }), { force: true })
        wrapped.integrityDigestAt = async () => forged
      }
      await expect(log.verifyHistory()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
      await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
      expect(log.faulted).toBe(true)
      expect(await storage.readVerifiedHead('k')).toBeUndefined()
      await expect(log.append([input('refused')], { beforeFullVerify: 'allow' })).rejects.toMatchObject({
        code: 'E_LEDGER_INTEGRITY',
      })
      await log.close()
    },
  )

  it('ordinary appends and forks proceed while an audit waits; evidence does not', async () => {
    const storage = await seeded(10)
    const slow = held(storage, false)
    const log = await SessionLogImpl.open(options(slow.storage, 'warm'))
    await log.fullVerified()
    slow.arm()
    await log.verifyHistory({ rehashPrefix: true })
    await slow.reached
    const waiting = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }])
    await expect(log.append([input('model-side')])).resolves.toMatchObject({ firstSeq: 11 })
    const child = await log.forkInto(5, 'child', {
      actor,
      agnesVersion: '0.0.1',
      preset: 'standard',
      resolvedProfileHash: null,
      writerRunId: 'child-run',
      lane: 'main',
    })
    expect(child.lastSeq).toBeGreaterThan(5)
    expect(log.lastSeq).toBe(11)
    slow.release()
    await waiting
    await child.close()
    await log.close()
  })

  it('detects live stored-byte tampering in the background, refuses a fork, and drops the checkpoint', async () => {
    const storage = await seeded(10)
    const slow = held(storage, false)
    const log = await SessionLogImpl.open(options(slow.storage, 'warm'))
    await log.fullVerified()
    slow.arm()
    tamper(storage, 'k', 2)
    await expect(log.verifyHistory({ rehashPrefix: true })).resolves.toBe(10)
    await slow.reached
    const fork = log.forkInto(5, 'child', {
      actor,
      agnesVersion: '0.0.1',
      preset: 'standard',
      resolvedProfileHash: null,
      writerRunId: 'child-run',
      lane: 'main',
    })
    void fork.catch(() => undefined)
    expect((await storage.scan('child', { fromSeq: 6, limit: 100 })).length).toBe(0)
    slow.release()
    await expect(fork).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY', detail: { seq: 2 } })
    expect(log.faulted).toBe(true)
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
    await expect(log.append([input('refused')], { beforeFullVerify: 'allow' })).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    await log.close()
  })

  it.each([false, true])(
    'cancels an observer while ordinary steps run; tool attestsHistory=%s is fenced',
    async (attestsHistory) => {
      const storage = new MemoryStorage()
      const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
      await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
      await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
      await first.session.close()
      const slow = held(storage, false)
      const provider = fakeProvider([toolTurn('read', {}), textTurn('two')])
      const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read evidence' }] }))
      const tool: ToolDef = readTool(execute)
      const registry = new ToolRegistry()
      registry.add({ ...tool, meta: { ...tool.meta, attestsHistory } }, { source: 'test', trust: 'builtin' })
      const second = await openSession({
        storage: slow.storage as MemoryStorage,
        provider,
        registry,
        writerRunId: 'warm',
      })
      await second.log.fullVerified()
      slow.arm()
      const controller = new AbortController()
      await second.session.verifyHistory({ rehashPrefix: true, signal: controller.signal })
      await slow.reached
      // A second observer waiting for that same live log can leave without releasing its gate.
      const cancelled = second.session.auditHistory(controller.signal)
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ code: 'E_CLOSED' })
      await second.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
      const run = second.session.run({ until: 'turn-end', signal: new AbortController().signal })
      await vi.waitFor(() => expect(provider.calls).toBeGreaterThanOrEqual(1))
      if (attestsHistory) expect(execute).not.toHaveBeenCalled()
      else await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
      slow.release()
      await run
      expect(provider.calls).toBe(2)
      expect(execute).toHaveBeenCalledTimes(1)
      await second.session.close()
    },
  )

  it('waits for an approval outside the session writer lock while ordinary input proceeds', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.close()
    const slow = held(storage)
    const second = await openSession({
      storage: slow.storage as MemoryStorage,
      provider: fakeProvider([textTurn('two')]),
      writerRunId: 'approval',
    })
    try {
      await slow.reached
      const handle = await second.session.decisions
        .port({
          owner: 'review',
          operationId: 'review',
          sourcePackage: '@fixture/review',
          packageVersion: '1.0.0',
          alive() {},
        })
        .request({
          key: 'review',
          purpose: 'business.confirm',
          subject: {},
          prompt: 'Review?',
          options: ['continue', 'reject'],
        })
      let answered = false
      const answer = second.session.decisions
        .answer(
          {
            handle,
            revision: 1,
            commandId: 'answer',
            response: { option: 'continue', value: null },
          },
          { actor, category: 'human', authorize() {} },
        )
        .then(() => {
          answered = true
        })
      await second.session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'ordinary input' }],
        actor,
      })
      expect(answered).toBe(false)
      slow.release()
      await answer
      expect(answered).toBe(true)
    } finally {
      slow.release()
      await second.session.close()
    }
  })

  it('closing a session cancels verification before draining a turn waiting at its evidence gate', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'seed' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    const slow = held(storage)
    const provider = fakeProvider([textTurn('two')])
    const second = await openSession({
      storage: slow.storage as MemoryStorage,
      provider,
      writerRunId: 'closing',
    })
    let closing: Promise<void> | undefined
    try {
      await second.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
      const run = second.session.run({ until: 'turn-end', signal: new AbortController().signal })
      void run.catch(() => undefined)
      await vi.waitFor(() => expect(provider.calls).toBe(1))
      let closed = false
      closing = second.session.close().then(() => {
        closed = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(closed).toBe(true)
      await run
    } finally {
      slow.release()
      await closing
      await second.session.close()
    }
  })

  it('closing during a warm background check refuses waiting writes without advancing the checkpoint', async () => {
    const storage = await seeded(10)
    const slow = held(storage, false)
    const log = await SessionLogImpl.open(options(slow.storage, 'warm'))
    await log.fullVerified()
    const head = await storage.readVerifiedHead('k')
    slow.arm()
    await log.verifyHistory({ rehashPrefix: true })
    await slow.reached
    const waiting = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }])
    await log.close()
    slow.release()
    await expect(waiting).rejects.toMatchObject({ code: 'E_CLOSED' })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(await storage.readVerifiedHead('k')).toEqual(head)
    expect(await storage.scan('k', { limit: 100 })).toHaveLength(10)
  })

  it.each(['cancel', 'close'] as const)(
    '%s during a tail read does not admit work after close',
    async (action) => {
      const storage = await seeded(10)
      let hold = false
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let reached!: () => void
      const reading = new Promise<void>((resolve) => {
        reached = resolve
      })
      const wrapped: StorageAdapter = Object.create(storage)
      wrapped.scanIntegrity = async (key, query) => {
        if (hold && query.fromSeq === 11) {
          reached()
          await gate
        }
        return storage.scanIntegrity(key, query)
      }
      const log = await SessionLogImpl.open(options(wrapped, 'warm'))
      await log.fullVerified()
      await log.append([input('tail')])
      hold = true
      const controller = new AbortController()
      const opening = log.verifyHistory({ signal: controller.signal })
      await reading
      const waiting = log.append([input('ordinary')])
      await expect(waiting).resolves.toMatchObject({ firstSeq: 12 })
      if (action === 'cancel') controller.abort()
      else await log.close()
      await expect(opening).rejects.toMatchObject({ code: 'E_CLOSED' })
      expect(log.historyVerified).toBe(action === 'cancel')
      expect(log.lastSeq).toBe(12)
      release()
      if (action === 'cancel') {
        await log.fullVerified()
        await expect(waiting).resolves.toMatchObject({ firstSeq: 12 })
      } else {
        await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
        expect((await storage.readVerifiedHead('k'))?.throughSeq).toBeLessThanOrEqual(12)
      }
      await log.close()
    },
  )
})

describe('reopening a live log this process already verified', () => {
  it.each(['checkpoint', 'full'] as const)(
    'checks only the tail after the checkpoint, not the prefix again (opened from %s)',
    async (opened) => {
      const storage = await seeded(1200)
      // Without a checkpoint the open hashes everything in the foreground instead of in the background.
      if (opened === 'full') await storage.deleteVerifiedHead('k')
      let rows = 0
      const counted: StorageAdapter = Object.create(storage)
      counted.scanIntegrity = async (key, q) => {
        const page = await storage.scanIntegrity(key, q)
        rows += page.length
        return page
      }
      const log = await SessionLogImpl.open(options(counted, 'live'))
      expect(log.openStats.checkpoint.used).toBe(opened === 'checkpoint')
      await log.fullVerified()
      await vi.waitFor(async () => expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(1200))
      for (const text of ['a', 'b', 'c']) await log.append([input(text)])
      rows = 0
      await expect(log.verifyHistory()).resolves.toBe(1203)
      expect(log.historyVerified).toBe(false)
      expect(rows).toBe(3)
      await log.fullVerified()
      await log.close()
    },
  )

  it('a warm reload schedules a prefix recheck and seals changed stored history', async () => {
    const storage = await seeded(10)
    const log = await SessionLogImpl.open(options(storage, 'live'))
    await log.fullVerified()
    tamper(storage, 'k', 2)
    await expect(log.verifyHistory()).resolves.toBe(10)
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY', detail: { seq: 2 } })
    await expect(log.append([input('after seal')])).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await log.close()
    await expect(SessionLogImpl.open(options(storage, 'cold'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
  })
})

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
      await log.verifyHistory({ rehashPrefix: true })
      await log.fullVerified()
    } finally {
      restore()
    }
    // The open folded in one page; the explicit verification read the same rows in pages of at most 32.
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
    const log = await openRehashed({ ...options(storage, 'b'), onFullVerify: (r) => reports.push(r) })
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 30 })
    const write = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }])
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
    const log = await openRehashed(options(storage, 'b'))
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
    const log = await openRehashed(options(storage, 'b'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: 10 })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await log.close()
    // A proven mismatch remains sealed across reload; recovery must preserve the evidence.
    await expect(SessionLogImpl.open(options(storage, 'c'))).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
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

  it('a checkpoint that cannot be read is not used, and the open treats the session as having none', async () => {
    const storage = await seeded(10)
    const failing: StorageAdapter = Object.create(storage)
    failing.readVerifiedHead = async () => {
      throw new Error('disk error')
    }
    const log = await SessionLogImpl.open(options(failing, 'b'))
    expect(log.openStats.checkpoint).toEqual({ used: false, reason: 'unsupported' })
    expect(log.historyVerified).toBe(false)
    await log.fullVerified()
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

  it('a cold fork checks its own tail while the parent prefix verification is pending', async () => {
    const storage = await seeded(10)
    tamper(storage, 'k', 2)
    const { storage: slow, release } = held(storage)
    const log = await openRehashed(options(slow, 'b'))
    const fork = log.forkInto(5, 'child', {
      actor,
      agnesVersion: '0.0.1',
      preset: 'standard',
      resolvedProfileHash: null,
      writerRunId: 'child-run',
      lane: 'main',
    })
    void fork.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 5))
    expect((await storage.scan('child', { fromSeq: 6, limit: 100 })).length).toBe(0)
    release()
    await expect(fork).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect((await storage.scan('child', { fromSeq: 6, limit: 100 })).length).toBe(0)
    await log.close()
  })

  it('a write queued behind a pending verify is refused, not written, when the log closes first', async () => {
    const storage = await seeded(10)
    const { storage: slow, release } = held(storage)
    const log = await openRehashed(options(slow, 'b'))
    await log.append([input('typed')], { beforeFullVerify: 'allow' })
    const waiting = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }])
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
    const log = await openRehashed(options(slow, 'b'))
    await reached
    const waiting = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }])
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
    const log = await openRehashed({ ...options(slow, 'b'), clock: () => 99 })
    await reached
    await log.close()
    release()
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
    await new Promise((r) => setTimeout(r, 5))
    expect(await storage.readVerifiedHead('k')).toEqual(before)
  })

  it('an ordinary idle step proceeds while history is pending; a seal prevents later steps', async () => {
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
    await second.session.verifyHistory({ rehashPrefix: true })
    let settled = false
    // Nothing is queued, so this step would write nothing: only the step itself can hold it.
    const step = second.session.step().finally(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(true)
    await step
    expect(snapshots).toEqual([1])
    release()
    await expect(second.log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    // Once the verification has failed, a step is refused before any of it runs.
    await expect(second.session.step()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(snapshots).toEqual([1])
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
    await second.session.verifyHistory({ rehashPrefix: true })
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
    const log = await openRehashed(options(failing, 'b'))
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
    const log = await openRehashed(options(failing, 'b'))
    expect(log.historyVerified).toBe(false)
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    // Whether the history is intact is unknown, not bad: the next open can still start from the checkpoint.
    expect(await storage.readVerifiedHead('k')).toEqual(checkpoint)
    await log.close()
  })

  it('a turn can call its model while the final gate waits for verified history', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    const { storage: slow, release } = held(storage)
    const provider = fakeProvider([textTurn('two')])
    const second = await openSession({ storage: slow as MemoryStorage, provider, writerRunId: 'r2' })
    expect(second.log.openStats.checkpoint).toMatchObject({ used: true })
    await second.session.verifyHistory({ rehashPrefix: true })
    const before = second.log.lastSeq
    await second.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
    expect(second.log.lastSeq).toBe(before + 1)
    const run = second.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 10))
    expect(provider.calls).toBe(1)
    expect(second.log.lastSeq).toBeGreaterThan(before + 1)
    release()
    await run
    await vi.waitFor(() => expect(provider.calls).toBe(1))
    await second.session.close()
  })

  it('a turn already running fails at its evidence gate when background verification finds corruption', async () => {
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
    await second.session.verifyHistory({ rehashPrefix: true })
    await second.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
    const run = second.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await vi.waitFor(() => expect(provider.calls).toBe(1))
    release()
    // The run reports the failure as its outcome; the model was never asked.
    await expect(run).resolves.toMatchObject({ reason: 'error', error: { code: 'E_LEDGER_INTEGRITY' } })
    expect(provider.calls).toBe(1)
    expect(second.log.faulted).toBe(true)
    await second.session.close()
  })
})

describe('a storage that vouches for the wrong digest', () => {
  it('is caught when the background verify reaches the end of the checkpointed prefix', async () => {
    const storage = await seeded(20)
    const head = (await storage.readVerifiedHead('k')) as VerifiedHead
    // A checkpoint naming a digest no row has, and a storage that confirms it for the row it names.
    const forged = 'c'.repeat(64)
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: forged }), { force: true })
    const liar = Object.create(storage) as MemoryStorage
    liar.integrityDigestAt = async (key, seq) =>
      seq === head.throughSeq ? forged : storage.integrityDigestAt(key, seq)
    const log = await openRehashed(options(liar, 'r2'))
    expect(log.openStats.checkpoint).toEqual({ used: true, throughSeq: head.throughSeq })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await log.close()
  })
})

const reviewOpener = {
  actor,
  agnesVersion: '0.0.1',
  preset: 'standard',
  resolvedProfileHash: null,
  writerRunId: 'review-child',
  lane: 'main',
}

describe('perf3-review: live checkpoint regression matrix', () => {
  it.each([
    'prefix',
    'tail',
    'invalid-checkpoint',
    'advanced-checkpoint',
    'foreign-checkpoint',
    'self-consistent-new-head',
  ] as const)('seals a live %s change before append or fork and drops its checkpoint', async (change) => {
    const storage = await seeded(10)
    const log = await SessionLogImpl.open(options(storage, 'review-live'))
    await log.fullVerified()
    if (change === 'tail') await log.append([input('tail')])
    const head = (await storage.readVerifiedHead('k'))!
    tamper(storage, 'k', change === 'tail' ? 11 : 2)
    if (change === 'invalid-checkpoint')
      await storage.writeVerifiedHead({ ...head, checkpointDigest: '0'.repeat(64) }, { force: true })
    if (change === 'advanced-checkpoint')
      await storage.writeVerifiedHead(makeVerifiedHead({ ...head, throughSeq: 20 }), { force: true })
    if (change === 'foreign-checkpoint') {
      const foreign = makeVerifiedHead({ ...head, sessionKey: 'other-profile:other-session' })
      await storage.writeVerifiedHead({ ...foreign, sessionKey: 'k' }, { force: true })
    }
    if (change === 'self-consistent-new-head') {
      // Rewrite a complete valid stored chain; the live process must retain its original head.
      const book = (
        storage as unknown as {
          books: Map<
            string,
            {
              events: Event[]
              integrity: Map<number, import('@agnes/core-ledger/log/storage').IntegrityMetadata>
            }
          >
        }
      ).books.get('k')!
      const next = prepareIntegrity('k', book.events, { lastSeq: 0, legacyThroughSeq: 0, headDigest: null })
      book.integrity.clear()
      for (const { seq, ...metadata } of next.entries) book.integrity.set(seq, metadata)
      await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: next.state.headDigest! }), {
        force: true,
      })
    }
    // A changed prefix of a live log is found only by a full recheck; the other changes by any recheck.
    const checked = log.verifyHistory(change === 'prefix' ? { rehashPrefix: true } : {}).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const append = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }]).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await checked
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(await append).toMatchObject({ error: { code: 'E_LEDGER_INTEGRITY' } })
    await expect(log.forkInto(5, 'review-child', reviewOpener)).rejects.toMatchObject({
      code: 'E_LEDGER_INTEGRITY',
    })
    expect(log.lastSeq).toBe(change === 'tail' ? 11 : 10)
    expect((storage as unknown as Books).books.has('review-child')).toBe(false)
    expect(log.faulted).toBe(true)
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
    await log.close()
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
  })

  it.each(['foreground', 'background'] as const)(
    'distinguishes %s storage outage from integrity failure',
    async (stage) => {
      const storage = await seeded(10)
      let armed = false
      const wrapped: StorageAdapter = Object.create(storage)
      wrapped.scanIntegrity = async (key, query) => {
        if (armed && query.fromSeq === (stage === 'foreground' ? 11 : 1))
          throw new Error('synthetic storage unavailable')
        return storage.scanIntegrity(key, query)
      }
      const reports: FullVerifyReport[] = []
      const log = await SessionLogImpl.open({
        ...options(wrapped, 'review-live'),
        onFullVerify: (value) => reports.push(value),
      })
      await log.fullVerified()
      await log.append([input('tail')])
      const head = await storage.readVerifiedHead('k')
      reports.length = 0
      armed = true
      await log.verifyHistory({ rehashPrefix: stage === 'background' }).catch(() => undefined)
      await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
      await expect(log.append([input('normal')])).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
      await expect(log.append([input('queued input')], { beforeFullVerify: 'allow' })).rejects.toMatchObject({
        code: 'E_STORAGE_FAULT',
      })
      await expect(log.forkInto(5, 'review-child', reviewOpener)).rejects.toMatchObject({
        code: 'E_STORAGE_FAULT',
      })
      expect(log.historyVerified).toBe(false)
      expect(log.faulted).toBe(true)
      expect(log.lastSeq).toBe(11)
      expect(await storage.readVerifiedHead('k')).toEqual(head)
      expect(reports.every((report) => report.outcome !== 'ok')).toBe(true)
      await log.close()
      expect(await storage.readVerifiedHead('k')).toEqual(head)
    },
  )

  it('audits a committed snapshot while admitted appends continue and evidence waits', async () => {
    const storage = await seeded(10),
      slow = held(storage, false)
    const log = await SessionLogImpl.open(options(slow.storage, 'review-live'))
    await log.fullVerified()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
      }),
      finish = new Promise<void>((resolve) => {
        release = resolve
      })
    const admitted = log.append([input('admitted before cut')], {
      beforeCommit: async () => {
        enter()
        await finish
      },
    })
    await entered
    slow.arm()
    const checking = log.verifyHistory({ rehashPrefix: true })
    expect(log.historyVerified).toBe(false)
    release()
    await expect(admitted).resolves.toMatchObject({ firstSeq: 11 })
    await expect(checking).resolves.toBe(10)
    await slow.reached
    await expect(log.append([input('queued user')], { beforeFullVerify: 'allow' })).resolves.toMatchObject({
      firstSeq: 12,
    })
    let completed = false
    const normal = log
      .append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }])
      .then((value) => {
        completed = true
        return value
      })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(log.lastSeq).toBe(12)
    slow.release()
    await expect(normal).resolves.toMatchObject({ firstSeq: 13 })
    await log.close()
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(13)
  })

  it.each(['abort', 'close'] as const)(
    'overlapping rechecks with %s never release an older gate',
    async (action) => {
      const storage = await seeded(10),
        slow = held(storage, false)
      const log = await SessionLogImpl.open(options(slow.storage, 'review-live'))
      await log.fullVerified()
      const head = await storage.readVerifiedHead('k')
      slow.arm()
      tamper(storage, 'k', 2)
      await log.verifyHistory({ rehashPrefix: true })
      await slow.reached
      const controller = new AbortController()
      const next = log.auditHistory(controller.signal).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      const append = log.append([{ ...input('evidence'), type: 'x/approval/review', ignorable: true }]).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      if (action === 'abort') controller.abort()
      else await log.close()
      expect(log.historyVerified).toBe(false)
      expect(log.lastSeq).toBe(10)
      slow.release()
      const code = action === 'abort' ? 'E_LEDGER_INTEGRITY' : 'E_CLOSED'
      expect(await next).toMatchObject({ error: { code: action === 'abort' ? 'E_CLOSED' : code } })
      expect(await append).toMatchObject({ error: { code } })
      await expect(log.forkInto(5, 'review-child', reviewOpener)).rejects.toMatchObject({ code })
      if (action === 'abort') expect(await storage.readVerifiedHead('k')).toBeUndefined()
      else expect(await storage.readVerifiedHead('k')).toEqual(head)
      await log.close()
    },
  )

  it('a warm recheck permits a step snapshot and seals later work on prefix failure', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'seed' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    const slow = held(storage, false),
      snapshots: string[] = []
    const second = await openSession({
      storage: slow.storage as MemoryStorage,
      provider: fakeProvider([]),
      writerRunId: 'review-live',
      withModelSnapshot: async (fn) => {
        snapshots.push('effect')
        return fn()
      },
    })
    try {
      await second.log.fullVerified()
      slow.arm()
      tamper(storage, 'k', 1)
      await second.session.verifyHistory({ rehashPrefix: true })
      await slow.reached
      const stepping = second.session.step().then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      await Promise.resolve()
      expect(snapshots).toEqual(['effect'])
      expect(await stepping).toHaveProperty('value')
      slow.release()
      await expect(second.log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
      await expect(second.session.step()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
      expect(snapshots).toEqual(['effect'])
      expect(await storage.readVerifiedHead('k')).toBeUndefined()
    } finally {
      slow.release()
      await second.session.close()
    }
  })
})

it('perf3-review: an older delayed checkpoint write cannot resurrect a checkpoint deleted by a failed recheck', async () => {
  const storage = await seeded(10)
  let armed = false,
    entered!: () => void,
    release!: () => void,
    finished!: () => void
  const reached = new Promise<void>((resolve) => {
      entered = resolve
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    written = new Promise<void>((resolve) => {
      finished = resolve
    })
  const wrapped: StorageAdapter = Object.create(storage)
  wrapped.writeVerifiedHead = async (head, options) => {
    if (armed) {
      armed = false
      entered()
      await gate
      await storage.writeVerifiedHead(head, options)
      finished()
    } else await storage.writeVerifiedHead(head, options)
  }
  const log = await SessionLogImpl.open(options(wrapped, 'review-live'))
  try {
    await log.fullVerified()
    await storage.deleteVerifiedHead('k')
    armed = true
    await log.verifyHistory()
    await reached
    expect(log.historyVerified).toBe(true)
    tamper(storage, 'k', 2)
    const failing = log.verifyHistory().catch(() => undefined)
    await vi.waitFor(() => expect(log.faulted).toBe(true))
    release()
    await written
    await failing
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await log.close()
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
  } finally {
    release()
    await log.close()
  }
})

it('waits for failed checkpoint deletion before close hands back the writer', async () => {
  const storage = await seeded(10)
  let removing = false,
    finished = false,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const wrapped: StorageAdapter = Object.create(storage)
  wrapped.deleteVerifiedHead = async (key) => {
    removing = true
    await gate
    await storage.deleteVerifiedHead(key)
  }
  const log = await SessionLogImpl.open(options(wrapped, 'review-close'))
  try {
    await log.fullVerified()
    tamper(storage, 'k', 2)
    await log.verifyHistory({ rehashPrefix: true }).catch(() => undefined)
    await vi.waitFor(() => expect(removing).toBe(true))
    const closing = log.close().then(() => {
      finished = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finished).toBe(false)
    release()
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    await closing
    expect(finished).toBe(true)
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
  } finally {
    release()
    await log.close()
  }
})

it('perf3-review: documents that a Byzantine persistence provider is a trusted backend, not authenticated storage', async () => {
  const storage = await seeded(10),
    folded: Event[] = []
  let folding = true
  const provider: StorageAdapter = Object.create(storage)
  provider.scanIntegrity = async (key, query) =>
    (await storage.scanIntegrity(key, query)).map((row) =>
      folding && row.event.seq === 2
        ? {
            ...row,
            event: {
              ...row.event,
              data: { content: [{ type: 'text', text: 'provider-only-foreground-content' }] },
            },
          }
        : row,
    )
  const log = await SessionLogImpl.open({
    ...options(provider, 'review-provider'),
    replay: {
      page: (events) => {
        folded.push(...events)
        folding = false
      },
    },
  })
  try {
    await log.fullVerified()
    expect(log.historyVerified).toBe(true)
    expect(JSON.stringify(folded)).toContain('provider-only-foreground-content')
    expect(JSON.stringify(await storage.scan('k', { limit: 20 }))).not.toContain(
      'provider-only-foreground-content',
    )
    // The provider served one view for folding and another for checking: stable truthful reads are its contract.
    await expect(log.append([input('backend admitted')])).resolves.toMatchObject({ firstSeq: 11 })
  } finally {
    await log.close()
  }
})
