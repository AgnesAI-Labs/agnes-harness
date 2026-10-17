import type { Session } from '@agnes/sdk/browser'
import type { AppSessionContext } from '../app.js'

type FeedbackContext = Pick<AppSessionContext, 'current' | 'notice' | 't' | 'live' | 'showError'>

/** Reconstruct local command feedback after reconnect/reload as well as after a failed send. */
export async function showCommandFeedback(context: FeedbackContext, session: Session): Promise<boolean> {
  const commands = await session.pendingCommands()
  if (context.current !== session || !commands.length) return false
  const unknown = commands.some((command) => command.state === 'needs-confirmation')
  context.notice.setText(context.t(unknown ? 'app.command.unconfirmed' : 'app.command.pending'))
  context.notice.setKind('warning')
  context.notice.offer({
    label: context.t('app.command.check'),
    run: () => {
      // Checking always uses the original ID and payload; it never creates a fresh submission.
      void (async () => {
        for (const command of commands) {
          try {
            await session.checkCommand(command.commandId)
          } catch {
            /* Still unresolved or refused. */
          }
        }
        if (context.current !== session) return
        if (!(await showCommandFeedback(context, session))) context.notice.setText('')
        context.live?.refresh()
      })().catch(context.showError)
    },
  })
  return true
}
