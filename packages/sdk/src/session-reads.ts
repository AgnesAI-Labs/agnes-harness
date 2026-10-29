import { type MethodName, validateMethod } from '@agnes/protocol'
import type { Client } from './client.js'
import { ProtocolViolation, TransportClosed } from './errors.js'

type ReadFlight = { lastSeq: number; watermark: number; promise: Promise<unknown> }

/** Only concurrent reads share work. Completed values and authorization decisions are never cached. */
export class SessionReads {
  private scope = 0
  private epoch = 0
  private watermark = 0
  private readonly pending = new Map<string, ReadFlight>()

  changed(): void {
    this.watermark += 1
  }

  invalidate(): void {
    this.scope += 1
    this.discard()
  }

  private discard(): void {
    this.epoch += 1
    this.pending.clear()
  }

  constructor(
    private readonly client: Client,
    private readonly position: () => {
      id: string
      generation: number
      lastSeq: number
      closed: boolean
      attached: boolean
    },
  ) {}

  async read<T>(method: MethodName, params: Record<string, unknown>): Promise<T> {
    const scope = this.scope
    await this.client.initialize()
    const { id, generation, lastSeq, closed, attached } = this.position()
    const requested = { id, generation, lastSeq, closed, attached }
    if (requested.closed || scope !== this.scope) throw new TransportClosed({ reason: 'closed' })
    // Without this session's subscription, there is no event watermark fencing a read after a mutation.
    if (!requested.attached || params.sessionId !== requested.id) return this.client.call<T>(method, params)
    const epoch = this.epoch
    const watermark = this.watermark
    let key: string
    try {
      key = JSON.stringify([requested.generation, method, Object.entries(params).sort()])
    } catch {
      return this.client.call<T>(method, params)
    }
    const current = () => {
      const value = this.position()
      if (scope !== this.scope || epoch !== this.epoch || value.closed)
        throw new TransportClosed({ reason: 'closed' })
      if (requested.generation !== value.generation)
        throw new ProtocolViolation('stale session read generation')
      return value
    }
    for (;;) {
      const position = current()
      if (!position.attached) return this.client.call<T>(method, params)
      let flight = this.pending.get(key)
      // A new RPC takes the client's normal validation path. A joining caller must pass it
      // too: serialization can collapse malformed values onto an existing request's key.
      if (flight && !validateMethod(method, 'params', params).ok) return this.client.call<T>(method, params)
      if (flight && (flight.lastSeq < requested.lastSeq || flight.watermark < watermark)) {
        // A later event needs a read started after it. Wait for the old flight, then let all
        // waiting callers share one fresh read at the newest cut. Older callers can still finish
        // from that flight; they do not chase every subsequent event and starve during a stream.
        await flight.promise.catch(() => undefined)
        continue
      }
      if (!flight) {
        const off = this.client.on('connectionStateChanged', () => this.discard())
        const started: ReadFlight = {
          lastSeq: position.lastSeq,
          watermark: this.watermark,
          promise: this.client
            .call<T>(method, params)
            .then((value) => {
              current()
              return value
            })
            .finally(() => {
              off()
              if (this.pending.get(key) === started) this.pending.delete(key)
            }),
        }
        this.pending.set(key, started)
        flight = started
      }
      const value = await flight.promise
      current()
      return structuredClone(value) as T
    }
  }
}
