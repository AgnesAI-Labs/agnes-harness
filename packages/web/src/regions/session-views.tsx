import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, IconButton, Menu, type MenuItem, Tabs, useDocumentLanguage } from '@agnes/web-ui'
import { useReducer } from 'react'

/**
 * The secondary top bar actions, for a bar too narrow to show them one by one. Each entry presses
 * the action's own (then hidden) button, so the action keeps a single owner and a single handler.
 */
function overflowActions(): MenuItem[] {
  const press = (id: string) => () => document.getElementById(id)?.click()
  return [
    // Runtime info exists only while a session is open.
    ...(document.getElementById('session-runtime')
      ? [{ id: 'runtime', label: tr('index-shell.runtimeInfo'), onSelect: press('session-runtime') }]
      : []),
    { id: 'report', label: tr('index-shell.reportProblem'), onSelect: press('report-problem') },
  ]
}

/** The trace controller owns selection and visibility on these stable buttons; the view owns their keys. */
export function SessionViews() {
  useDocumentLanguage()
  // The entries depend on what the bar currently holds; re-read them when the menu is approached.
  const [, refreshOverflow] = useReducer((version: number) => version + 1, 0)
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
      <span className="topbar-overflow" onPointerEnter={refreshOverflow} onFocusCapture={refreshOverflow}>
        <Menu
          label={tr('index-shell.moreActions')}
          trigger={
            <IconButton
              id="topbar-more"
              name="ellipsis"
              label={tr('index-shell.moreActions')}
              title={tr('index-shell.moreActions')}
            />
          }
          items={overflowActions()}
        />
      </span>
      <IconButton
        id="report-problem"
        name="bug"
        label={tr('index-shell.reportProblem')}
        title={tr('index-shell.reportProblem')}
      />
    </>
  )
}
