// The reconnect loop: once the transport drops for a reason nobody asked for, this keeps
// retrying - connect, handshake, recover every session that was attached - until it
// succeeds or the client is told to stop (an explicit close(), or a shutting_down notice
// that later close arrives on). It never builds a second RpcConnection: Client owns one
// for the life of the process, and this only ever calls back into it.
import { AGNES_ERRORS } from '@agnes/protocol'
import type { Client } from './client.js'
import { JsonRpcError } from './errors.js'
import type { CloseInfo } from './transport/types.js'

export type ReconnectOptions = {
  baseMs?: number
  maxMs?: number
  jitter?: number
  // Test-only escape hatch: a fake clock in place of real timers. Still raced against
  // stop()'s abort signal, so a cancelled wait is cancelled whether the clock is real or not.
  sleep?: (ms: number) => Promise<void>
}

function jittered(delay: number, factor: number): number {
  if (factor <= 0) return delay
  return Math.max(0, delay + delay * factor * (Math.random() * 2 - 1))
}

// OVERLOADED is the one failure with its own opinion about how long to wait; every other
// rejection - a fresh SESSION_NOT_FOUND, a timeout, a plain network error - falls back to
// the doubling schedule instead of being special-cased one at a time.
function overloadRetryAfter(e: unknown): number | null {
  if (!(e instanceof JsonRpcError) || e.code !== AGNES_ERRORS.OVERLOADED) return null
  const v = e.data.retryAfterMs
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

export class Reconnector {
  private readonly base: number
  private readonly max: number
  private readonly jitter: number
  private readonly rawSleep: (ms: number) => Promise<void>
  // The loop's own lifetime: present exactly while a retry sequence is in flight, so a
  // second unexpected close while one is already running is not a second loop racing the
  // first, and stop() has a signal to abort.
  private abort: AbortController | null = null
  private loopPromise: Promise<void> | null = null

  constructor(
    private readonly client: Client,
    opts: ReconnectOptions = {},
  ) {
    this.base = opts.baseMs ?? 100
    this.max = opts.maxMs ?? 5000
    this.jitter = opts.jitter ?? 0.2
    this.rawSleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  // Non-user close ⇒ start (or, if one is already running, leave it alone - the same
  // failure reported twice is not two things to retry).
  onClosed(_info: CloseInfo): void {
    if (this.loopPromise) return
    const abort = new AbortController()
    this.abort = abort
    this.loopPromise = this.loop(abort.signal).finally(() => {
      if (this.abort === abort) this.abort = null
      this.loopPromise = null
    })
  }

  // Cancels a wait in progress and lets a step already running finish without starting
  // another retry. Idempotent, and safe to call whether or not a loop is running at all.
  stop(): void {
    this.abort?.abort(new Error('reconnect stopped'))
  }

  private waitBackoff(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      this.rawSleep(ms).then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, reject)
    })
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let delay = this.base
    // Set only by an OVERLOADED response: the server named an exact wait, and scattering
    // it with jitter would be second-guessing a number it already computed.
    let exact = false
    let attempts = 0
    while (!signal.aborted) {
      attempts++
      try {
        await this.waitBackoff(exact ? delay : jittered(delay, this.jitter), signal)
      } catch {
        return
      }
      if (signal.aborted) return
      try {
        await this.client.initialize()
        // Order matters: every attached session's own recover() resends its pending
        // commands before touching attach, so a write from before the drop cannot land
        // after the event stream has already moved past where it would have shown up.
        for (const session of this.client.sessions.values()) {
          if (signal.aborted) return
          if (session.attached) await session.recover()
        }
        this.client.emit('reconnected', { attempts })
        return
      } catch (e) {
        if (signal.aborted) return
        const retryAfter = overloadRetryAfter(e)
        if (retryAfter !== null) {
          delay = retryAfter
          exact = true
        } else {
          delay = Math.min(this.max, delay * 2)
          exact = false
        }
      }
    }
  }
}
