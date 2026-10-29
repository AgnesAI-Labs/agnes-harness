import { type Context, Service } from '@agnes/cordis'
import { notifyListeners } from '@agnes/sdk/browser'
import type {
  HostAgnesClient,
  SessionClientHandle,
  SessionCommands,
  SessionProjection,
} from './service-contracts.js'

export type SessionReadiness = Readonly<{
  status: 'no-session' | 'connecting' | 'ready' | 'history-only' | 'failed'
  sessionId?: string
  epoch: number
}>
export class SessionService extends Service {
  private scope = 0
  private readinessSnapshot: SessionReadiness = Object.freeze({ status: 'no-session', epoch: 0 })
  readonly readiness = {
    getSnapshot: (): SessionReadiness => this.readinessSnapshot,
    subscribe: (listener: () => void): (() => void) => {
      this.readinessListeners.add(listener)
      return () => this.readinessListeners.delete(listener)
    },
  }
  /** Host binding transition; every epoch invalidates in-flight client reads. */
  setReadiness(status: SessionReadiness['status'], sessionId = this.currentSessionId): void {
    this.scope++
    this.readinessSnapshot = Object.freeze({ status, epoch: this.scope, ...(sessionId ? { sessionId } : {}) })
    notifyListeners(this.readinessListeners, 'session readiness')
  }
  private currentSessionId: string | undefined
  private readonly client: HostAgnesClient | undefined
  private readonly listeners = new Set<() => void>()
  private readonly readinessListeners = new Set<() => void>()
  private readonly projectionListeners = new Set<() => void>()
  private currentHandle: SessionClientHandle | undefined
  private currentHandleListener: ((...args: never[]) => void) | undefined

  constructor(ctx: Context, initial?: string, client?: HostAgnesClient) {
    super(ctx, 'session')
    this.currentSessionId = initial
    this.client = client
    this.reattachHandle()
    if (initial) this.setReadiness(this.currentHandle ? 'ready' : 'connecting')
  }

  get sessionId(): string | undefined {
    return this.currentSessionId
  }

  /** Host-only call. */
  setSession(sessionId: string | undefined, readiness?: 'connecting' | 'ready' | 'history-only'): void {
    if (
      sessionId === this.currentSessionId &&
      this.readinessSnapshot.status === (sessionId ? (readiness ?? 'ready') : 'no-session')
    )
      return
    const changed = sessionId !== this.currentSessionId
    this.detachHandle()
    this.currentSessionId = sessionId
    this.reattachHandle()
    this.setReadiness(
      !sessionId ? 'no-session' : (readiness ?? (this.currentHandle ? 'ready' : 'connecting')),
    )
    if (changed) notifyListeners(this.listeners, 'session identity')
  }

  /** Alias for hosts that model a session switch as a scope reattachment. */
  reattach(sessionId: string | undefined): void {
    const changed = sessionId !== this.currentSessionId
    this.detachHandle()
    this.currentSessionId = sessionId
    this.reattachHandle()
    this.setReadiness(!sessionId ? 'no-session' : this.currentHandle ? 'ready' : 'connecting')
    if (changed) notifyListeners(this.listeners, 'session identity')
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string | undefined => this.currentSessionId

  get handle(): SessionClientHandle | undefined {
    return this.currentHandle
  }

  /** Session-scoped UI projection bound to the current SDK session. */
  readonly projection: SessionProjection = {
    read: async (name = 'session.ui') => {
      const handle = this.currentHandle
      const scope = this.scope
      const unavailable = () => ({
        status: 'unavailable' as const,
        name,
        error: { code: 'E_PROJECTION_STATE' as const, safeMessage: 'session unavailable' },
      })
      if (!handle) return unavailable()
      const value = await handle.projectUI()
      if (scope !== this.scope || handle !== this.currentHandle) return unavailable()
      return { status: 'available' as const, name, asOfSeq: 0, stateVersion: 1, value }
    },
    subscribe: (listener) => {
      this.projectionListeners.add(listener)
      return () => this.projectionListeners.delete(listener)
    },
  }

  /** Commands are bound to the current SDK session; the host remains the authority. */
  readonly commands: SessionCommands = {
    prompt: (input) => this.requireHandle().prompt(input),
    steer: (input) => this.requireHandle().steer(input),
    followUp: (input) => this.requireHandle().followUp(input),
    compact: (instructions) => this.requireHandle().compact(instructions),
    cancel: () => this.requireHandle().cancel(),
  }

  private requireHandle(): SessionClientHandle {
    if (!this.currentHandle) throw new Error('session unavailable')
    return this.currentHandle
  }

  private detachHandle(): void {
    if (this.currentHandle && this.currentHandleListener)
      this.currentHandle.listeners.delete(this.currentHandleListener)
    this.currentHandle = undefined
    this.currentHandleListener = undefined
  }

  private reattachHandle(): void {
    if (!this.client || !this.currentSessionId) return
    // Browser test hosts and compatibility embedders may supply the SDK subset
    // used by the workbench before `sessions` is available. Treat that as an
    // unavailable projection rather than breaking the entire Web bootstrap.
    const sessions = (this.client as unknown as { sessions?: { get?(id: string): unknown } }).sessions
    const handle = sessions?.get?.(this.currentSessionId) as SessionClientHandle | undefined
    if (!handle) return
    const listener = (() => {
      notifyListeners(this.projectionListeners, 'session projection')
    }) as (...args: never[]) => void
    this.currentHandle = handle
    this.currentHandleListener = listener
    handle.listeners.add(listener)
  }
}
