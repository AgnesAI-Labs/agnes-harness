import { ChildLock } from '@agnes/core-child-control/child/child-lock'
import { type ChildCursor, ChildEventBus, observeChildCas } from '@agnes/core-child-control/child/events'
import { projectChildStatus } from '@agnes/core-child-control/child/status-projection'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import type {
  AppendChildEventInput,
  AppendChildEventResult,
  ChildAgentEvent,
  ChildControlStore,
  ChildEventEnvelope,
  ChildExecutionState,
  ChildLeaseRecord,
  ChildTaskRecord,
} from '@agnes/extension-api'

type EventMethods =
  | 'appendChildEvent'
  | 'scanChildEvents'
  | 'upsertChildLease'
  | 'lookupChildLease'
  | 'listChildLeasesByParent'
export type ChildEventStore = ChildControlStore & Required<Pick<ChildControlStore, EventMethods>>

export function supportsChildEvents(store: object): store is ChildEventStore {
  return [
    'casState',
    'lookupByKey',
    'appendChildEvent',
    'scanChildEvents',
    'upsertChildLease',
    'lookupChildLease',
    'listChildLeasesByParent',
  ].every((key) => typeof Reflect.get(store, key) === 'function')
}

type Options = { clock?: () => number; onDiagnostic?: (issue: string, detail: unknown) => unknown }
type Transition = Pick<ChildTaskRecord, 'childKey' | 'state' | 'stateRevision'>
function heartbeatEventId(lease: ChildLeaseRecord): string {
  return `hb:${encodeURIComponent(lease.childKey)}:${encodeURIComponent(lease.ownerRunId)}:${lease.heartbeatSeq}`
}
function heartbeatFrame(lease: ChildLeaseRecord): ChildAgentEvent {
  return {
    type: 'heartbeat',
    ts: lease.lastHeartbeatAt,
    leaseUntil: lease.leaseUntil,
    eventId: heartbeatEventId(lease),
  }
}
export type OwnerStatus = AppendChildEventInput & {
  kind: 'status'
  state: 'running' | 'waiting_approval'
  seq: number
}

function childPorts(store: ChildEventStore) {
  return {
    leaseLock: new ChildLock(),
    writes: new ChildLock(),
    channels: new Map<string, ChildEventBus>(),
    cas: store.casState.bind(store),
  }
}
const ports = new WeakMap<ChildEventStore, ReturnType<typeof childPorts>>()

/** The journal owns durable sequence numbers. Heartbeats carry lease time on a separate live channel. */
export class ChildEventStream {
  private readonly port: ReturnType<typeof childPorts>
  get leaseLock() {
    return this.port.leaseLock
  }
  readonly clock: () => number

  constructor(
    readonly store: ChildEventStore,
    private readonly options: Options = {},
  ) {
    this.clock = options.clock ?? Date.now
    this.port = ports.get(store) ?? childPorts(store)
    ports.set(store, this.port)
  }

  async snapshot(childKey: string, afterSeq: number) {
    const { events } = await this.store.scanChildEvents(childKey, { afterSeq })
    return events.map((envelope) => ({ type: 'envelope' as const, envelope }))
  }

  async latestHeartbeat(childKey: string) {
    const [record, lease] = await Promise.all([
      this.store.lookupByKey(childKey),
      this.store.lookupChildLease(childKey),
    ])
    return record && leasedState(record.state) && lease && lease.leaseUntil >= this.clock()
      ? heartbeatFrame(lease)
      : undefined
  }

  subscribe(childKey: string, cursor?: ChildCursor) {
    return new ChildEventBus({
      follow: (listener) => this.listen(childKey, listener),
      scan: (after) => this.snapshot(childKey, after),
      snapshot: async (after) => {
        const [events, heartbeat] = await Promise.all([
          this.snapshot(childKey, after),
          this.latestHeartbeat(childKey),
        ])
        return heartbeat ? [...events, heartbeat] : events
      },
    }).subscribe(cursor)
  }

  listen(childKey: string, listener: (frame: ChildAgentEvent) => unknown) {
    const channels = this.port.channels
    const bus = channels.get(childKey) ?? new ChildEventBus(this.options)
    channels.set(childKey, bus)
    const stop = bus.listen(listener)
    return () => {
      stop()
      if (!bus.observed && channels.get(childKey) === bus) channels.delete(childKey)
    }
  }

  async publishHeartbeat(lease: ChildLeaseRecord) {
    const channel = this.port.channels.get(lease.childKey)
    if (!channel) return
    const latest = await this.latestHeartbeat(lease.childKey)
    if (latest?.type === 'heartbeat' && latest.eventId === heartbeatEventId(lease)) channel.notify(latest)
  }

  /** Publish the revision won by the CAS, even if another writer has since advanced the task. */
  async transition(
    childKey: string,
    revision: number,
    state: ChildExecutionState,
    admission?: { maxFanOut: number },
    payload?: ChildEventEnvelope['payload'],
  ) {
    return this.port.writes.run(childKey, async () => {
      if (!(await this.port.cas(childKey, revision, state, admission))) return false
      await this.append(this.transitionEvent({ childKey, state, stateRevision: revision + 1 }, payload))
      return true
    })
  }

  publishStateTransition(record: Transition, payload?: ChildEventEnvelope['payload']) {
    return this.publishEvent(this.transitionEvent(record, payload))
  }

  private transitionEvent(
    record: Transition,
    payload?: ChildEventEnvelope['payload'],
  ): AppendChildEventInput {
    return {
      childKey: record.childKey,
      eventId: `state:${record.childKey}:${record.stateRevision}`,
      ts: this.clock(),
      kind: 'status',
      state: record.state,
      status: projectChildStatus(record).status,
      ...(payload ? { payload } : {}),
    }
  }

  publishEvent(event: AppendChildEventInput): Promise<AppendChildEventResult> {
    if (event.kind === 'heartbeat') throw new TypeError('send live heartbeats through the lease emitter')
    if (event.kind === 'text') throw new TypeError('turn text belongs to the live handle')
    return this.port.writes.run(event.childKey, () => this.append(event))
  }

  /** Authenticate and order a writer's status before letting it change a disconnected task. */
  acceptOwnerStatus(event: OwnerStatus, owner: string, maxFanOut: number) {
    return this.port.writes.run(event.childKey, async () => {
      const lease = await this.store.lookupChildLease(event.childKey)
      if (!lease || lease.ownerRunId !== owner || event.ts < (lease.disconnectedAt ?? lease.lastHeartbeatAt))
        return false
      const refused = await this.refusal(event)
      if (refused) return false
      const task = await this.store.lookupByKey(event.childKey)
      if (!task || !(leasedState(task.state) || task.state === 'disconnected')) return false
      const recovered = task.state === 'disconnected'
      if (
        task.state !== event.state &&
        !(await this.port.cas(task.childKey, task.stateRevision, event.state, { maxFanOut }))
      )
        return false
      return (
        await this.commit({
          ...event,
          status: event.state,
          ...(recovered ? { payload: { ...event.payload, recoveredFrom: 'disconnected' } } : {}),
        })
      ).accepted
    })
  }

  private async refusal(event: AppendChildEventInput): Promise<AppendChildEventResult | undefined> {
    const journal = await this.store.scanChildEvents(event.childKey)
    const existing = journal.events.find((row) => row.eventId === event.eventId)
    if (existing) return { accepted: false, duplicate: true, envelope: existing }
    if (event.seq === undefined || event.seq > journal.highWaterSeq) {
      const terminal = journal.events.find(
        (row) =>
          (row.state && isTerminalChildState(row.state)) ||
          row.status === 'completed' ||
          row.status === 'failed' ||
          row.status === 'cancelled',
      )
      if (terminal && (event.state || event.status))
        return { accepted: false, terminalLocked: true, envelope: terminal }
      if (event.seq !== undefined && event.seq > journal.highWaterSeq + 1)
        throw new RangeError(`child event gap after ${journal.highWaterSeq}, received ${event.seq}`)
    }
    if (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq <= journal.highWaterSeq))
      return this.commit(event)
    return undefined
  }

  private async append(event: AppendChildEventInput) {
    return (await this.refusal(event)) ?? this.commit(event)
  }

  private async commit(event: AppendChildEventInput) {
    const result = await this.store.appendChildEvent(event)
    if (result.accepted)
      this.port.channels.get(event.childKey)?.notify({ type: 'envelope', envelope: result.envelope })
    if (result.outOfOrder) {
      try {
        void Promise.resolve(this.options.onDiagnostic?.('out_of_order', result.envelope)).catch(() => {})
      } catch {
        /* A diagnostic sink cannot change the rejection. */
      }
    }
    return result
  }
}

export function recoveryState(events: readonly ChildEventEnvelope[]): 'running' | 'waiting_approval' {
  const last = events.findLast((event) => event.state === 'disconnected')
  return last?.payload?.previousState === 'waiting_approval' ? 'waiting_approval' : 'running'
}

export const leasedState = (state: ChildExecutionState) =>
  state === 'ready' || state === 'running' || state === 'waiting_approval'

export function observeChildTransitions(
  stream: ChildEventStream,
  childKey: string,
  onActive?: () => Promise<void>,
) {
  return observeChildCas(stream.store, childKey, (key, revision, next, admission) =>
    stream.leaseLock.run(key, async () => {
      const won = await stream.transition(key, revision, next, admission)
      if (won && leasedState(next)) await onActive?.()
      return won
    }),
  )
}
