import type { AppSessionContext } from '../app.js'
import type { ReconnectController } from '../reconnect.js'
import { showCommandFeedback } from './command-feedback.js'

/** Retire transport-driven UI updates before the application releases its React controls. */
export function bindConnectionEvents(
  context: Pick<
    AppSessionContext,
    | 'client'
    | 'current'
    | 'sessionBinding'
    | 'submissions'
    | 'live'
    | 'intentionalClose'
    | 'notice'
    | 'run'
    | 'showError'
    | 't'
    | 'titleRefresh'
  >,
  options: {
    reconnect: ReconnectController
    setConnection(value: 'connecting' | 'connected' | 'reconnecting' | 'closed'): void
    refresh(): Promise<void>
    recover(message: string): boolean
  },
): () => void {
  const stopCommandNotice = context.client.on('notice', (payload) => {
    const notice = payload as { kind?: unknown; sessionId?: unknown }
    const session = context.current
    if (notice.kind === 'command-needs-confirmation' && session?.id === notice.sessionId && session)
      context.run(() => showCommandFeedback(context, session).then(() => undefined))
  })
  const stopReconnecting = context.client.on('reconnecting', () => options.setConnection('reconnecting'))
  const stopReconnected = context.client.on('reconnected', () => {
    options.reconnect.reset()
    options.setConnection('connected')
    // The live projection reopens its session; refresh only the page's catalogs.
    context.run(async () => {
      await options.refresh()
      if (context.current) await showCommandFeedback(context, context.current)
    })
  })
  const stopClosed = context.client.on('closed', () => {
    context.titleRefresh.close()
    options.setConnection('closed')
    const message = context.intentionalClose
      ? context.t('app.connection.closedIntentional')
      : context.t('app.connection.lost')
    if (!options.recover(message)) {
      context.notice.setText(message)
      context.notice.setKind('error')
    }
    if (!context.intentionalClose) options.reconnect.start()
  })
  return () => {
    stopCommandNotice()
    stopReconnecting()
    stopReconnected()
    stopClosed()
  }
}
