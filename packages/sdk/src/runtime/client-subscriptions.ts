// Runtime subscriptions over the client wire. Frames are pushed on the transport's socket while it
// is open and polled over HTTP otherwise; either way a subscription delivers only its own frames,
// in arrival order, never merged or reordered. A consumer that falls behind the protocol's reader
// queue bound loses the subscription rather than memory, and subscribes again.
import { jcs } from '@agnes/protocol'
import {
  type ClientCallHeader,
  type ClientCloseSubscriptionResult,
  type ClientSubscribeRequest,
  type ClientSubscribeResult,
  type ClientSubscriptionFrame,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  type RuntimeError,
  utf8ByteLength,
  validateClientTransportFrame,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type CallResult,
  type PushEvent,
  type RuntimeClientTransport,
  readOutcome,
} from './client-transport.js'

const { routes } = RuntimeClientTransportWire
const { maxReaderQueueFrames, maxReaderQueueBytes } = RuntimeClientTransportPolicy

export type SubscribeRequest = ClientSubscribeRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'header'>
    : never
  : never
export type SubscriptionEnd =
  | { reason: 'error'; error: RuntimeError }
  | { reason: 'end' | 'overflow' | 'resync-required' | 'session-replaced' | 'closed' | 'unknown' }
export type RuntimeSubscription = {
  readonly subscriptionId: string
  readonly topic: ClientSubscriptionFrame['topic']
  /** The initial frame of the subscribe result. */
  readonly first: ClientSubscriptionFrame
  /** Single-use; every later frame in arrival order. Leaving the loop early closes the subscription. */
  readonly frames: AsyncIterable<ClientSubscriptionFrame>
  /** An end or error frame is delivered first; any other reason drops what was not yet delivered. */
  readonly ended: Promise<SubscriptionEnd>
  /** Ends locally at once and closes the subscription on the server; later calls share the first. */
  close(): Promise<CallResult<ClientCloseSubscriptionResult>>
}

const terminal = (frame: ClientSubscriptionFrame): SubscriptionEnd | null =>
  frame.kind === 'end'
    ? { reason: 'end' }
    : frame.kind === 'error'
      ? { reason: 'error', error: frame.payload }
      : null

/** Checked as if pushed under `header`, so an error payload must carry a registered classification. */
const valid = (header: ClientCallHeader, frame: unknown) =>
  validateClientTransportFrame(header, { kind: 'subscription', header, frame }).ok

export function subscriptions(transport: RuntimeClientTransport, options: { pollIntervalMs?: number } = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const refused = () =>
    ({
      state: 'refused',
      reason: transport.mode === 'incompatible' ? 'incompatible' : 'disconnected',
    }) as const
  const exchange = async (path: string, request: unknown, signal?: AbortSignal) => {
    try {
      return await readOutcome(await transport.post(path, request, signal))
    } catch {
      return null
    }
  }

  async function closeRemote(subscriptionId: string): Promise<CallResult<ClientCloseSubscriptionResult>> {
    const header = transport.header()
    if (!header) return refused()
    const outcome = await exchange(routes.closeSubscription.path, { header, subscriptionId })
    if (!outcome) return { state: 'unknown', reason: 'no reply' }
    if (!outcome.ok) return { state: 'failed', error: outcome.error }
    const result = validateRuntime('ClientCloseSubscriptionResult', outcome.value)
    return result.ok ? { state: 'ok', value: result.value } : { state: 'unknown', reason: 'invalid reply' }
  }

  function open(result: ClientSubscribeResult, held: ClientSubscriptionFrame[]): RuntimeSubscription {
    const { subscriptionId, topic, frame: first } = result
    let cursor = result.cursor
    const buffer: { frame: ClientSubscriptionFrame; bytes: number }[] = []
    let bytes = 0
    // An end or error frame is buffered: nothing after it is accepted.
    let final = false
    let end: SubscriptionEnd | null = null
    let settle: (value: SubscriptionEnd) => void = () => undefined
    const ended = new Promise<SubscriptionEnd>((resolve) => {
      settle = resolve
    })
    let wake: () => void = () => undefined
    let closing: Promise<CallResult<ClientCloseSubscriptionResult>> | undefined

    /** Resolves on the next event, or after `ms` when given. */
    const pause = (ms?: number) =>
      new Promise<void>((resolve) => {
        const timer = ms === undefined ? undefined : setTimeout(resolve, ms)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    const finish = (value: SubscriptionEnd) => {
      if (end) return
      end = value
      buffer.length = 0
      transport.listeners.delete(listen)
      settle(value)
      wake()
    }
    const close = () => {
      finish({ reason: 'closed' })
      closing ??= closeRemote(subscriptionId)
      return closing
    }
    const overflow = () => {
      finish({ reason: 'overflow' })
      void close()
    }
    const accept = (frame: ClientSubscriptionFrame) => {
      if (end || final || frame.subscriptionId !== subscriptionId || frame.topic !== topic) return
      const size = utf8ByteLength(JSON.stringify(frame), maxReaderQueueBytes)
      const entry = { frame, bytes: size.ok ? size.value : Number.POSITIVE_INFINITY }
      buffer.push(entry)
      bytes += entry.bytes
      // Polling starts only once the buffer is drained, so by then this is the last delivered cursor.
      cursor = frame.cursor
      final = terminal(frame) !== null
      if (buffer.length > maxReaderQueueFrames || bytes > maxReaderQueueBytes) overflow()
      else wake()
    }
    function listen(event: PushEvent) {
      if (event === 'session-replaced') finish({ reason: 'session-replaced' })
      else if (event === 'socket-closed') wake()
      else accept(event)
    }

    // HTTP and poll deployments learn of a catalog change only by asking, once per idle cycle.
    // ponytail: one status query per idle subscription; share one ticker when many poll at once.
    const idle = async () => {
      const header = transport.header()
      await Promise.all([
        header && transport.query('transport.catalogStatus', { header }),
        pause(pollIntervalMs),
      ])
    }
    const poll = async () => {
      const header = transport.header()
      if (!header) return finish({ reason: 'unknown' })
      const request = { header, subscriptionId, cursor, limit: maxReaderQueueFrames }
      const outcome = await exchange(routes.readSubscription.path, request)
      if (end) return
      if (!outcome) return finish({ reason: 'unknown' })
      if (!outcome.ok) {
        const code = outcome.error.detailCode
        // Dropping the session ends this subscription, and every other one, as session-replaced.
        if (code === 'catalog_changed') return void transport.invalidate().catch(() => undefined)
        return finish(
          code === 'resync_required'
            ? { reason: 'resync-required' }
            : { reason: 'error', error: outcome.error },
        )
      }
      const page = validateRuntime('ClientReadSubscriptionResult', outcome.value)
      if (
        !page.ok ||
        jcs(page.value.header) !== jcs(header) ||
        !page.value.frames.every((f) => valid(header, f))
      )
        return finish({ reason: 'unknown' })
      for (const frame of page.value.frames) accept(frame)
      cursor = page.value.nextCursor ?? cursor
      // An empty page waits even when it claims more, so a confused server cannot spin this loop.
      if (!page.value.frames.length) await idle()
    }
    async function* frames(): AsyncGenerator<ClientSubscriptionFrame> {
      try {
        while (!end) {
          const next = buffer.shift()
          if (next) {
            bytes -= next.bytes
            const last = terminal(next.frame)
            if (last) finish(last)
            yield next.frame
          } else if (transport.pushOpen) await pause()
          else await poll()
        }
      } finally {
        if (!end) void close()
      }
    }

    const initial = terminal(first)
    if (initial) finish(initial)
    else {
      transport.listeners.add(listen)
      for (const frame of held) accept(frame)
      // A full hold may have dropped frames of this subscription.
      if (held.length > maxReaderQueueFrames) overflow()
    }
    return { subscriptionId, topic, first, frames: frames(), ended, close }
  }

  /** Subscribes with a fresh header; the reply must echo that header and the requested topic. */
  async function subscribe(
    request: SubscribeRequest,
    signal?: AbortSignal,
  ): Promise<CallResult<RuntimeSubscription>> {
    const header = transport.header()
    if (!header) return refused()
    const body = { ...request, header }
    if (!validateRuntime('ClientSubscribeRequest', body).ok)
      return { state: 'refused', reason: 'invalid-request' }
    // Pushed frames can outrun the subscribe reply, so they are held from before the request leaves.
    let replaced = false
    const held: ClientSubscriptionFrame[] = []
    const hold = (event: PushEvent) => {
      if (event === 'session-replaced') replaced = true
      else if (event !== 'socket-closed' && held.length <= maxReaderQueueFrames) held.push(event)
    }
    transport.listeners.add(hold)
    const outcome = await exchange(routes.subscribe.path, body, signal)
    transport.listeners.delete(hold)
    if (replaced) return { state: 'unknown', reason: 'reply from a replaced session' }
    if (!outcome) return { state: 'unknown', reason: 'no reply' }
    if (!outcome.ok) {
      if (outcome.error.detailCode === 'catalog_changed') void transport.invalidate().catch(() => undefined)
      return { state: 'failed', error: outcome.error }
    }
    const result = validateRuntime('ClientSubscribeResult', outcome.value)
    if (
      !result.ok ||
      jcs(result.value.header) !== jcs(header) ||
      result.value.topic !== request.topic ||
      result.value.frame.subscriptionId !== result.value.subscriptionId ||
      !valid(header, result.value.frame)
    )
      return { state: 'unknown', reason: 'invalid reply' }
    return { state: 'ok', value: open(result.value, held) }
  }

  return { subscribe }
}
