import type { ClientContext } from '@agnes/web-client'

type Stream = Awaited<ReturnType<ClientContext['sessionStreams']['open']>>
type Result = Record<string, unknown>

/** One native, renewable lease for a visible panel. No website input is retried. */
export class BrowserInteraction {
  private stream: Stream | undefined
  private opening: Promise<void> | undefined
  private abort = new AbortController()
  private operationId = crypto.randomUUID()
  private grantedAt = 0
  private sequence = 0
  private timer?: ReturnType<typeof setTimeout>
  private pending = new Map<
    number,
    { resolve(value: Result): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  private lost = new Set<(pageId?: string) => void>()
  constructor(private ctx: ClientContext) {}
  prepare() {
    if (this.opening) return this.opening
    if (this.stream) return Promise.resolve()
    this.opening = this.connect().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }
  private async connect(renew = false) {
    this.abort.signal.throwIfAborted()
    if (!this.grantedAt || Date.now() - this.grantedAt >= 270_000) {
      // A new authorization follows an explicit panel opening/gesture, never a timer.
      if (renew) throw new Error('Browser control expired. Click the page to reconnect.')
      this.operationId = crypto.randomUUID()
      await this.ctx.agnes.services.effect('browser.connect', {}, { operationId: this.operationId })
      this.grantedAt = Date.now()
    }
    const next = await this.ctx.sessionStreams.open(
      'browser.interaction',
      {},
      {
        signal: this.abort.signal,
        controlOperationId: this.operationId,
      },
    )
    if (this.abort.signal.aborted) {
      next.close('cancelled')
      return
    }
    const previous = this.stream
    this.stream = next
    next.onFrame((frame) => {
      if (this.stream !== next || !frame || frame instanceof Uint8Array || typeof frame !== 'object') return
      const value = frame as Result
      if (value.type === 'controlLost') {
        for (const fn of this.lost) fn(String(value.pageId))
        return
      }
      const entry = this.pending.get(Number(value.id))
      if (!entry) return
      this.pending.delete(Number(value.id))
      clearTimeout(entry.timer)
      if (value.status === 'ok') entry.resolve((value.result ?? {}) as Result)
      else entry.reject(Object.assign(new Error(String(value.code)), { code: value.code }))
    })
    next.onDisconnect(() => {
      if (this.stream === next) this.disconnect()
    })
    previous?.close('renewed')
    clearTimeout(this.timer)
    const renewAfterDrain = () => {
      if (this.abort.signal.aborted || this.stream !== next) return
      // Do not discard acknowledgements while replacing a healthy connection.
      if (this.pending.size) {
        this.timer = setTimeout(renewAfterDrain, 100)
        return
      }
      this.opening = this.connect(true)
        .catch(() => this.disconnect())
        .finally(() => {
          this.opening = undefined
        })
    }
    this.timer = setTimeout(renewAfterDrain, 22_000)
  }
  private disconnect() {
    clearTimeout(this.timer)
    const previous = this.stream
    this.stream = undefined
    previous?.close('control-ended')
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(
        new Error('Connection lost; the action was not retried. Check the page before continuing.'),
      )
    }
    this.pending.clear()
    for (const fn of this.lost) fn()
  }
  async request(input: Result): Promise<Result> {
    await this.prepare()
    this.abort.signal.throwIfAborted()
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Action result unavailable. Check the page before continuing.'))
      }, 25_000)
      this.pending.set(id, { resolve, reject, timer })
      if (this.stream?.send({ ...input, id } as Parameters<Stream['send']>[0]) !== 'accepted') {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Input was not delivered. Reconnect before continuing.'))
      }
    })
  }
  onLost(fn: (pageId?: string) => void) {
    this.lost.add(fn)
    return () => {
      this.lost.delete(fn)
    }
  }
  close() {
    this.abort.abort()
    this.disconnect()
    this.lost.clear()
  }
}
