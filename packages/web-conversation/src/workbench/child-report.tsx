import type { SessionJob } from '@agnes/protocol'
import type { UiExtensionContext } from '@agnes/web-client'
import { ConversationMarkdown } from '@agnes/web-ui/conversation'

/**
 * A child agent reports messages, not terminal output: its job text is the prose it wrote, so it
 * renders as a readable document instead of a fixed-width screen that breaks the lines at a column
 * count. The snapshot is the same bounded one the terminal screen receives.
 * Parse each received snapshot in full: a live child's complete messages can contain literal
 * examples such as `<tool>` whose closing tag will never arrive.
 */
export function ChildAgentReport({ job, t }: { job: SessionJob; t: UiExtensionContext['t'] }) {
  const childState = job.childStatus ?? job.status
  const running = childState === 'running' || childState === 'starting'
  const text = job.stdout ?? ''
  return (
    <section className="workbench-child-report" aria-label={t('workbench.terminal.childOutput')}>
      {text ? (
        <div className="workbench-child-report-body">
          <ConversationMarkdown source={text} part="body" t={t} />
        </div>
      ) : (
        <p className="workbench-child-report-waiting" role="status">
          {running ? t('workbench.terminal.childWaiting') : t('workbench.terminal.childSilent')}
        </p>
      )}
      {running ? null : (
        <p
          className="workbench-child-report-foot"
          data-tone={job.status === 'failed' || childState === 'disconnected' ? 'danger' : undefined}
        >
          {t(`workbench.terminal.childStatus.${childState}`)}
        </p>
      )}
    </section>
  )
}
