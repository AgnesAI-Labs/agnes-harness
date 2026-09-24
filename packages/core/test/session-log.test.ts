import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { CoreError, type EventInput, type StorageAdapter } from '../src/index.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { SessionLogImpl } from '../src/log/session-log.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const user = (text: string): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})
const opstate = (step: number): EventInput => ({
  actor,
  origin: 'system',
  trust: 'trusted',
  type: 'op.state',
  register: 'op.state',
  data: {
    meta: {
      turn: 1,
      lane: 'main',
      acceptedAt: 't',
      triggerSeq: 1,
      presetName: 'standard',
      profileHash: null,
      depthLimit: 1,
    },
    control: { status: 'running' },
    step,
    latestAssistantSeq: null,
    taint: false,
    phase: { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: 1 },
  },
})

// A hand-driven timer queue: nothing fires until flush() is called, so the renewal schedule is
// asserted rather than waited on. Handles are distinct objects and cleared ones are recorded, so a
// timer that is never cancelled is visible instead of merely harmless.
function timers() {
  const queue: Array<{ handle: object; fn: () => void }> = []
  const cleared: unknown[] = []
  return {
    setTimeout: (fn: () => void) => {
      const handle = {}
      queue.push({ handle, fn })
      return handle
    },
    clearTimeout: (handle: unknown) => {
      cleared.push(handle)
    },
    cleared,
    pending: () => queue.map((e) => e.handle),
    flush: () => {
      const q = queue.splice(0)
      for (const e of q) e.fn()
    },
  }
}

async function openLog(storage: StorageAdapter = new MemoryStorage()) {
  const t = timers()
  const log = await SessionLogImpl.open({
    storage,
    key: 'k',
    writerRunId: 'r1',
    ttlMs: 900,
    ids: defaultIds(),
    clock: () => Date.now(),
    timers: t,
  })
  return { log, storage, t }
}

// Wraps a MemoryStorage so individual methods can be overridden: spreading the instance copies no
// prototype methods, so every method is bound through explicitly.
function wrap(storage: MemoryStorage, over: Partial<StorageAdapter>): StorageAdapter {
  const wrapped = {
    open: storage.open.bind(storage),
    commit: storage.commit.bind(storage),
    renew: storage.renew.bind(storage),
    release: storage.release.bind(storage),
    scan: storage.scan.bind(storage),
    registers: storage.registers.bind(storage),
    createChild: storage.createChild.bind(storage),
    close: storage.close.bind(storage),
    ...over,
  }
  return {
    ...wrapped,
    scanIntegrity: over.scanIntegrity ?? storage.scanIntegrity.bind(storage),
  }
}

describe('SessionLogImpl', () => {
  it('isolates post-commit observer failures and mutations, and unsubscribes cleanly', async () => {
    const { log } = await openLog()
    let observed = 0
    const off = log.observeCommitted(['user/message'], (events) => {
      observed += events.length
      if (events[0]) events[0].data = null
      throw new Error('optional observer failure')
    })
    log.observeCommitted(['user/message'], async () => {
      throw new Error('optional async observer failure')
    })
    await expect(log.append([user('original')])).resolves.toMatchObject({ firstSeq: 1 })
    expect(observed).toBe(1)
    expect((await log.scan({ fromSeq: 1, toSeq: 1 }))[0]?.data).not.toBeNull()
    off()
    await log.append([user('next')])
    expect(observed).toBe(1)
    await log.close()
  })
  it('appends atomically and exposes latest register', async () => {
    const { log } = await openLog()
    const r = await log.append([user('a'), opstate(1)])
    expect(r.seqs).toEqual([1, 2])
    expect(log.lastSeq).toBe(2)
    expect(log.latest('op.state')).toMatchObject({ step: 1 })
    await log.append([{ ...opstate(2), data: null }])
    expect(log.latest('op.state')).toBeUndefined()
  })

  it('rejects the whole batch when one event is invalid', async () => {
    const { log } = await openLog()
    await expect(
      log.append([user('a'), { ...user('b'), trust: undefined } as unknown as EventInput]),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    expect(log.lastSeq).toBe(0)
  })

  it('renews the lease on a ttl/3 timer, reschedules itself, and cancels on close', async () => {
    const storage = new MemoryStorage()
    const calls: string[] = []
    const spy = wrap(storage, {
      renew: async (k, r) => {
        calls.push(r)
        await storage.renew(k, r)
      },
    })
    const { log, t } = await openLog(spy)
    // The timer runs while a turn is open.
    await log.append([opstate(1)])
    const [first] = t.pending()
    expect(t.pending()).toHaveLength(1)
    t.flush()
    expect(calls).toEqual(['r1'])
    // A one-shot renewal would keep the lease alive for a single term and then let it lapse under a
    // long-running session, so the timer must have armed itself again with a fresh handle.
    const [second] = t.pending()
    expect(t.pending()).toHaveLength(1)
    expect(second).not.toBe(first)
    t.flush()
    expect(calls).toEqual(['r1', 'r1'])
    const outstanding = t.pending()
    await log.close()
    // The outstanding timer is cancelled rather than left to fire against a closed session.
    expect(t.cleared).toEqual(outstanding)
  })

  it('enters fault state on commit failure and refuses further calls', async () => {
    const storage = new MemoryStorage()
    const broken = wrap(storage, {
      commit: async () => {
        throw new Error('disk full')
      },
    })
    const { log } = await openLog(broken)
    await expect(log.append([user('a')])).rejects.toThrow(/disk full/)
    expect(log.faulted).toBe(true)
    await expect(log.append([user('b')])).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    await expect(log.scan({ limit: 1 })).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
  })

  it('only a refusal is exempt from faulting; any other CoreError seals the session', async () => {
    // The exemption is a closed list of two codes. Widening it to "any CoreError" would let a
    // storage fault pass as a mere refusal and leave the session writing on top of an unknown
    // outcome, so a CoreError with any other code must still seal.
    const storage = new MemoryStorage()
    const broken = wrap(storage, {
      commit: async () => {
        throw new CoreError('E_STORAGE_FAULT', 'write outcome unknown')
      },
    })
    const { log } = await openLog(broken)
    await expect(log.append([user('a')])).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    expect(log.faulted).toBe(true)
    // The seal covers the cache reseed as well: a faulted log's registers are exactly what nobody
    // should be able to rewrite from outside.
    expect(() => log.replaceRegisterCache([])).toThrow('E_STORAGE_FAULT')
  })

  it('a batch queued behind a faulting one never reaches storage', async () => {
    // The fault state is a seal, so it has to hold against batches that were already waiting their
    // turn in the serialization chain when the earlier batch failed.
    const storage = new MemoryStorage()
    let commits = 0
    let letFirstFail!: () => void
    const held = new Promise<void>((res) => {
      letFirstFail = res
    })
    const broken = wrap(storage, {
      commit: async () => {
        commits++
        await held
        throw new Error('disk full')
      },
    })
    const { log } = await openLog(broken)
    const first = log.append([user('a')])
    const second = log.append([user('b')])
    letFirstFail()
    await expect(first).rejects.toThrow(/disk full/)
    await expect(second).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    expect(commits).toBe(1)
  })

  it('close is idempotent, releases the lease and refuses later appends', async () => {
    const { log, storage } = await openLog()
    await log.append([user('a')])
    await log.close()
    await log.close()
    await expect(log.append([user('b')])).rejects.toMatchObject({ code: 'E_CLOSED' })
    // Reseeding the register cache is a write too, and this class is a root export: ungated, it lets
    // a consumer put cells no live ledger stands behind in front of every reader of latest().
    expect(() => log.replaceRegisterCache([{ register: 'inbox', key: 'main', seq: 1, data: {} }])).toThrow(
      'E_CLOSED',
    )
    expect(log.latest('inbox')).toBeUndefined()
    // The lease is gone, so a different writer can take the session over.
    await storage.open('k', { writerRunId: 'r2', ttlMs: 900 })
  })

  it('releases only its own lease when new-session discard fails', async () => {
    const storage = new MemoryStorage()
    const broken = wrap(storage, {
      discardNewSession: async () => {
        throw new Error('disk full while removing import target')
      },
    })
    const { log } = await openLog(broken)

    await expect(log.discardNewSession()).rejects.toThrow('disk full while removing import target')

    const next = await SessionLogImpl.open({
      storage,
      key: 'k',
      writerRunId: 'r2',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: timers(),
    })
    await next.close()
  })

  it('does not release a successor lease after new-session discard fails', async () => {
    let now = 0
    const storage = new MemoryStorage({ clock: () => now })
    const broken = wrap(storage, {
      discardNewSession: async () => {
        now = 901
        await storage.open('k', { writerRunId: 'r2', ttlMs: 900 })
        throw new Error('discard lost its lease')
      },
    })
    const log = await SessionLogImpl.open({
      storage: broken,
      key: 'k',
      writerRunId: 'r1',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => now,
      timers: timers(),
    })

    await expect(log.discardNewSession()).rejects.toThrow('discard lost its lease')
    await expect(
      SessionLogImpl.open({
        storage,
        key: 'k',
        writerRunId: 'r3',
        ttlMs: 900,
        ids: defaultIds(),
        clock: () => now,
        timers: timers(),
      }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await storage.release('k', 'r2')
  })
  it('a refused batch (CAS / lost lease) does not fault the session', async () => {
    // These two are the storage saying "I did not write this batch". The ledger is intact, so the
    // session must stay usable; only an unknown outcome is allowed to seal it.
    const storage = new MemoryStorage()
    let failNext = true
    const flaky = wrap(storage, {
      commit: async (k, tx) => {
        if (failNext) {
          failNext = false
          throw new CoreError('E_CAS', 'register seq mismatch')
        }
        return storage.commit(k, tx)
      },
    })
    const { log } = await openLog(flaky)
    await expect(log.append([user('a')])).rejects.toMatchObject({ code: 'E_CAS' })
    expect(log.faulted).toBe(false)
    expect(log.lastSeq).toBe(0)
    const r = await log.append([user('b')])
    expect(r.seqs).toEqual([1])
  })

  it('reloads the register cache on reopen, keyed the same way it was written', async () => {
    // Reopening rebuilds registersCache from storage.registers(). If the two sides spelled the
    // composite key differently, every register would silently read back as absent here.
    const storage = new MemoryStorage()
    const { log } = await openLog(storage)
    await log.append([opstate(7)])
    await log.append([
      {
        actor,
        origin: 'system',
        trust: 'trusted',
        type: 'inbox',
        register: 'a',
        lane: 'b c',
        // The register name and lane are the point here; the payload only has to be a legal inbox
        // now that protocol validates every row's data against its type.
        data: { items: [] },
      },
    ])
    await log.close()

    const reopened = await SessionLogImpl.open({
      storage,
      key: 'k',
      writerRunId: 'r2',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: timers(),
    })
    expect(reopened.lastSeq).toBe(2)
    expect(reopened.latest('op.state')).toMatchObject({ step: 7 })
    expect(reopened.latest('a', 'b c')).toEqual({ items: [] })
    expect(reopened.latest('a b', 'c')).toBeUndefined()
    await reopened.close()
  })

  it('a failing relationCheck rejects before anything reaches storage', async () => {
    const storage = new MemoryStorage()
    let commits = 0
    const counted = wrap(storage, {
      commit: async (k, tx) => {
        commits++
        return storage.commit(k, tx)
      },
    })
    const log = await SessionLogImpl.open({
      storage: counted,
      key: 'k',
      writerRunId: 'r1',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: timers(),
      relationCheck: () => {
        throw new CoreError('E_RELATION', 'turn already open')
      },
    })
    await expect(log.append([user('a')])).rejects.toMatchObject({ code: 'E_RELATION' })
    expect(commits).toBe(0)
    expect(log.lastSeq).toBe(0)
    expect(log.faulted).toBe(false)
  })

  it('close waits for an append that was already admitted, and reports it via onAppended', async () => {
    const storage = new MemoryStorage()
    let letCommitFinish!: () => void
    const held = new Promise<void>((res) => {
      letCommitFinish = res
    })
    const slow = wrap(storage, {
      commit: async (k, tx) => {
        await held
        return storage.commit(k, tx)
      },
    })
    const seen: number[] = []
    const log = await SessionLogImpl.open({
      storage: slow,
      key: 'k',
      writerRunId: 'r1',
      ttlMs: 900,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: timers(),
      onAppended: (events) => seen.push(...events.map((e) => e.seq)),
    })
    const appending = log.append([user('a')])
    let closed = false
    const closing = log.close().then(() => {
      closed = true
    })
    // The commit is still parked, so close must not have returned yet.
    await Promise.resolve()
    expect(closed).toBe(false)
    letCommitFinish()
    await appending
    await closing
    expect(closed).toBe(true)
    expect(seen).toEqual([1])
    expect(log.lastSeq).toBe(1)
  })
})

describe('SessionLogImpl push and fault notice', () => {
  it("observes every committed type with '*', in commit order, isolated, and not after close", async () => {
    const { log } = await openLog()
    const seen: Array<[number, string]> = []
    log.observeCommitted('*', (events) => {
      for (const e of events) seen.push([e.seq, e.type])
      if (events[0]) events[0].data = null
    })
    await log.append([user('a'), opstate(1)])
    await log.append([user('b')])
    expect(seen).toEqual([
      [1, 'user/message'],
      [2, 'op.state'],
      [3, 'user/message'],
    ])
    expect((await log.scan({ fromSeq: 1, toSeq: 1 }))[0]?.data).not.toBeNull()
    await log.close()
    expect(seen).toHaveLength(3)
  })

  it('notifies a fault once when a lease renewal fails', async () => {
    const storage = new MemoryStorage()
    const failing = wrap(storage, {
      renew: async () => {
        throw new CoreError('E_WRITER_LEASE', 'lease lost')
      },
    })
    const { log, t } = await openLog(failing)
    await log.append([opstate(1)])
    const faults: unknown[] = []
    log.onFault((e) => faults.push(e))
    t.flush()
    await new Promise((r) => setTimeout(r, 0))
    t.flush()
    await new Promise((r) => setTimeout(r, 0))
    expect(log.faulted).toBe(true)
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ code: 'E_WRITER_LEASE' })
  })

  it('notifies a fault once when a commit outcome is unknown, and not for a refusal', async () => {
    const storage = new MemoryStorage()
    let refuse = true
    const broken = wrap(storage, {
      commit: async () => {
        if (refuse) throw new CoreError('E_CAS', 'refused')
        throw new Error('disk full')
      },
    })
    const { log } = await openLog(broken)
    const faults: unknown[] = []
    log.onFault((e) => faults.push(e))
    await expect(log.append([user('a')])).rejects.toMatchObject({ code: 'E_CAS' })
    expect(faults).toEqual([])
    refuse = false
    await expect(log.append([user('b')])).rejects.toThrow(/disk full/)
    await expect(log.append([user('c')])).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
    expect(faults).toHaveLength(1)
  })

  it('calls a listener registered after the fault once, on the next microtask', async () => {
    const storage = new MemoryStorage()
    const broken = wrap(storage, {
      commit: async () => {
        throw new Error('disk full')
      },
    })
    const { log } = await openLog(broken)
    await expect(log.append([user('a')])).rejects.toThrow(/disk full/)
    const faults: unknown[] = []
    log.onFault((e) => faults.push(e))
    expect(faults).toEqual([])
    await Promise.resolve()
    expect(faults).toHaveLength(1)
  })

  it('does not notify after close or after the listener is removed', async () => {
    const storage = new MemoryStorage()
    let fail = false
    const flaky = wrap(storage, {
      renew: async (k, r) => {
        if (fail) throw new CoreError('E_WRITER_LEASE', 'lease lost')
        await storage.renew(k, r)
      },
    })
    const a = await openLog(flaky)
    await a.log.append([opstate(1)])
    const removed: unknown[] = []
    a.log.onFault((e) => removed.push(e))()
    fail = true
    a.t.flush()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.log.faulted).toBe(true)
    expect(removed).toEqual([])

    fail = false
    const b = await openLog(new MemoryStorage())
    const afterClose: unknown[] = []
    b.log.onFault((e) => afterClose.push(e))
    await b.log.close()
    b.t.flush()
    await new Promise((r) => setTimeout(r, 0))
    expect(afterClose).toEqual([])
  })
})

describe('SessionLogImpl renews its lease during turns and on writes', () => {
  const TTL = 900
  // One clock for the log and its storage, so an idle stretch lapses the lease on both sides.
  const shared = { now: 1_000_000 }
  const fresh = () => new MemoryStorage({ clock: () => shared.now })
  async function openAt(
    storage: StorageAdapter = fresh(),
    extra: Partial<Parameters<typeof SessionLogImpl.open>[0]> = {},
  ) {
    const t = timers()
    const clock = shared
    const log = await SessionLogImpl.open({
      storage,
      key: 'k',
      writerRunId: 'r1',
      ttlMs: TTL,
      ids: defaultIds(),
      clock: () => clock.now,
      timers: t,
      ...extra,
    })
    const armed = () => t.pending().filter((h) => !t.cleared.includes(h))
    return { log, storage, t, clock, armed }
  }
  const idleOp = (lane = 'main'): EventInput => ({ ...opstate(1), lane, data: null })

  it('keeps no renewal timer while no turn is open, and one while a turn is open', async () => {
    const { log, armed } = await openAt()
    expect(armed()).toHaveLength(0)
    await log.append([user('a')])
    expect(armed()).toHaveLength(0)
    await log.append([opstate(1)])
    expect(armed()).toHaveLength(1)
    await log.append([opstate(2)])
    expect(armed()).toHaveLength(1)
    await log.append([idleOp()])
    expect(armed()).toHaveLength(0)
  })

  it('renews on schedule while the turn runs', async () => {
    const storage = fresh()
    let renewals = 0
    const counted = Object.assign(Object.create(storage) as MemoryStorage, {
      renew: async (k: string, r: string) => {
        renewals++
        await storage.renew(k, r)
      },
    })
    const { log, t } = await openAt(counted)
    await log.append([opstate(1)])
    t.flush()
    t.flush()
    expect(renewals).toBe(2)
    await log.append([idleOp()])
    t.flush()
    expect(renewals).toBe(2)
  })

  it('keeps renewing while any lane has a turn open', async () => {
    const { log, armed } = await openAt()
    await log.append([opstate(1), { ...opstate(1), lane: 'side' }])
    await log.append([idleOp()])
    expect(armed()).toHaveLength(1)
    await log.append([idleOp('side')])
    expect(armed()).toHaveLength(0)
  })

  it('renews at once when it opens on a turn left open', async () => {
    const storage = fresh()
    const first = await openAt(storage)
    await first.log.append([opstate(1)])
    await first.log.close()
    const { armed } = await openAt(storage)
    expect(armed()).toHaveLength(1)
  })

  it('uses no idle timer with any adapter: every adapter claims on commit', async () => {
    const { armed } = await openAt(wrap(fresh(), {}))
    expect(armed()).toHaveLength(0)
  })

  it('passes a claim on every commit, whatever the adapter declares', async () => {
    const { log, clock } = await openAt(wrap(fresh(), {}))
    await log.append([user('a')])
    clock.now += 10 * TTL
    await expect(log.append([user('b')])).resolves.toMatchObject({ seqs: [2] })
  })

  it('writes after a long idle by taking its lease back, with the full ttl ahead', async () => {
    const { log, clock } = await openAt()
    await log.append([user('a')])
    clock.now += 10 * TTL
    await expect(log.append([user('b')])).resolves.toMatchObject({ seqs: [2] })
    expect(log.leaseRemainingMs()).toBe(TTL)
  })

  it('seals itself, notifying once, when another writer took the session while it was idle', async () => {
    const { log, clock, storage } = await openAt()
    await log.append([user('a')])
    const faults: unknown[] = []
    log.onFault((e) => faults.push(e))
    clock.now += 10 * TTL
    await storage.open('k', { writerRunId: 'r2', ttlMs: TTL })
    await expect(log.append([user('b')])).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    expect(log.faulted).toBe(true)
    expect(faults).toHaveLength(1)
  })
})
