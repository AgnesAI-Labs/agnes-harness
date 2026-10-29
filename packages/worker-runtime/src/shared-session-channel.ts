import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostSession, Prompter } from '@agnes/host'
import { samePermissionContext } from '@agnes/protocol'
import type { RequestFrame, SessionReplyFrame, WorkerReplyFrame } from './frames.js'

type SessionContext = Readonly<{ sessionKey: string }>

export function sessionPermissions(lookup: (key: string) => HostSession | undefined) {
  return {
    context(key: string) {
      const session = lookup(key)
      return session?.permissionContext
    },
    subscribe(key: string, changed: () => void) {
      return lookup(key)?.onPermissionChange(changed) ?? (() => {})
    },
    beforeChange(key: string, revoke: () => Promise<void>) {
      return lookup(key)?.onBeforePermissionChange(revoke) ?? (() => {})
    },
    async record(key: string, evidence: readonly import('@agnes/protocol').JsonValue[]) {
      const session = lookup(key)
      if (!session) throw new Error('Permission evidence session is closed')
      if (evidence.length)
        await session.d.log.append(
          evidence.map((value) => session.ev('x/core/permission-auto-allowed', value, { ignorable: true })),
        )
    },
  }
}

/**
 * Attributes Host-wide callbacks to the session whose async work produced them.
 * The worker never guesses a session when the context is absent.
 */
export class SharedSessionChannel {
  private closed = false
  private readonly permissionWatches = new Map<string, () => void>()
  private readonly context = new AsyncLocalStorage<SessionContext>()
  private readonly pending = new Map<
    string,
    { sessionKey: string; cancel(): void; resolve(value: unknown): void; reject(error: unknown): void }
  >()
  private nextRequestId = 1

  constructor(
    private readonly send: (frame: unknown) => void,
    private readonly permissions?: {
      context(sessionKey: string): import('@agnes/protocol').PermissionContext | undefined
      subscribe?(sessionKey: string, changed: () => void): () => void
      beforeChange?(sessionKey: string, revoke: () => Promise<void>): () => void
      record(sessionKey: string, evidence: readonly import('@agnes/protocol').JsonValue[]): Promise<void>
    },
  ) {}

  run<T>(sessionKey: string, operation: () => T): T {
    if (!sessionKey) throw new Error('session key is required')
    return this.context.run(Object.freeze({ sessionKey }), operation)
  }

  /** The session whose async work is running now, if any. */
  sessionInContext(): string | undefined {
    return this.context.getStore()?.sessionKey
  }

  currentSessionKey(): string {
    const sessionKey = this.context.getStore()?.sessionKey
    if (!sessionKey) throw new Error('worker callback has no session context')
    return sessionKey
  }

  ask(req: Parameters<Prompter['ask']>[0], options: { signal: AbortSignal }): ReturnType<Prompter['ask']> {
    return this.request('permission', req, options.signal) as ReturnType<Prompter['ask']>
  }

  notice(params: unknown, signal: AbortSignal): Promise<unknown> {
    return this.request('notice', params, signal)
  }

  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    correlation?: { traceId: string; spanId: string },
  ): void {
    this.send({ ...correlation, kind: 'log', sessionKey: this.currentSessionKey(), level, message })
  }

  request(method: RequestFrame['method'], params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('worker channel closed'))
    const sessionKey = this.currentSessionKey()
    const requestId = `w${this.nextRequestId++}`
    const permissionContext = ['permission', 'plugin-manage', 'mcp-manage', 'skill-install'].includes(method)
      ? this.permissions?.context(sessionKey)
      : undefined
    if (permissionContext && !this.permissionWatches.has(sessionKey) && this.permissions?.beforeChange) {
      const off = this.permissions.beforeChange(sessionKey, async () => {
        const current = this.permissions?.context(sessionKey)
        if (!current) throw new Error('Permission revocation session is closed')
        await this.run(sessionKey, () =>
          this.request(
            'permission-revoke',
            {
              sessionId: current.sessionId,
              epoch: current.epoch,
            },
            AbortSignal.timeout(30_000),
          ),
        )
      })
      this.permissionWatches.set(sessionKey, off)
    }
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        if (
          method === 'permission' ||
          method === 'skill-install' ||
          method === 'mcp-manage' ||
          method === 'plugin-manage'
        ) {
          try {
            this.send({
              kind: 'request',
              sessionKey,
              requestId: `${requestId}-abort`,
              method: `${method}-abort`,
              params: {
                requestId,
                ...(method === 'permission'
                  ? { reason: signal.reason === 'deadline' ? 'deadline' : 'stopped' }
                  : {}),
              },
            } satisfies RequestFrame)
          } catch {
            /* A closed channel cannot authorize further work. */
          }
        }
      }
      let offPermission: (() => void) | undefined
      const onAbort = (): void => {
        offPermission?.()
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
        cancel()
        if (method === 'permission')
          resolve(
            signal.reason === 'deadline'
              ? { verdict: 'unavailable', reason: 'deadline' }
              : { verdict: 'cancelled', reason: 'stopped' },
          )
        else reject(signal.reason ?? new Error('session request cancelled'))
      }
      offPermission =
        permissionContext?.policy === 'full-access'
          ? this.permissions?.subscribe?.(sessionKey, () => {
              if (this.permissions?.context(sessionKey)?.epoch === permissionContext.epoch) return
              const pending = this.pending.get(requestId)
              if (!pending) return
              this.pending.delete(requestId)
              cancel()
              if (method === 'permission') pending.resolve({ verdict: 'cancelled', reason: 'stopped' })
              else pending.reject(new Error('Permission authority revoked'))
            })
          : undefined
      this.pending.set(requestId, {
        sessionKey,
        cancel: () => {
          offPermission?.()
          signal.removeEventListener('abort', onAbort)
          cancel()
        },
        resolve: (value) => {
          offPermission?.()
          signal.removeEventListener('abort', onAbort)
          if (permissionContext && value && typeof value === 'object' && '__aghPermissionEvidence' in value) {
            const envelope = value as {
              value: unknown
              __aghPermissionEvidence: import('@agnes/protocol').JsonValue[]
            }
            resolve(
              this.permissions!.record(sessionKey, envelope.__aghPermissionEvidence).then(() => {
                const current = this.permissions?.context(sessionKey)
                if (
                  envelope.__aghPermissionEvidence.length &&
                  !samePermissionContext(permissionContext, current)
                )
                  throw new Error('Permission authority revoked')
                return envelope.value
              }),
            )
          } else resolve(value)
        },
        reject: (error) => {
          offPermission?.()
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
        this.send({
          kind: 'request',
          sessionKey,
          requestId,
          method,
          params,
          ...(permissionContext ? { permissionContext } : {}),
        } satisfies RequestFrame)
      } catch (error) {
        this.pending.delete(requestId)
        offPermission?.()
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
    if (frame.error) {
      if (frame.permissionEvidence?.length && this.permissions)
        void this.permissions.record(pending.sessionKey, frame.permissionEvidence).then(
          () => pending.reject(frame.error),
          (error) => pending.reject(error),
        )
      else pending.reject(frame.error)
    } else pending.resolve(frame.result)
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
    this.closed = true
    for (const off of this.permissionWatches.values()) off()
    this.permissionWatches.clear()
    for (const pending of this.pending.values()) {
      pending.cancel()
      pending.reject(reason)
    }
    this.pending.clear()
  }

  releaseSession(sessionKey: string): void {
    this.permissionWatches.get(sessionKey)?.()
    this.permissionWatches.delete(sessionKey)
  }
}
