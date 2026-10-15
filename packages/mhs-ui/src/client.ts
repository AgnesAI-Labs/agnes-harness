import type { JsonValue } from '@agnes/protocol'
import { activityFrom, devicesFrom, record, text } from './model.js'
import type { MhsPorts, Receipt } from './ports.js'

/** Each action gets one operation ID; polling never repeats dispatch. */
export class MhsClient {
  readonly abort = new AbortController()
  private readonly children = new Set<() => void>()
  constructor(readonly ports: MhsPorts) {}
  query(name: string, input: JsonValue = {}, signal = this.abort.signal): Promise<unknown> {
    signal.throwIfAborted()
    return this.ports.services.query(`${this.ports.prefix ?? 'mhs.'}${name}`, input, { signal })
  }
  async devices(signal?: AbortSignal) {
    return devicesFrom(await this.query('devices', {}, signal))
  }
  async activity(input: JsonValue, signal?: AbortSignal) {
    return activityFrom(await this.query('activity', input, signal))
  }
  async effect(name: string, input: JsonValue, signal = this.abort.signal): Promise<Receipt> {
    signal.throwIfAborted()
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
    signal.throwIfAborted()
    const stream = await this.ports.streams.open(`${this.ports.prefix ?? 'mhs.'}${name}`, input, {
      signal,
      ...(controlOperationId ? { controlOperationId } : {}),
    })
    if (signal.aborted || this.abort.signal.aborted) {
      stream.close('disposed')
      throw new DOMException('Disposed', 'AbortError')
    }
    const off = stream.onFrame(onFrame)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      off()
      stream.close('disposed')
      this.children.delete(close)
      signal.removeEventListener('abort', close)
      this.abort.signal.removeEventListener('abort', close)
    }
    this.children.add(close)
    signal.addEventListener('abort', close, { once: true })
    this.abort.signal.addEventListener('abort', close, { once: true })
    return { stream, close }
  }
  dispose() {
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
  return text(outcome.status) || text(out.state) || 'completed'
}
