import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChildEventBus, createChildEventQueue, providerFrame } from '@agnes/core-child-control/child/events'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { AppendChildEventInput, ChildAgentEvent, ChildExecutionState } from '@agnes/extension-api'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import { describe, expect, it, vi } from 'vitest'
import { ChildEventStream, observeChildTransitions, supportsChildEvents } from '../src/child/event-stream.js'
import {
  attachChildHeartbeat,
  ChildHeartbeatEmitter,
  ChildLeaseWatchdog,
  protectChildLeases,
} from '../src/child/heartbeat.js'
import { type InProcessChildBackend, inProcessChildAgentProvider } from '../src/child/provider.js'

import type { SessionImpl } from '../src/step/session.js'

class FakeClock {
  now = 100
  read = () => this.now
  advance(ms: number) {
    this.now += ms
  }
}

const key = 'parent/child'
const owner = 'child-writer'
const parent = 'parent'

async function setup(
  clock = new FakeClock(),
  storage: MemoryStorage | ReturnType<typeof createSqliteStorage> = new MemoryStorage({ clock: clock.read }),
) {
  if (!supportsChildEvents(storage)) throw new Error('missing child event store')
  await storage.open(parent, { writerRunId: 'parent-writer', ttlMs: 1000 })
  await storage.ensureRootScope(parent, 10_000_000n)
  const child = await storage.createDelegatedChild({
    childKey: key,
    parentKey: parent,
    boundarySeq: 0,
    creationId: 'create-child',
    kind: 'spawn',
    rootTaskId: parent,
    runtimeOwnerSessionKey: parent,
    generationDepth: 1,
    generationLimit: 2,
    maxFanOut: 4,
    inputHash: 'input',
    inputText: 'work',
    cwd: '/work',
    actorId: 'actor',
    isolation: 'shared',
    workspaceId: 'workspace',
    treeCapMicro: 10_000_000n,
    childCapMicro: null,
    writerRunId: owner,
  })
  if (child.status !== 'created') throw new Error('child fixture creation failed')
  const { creationId, attemptId, creationRevision } = child.record
  await storage.commitCreatingChild({
    childKey: key,
    creationId,
    attemptId,
    expectedRevision: creationRevision,
  })
  const stream = new ChildEventStream(storage, { clock: clock.read })
  await stream.publishStateTransition(child.record)
  const emitter = new ChildHeartbeatEmitter(stream)
  const watchdog = new ChildLeaseWatchdog(stream)
  const move = async (state: ChildExecutionState) => {
    const record = await storage.lookupByKey(key)
    if (!record) throw new Error('child disappeared')
    expect(await stream.transition(key, record.stateRevision, state, { maxFanOut: 4 })).toBe(true)
  }
  return { stream, storage, clock, emitter, watchdog, move }
}

async function collect(source: AsyncIterable<ChildAgentEvent>) {
  const events: ChildAgentEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

async function take(reader: AsyncIterator<ChildAgentEvent>, count: number) {
  const events: ChildAgentEvent[] = []
  while (events.length < count) {
    const frame = await reader.next()
    expect(frame.done).toBeFalsy()
    events.push(providerFrame(frame.value))
  }
  return events
}

function names(events: ChildAgentEvent[]) {
  return events.map((e) => (e.type === 'status' ? e.status : e.type))
}

describe('normal_flow', () => {
  it('delivers live beats between durable transitions including short approval waits', async () => {
    const { stream, storage, clock, emitter } = await setup()
    const release = observeChildTransitions(stream, key)
    const reader = stream.subscribe(key)[Symbol.asyncIterator]()
    const heartbeats: ChildAgentEvent[] = []
    const stop = stream.listen(key, (e) => {
      if (e.type === 'heartbeat') heartbeats.push(e)
    })
    const frames = take(reader, 8)
    try {
      const move = async (state: ChildExecutionState) => {
        const record = await storage.lookupByKey(key)
        if (!record) throw new Error('child disappeared')
        expect(await storage.casState(key, record.stateRevision, state)).toBe(true)
      }
      await move('running')
      for (let i = 0; i < 3; i++) {
        clock.advance(5_000)
        expect(await emitter.beat(key, owner)).toBe(true)
      }
      const lease = await storage.lookupChildLease(key)
      if (!lease) throw new Error('missing active lease')
      await stream.publishHeartbeat(lease)
      expect(heartbeats).toHaveLength(3)
      await move('waiting_approval')
      await move('running')
      await move('completed')
      expect(names(await frames)).toEqual([
        'starting',
        'running',
        'heartbeat',
        'heartbeat',
        'heartbeat',
        'waiting_approval',
        'running',
        'completed',
      ])
      expect((await storage.scanChildEvents(key)).events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
      expect(await storage.listChildLeasesByParent(parent)).toMatchObject([
        { heartbeatSeq: 3, leaseUntil: clock.now + 15_000 },
      ])
      expect(await emitter.beat(key, owner)).toBe(false)
    } finally {
      stop()
      release()
      await reader.return?.()
    }
  })

  it('runs the factory heartbeat and parent watchdog on the injected clock and releases both timers', async () => {
    const { storage, clock, move } = await setup()
    const fixture = (id: string) => {
      const closed = new Set<() => void>()
      const session = {
        key: id,
        writerRunId: owner,
        onClosed: (cb: () => void) => closed.add(cb),
        preset: { maxFanOut: 4 },
        d: { log: { storage, leaseRemainingMs: () => 1000 }, clock: clock.read, logger: { warn: vi.fn() } },
      } as unknown as SessionImpl
      return {
        session,
        close: () => {
          for (const cb of closed) cb()
        },
      }
    }
    const p = fixture(parent),
      c = fixture(key)
    vi.useFakeTimers()
    try {
      await move('running')
      await attachChildHeartbeat(p.session, c.session)
      clock.advance(5000)
      await vi.advanceTimersByTimeAsync(5000)
      expect(await storage.lookupChildLease(key)).toMatchObject({ heartbeatSeq: 2 })
      c.close()
      clock.advance(15_001)
      await vi.advanceTimersByTimeAsync(2500)
      expect((await storage.lookupByKey(key))?.state).toBe('disconnected')
      const protectedKey = await protectChildLeases(p.session, (k) => k === 'opening')
      expect([key, 'opening', 'other'].map(protectedKey)).toEqual([true, true, false])
      p.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      c.close()
      p.close()
      vi.useRealTimers()
    }
  })
  it('forwards durable cursors and live frames through the in-process handle and closes its readers', async () => {
    const { stream, move, emitter } = await setup()
    const backend = {
      childEvents: stream,
      list: async () => [{ id: key, status: 'running', continuable: true, providerId: 'in-process' }],
      startResident: async () => ({ id: key }),
      onTurn: () => () => {},
      completion: () => new Promise(() => {}),
      cancel: async () => {},
    } as unknown as InProcessChildBackend
    const provider = inProcessChildAgentProvider(() => backend)
    const handle = await provider.start('work', {
      sessionKey: parent,
      cwd: '/work',
      signal: new AbortController().signal,
    })
    const reader = handle.events({ afterSeq: 1 })[Symbol.asyncIterator]()
    const frames = take(reader, 3)
    await move('running')
    await emitter.beat(key, owner)
    await move('waiting_approval')
    expect(names(await frames)).toEqual(['running', 'heartbeat', 'waiting_approval'])
    expect(await provider.list?.(parent)).toMatchObject([
      { status: 'waiting_approval', lastHeartbeatAt: 100, leaseUntil: 15100 },
    ])
    await handle.dispose()
    expect((await reader.next()).done).toBe(true)
    expect(names(await collect(handle.events({ afterSeq: 2 })))).toEqual(['waiting_approval'])
  })
})

describe('missed_heartbeat', () => {
  it.each(['running', 'waiting_approval', 'ready'] as const)(
    'recovers %s only after strict expiry and a valid owner',
    async (state) => {
      const { emitter, watchdog, storage, clock, move } = await setup()
      await move(state)
      await emitter.beat(key, owner)
      clock.advance(12_000)
      await watchdog.sweep(parent)
      await emitter.beat(key, owner)
      clock.advance(15_000)
      await watchdog.sweep(parent)
      expect((await storage.lookupByKey(key))?.state).toBe(state)
      clock.advance(1)
      await Promise.all([watchdog.sweep(parent), watchdog.sweep(parent)])
      expect((await storage.lookupByKey(key))?.state).toBe('disconnected')
      expect(await emitter.beat(key, 'wrong-writer')).toBe(false)
      expect(await emitter.beat(key, owner)).toBe(true)
      const resume = state === 'ready' ? 'running' : state
      expect((await storage.lookupByKey(key))?.state).toBe(resume)
      expect((await storage.scanChildEvents(key)).events.map((e) => e.state)).toEqual([
        'creating',
        state,
        'disconnected',
        resume,
      ])
      expect(await storage.lookupChildLease(key)).toMatchObject({ heartbeatSeq: 3, missedCount: 0 })
    },
  )
  it('accepts only a fresh, ordered status from the lease owner when recovering', async () => {
    const { emitter, watchdog, storage, clock, move } = await setup()
    await move('running')
    await emitter.beat(key, owner)
    clock.advance(15_001)
    await watchdog.sweep(parent)
    const event = {
      childKey: key,
      kind: 'status' as const,
      state: 'waiting_approval' as const,
      seq: 4,
      eventId: 'approval',
      ts: clock.now,
    }
    expect(await emitter.reportStatus(event, 'wrong-owner')).toBe(false)
    expect(await emitter.reportStatus({ ...event, seq: 2 }, owner)).toBe(false)
    expect((await storage.lookupByKey(key))?.state).toBe('disconnected')
    expect(await emitter.reportStatus(event, owner)).toBe(true)
    expect(await emitter.reportStatus(event, owner)).toBe(false)
    expect((await storage.lookupByKey(key))?.state).toBe('waiting_approval')
    expect(await storage.scanChildEvents(key, { afterSeq: 3 })).toMatchObject({
      highWaterSeq: 4,
      droppedOutOfOrder: 1,
      events: [{ eventId: 'approval', payload: { recoveredFrom: 'disconnected' } }],
    })
  })
  it.each(['paused', 'idle', 'cancelled', 'completed', 'failed'] as const)(
    'exempts %s from expiry and revival',
    async (state) => {
      const { emitter, watchdog, storage, clock, move } = await setup()
      await move('running')
      await emitter.beat(key, owner)
      await move(state)
      clock.advance(60_000)
      await watchdog.sweep(parent)
      expect(await emitter.beat(key, owner)).toBe(false)
      expect((await storage.lookupByKey(key))?.state).toBe(state)
    },
  )
})

describe('reconnect_catchup', () => {
  it('repairs a missed live notification before delivering a cursorless beat to either reader', async () => {
    const { stream, storage, emitter, move } = await setup()
    const first = stream.subscribe(key, { afterSeq: 1 })[Symbol.asyncIterator]()
    const second = stream.subscribe(key, { afterSeq: 1 })[Symbol.asyncIterator]()
    const both = Promise.all([take(first, 3), take(second, 3)])
    await storage.appendChildEvent({ childKey: key, eventId: 'external', ts: 100, kind: 'lifecycle' })
    await move('running')
    await emitter.beat(key, owner)
    for (const frames of await both) {
      expect(names(frames)).toEqual(['envelope', 'running', 'heartbeat'])
      expect(frames[0]).toMatchObject({ envelope: { eventId: 'external', seq: 2 } })
      expect(frames[1]).toMatchObject({ seq: 3 })
    }
    await first.return?.()
    await move('waiting_approval')
    const reconnect = stream.subscribe(key, { afterSeq: 3 })[Symbol.asyncIterator]()
    expect(await take(reconnect, 1)).toEqual(await take(second, 1))
    await reconnect.return?.()
    const blocked = second.next()
    await second.return?.()
    expect((await blocked).done).toBe(true)
  })
  it('holds cursorless notifications while a gap repair is in flight', async () => {
    const scanning = deferred<void>()
    const repair = deferred<ChildAgentEvent[]>()
    const bus = new ChildEventBus({
      snapshot: async () => [],
      scan: async () => {
        scanning.resolve()
        return repair.promise
      },
    })
    const reader = bus.subscribe({ afterSeq: 1 })[Symbol.asyncIterator]()
    const received = take(reader, 3)
    bus.notify({ type: 'status', status: 'paused', seq: 3 })
    await scanning.promise
    bus.notify({ type: 'heartbeat', ts: 100, leaseUntil: 15100 })
    repair.resolve([{ type: 'status', status: 'running', seq: 2 }])
    expect(names(await received)).toEqual(['running', 'paused', 'heartbeat'])
    await reader.return?.()
  })
  it('reports a permanently missing cursor and allows a fresh snapshot at the retention floor', async () => {
    const bus = new ChildEventBus({ scan: async () => [{ type: 'status', status: 'running', seq: 11 }] })
    await expect(bus.subscribe({ afterSeq: 3 })[Symbol.asyncIterator]().next()).rejects.toThrow('gap after 3')
    const reader = bus.subscribe()[Symbol.asyncIterator]()
    expect(await take(reader, 1)).toMatchObject([{ seq: 11 }])
    await reader.return?.()
  })
})

describe('duplicate_delivery', () => {
  it('assigns one journal sequence and isolates throwing and rejecting listeners', async () => {
    const storage = new MemoryStorage()
    const warn = vi.fn()
    const stream = new ChildEventStream(storage, { onDiagnostic: warn })
    const seen: ChildAgentEvent[] = []
    stream.listen(key, () => {
      throw new Error('bad listener')
    })
    stream.listen(key, async () => {
      throw new Error('bad async listener')
    })
    stream.listen(key, (e) => seen.push(e))
    const event: AppendChildEventInput = { childKey: key, kind: 'lifecycle', eventId: 'e1', ts: 100 }
    const results = await Promise.all([event, event, event].map((e) => stream.publishEvent(e)))
    expect(results.map((r) => r.accepted)).toEqual([true, false, false])
    expect(seen).toMatchObject([{ envelope: { seq: 1 } }])
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['listener_error', 'listener_error'])
    expect((await storage.scanChildEvents(key)).highWaterSeq).toBe(1)
  })
  it('gives each legacy queue reader its own replay and settles once', async () => {
    const queue = createChildEventQueue()
    for (let i = 0; i < 3; i++) queue.push({ type: 'status', status: 'running', eventId: 'same' })
    queue.push({ type: 'status', status: 'completed', eventId: 'end' })
    queue.settle({ status: 'completed', text: 'ok' })
    queue.fail(new Error('late'))
    expect(await collect(queue.events())).toEqual(await collect(queue.events()))
    expect(names(await collect(queue.events()))).toEqual(['running', 'completed'])
    expect(await queue.result).toEqual({ status: 'completed', text: 'ok' })
  })
})

describe('out_of_order', () => {
  it.each(['completed', 'cancelled', 'failed'] as const)(
    'audits stale cursors and fences %s after restart',
    async (state) => {
      const storage = new MemoryStorage()
      const warn = vi.fn()
      const options = { onDiagnostic: warn, clock: () => 100 }
      const stream = new ChildEventStream(storage, options)
      await stream.publishStateTransition({ childKey: key, state: 'running', stateRevision: 1 })
      await stream.publishStateTransition({ childKey: key, state, stateRevision: 2 })
      const restarted = new ChildEventStream(storage, options)
      const stale: AppendChildEventInput = {
        childKey: key,
        state: 'running',
        status: 'running',
        kind: 'status',
        seq: 1,
        eventId: 'late',
        ts: 100,
      }
      expect(await restarted.publishEvent(stale)).toMatchObject({ outOfOrder: true })
      expect(
        await restarted.publishStateTransition({ childKey: key, state: 'running', stateRevision: 3 }),
      ).toMatchObject({ terminalLocked: true })
      expect(warn).toHaveBeenCalledWith('out_of_order', expect.objectContaining({ eventId: 'late' }))
      expect(await storage.scanChildEvents(key)).toMatchObject({ droppedOutOfOrder: 1, highWaterSeq: 2 })
    },
  )
  it('enforces the same identity, high-water and terminal rules on the memory bus', () => {
    const warn = vi.fn()
    const bus = new ChildEventBus({ onDiagnostic: warn })
    expect(bus.push({ type: 'status', status: 'failed', seq: 1, eventId: 'end' })).toBe(true)
    expect(bus.push({ type: 'status', status: 'failed', seq: 1, eventId: 'end' })).toBe(false)
    expect(bus.push({ type: 'status', status: 'running', seq: 1, eventId: 'late' })).toBe(false)
    expect(bus.push({ type: 'status', status: 'running' })).toBe(false)
    expect(bus.push({ type: 'heartbeat', ts: 100, leaseUntil: 15100 })).toBe(false)
    expect(bus.droppedOutOfOrder).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('process_restart', () => {
  it('repairs a crash between a successful state CAS and its journal write on the next beat', async () => {
    const { storage, emitter, watchdog, clock, move } = await setup()
    await move('waiting_approval')
    await emitter.beat(key, owner)
    clock.advance(15_001)
    vi.spyOn(storage, 'appendChildEvent').mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(watchdog.sweep(parent)).rejects.toThrow('journal unavailable')
    expect((await storage.lookupByKey(key))?.state).toBe('disconnected')
    await emitter.beat(key, owner)
    expect((await storage.scanChildEvents(key)).events.map((e) => e.state)).toEqual([
      'creating',
      'waiting_approval',
      'disconnected',
      'waiting_approval',
    ])
  })
  it.each(['memory', 'sqlite'])('restores leases and old cursors over %s storage', async (kind) => {
    const clock = new FakeClock()
    const dir = mkdtempSync(join(tmpdir(), 'agh-child-heartbeat-'))
    const open = () => createSqliteStorage({ file: join(dir, 'ledger.sqlite'), clock: clock.read })
    let storage = kind === 'memory' ? new MemoryStorage({ clock: clock.read }) : open()
    try {
      const f = await setup(clock, storage)
      await f.move('waiting_approval')
      await f.emitter.beat(key, owner)
      const cursor = (await f.storage.scanChildEvents(key)).highWaterSeq
      await storage.close()
      if (kind === 'sqlite') storage = open()
      if (!supportsChildEvents(storage)) throw new Error('missing child event store')
      const fresh = new ChildEventStream(storage, { clock: clock.read })
      const watchdog = new ChildLeaseWatchdog(fresh)
      expect(await watchdog.recoverChildLeases(parent, clock.now)).toContain(key)
      expect((await storage.lookupByKey(key))?.state).toBe('waiting_approval')
      const tail = fresh.subscribe(key, { afterSeq: cursor })[Symbol.asyncIterator]()
      expect(await take(tail, 1)).toMatchObject([{ type: 'heartbeat', ts: clock.now }])
      await tail.return?.()
      clock.advance(15_001)
      await watchdog.recoverChildLeases(parent, clock.now)
      expect(await storage.listLostChildren?.(parent)).toEqual([])
      expect(await storage.lookupChildLease(key)).toMatchObject({
        ownerRunId: owner,
        disconnectedAt: clock.now,
      })
      await new ChildHeartbeatEmitter(fresh).beat(key, owner)
      const reader = fresh.subscribe(key, { afterSeq: cursor })[Symbol.asyncIterator]()
      expect(names(await take(reader, 2))).toEqual(['disconnected', 'waiting_approval'])
      await reader.return?.()
      expect((await storage.scanChildEvents(key)).events.map((e) => e.kind)).toEqual(Array(4).fill('status'))
    } finally {
      await storage.close()
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
