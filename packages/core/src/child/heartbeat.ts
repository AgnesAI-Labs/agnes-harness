import { presetDefaults } from '@agnes/core-common/step/preset'
import type { Timers } from '@agnes/core-ledger/log/session-log'
import type { ChildLeaseRecord, ChildTaskRecord } from '@agnes/extension-api'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import {
  type ChildEventStore,
  ChildEventStream,
  leasedState,
  type OwnerStatus,
  observeChildTransitions,
  recoveryState,
  supportsChildEvents,
} from './event-stream.js'

type Options = {
  clock?: () => number
  heartbeatIntervalMs?: number
  maxMissedBeforeDisconnect?: number
  leaseTtlMs?: number
  maxFanOut?: number
}

async function reconcileLeaseTransition(
  stream: ChildEventStream,
  record: ChildTaskRecord,
  lease: ChildLeaseRecord,
) {
  const disconnected = record.state === 'disconnected'
  if (disconnected === (lease.disconnectedAt !== undefined)) return
  const journal = await stream.store.scanChildEvents(record.childKey)
  const last = journal.events.findLast((e) => e.state)
  if (last?.state === record.state) return
  if (disconnected) {
    await stream.publishStateTransition(record, {
      reason: 'lease_expired',
      previousState: last?.state ?? 'running',
      lastHeartbeatAt: lease.lastHeartbeatAt,
      leaseUntil: lease.leaseUntil,
    })
  } else if (leasedState(record.state) && last?.state === 'disconnected') {
    await stream.publishStateTransition(record, { recoveredFrom: 'disconnected' })
  }
}

export class ChildHeartbeatEmitter {
  readonly heartbeatIntervalMs: number
  readonly leaseTtlMs: number
  private readonly clock: () => number
  private readonly maxFanOut: number

  constructor(
    private readonly stream: ChildEventStream,
    options: Options = {},
  ) {
    this.clock = options.clock ?? stream.clock
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
    this.leaseTtlMs =
      options.leaseTtlMs ?? this.heartbeatIntervalMs * (options.maxMissedBeforeDisconnect ?? 3)
    this.maxFanOut = options.maxFanOut ?? presetDefaults().maxFanOut
    if (![this.heartbeatIntervalMs, this.leaseTtlMs].every((ms) => Number.isSafeInteger(ms) && ms > 0))
      throw new RangeError('invalid child heartbeat interval')
  }

  beat(childKey: string, ownerRunId: string, status?: 'running' | 'waiting_approval') {
    return this.stream.leaseLock.run(childKey, () => this.refresh(childKey, ownerRunId, false, status))
  }

  reportStatus(event: OwnerStatus, ownerRunId: string) {
    return this.stream.leaseLock.run(event.childKey, async () => {
      if (!(await this.stream.acceptOwnerStatus(event, ownerRunId, this.maxFanOut))) return false
      return this.refresh(event.childKey, ownerRunId, false)
    })
  }

  observe(childKey: string, ownerRunId: string) {
    return observeChildTransitions(this.stream, childKey, async () => {
      const lease = await this.stream.store.lookupChildLease(childKey)
      if (!lease || lease.leaseUntil < this.clock()) await this.refresh(childKey, ownerRunId, false)
    })
  }

  /** Only the newly opened child writer may take over a prior process's lease. */
  attachWriter(childKey: string, ownerRunId: string) {
    return this.stream.leaseLock.run(childKey, () => this.refresh(childKey, ownerRunId, true))
  }

  private async refresh(
    childKey: string,
    ownerRunId: string,
    takeover: boolean,
    status?: 'running' | 'waiting_approval',
  ) {
    const { store } = this.stream
    const record = await store.lookupByKey(childKey)
    if (
      !ownerRunId ||
      !record ||
      !(
        leasedState(record.state) ||
        record.state === 'disconnected' ||
        (takeover && ['creating', 'idle', 'paused', 'interrupted', 'recovery_pending'].includes(record.state))
      )
    )
      return false
    const previous = await store.lookupChildLease(childKey)
    if (previous && !takeover && previous.ownerRunId !== ownerRunId) return false
    const now = this.clock()
    if (previous && now < previous.lastHeartbeatAt) return false
    if (previous) await reconcileLeaseTransition(this.stream, { ...record }, previous)
    if (record.state === 'disconnected') {
      if (!previous) return false
      const resume = status ?? recoveryState((await store.scanChildEvents(childKey)).events)
      if (
        !(await this.stream.transition(
          childKey,
          record.stateRevision,
          resume,
          { maxFanOut: this.maxFanOut },
          {
            recoveredFrom: 'disconnected',
          },
        ))
      )
        return false
    }
    const lease = {
      childKey,
      parentKey: record.parentKey,
      ownerRunId,
      lastHeartbeatAt: now,
      leaseUntil: now + this.leaseTtlMs,
      heartbeatSeq: (previous?.heartbeatSeq ?? 0) + 1,
      missedCount: 0,
    }
    await store.upsertChildLease(lease)
    await this.stream.publishHeartbeat(lease)
    return true
  }
}

export class ChildLeaseWatchdog {
  constructor(
    private readonly stream: ChildEventStream,
    private readonly clock = stream.clock,
  ) {}

  sweep(parentKey: string) {
    return this.recoverChildLeases(parentKey, this.clock())
  }

  async recoverChildLeases(parentKey: string, now: number) {
    const protectedKeys = new Set<string>()
    for (const { childKey } of await this.stream.store.listChildLeasesByParent(parentKey)) {
      await this.stream.leaseLock.run(childKey, async () => {
        const { store } = this.stream
        const lease = await store.lookupChildLease(childKey)
        const record = await store.lookupByKey(childKey)
        if (!lease || !record || record.parentKey !== parentKey) return
        // Paused/idle children consume no active lease and keep all of their context.
        if (record.state === 'paused' || record.state === 'idle') return
        if (!leasedState(record.state) && record.state !== 'disconnected') return
        protectedKeys.add(childKey)
        await reconcileLeaseTransition(this.stream, { ...record }, lease)
        if (now > lease.leaseUntil) await this.expire({ ...record }, lease, now)
      })
    }
    return protectedKeys
  }

  private async expire(record: ChildTaskRecord, lease: ChildLeaseRecord, now: number) {
    const payload = {
      reason: 'lease_expired',
      lastHeartbeatAt: lease.lastHeartbeatAt,
      leaseUntil: lease.leaseUntil,
      previousState: record.state,
    }
    if (record.state === 'disconnected') {
      if (lease.disconnectedAt !== undefined) return
    } else if (
      !(await this.stream.transition(
        record.childKey,
        record.stateRevision,
        'disconnected',
        undefined,
        payload,
      ))
    )
      return
    await this.stream.store.upsertChildLease({
      ...lease,
      disconnectedAt: now,
      missedCount: lease.missedCount + 1,
    })
  }
}

const timers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

function schedule(session: SessionImpl, interval: number, work: () => Promise<unknown>) {
  const timer = session.d.timers ?? timers
  let stopped = false
  let handle: unknown
  const tick = () => {
    if (!stopped)
      handle = timer.setTimeout(() => {
        if (!stopped) void work().catch(bestEffort(session.d.logger, 'child-heartbeat')).finally(tick)
      }, interval)
  }
  tick()
  return () => {
    stopped = true
    timer.clearTimeout(handle)
  }
}

const streams = new WeakMap<ChildEventStore, ChildEventStream>()
const watchdogs = new WeakMap<SessionImpl, ChildLeaseWatchdog>()

export function childEventStreamFor(parent: SessionImpl) {
  const store = parent.d.log.storage
  if (!supportsChildEvents(store)) return undefined
  const existing = streams.get(store)
  if (existing) return existing
  const stream = new ChildEventStream(store, {
    clock: parent.d.clock,
    onDiagnostic: (issue) => parent.d.logger.warn(`child events: ${issue}`),
  })
  streams.set(store, stream)
  return stream
}

function parentWatchdog(parent: SessionImpl, stream: ChildEventStream) {
  let watchdog = watchdogs.get(parent)
  if (!watchdog) {
    watchdog = new ChildLeaseWatchdog(stream, parent.d.clock)
    watchdogs.set(parent, watchdog)
    const current = watchdog
    parent.onClosed(schedule(parent, 2_500, () => current.sweep(parent.key)))
  }
  return watchdog
}

/** Wrap the legacy opening predicate before recoverChildren enters orphan settlement. */
export async function protectChildLeases(parent: SessionImpl, opening: (key: string) => boolean) {
  const stream = childEventStreamFor(parent)
  if (!stream) return opening
  const leased = await new ChildLeaseWatchdog(stream).recoverChildLeases(parent.key, parent.d.clock())
  if (leased.size) parentWatchdog(parent, stream)
  return (key: string) => leased.has(key) || opening(key)
}

/** Called once a child session actually owns its writer, including a reopened writer. */
export async function attachChildHeartbeat(parent: SessionImpl, child: SessionImpl) {
  const stream = childEventStreamFor(parent)
  if (!stream) return
  const record = await stream.store.lookupByKey(child.key)
  if (!record || record.parentKey !== parent.key) return
  const emitter = new ChildHeartbeatEmitter(stream, {
    clock: child.d.clock,
    maxFanOut: parent.preset.maxFanOut,
  })
  const release = emitter.observe(child.key, child.writerRunId)
  try {
    await stream.publishStateTransition({ ...record })
    await emitter.attachWriter(child.key, child.writerRunId)
    if (child.closingOrClosed || parent.closingOrClosed) {
      release()
      return
    }
    parentWatchdog(parent, stream)
    const stop = schedule(child, emitter.heartbeatIntervalMs, async () => {
      if (!child.closingOrClosed && !child.d.log.faulted && child.d.log.leaseRemainingMs() > 0)
        await emitter.beat(child.key, child.writerRunId)
    })
    child.onClosed(() => {
      stop()
      release()
    })
  } catch (error) {
    release()
    throw error
  }
}
