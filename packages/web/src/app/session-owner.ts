import type { Session } from '@agnes/sdk/browser'
import type { LiveProjection } from '@agnes/web-conversation/live-projection'
import type { WebSessionBinding } from '../session-binding.js'

/** Identity survives attachment, but never a switch, detach or reload of the same session. */
export type SessionBinding = Readonly<{ generation: number; sessionId?: string }>

export class SessionBindingOwner {
  private binding: SessionBinding = { generation: 0 }
  private selected: Session | undefined
  private permission: (() => void) | undefined
  private projection: LiveProjection | undefined
  private loading: AbortController | undefined

  get targetId(): string | undefined {
    return this.binding.sessionId ?? this.selected?.id
  }
  loadingSignal(binding: SessionBinding): AbortSignal {
    return this.isCurrent(binding) && this.loading ? this.loading.signal : AbortSignal.abort()
  }
  loadingPermission(binding: SessionBinding, off: () => void): void {
    if (this.isCurrent(binding)) this.permission = off
    else off()
  }

  get session(): Session | undefined {
    return this.selected
  }
  get generation(): number {
    return this.binding.generation
  }
  get live(): LiveProjection | undefined {
    return this.projection
  }
  get stop(): (() => Promise<void>) | undefined {
    const live = this.projection
    return live && (() => live.stop())
  }
  capture(): SessionBinding {
    return this.binding
  }
  isCurrent(binding: SessionBinding | undefined, session?: Session): boolean {
    return binding === this.binding && (session === undefined || session === this.selected)
  }

  /** Invalidate callbacks synchronously; the controller retains the bounded async cleanup order. */
  begin(sessionId?: string): {
    binding: SessionBinding
    previous: ReturnType<SessionBindingOwner['release']>
  } {
    this.binding = { generation: this.binding.generation + 1, ...(sessionId ? { sessionId } : {}) }
    const previous = this.release(this.binding)
    this.loading = new AbortController()
    return { binding: this.binding, previous }
  }

  attach(binding: SessionBinding, loaded: WebSessionBinding): boolean {
    if (!this.isCurrent(binding)) {
      loaded.offPermission?.()
      return false
    }
    this.selected = loaded.session
    this.permission = loaded.offPermission
    return true
  }

  watch(binding: SessionBinding, live: LiveProjection): void {
    if (this.isCurrent(binding)) this.projection = live
  }

  release(binding: SessionBinding): { session?: Session; stop?: () => Promise<void> } {
    if (!this.isCurrent(binding)) return {}
    const session = this.selected
    const stop = this.stop
    this.loading?.abort(new Error('session selection changed'))
    this.loading = undefined
    this.selected = undefined
    this.projection = undefined
    this.permission?.()
    this.permission = undefined
    return { ...(session ? { session } : {}), ...(stop ? { stop } : {}) }
  }
}
