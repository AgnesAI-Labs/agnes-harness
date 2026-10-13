import { CandidateInbox } from '@agnes/web-admin/admin/plugins/candidates'
import { FeedbackAdminPanel } from '@agnes/web-admin/settings/feedback'
import { Button, Count, SettingsState } from '@agnes/web-ui'
import { useState } from 'react'
import type { PluginView, useCandidateSources } from './admin-view.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
type Kind = 'plugin' | 'skill' | undefined

function Choice<T extends string | undefined>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string
  value: T
  options: readonly (readonly [T, React.ReactNode])[]
  onChange(value: T): void
  testId: string
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pressed-button group, not a form fieldset.
    <div className="plugins-page-choice" role="group" aria-label={label} data-testid={testId}>
      {options.map(([option, text]) => (
        <Button
          key={option ?? 'all'}
          size="small"
          appearance={option === value ? 'secondary' : 'ghost'}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {text}
        </Button>
      ))}
    </div>
  )
}

/** Everything the agent drafted, plugins and skills in one list; your ratings sit beside it. */
export function ReviewTab({
  view,
  t,
  pending,
  sources,
  onPendingCount,
}: {
  view: PluginView
  t: Text
  pending: number
  sources: ReturnType<typeof useCandidateSources>
  onPendingCount(count: number): void
}) {
  const [showing, setShowing] = useState<'candidates' | 'feedback'>('candidates')
  const [kind, setKind] = useState<Kind>(undefined)
  return (
    <>
      <div className="plugins-page-toolbar">
        <Choice<'candidates' | 'feedback'>
          label={t('review.view')}
          testId="review-view"
          value={showing}
          onChange={setShowing}
          options={[
            [
              'candidates',
              <>
                {t('review.candidates')}
                <Count value={pending} label={t('tab.reviewCount', { count: pending })} />
              </>,
            ],
            ['feedback', t('review.feedback')],
          ]}
        />
        {showing === 'candidates' && (
          <Choice<Kind>
            label={t('review.type')}
            testId="review-type"
            value={kind}
            onChange={setKind}
            options={[
              [undefined, t('review.all')],
              ['plugin', t('review.plugin')],
              ['skill', t('review.skill')],
            ]}
          />
        )}
      </div>
      {showing === 'feedback' ? (
        <FeedbackAdminPanel />
      ) : view.api ? (
        <CandidateInbox
          merged
          type={kind}
          api={view.api}
          canReview={
            view.canEffect('packages.trust') &&
            view.canEffect('packages.install') &&
            view.canEffect('packages.activate')
          }
          canTest={view.canEffect('extensions.execute')}
          t={view.t}
          confirm={(input) => view.configureConfirm(input)}
          onPublished={() => view.refresh()}
          sessionTitle={sources.sessionTitle}
          sessionTurnTime={sources.sessionTurnTime}
          onPendingCount={onPendingCount}
        />
      ) : (
        <SettingsState tone={view.state.error ? 'error' : 'loading'}>
          {t(view.state.error ? 'review.unavailable' : 'review.loading')}
        </SettingsState>
      )}
    </>
  )
}
