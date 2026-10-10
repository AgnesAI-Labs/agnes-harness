import type { Context } from '@agnes/cordis'
import type { ToolResult } from '@agnes/extension-api'
import { providerSource } from '@agnes/host-common/assemble/provider-registry'
import { isHostError } from '@agnes/host-common/errors'
import type {
  DeferredActor,
  DeferredInvocationProducer,
  DeferredInvocationReceipt,
  DeferredInvocationState,
  DeferredJson,
  DeferredToolInvocation,
  DeferredToolInvocationQueue,
} from '@agnes/plugin-runtime/deferred-contract'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { type Actor, type EventEnvelope, type JsonValue, jcs } from '@agnes/protocol'

export const DEFERRED_INVOCATION_EVENT = 'x/agnes/deferred-invocations/state'
export const DEFERRED_NOTIFICATION_EVENT = 'x/agnes/deferred-invocations/notified'
const FOREIGN = 'Deferred invocation belongs to another producer'
const terminal = (state: DeferredInvocationState) => state === 'succeeded' || state === 'failed'
const json = (value: unknown): JsonValue => JSON.parse(jcs(value))

/** Host-owned durable ports. The scan includes only this lane's trusted invocation facts. */
export interface DeferredInvocationLedgerPort {
  scan(): Promise<readonly EventEnvelope[]>
  append(type: string, data: DeferredJson, actor: Actor, sourceSeq?: number): Promise<number>
  outcome(
    id: string,
  ): Promise<{ resultSeq?: number; toolCallSeq?: number; approvalId?: string; result?: ToolResult }>
  wake(id: string, actor: Actor, signal: AbortSignal): Promise<void>
}

export type DeferredProducerLookup = (
  source: string,
  signal: AbortSignal,
) => DeferredInvocationProducer | undefined | Promise<DeferredInvocationProducer | undefined>

/** Admitted producer identity. The actor and source come from the host, not the invocation body. */
export interface DeferredOwnerAdmission {
  readonly owner: string
  readonly actor: DeferredActor
  confirmSource(seq: number, source: string, signal: AbortSignal): Promise<void>
}

interface DeferredDispatcherQueue extends DeferredToolInvocationQueue {
  /** Acknowledges one owner's receipts. Another owner's notification stays pending. */
  notifyOwner(owner: string, signal: AbortSignal): Promise<void>
}

/** Ledger is the queue and the dedupe index. The in-memory tail is only admission serialization. */
export function createDeferredInvocationQueue(
  sessionKey: string,
  lane: string,
  ports: DeferredInvocationLedgerPort,
  producer: DeferredProducerLookup,
): DeferredDispatcherQueue {
  let tail = Promise.resolve()
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  async function records() {
    const states = new Map<string, DeferredInvocationReceipt>()
    const notified = new Set<number>()
    for (const row of await ports.scan()) {
      if (row.origin !== 'system' || row.trust !== 'trusted' || row.lane !== lane) continue
      if (row.type === DEFERRED_NOTIFICATION_EVENT) {
        notified.add((row.data as { receiptSeq: number }).receiptSeq)
        continue
      }
      if (row.type !== DEFERRED_INVOCATION_EVENT) continue
      const data = row.data as unknown as Omit<DeferredInvocationReceipt, 'seq'> & { previousSeq?: number }
      const call = data.invocation
      const previous = states.get(call?.id)
      if (
        !call ||
        call.sessionKey !== sessionKey ||
        call.lane !== lane ||
        (previous
          ? data.previousSeq !== previous.seq || jcs(call) !== jcs(previous.invocation)
          : data.state !== 'queued')
      )
        throw new Error('Deferred invocation ledger chain is corrupt')
      if (previous && terminal(previous.state))
        throw new Error('Terminal deferred invocation cannot be reset')
      states.set(call.id, { ...data, seq: row.seq })
    }
    return { states, notified }
  }
  async function hydrate(value: DeferredInvocationReceipt): Promise<DeferredInvocationReceipt> {
    return { ...value, ...(await ports.outcome(value.invocation.id)) }
  }
  const queue: DeferredDispatcherQueue = {
    sessionKey,
    lane,
    enqueue: (input, signal) =>
      serialized(async () => {
        signal.throwIfAborted()
        const call = structuredClone(input)
        if (
          call.sessionKey !== sessionKey ||
          call.lane !== lane ||
          !call.id ||
          call.id.length > 256 ||
          !call.tool ||
          call.tool.length > 128 ||
          !Number.isSafeInteger(call.sourceSeq) ||
          call.sourceSeq < 1 ||
          new TextEncoder().encode(jcs(call)).byteLength > 32768
        )
          throw new Error('Invalid deferred tool invocation')
        const { states } = await records()
        const old = states.get(call.id)
        if (old) {
          if (jcs(old.invocation) !== jcs(call))
            throw new Error('Deferred invocation id conflicts with its original binding')
          if (!terminal(old.state)) await ports.wake(call.id, call.actor, signal)
          return hydrate(old)
        }
        const owner = await producer(call.source, signal)
        if (!owner) throw new Error('Deferred invocation producer is unavailable')
        if ([...states.values()].filter((item) => !terminal(item.state)).length >= 8)
          throw new Error('Deferred invocation queue is full')
        await owner.validate(call, signal)
        signal.throwIfAborted()
        const seq = await ports.append(
          DEFERRED_INVOCATION_EVENT,
          json({ invocation: call, state: 'queued' }),
          call.actor,
          call.sourceSeq,
        )
        // A failed wake leaves recoverable queued work; re-enqueue uses the original durable binding.
        await ports.wake(call.id, call.actor, signal)
        return { invocation: call, state: 'queued', seq }
      }),
    async next(signal) {
      signal.throwIfAborted()
      const next = [...(await records()).states.values()].find((item) => !terminal(item.state))
      return next ? hydrate(next) : null
    },
    async read(id, signal) {
      signal.throwIfAborted()
      const found = (await records()).states.get(id)
      return found ? hydrate(found) : null
    },
    transition: (id, expectedSeq, state, outcome = {}) =>
      serialized(async () => {
        const old = (await records()).states.get(id)
        if (!old || old.seq !== expectedSeq || terminal(old.state))
          throw new Error('Deferred invocation transition is stale')
        const allowed: Record<DeferredInvocationState, readonly DeferredInvocationState[]> = {
          queued: ['executing', 'failed'],
          executing: ['pending-approval', 'succeeded', 'failed'],
          'pending-approval': ['executing', 'succeeded', 'failed'],
          succeeded: [],
          failed: [],
        }
        if (!allowed[old.state].includes(state)) throw new Error('Invalid deferred invocation transition')
        const original = await ports.outcome(id)
        if (state === 'pending-approval' && !original.approvalId)
          throw new Error('Deferred approval is missing its original ticket')
        if (state === 'succeeded' && !original.resultSeq)
          throw new Error('Deferred success is missing its original tool receipt')
        const data = {
          invocation: old.invocation,
          state,
          previousSeq: old.seq,
          ...(original.resultSeq ? { resultSeq: original.resultSeq } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        }
        const seq = await ports.append(DEFERRED_INVOCATION_EVENT, json(data), old.invocation.actor, old.seq)
        return { ...data, ...original, ...(outcome.result ? { result: outcome.result } : {}), seq }
      }),
    async notify(signal) {
      await deliver(undefined, signal)
    },
    async notifyOwner(owner, signal) {
      await deliver(owner, signal)
    },
  }
  async function deliver(source: string | undefined, signal: AbortSignal) {
    const { states, notified } = await records()
    for (const receipt of states.values()) {
      signal.throwIfAborted()
      if (source !== undefined && receipt.invocation.source !== source) continue
      if (notified.has(receipt.seq)) continue
      const owner = await producer(receipt.invocation.source, signal)
      if (!owner) throw new Error('Deferred invocation producer is unavailable during recovery')
      await owner.changed(await hydrate(receipt), signal)
      await ports.append(
        DEFERRED_NOTIFICATION_EVENT,
        { id: receipt.invocation.id, receiptSeq: receipt.seq },
        receipt.invocation.actor,
        receipt.seq,
      )
    }
  }
  return queue
}

/**
 * Producer view of one shared lane queue. The caller sees and moves only its own invocations.
 * Its notification acknowledges only those receipts, so one producer cannot clear another owner's delivery.
 */
export function ownerDeferredQueue(
  queue: DeferredDispatcherQueue,
  admission: DeferredOwnerAdmission,
): DeferredToolInvocationQueue {
  const signal = () => new AbortController().signal
  return {
    sessionKey: queue.sessionKey,
    lane: queue.lane,
    async enqueue(invocation, admitted) {
      admitted.throwIfAborted()
      if (invocation.source !== admission.owner) throw new Error(FOREIGN)
      if (jcs(invocation.actor) !== jcs(admission.actor))
        throw new Error('Deferred invocation actor does not match its admission')
      // The first admission cites the source event. An identical durable binding stays idempotent.
      const existing = await queue.read(invocation.id, admitted)
      if (!existing || jcs(existing.invocation) !== jcs(invocation))
        await admission.confirmSource(invocation.sourceSeq, invocation.source, admitted)
      return queue.enqueue(invocation, admitted)
    },
    async next(admitted) {
      const found = await queue.next(admitted)
      if (found && found.invocation.source !== admission.owner) return null
      return found
    },
    async read(id, admitted) {
      const found = await queue.read(id, admitted)
      if (found && found.invocation.source !== admission.owner) throw new Error(FOREIGN)
      return found
    },
    async transition(id, expectedSeq, state, outcome) {
      const current = await queue.read(id, signal())
      if (!current) throw new Error('Deferred invocation transition is stale')
      if (current.invocation.source !== admission.owner) throw new Error(FOREIGN)
      if (outcome?.result && (!current.result || jcs(outcome.result) !== jcs(current.result)))
        throw new Error('Deferred invocation receipt does not match its durable result')
      return queue.transition(id, expectedSeq, state, outcome)
    },
    async notify(admitted) {
      admitted.throwIfAborted()
      await queue.notifyOwner(admission.owner, admitted)
    },
  }
}

export type DeferredProducerResolver = (
  source: string,
  sessionKey: string,
  lane: string,
  signal: AbortSignal,
) => Promise<DeferredInvocationProducer | undefined>

/**
 * Per-generation registry. Not a context service: a provided name is inherited by every plugin
 * in the tree, and the raw queue must stay with the host that constructed this registry.
 * A producer disappears only with its owning plugin row.
 */
export class DeferredInvocationsService {
  private readonly producers = new Map<string, DeferredInvocationProducer>()
  private readonly sessions = new Map<string, DeferredDispatcherQueue>()
  private resolver?: DeferredProducerResolver
  constructor(
    private readonly ownerContext: Context,
    private readonly origins?: RowOriginLookup,
  ) {}
  /** Opens a producer when this generation has no locally registered callback for that owner. */
  setProducerResolver(resolver: DeferredProducerResolver | undefined): void {
    this.resolver = resolver
  }
  register(producer: DeferredInvocationProducer): () => void {
    const source = this.admittedSource(producer.source)
    const admitted: DeferredInvocationProducer = { ...producer, source }
    if (this.producers.has(source)) throw new Error('Duplicate deferred invocation producer')
    this.producers.set(source, admitted)
    return () => {
      if (this.producers.get(source) === admitted) this.producers.delete(source)
    }
  }
  /** No plugin row: keep the host backend id. A verified row pins source to that package id. */
  private admittedSource(fallback: string): string {
    try {
      return providerSource(this.ownerContext, this.origins, fallback, true)
    } catch (error) {
      if (isHostError(error, 'E_EXT_LOAD') && error.message.includes('verified plugin row')) return fallback
      throw error
    }
  }
  bind(sessionKey: string, lane: string, ports: DeferredInvocationLedgerPort): () => void {
    const key = jcs([sessionKey, lane])
    if (this.sessions.has(key)) throw new Error('Deferred invocation session is already bound')
    const queue = createDeferredInvocationQueue(sessionKey, lane, ports, async (source, signal) => {
      const local = this.producers.get(source)
      if (local) return local
      return this.resolver?.(source, sessionKey, lane, signal)
    })
    this.sessions.set(key, queue)
    return () => {
      if (this.sessions.get(key) === queue) this.sessions.delete(key)
    }
  }
  /** Dispatcher view. A bound session queue remains readable after its producer unloads. */
  forSession(sessionKey: string, lane: string): DeferredDispatcherQueue | undefined {
    return this.sessions.get(jcs([sessionKey, lane]))
  }
  /** Producer view. Each owner can read and move only the invocations it admitted. */
  ownerFacade(
    sessionKey: string,
    lane: string,
    admission: DeferredOwnerAdmission,
  ): DeferredToolInvocationQueue | undefined {
    const queue = this.forSession(sessionKey, lane)
    return queue ? ownerDeferredQueue(queue, admission) : undefined
  }
}
