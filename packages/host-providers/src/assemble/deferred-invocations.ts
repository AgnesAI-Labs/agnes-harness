import { type Context, Service } from '@agnes/cordis'
import type {
  DeferredInvocationLedgerPort,
  DeferredInvocationProducer,
  DeferredInvocationReceipt,
  DeferredInvocationRegistryPort,
  DeferredInvocationState,
  DeferredToolInvocation,
  DeferredToolInvocationQueue,
} from '@agnes/extension-api'
import { providerSource } from '@agnes/host-common/assemble/provider-registry'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { jcs, type JsonValue } from '@agnes/protocol'

export const DEFERRED_INVOCATION_EVENT = 'x/agnes/deferred-invocations/state'
export const DEFERRED_NOTIFICATION_EVENT = 'x/agnes/deferred-invocations/notified'
const terminal = (state: DeferredInvocationState) => state === 'succeeded' || state === 'failed'
const json = (value: unknown): JsonValue => JSON.parse(jcs(value))

/** Ledger is the queue and the dedupe index. The in-memory tail is only admission serialization. */
export function createDeferredInvocationQueue(
  sessionKey: string,
  lane: string,
  ports: DeferredInvocationLedgerPort,
  producer: (source: string) => DeferredInvocationProducer | undefined,
): DeferredToolInvocationQueue {
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
  const queue: DeferredToolInvocationQueue = {
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
        const owner = producer(call.source)
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
      const { states, notified } = await records()
      for (const receipt of states.values()) {
        signal.throwIfAborted()
        if (notified.has(receipt.seq)) continue
        const owner = producer(receipt.invocation.source)
        if (!owner) throw new Error('Deferred invocation producer is unavailable during recovery')
        await owner.changed(await hydrate(receipt), signal)
        await ports.append(
          DEFERRED_NOTIFICATION_EVENT,
          { id: receipt.invocation.id, receiptSeq: receipt.seq },
          receipt.invocation.actor,
          receipt.seq,
        )
      }
    },
  }
  return queue
}

declare module '@agnes/cordis' {
  interface Context {
    deferredInvocations: DeferredInvocationsService
  }
}
/** Per-generation registry. A producer disappears only with its owning plugin row. */
export class DeferredInvocationsService extends Service implements DeferredInvocationRegistryPort {
  private readonly producers = new Map<string, DeferredInvocationProducer>()
  private readonly sessions = new Map<string, DeferredToolInvocationQueue>()
  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'deferredInvocations')
  }
  register(producer: DeferredInvocationProducer): () => void {
    providerSource(this.ctx, this.origins, producer.source)
    if (this.producers.has(producer.source)) throw new Error('Duplicate deferred invocation producer')
    this.producers.set(producer.source, producer)
    return () => {
      if (this.producers.get(producer.source) === producer) this.producers.delete(producer.source)
    }
  }
  bind(sessionKey: string, lane: string, ports: DeferredInvocationLedgerPort): () => void {
    const key = jcs([sessionKey, lane])
    if (this.sessions.has(key)) throw new Error('Deferred invocation session is already bound')
    const queue = createDeferredInvocationQueue(sessionKey, lane, ports, (source) =>
      this.producers.get(source),
    )
    this.sessions.set(key, queue)
    return () => {
      if (this.sessions.get(key) === queue) this.sessions.delete(key)
    }
  }
  forSession(sessionKey: string, lane: string) {
    return this.producers.size ? this.sessions.get(jcs([sessionKey, lane])) : undefined
  }
}
