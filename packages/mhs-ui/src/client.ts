import type { JsonValue } from '@agnes/protocol'
import { activityFrom, devicesFrom, record, text } from './model.js'
import type { ClientStream, MhsPorts, Receipt } from './ports.js'

/** Each action gets one operation ID; polling never repeats dispatch. */
export class MhsClient {
  readonly abort = new AbortController()
  private readonly disposers = new Set<() => void>()
  onDispose(dispose: () => void) {
    if (this.abort.signal.aborted) {
      dispose()
      return () => {}
    }
    this.disposers.add(dispose)
    return () => {
      this.disposers.delete(dispose)
    }
  }
  private readonly children = new Set<() => void>()
  constructor(readonly ports: MhsPorts) {}
  query(name: string, input: JsonValue = {}, signal = this.abort.signal): Promise<unknown> {
    this.abort.signal.throwIfAborted()
    signal.throwIfAborted()
    signal = AbortSignal.any([signal, this.abort.signal])
    return this.ports.services.query(`${this.ports.prefix ?? 'mhs.'}${name}`, input, { signal })
  }
  async devices(signal?: AbortSignal) {
    return devicesFrom(await this.query('devices', {}, signal))
  }
  async activity(input: JsonValue, signal?: AbortSignal) {
    return activityFrom(await this.query('activity', input, signal))
  }
  async effect(name: string, input: JsonValue, signal = this.abort.signal): Promise<Receipt> {
    this.abort.signal.throwIfAborted()
    signal.throwIfAborted()
    signal = AbortSignal.any([signal, this.abort.signal])
    return this.ports.services.effect(`${this.ports.prefix ?? 'mhs.'}${name}`, input, {
      operationId: crypto.randomUUID(),
      signal,
    })
  }
  async stream(
    name: string,
    input: JsonValue,
    onFrame: Parameters<import('./ports.js').ClientStream['onFrame']>[0],
    signal = this.abort.signal,
    controlOperationId?: string,
  ) {
    this.abort.signal.throwIfAborted()
    signal.throwIfAborted()
    signal = AbortSignal.any([signal, this.abort.signal])
    const stream = await this.ports.streams.open(`${this.ports.prefix ?? 'mhs.'}${name}`, input, {
      signal,
      ...(controlOperationId ? { controlOperationId } : {}),
    })
    if (signal.aborted || this.abort.signal.aborted) {
      stream.close('disposed')
      throw new DOMException('Disposed', 'AbortError')
    }
    const observers = new Set<() => void>()
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      for (const off of observers) off()
      observers.clear()
      stream.close('disposed')
      this.children.delete(close)
      signal.removeEventListener('abort', close)
    }
    const observe = <T>(
      register: (listener: (value: T) => void) => () => void,
      listener: (value: T) => void,
    ) => {
      if (closed) return () => {}
      const off = register((value) => {
        if (!closed && !signal.aborted) listener(value)
      })
      observers.add(off)
      return () => {
        off()
        observers.delete(off)
      }
    }
    const bound: ClientStream = {
      send: (frame) => (closed ? 'closed' : stream.send(frame)),
      onFrame: (listener) => observe((fn) => stream.onFrame(fn), listener),
      onDrop: (listener) => observe((fn) => stream.onDrop(fn), listener),
      onDisconnect: (listener) => observe((fn) => stream.onDisconnect(fn), listener),
      close,
    }
    bound.onFrame(onFrame)
    this.children.add(close)
    signal.addEventListener('abort', close, { once: true })
    return { stream: bound, close }
  }
  dispose() {
    for (const dispose of this.disposers) dispose()
    this.disposers.clear()
    this.abort.abort()
    for (const close of [...this.children]) close()
  }
}
export function receiptMessage(receipt: Receipt): string {
  if (receipt.state !== 'completed')
    return receipt.state === 'approval-required'
      ? 'approval-required'
      : 'code' in receipt
        ? receipt.code
        : receipt.state
  const out = record(receipt.output),
    outcome = record(out.outcome)
  const refused = record(outcome.data).refused
  if (Array.isArray(refused) && refused.length > 0) return 'refused'
  return text(outcome.status) || text(out.state) || 'completed'
}
