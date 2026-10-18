import { UiExtensionRegistry } from './ui-registries.js'

/** Presentation bridge only. The runtime's reviewed client owns authentication and session-read admission. */
export interface BrowserViewSource {
  id: string
  order: number
  observe(sessionId: string): Promise<{
    state: 'idle' | 'starting' | 'ready'
    ticket?: string
    expiresAt?: number
    url?: string
  }>
  watch(
    ticket: string,
    signal: AbortSignal,
  ): Promise<{
    onFrame(listener: (frame: unknown) => void): () => void
    onDisconnect(listener: (info: { reason: string }) => void): () => void
    close(reason: string): void
  }>
}

/** The default runtime contributes a transport; only the optional UI contributes a panel. */
export const browserViews = new UiExtensionRegistry<BrowserViewSource>()
