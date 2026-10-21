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
import { describe, expect, it, vi } from 'vitest'
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
    if (q.fromSeq === 1 && folded && holding) {
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

  it('checks the tail before returning and keeps waiting writes behind a newer recheck', async () => {
    const storage = await seeded(10)
    const slow = held(storage, false)
    let checkingAgain = false
    let releaseAgain!: () => void
    const secondGate = new Promise<void>((resolve) => {
      releaseAgain = resolve
    })
    let reachedAgain!: () => void
    const secondRead = new Promise<void>((resolve) => {
      reachedAgain = resolve
    })
    const wrapped: StorageAdapter = Object.create(slow.storage)
    wrapped.scanIntegrity = async (key, query) => {
      if (checkingAgain && query.fromSeq === 1) {
        reachedAgain()
        await secondGate
      }
      return slow.storage.scanIntegrity(key, query)
    }
    const log = await SessionLogImpl.open(options(wrapped, 'warm'))
    await log.fullVerified()
    await log.append([input('tail')])
    slow.arm()
    const progress: number[] = []
    expect(await log.verifyHistory({ onProgress: (p) => progress.push(p.verifiedSeq) })).toBe(11)
    expect(progress).toEqual([10, 11])
    await slow.reached
    expect(log.historyVerified).toBe(false)
    await expect(log.append([input('queued')], { beforeFullVerify: 'allow' })).resolves.toMatchObject({
      firstSeq: 12,
    })
    let rechecked = false
    // An earlier waiter starts a new recheck before the writer's await continuation resumes.
    const again = log
      .fullVerified()
      .then(() =>
        log.verifyHistory({
          onProgress: () => {
            checkingAgain = true
          },
        }),
      )
      .then(() => {
        rechecked = true
      })
    const write = log.append([input('model-side')])
    const fork = log.forkInto(5, 'child', {
      actor,
      agnesVersion: '0.0.1',
      preset: 'standard',
      resolvedProfileHash: null,
      writerRunId: 'child-run',
      lane: 'main',
    })
    expect(log.lastSeq).toBe(12)
    expect(rechecked).toBe(false)
    slow.release()
    await again
    await secondRead
    expect(log.historyVerified).toBe(false)
    expect(log.lastSeq).toBe(12)
    expect((storage as unknown as Books).books.has('child')).toBe(false)
    releaseAgain()
    await log.fullVerified()
    await expect(write).resolves.toBeDefined()
    await (await fork).close()
    expect(log.historyVerified).toBe(true)
    await log.close()
  })

  it('detects live stored-byte tampering in the background, refuses a fork, and drops the checkpoint', async () => {
    const storage = await seeded(10)
    const slow = held(storage, false)
    const log = await SessionLogImpl.open(options(slow.storage, 'warm'))
    await log.fullVerified()
    slow.arm()
    tamper(storage, 'k', 2)
    await expect(log.verifyHistory()).resolves.toBe(10)
    await slow.reached
    const fork = log.forkInto(5, 'child', {
      actor,
      agnesVersion: '0.0.1',
      preset: 'standard',
      resolvedProfileHash: null,
      writerRunId: 'child-run',
      lane: 'main',
    })
    expect((storage as unknown as Books).books.has('child')).toBe(false)
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

  it('cancels an opening observer while the background check keeps the step gate closed', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ storage, provider: fakeProvider([textTurn('one')]) })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await first.session.close()
    const slow = held(storage, false)
    const provider = fakeProvider([textTurn('two')])
    const second = await openSession({
      storage: slow.storage as MemoryStorage,
      provider,
      writerRunId: 'warm',
    })
    await second.log.fullVerified()
    slow.arm()
    const controller = new AbortController()
    await second.session.verifyHistory({ signal: controller.signal })
    await slow.reached
    // A second observer waiting for that same live log can leave without releasing its gate.
    const cancelled = second.session.verifyHistory({ signal: controller.signal })
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'E_CLOSED' })
    await second.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
    const run = second.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(provider.calls).toBe(0)
    slow.release()
    await run
    expect(provider.calls).toBe(1)
    await second.session.close()
  })

  it('closing during a warm background check refuses waiting writes without advancing the checkpoint', async () => {
    const storage = await seeded(10)
    const slow = held(storage, false)
    const log = await SessionLogImpl.open(options(slow.storage, 'warm'))
    await log.fullVerified()
    const head = await storage.readVerifiedHead('k')
    slow.arm()
    await log.verifyHistory()
    await slow.reached
    const waiting = log.append([input('model-side')])
    await log.close()
    slow.release()
    await expect(waiting).rejects.toMatchObject({ code: 'E_CLOSED' })
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(await storage.readVerifiedHead('k')).toEqual(head)
    expect(await storage.scan('k', { limit: 100 })).toHaveLength(10)
  })

  it.each(['cancel', 'close'] as const)(
    '%s during the foreground tail read preserves the integrity gate',
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
      const waiting = log.append([input('model-side')])
      if (action === 'cancel') controller.abort()
      else await log.close()
      await expect(opening).rejects.toMatchObject({ code: 'E_CLOSED' })
      expect(log.historyVerified).toBe(false)
      expect(log.lastSeq).toBe(11)
      release()
      if (action === 'cancel') {
        await log.fullVerified()
        await expect(waiting).resolves.toMatchObject({ firstSeq: 12 })
      } else {
        await expect(waiting).rejects.toMatchObject({ code: 'E_CLOSED' })
        await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_CLOSED' })
        expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(10)
      }
      await log.close()
    },
  )
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
    const log = await SessionLogImpl.open(options(liar, 'r2'))
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
    const checked = log.verifyHistory().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const append = log.append([input('non-input write')]).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const fork = log.forkInto(5, 'review-child', reviewOpener).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await checked
    await expect(log.fullVerified()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(await append).toMatchObject({ error: { code: 'E_LEDGER_INTEGRITY' } })
    expect(await fork).toMatchObject({ error: { code: 'E_LEDGER_INTEGRITY' } })
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
      await log.verifyHistory().catch(() => undefined)
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

  it('drains already admitted appends, fixes the head, and allows only queued input past that cut', async () => {
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
    const checking = log.verifyHistory()
    expect(log.historyVerified).toBe(false)
    release()
    await expect(admitted).resolves.toMatchObject({ firstSeq: 11 })
    await expect(checking).resolves.toBe(11)
    await slow.reached
    await expect(log.append([input('queued user')], { beforeFullVerify: 'allow' })).resolves.toMatchObject({
      firstSeq: 12,
    })
    let completed = false
    const normal = log.append([input('after cut')]).then((value) => {
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
      await log.verifyHistory()
      await slow.reached
      const controller = new AbortController()
      const next = log.verifyHistory({ signal: controller.signal }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      const append = log.append([input('blocked')]).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      const fork = log.forkInto(5, 'review-child', reviewOpener).then(
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
      expect(await fork).toMatchObject({ error: { code } })
      if (action === 'abort') expect(await storage.readVerifiedHead('k')).toBeUndefined()
      else expect(await storage.readVerifiedHead('k')).toEqual(head)
      await log.close()
    },
  )

  it('a warm recheck stops a real step before any model snapshot when the stored prefix fails', async () => {
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
      await second.session.verifyHistory()
      await slow.reached
      const stepping = second.session.step().then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      await Promise.resolve()
      expect(snapshots).toEqual([])
      slow.release()
      expect(await stepping).toMatchObject({ error: { code: 'E_LEDGER_INTEGRITY' } })
      expect(snapshots).toEqual([])
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
    await log.verifyHistory().catch(() => undefined)
    expect(log.faulted).toBe(true)
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
    release()
    await written
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
    await log.verifyHistory().catch(() => undefined)
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

// Recheck the checkpoint queue with more than one admitted write, including a rejected write.
it.each(
  (['write-ok', 'write-outage'] as const).flatMap((write) =>
    (['integrity', 'read-outage', 'close', 'pending-close'] as const).map((end) => ({ write, end })),
  ),
)(
  'perf3-recheck: drains repeated checkpoint writes ($write) before $end hands back the writer',
  async ({ write, end }) => {
    const storage = await seeded(10)
    const wrapped: StorageAdapter = Object.create(storage)
    let armed = false,
      arrived = false,
      closingDone = false,
      released = false
    let reading: 'normal' | 'outage' | 'hold' = 'normal',
      readPaused = false
    let release!: () => void, resumeRead!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      resumeRead = resolve
    })
    wrapped.writeVerifiedHead = async (head, opts) => {
      if (armed) {
        armed = false
        arrived = true
        await gate
        if (write === 'write-outage') throw new Error('synthetic checkpoint write outage')
      }
      await storage.writeVerifiedHead(head, opts)
    }
    wrapped.scanIntegrity = async (key, query) => {
      if (reading === 'outage') throw new Error('synthetic ledger read outage')
      if (reading === 'hold') {
        readPaused = true
        await readGate
      }
      return storage.scanIntegrity(key, query)
    }
    wrapped.release = async (...args) => {
      await storage.release(...args)
      released = true
    }
    const log = await SessionLogImpl.open(options(wrapped, 'review-queue'))
    let closing: Promise<void> | undefined
    let pendingRead: Promise<unknown> | undefined
    try {
      await log.fullVerified()
      await storage.deleteVerifiedHead('k')
      armed = true
      await log.verifyHistory()
      await vi.waitFor(() => expect(arrived).toBe(true))
      expect(log.historyVerified).toBe(true)
      // The next successful cycle queues another forced write behind the held one.
      await log.verifyHistory()
      expect(log.historyVerified).toBe(true)
      if (end === 'integrity' || end === 'read-outage') {
        if (end === 'integrity') tamper(storage, 'k', 2)
        else reading = 'outage'
        const code = end === 'integrity' ? 'E_LEDGER_INTEGRITY' : 'E_STORAGE_FAULT'
        const foreground = log.verifyHistory()
        if (end === 'integrity') await expect(foreground).rejects.toMatchObject({ code })
        else await expect(foreground).rejects.toThrow('synthetic ledger read outage')
        expect(log.historyVerified).toBe(false)
        expect(log.faulted).toBe(true)
        await expect(log.append([input('refused')], { beforeFullVerify: 'allow' })).rejects.toMatchObject({
          code,
        })
        await expect(
          log.forkInto(5, 'queue-child', {
            actor,
            agnesVersion: '0.0.1',
            preset: 'standard',
            resolvedProfileHash: null,
            writerRunId: 'child',
            lane: 'main',
          }),
        ).rejects.toMatchObject({ code })
      } else if (end === 'pending-close') {
        reading = 'hold'
        pendingRead = log.verifyHistory().then(
          () => ({ ok: true }),
          (error: unknown) => ({ error }),
        )
        await vi.waitFor(() => expect(readPaused).toBe(true))
        expect(log.historyVerified).toBe(false)
      }
      closing = log.close().then(() => {
        closingDone = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(closingDone).toBe(false)
      expect(released).toBe(false)
      release()
      await closing
      expect(released).toBe(true)
      resumeRead()
      await pendingRead
      if (end === 'integrity' || end === 'read-outage' || end === 'pending-close') {
        const code =
          end === 'integrity' ? 'E_LEDGER_INTEGRITY' : end === 'read-outage' ? 'E_STORAGE_FAULT' : 'E_CLOSED'
        await expect(log.fullVerified()).rejects.toMatchObject({ code })
        expect(log.historyVerified).toBe(false)
      }
      const checkpoint = await storage.readVerifiedHead('k')
      if (end === 'integrity') expect(checkpoint).toBeUndefined()
      else expect(checkpoint?.throughSeq).toBe(10)
      expect((await storage.scan('k', { limit: 100 })).length).toBe(10)
      expect((storage as unknown as Books).books.has('queue-child')).toBe(false)
    } finally {
      release()
      resumeRead()
      await pendingRead
      await closing
      await log.close()
    }
  },
)
