import type {
  HostAgnesClient,
  SessionClientHandle,
  SessionProjection,
  SessionCommands,
} from './service-contracts.js'
import { type Context, Service } from '@agnes/cordis'

export class SessionService extends Service {
  private currentSessionId: string | undefined
  private readonly client: HostAgnesClient | undefined
  private readonly listeners = new Set<() => void>()
  private readonly projectionListeners = new Set<() => void>()
  private currentHandle: SessionClientHandle | undefined
  private currentHandleListener: ((...args: never[]) => void) | undefined

  constructor(ctx: Context, initial?: string, client?: HostAgnesClient) {
    super(ctx, 'session')
    this.currentSessionId = initial
    this.client = client
    this.reattachHandle()
  }

  get sessionId(): string | undefined {
    return this.currentSessionId
  }

  /** 仅宿主调用。 */
  setSession(sessionId: string | undefined): void {
    if (sessionId === this.currentSessionId) return
    this.detachHandle()
    this.currentSessionId = sessionId
    this.reattachHandle()
    for (const listener of [...this.listeners]) listener()
  }

  /** Alias for hosts that model a session switch as a scope reattachment. */
  reattach(sessionId: string | undefined): void {
    this.setSession(sessionId)
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
      if (!handle)
        return {
          status: 'unavailable' as const,
          name,
          error: { code: 'E_PROJECTION_STATE' as const, safeMessage: 'session unavailable' },
        }
      const value = await handle.projectUI()
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
      for (const item of [...this.projectionListeners]) item()
    }) as (...args: never[]) => void
    this.currentHandle = handle
    this.currentHandleListener = listener
    handle.listeners.add(listener)
  }
}
