import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prompter } from '@agnes/host'
import type { ApprovalVerdict } from '@agnes/protocol'
import type { RequestFrame, SessionReplyFrame, WorkerReplyFrame } from './frames.js'

type SessionContext = Readonly<{ sessionKey: string }>

/**
 * Attributes Host-wide callbacks to the session whose async work produced them.
 * The worker never guesses a session when the context is absent.
 */
export class SharedSessionChannel {
  private readonly context = new AsyncLocalStorage<SessionContext>()
  private readonly pending = new Map<
    string,
    { sessionKey: string; cancel(): void; resolve(value: unknown): void; reject(error: unknown): void }
  >()
  private nextRequestId = 1

  constructor(private readonly send: (frame: unknown) => void) {}

  run<T>(sessionKey: string, operation: () => T): T {
    if (!sessionKey) throw new Error('session key is required')
    return this.context.run(Object.freeze({ sessionKey }), operation)
  }

  currentSessionKey(): string {
    const sessionKey = this.context.getStore()?.sessionKey
    if (!sessionKey) throw new Error('worker callback has no session context')
    return sessionKey
  }

  ask(req: Parameters<Prompter['ask']>[0], options: { signal: AbortSignal }): Promise<ApprovalVerdict> {
    return this.request('permission', req, options.signal) as Promise<ApprovalVerdict>
  }

  notice(params: unknown, signal: AbortSignal): Promise<unknown> {
    return this.request('notice', params, signal)
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.send({ kind: 'log', sessionKey: this.currentSessionKey(), level, message })
  }

  request(method: RequestFrame['method'], params: unknown, signal: AbortSignal): Promise<unknown> {
    const sessionKey = this.currentSessionKey()
    const requestId = `w${this.nextRequestId++}`
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        if (method === 'skill-install' || method === 'mcp-manage' || method === 'plugin-manage') {
          try {
            this.send({
              kind: 'request',
              sessionKey,
              requestId: `${requestId}-abort`,
              method: `${method}-abort`,
              params: { requestId },
            } satisfies RequestFrame)
          } catch {
            /* A closed channel cannot authorize further work. */
          }
        }
      }
      const onAbort = (): void => {
        this.pending.delete(requestId)
        cancel()
        if (method === 'permission') resolve('cancelled')
        else reject(signal.reason ?? new Error('session request cancelled'))
      }
      this.pending.set(requestId, {
        sessionKey,
        cancel,
        resolve: (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        this.send({ kind: 'request', sessionKey, requestId, method, params } satisfies RequestFrame)
      } catch (error) {
        this.pending.delete(requestId)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    })
  }

  /** Whether a request made on behalf of `sessionKey` is still waiting for the supervisor. */
  hasPending(sessionKey: string): boolean {
    for (const pending of this.pending.values()) if (pending.sessionKey === sessionKey) return true
    return false
  }

  settle(frame: WorkerReplyFrame | SessionReplyFrame): boolean {
    const pending = this.pending.get(frame.requestId)
    if (!pending) return false
    const sessionKey = 'sessionKey' in frame ? frame.sessionKey : undefined
    if (sessionKey !== pending.sessionKey) throw new Error('supervisor reply session mismatch')
    this.pending.delete(frame.requestId)
    if (frame.error) pending.reject(frame.error)
    else pending.resolve(frame.result)
    return true
  }

  closeSession(sessionKey: string, reason: unknown = new Error('session closed')): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionKey !== sessionKey) continue
      this.pending.delete(requestId)
      pending.cancel()
      pending.reject(reason)
    }
  }

  closeAll(reason: unknown = new Error('worker closed')): void {
    for (const pending of this.pending.values()) {
      pending.cancel()
      pending.reject(reason)
    }
    this.pending.clear()
  }
}
