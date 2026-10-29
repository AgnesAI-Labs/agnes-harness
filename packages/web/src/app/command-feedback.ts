import type { Session } from '@agnes/sdk/browser'
import type { AppSessionContext } from '../app.js'

type FeedbackContext = Pick<
  AppSessionContext,
  'sessionBinding' | 'submissions' | 'notice' | 't' | 'live' | 'showError'
>

/** Reconstruct local command feedback after reconnect/reload as well as after a failed send. */
export async function showCommandFeedback(context: FeedbackContext, session: Session): Promise<boolean> {
  const binding = context.sessionBinding.capture()
  const submissions = await context.submissions.recover(session)
  if (!context.sessionBinding.isCurrent(binding, session)) return false
  if (submissions === undefined) return true
  if (!submissions.length) return false
  const unknown = submissions.some(
    (submission) => submission.snapshot.command?.state === 'needs-confirmation',
  )
  context.notice.setText(context.t(unknown ? 'app.command.unconfirmed' : 'app.command.pending'))
  context.notice.setKind('warning')
  context.notice.offer({
    label: context.t('app.command.check'),
    run: () => {
      // Checking always uses the original ID and payload; it never creates a fresh submission.
      void (async () => {
        for (const submission of submissions) {
          if (!context.sessionBinding.isCurrent(binding, session)) return
          try {
            await submission.check(session)
          } catch {
            /* Still unresolved or refused. */
          }
        }
        if (!context.sessionBinding.isCurrent(binding, session)) return
        const unresolved = await showCommandFeedback(context, session)
        if (!context.sessionBinding.isCurrent(binding, session)) return
        if (!unresolved) context.notice.setText('')
        context.live?.refresh()
      })().catch(context.showError)
    },
  })
  return true
}
