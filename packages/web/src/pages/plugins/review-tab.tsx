import { CandidateInbox } from '@agnes/web-admin/admin/plugins/candidates'
import { FeedbackAdminPanel } from '@agnes/web-admin/settings/feedback'
import { Count, PushPage, Segmented, SettingsState, usePushStack } from '@agnes/web-ui'
import { useState } from 'react'
import type { PluginView, useCandidateSources } from './admin-view.js'
import { pluginPage, pluginPageId } from './route.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
type Kind = 'all' | 'plugin' | 'skill'

/** Everything the agent drafted, plugins and skills in one list; your ratings sit beside it. */
export function ReviewTab({
  view,
  t,
  pending,
  sources,
}: {
  view: PluginView
  t: Text
  pending: number
  sources: ReturnType<typeof useCandidateSources>
}) {
  // A draft under review is a page over this list: `review:<candidate>` in the address.
  const pages = usePushStack()
  const top = pages.stack.at(-1)
  const topPage = top ? pluginPage(top) : undefined
  const opened = topPage?.kind === 'review' ? topPage.id : undefined
  const [showing, setShowing] = useState<'candidates' | 'feedback'>('candidates')
  const [kind, setKind] = useState<Kind>('all')
  return (
    <>
      <div className="plugins-page-toolbar">
        <Segmented<'candidates' | 'feedback'>
          label={t('review.view')}
          testId="review-view"
          value={showing}
          onChange={setShowing}
          options={[
            {
              value: 'candidates',
              label: (
                <>
                  {t('review.candidates')}
                  <Count value={pending} label={t('tab.reviewCount', { count: pending })} />
                </>
              ),
            },
            { value: 'feedback', label: t('review.feedback') },
          ]}
        />
        {showing === 'candidates' && (
          <Segmented<Kind>
            label={t('review.type')}
            testId="review-type"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: t('review.all') },
              { value: 'plugin', label: t('review.plugin') },
              { value: 'skill', label: t('review.skill') },
            ]}
          />
        )}
      </div>
      {showing === 'feedback' ? (
        <FeedbackAdminPanel />
      ) : view.api ? (
        <CandidateInbox
          merged
          type={kind === 'all' ? undefined : kind}
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
          openId={opened}
          onSelectedChange={(id) => {
            if (id) {
              const segment = pluginPageId({ kind: 'review', id })
              if (top === segment) return
              // One draft replaces another; from the list it is a new page.
              if (opened) pages.replace(segment)
              else pages.open(segment)
            } else if (opened) pages.back()
          }}
          reviewSurface={(content, _close, candidate) => (
            <PushPage
              id={pluginPageId({ kind: 'review', id: candidate.candidateId })}
              title={candidate.packageId}
            >
              {content}
            </PushPage>
          )}
        />
      ) : (
        <SettingsState tone={view.state.error ? 'error' : 'loading'}>
          {t(view.state.error ? 'review.unavailable' : 'review.loading')}
        </SettingsState>
      )}
    </>
  )
}
