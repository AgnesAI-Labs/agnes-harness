import { randomUUID } from 'node:crypto'
import type { UiActionParams, UiSurfaceRecord } from '@agnes/protocol'
import { numberedSurfaceInput, surfaceText } from '@agnes/protocol/intelligent-ui'
import type { Session } from '@agnes/sdk'
import type { Component } from './component.js'
import type { Locale } from './locale.js'
import { tt } from './locale-extended.js'
import { pendingSurface } from './surface-prompt.js'
import type { StatusBar } from './views/status-bar.js'

/** What the inbox needs from the app: the current session, the app's state, and its output. */
export interface SurfaceInboxHost {
  session: () => Session
  stopped: () => boolean
  closed: () => boolean
  locale: () => Locale
  statusBar: StatusBar
  /** Anchors a connection-local view beside the projected nodes of one session. */
  appendLocal: (sessionId: string, view: Component) => void
  localCommandView: (command: string, output: string, quiet?: boolean) => Component
  repaint: () => void
  showError: (error: unknown) => void
}

/** The surfaces of the current session: lists new ones in the timeline and answers the pending one. */
export class SurfaceInbox {
  private prompt: UiSurfaceRecord | undefined
  private command: Omit<UiActionParams, 'sessionId'> | undefined
  private reading: Session | undefined
  private readAgain = false
  private watermark = 0
  private readonly versions = new Map<string, number>()

  constructor(private readonly host: SurfaceInboxHost) {}

  /** True while a form waits for an answer, or an answer is still being delivered. */
  get pending(): boolean {
    return Boolean(this.prompt || this.command)
  }

  reset(): void {
    this.prompt = undefined
    this.command = undefined
    this.versions.clear()
    this.watermark = 0
    this.readAgain = false
  }

  async sync(): Promise<void> {
    const host = this.host
    const session = host.session()
    if (host.stopped() || host.closed() || typeof session.uiRead !== 'function') return
    if (this.reading === session) {
      this.readAgain = true
      return
    }
    this.reading = session
    try {
      const page = await session.uiRead()
      let cursor = page.nextCursor
      while (cursor) {
        const next = await session.uiRead({ cursor })
        page.surfaces.push(...next.surfaces)
        cursor = next.nextCursor
      }
      if (host.stopped() || host.closed() || session !== host.session()) return
      if (page.lastSeq < this.watermark) {
        this.readAgain = true
        return
      }
      this.watermark = page.lastSeq
      for (const record of page.surfaces) {
        if (this.versions.get(record.surface.id) === record.updatedSeq) continue
        this.versions.set(record.surface.id, record.updatedSeq)
        host.appendLocal(
          session.id,
          host.localCommandView(
            record.surface.title,
            surfaceText(record.surface) +
              `\n[Open in Web](/?session=${encodeURIComponent(session.id)}&surface=${encodeURIComponent(record.surface.id)})`,
            false,
          ),
        )
      }
      const next = pendingSurface(page)
      // Keep the displayed request binding until submission; backend refuses an old revision.
      if (!this.prompt || this.prompt.surface.id !== next?.surface.id) this.prompt = next
      if (this.prompt) host.statusBar.setNotice(tt('app.surfacePrompt', host.locale()))
      host.repaint()
    } catch (error) {
      const code = (error as { data?: { code?: string } } | undefined)?.data?.code
      if (code !== 'CAPABILITY_DENIED' && code !== 'METHOD_NOT_FOUND' && session === host.session())
        host.showError(error)
    } finally {
      if (this.reading === session) {
        this.reading = undefined
        if (this.readAgain) {
          this.readAgain = false
          void this.sync()
        }
      }
    }
  }

  /** Sends `text` as the answer to the pending form. */
  async answer(text: string): Promise<void> {
    const host = this.host
    const record = this.prompt
    const session = host.session()
    const command =
      this.command ??
      (record
        ? {
            surfaceId: record.surface.id,
            revision: record.surface.revision,
            commandId: randomUUID(),
            ...numberedSurfaceInput(record.surface, text),
          }
        : undefined)
    if (!command) return
    this.command = command
    const receipt = await session.uiAction(command)
    if (session !== host.session() || host.stopped()) return
    this.watermark = Math.max(this.watermark, receipt.seq)
    this.command = undefined
    this.prompt = undefined
    await this.sync()
    host.statusBar.setNotice(
      receipt.refusal?.message ?? tt('app.questionSent', host.locale()),
      receipt.status === 'rejected' ? 'error' : 'success',
    )
    host.repaint()
  }
}
