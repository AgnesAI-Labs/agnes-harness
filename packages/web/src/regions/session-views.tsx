import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, IconButton, Tabs, useDocumentLanguage } from '@agnes/web-ui'

/** The trace controller owns selection and visibility on these stable buttons; the view owns their keys. */
export function SessionViews() {
  useDocumentLanguage()
  return (
    <>
      <Tabs
        className="session-view-tabs"
        items={['chat', 'trace'].map((key) => ({
          key,
          label: tr(`index-shell.tab${key === 'chat' ? 'Chat' : 'Trace'}`),
        }))}
        renderTabBar={() => (
          <div className="session-tabs" role="tablist" aria-label={tr('index-shell.tabsView')}>
            {(['chat', 'trace'] as const).map((view, index) => (
              <Button
                key={view}
                appearance="ghost"
                size="small"
                id={`view-${view}`}
                role="tab"
                aria-selected={view === 'chat'}
                aria-controls={view === 'chat' ? 'conversation-shell' : 'trace-panel'}
                aria-posinset={index + 1}
                aria-setsize={2}
                tabIndex={index === 0 ? 0 : -1}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  // The trace controller listens on these stable buttons; arrows move focus and selection.
                  const target = document.getElementById(
                    event.key === 'Home' || event.key === 'ArrowLeft' ? 'view-chat' : 'view-trace',
                  )
                  target?.focus()
                  if (target?.getAttribute('aria-selected') !== 'true') target?.click()
                }}
              >
                {tr(view === 'chat' ? 'index-shell.tabChat' : 'index-shell.tabTrace')}
              </Button>
            ))}
          </div>
        )}
      />
      <IconButton
        id="report-problem"
        name="bug"
        label={tr('index-shell.reportProblem')}
        title={tr('index-shell.reportProblem')}
      />
    </>
  )
}
