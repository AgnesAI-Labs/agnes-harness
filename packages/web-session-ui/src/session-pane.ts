import type { RuntimeIdentity, SessionRuntimeState } from '@agnes/protocol'
import { type Client, JsonRpcError, type Session } from '@agnes/sdk/browser'
import { createLiveProjection, type LiveProjection, type LiveProjectionSink } from './live-projection.js'
import { bindWebSession, loadWebSession, type WebSessionBinding } from './session-binding.js'

type PermissionHandler = Parameters<Session['onPermissionRequest']>[0]

/** One owner per visible session. Disposing this pane never cancels another pane's work. */
export class SessionPaneController {
  private binding: WebSessionBinding | undefined
  private live: LiveProjection | undefined
  private disposed = false
  private cleanup: Promise<void> | undefined
  runtime: SessionRuntimeState | undefined
  identity: RuntimeIdentity | undefined

  constructor(
    private readonly client: Client,
    readonly id: string,
  ) {}

  get session(): Session | undefined {
    return this.binding?.session
  }

  async open(
    permission: PermissionHandler,
    created?: Session,
    historicalRuntime?: RuntimeIdentity,
  ): Promise<Session> {
    if (this.disposed || this.binding) throw new Error('会话面板已经打开或关闭。')
    const binding = created
      ? bindWebSession(created, permission)
      : await loadWebSession((id, options) => this.client.session.load(id, options), this.id, permission)
    if (this.disposed) {
      binding.offPermission?.()
      await binding.session.detach()
      throw new Error('会话面板已关闭。')
    }
    this.binding = binding
    try {
      this.runtime = await binding.session.runtime()
      this.identity = this.runtime.runtime
    } catch (error) {
      // Only a definitively old server may use the documented legacy identity. A network
      // failure cannot establish which loop owns a session and must remain visible.
      if (error instanceof JsonRpcError && error.code === -32601)
        this.identity = historicalRuntime ?? { id: 'native', version: '1' }
      else {
        await this.dispose()
        throw error
      }
    }
    if (this.disposed) throw new Error('会话面板已关闭。')
    return binding.session
  }

  project(sink: LiveProjectionSink): LiveProjection {
    if (this.disposed || !this.binding || this.live) throw new Error('会话面板不能开始订阅。')
    const live = createLiveProjection(this.binding.session, this.client, {
      timeline: (value, window) => {
        if (!this.disposed) sink.timeline(value, window)
      },
      stream: (value) => {
        if (!this.disposed) sink.stream(value)
      },
      event: (value) => {
        if (!this.disposed) sink.event(value)
      },
      error: (error) => {
        if (!this.disposed) sink.error(error)
      },
    })
    this.live = live
    return live
  }

  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup
    this.disposed = true
    this.binding?.offPermission?.()
    this.cleanup = (async () => {
      try {
        await this.live?.stop()
      } finally {
        await this.binding?.session.detach()
      }
    })()
    return this.cleanup
  }
}
