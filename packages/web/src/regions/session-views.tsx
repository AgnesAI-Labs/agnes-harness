import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, IconButton, Menu, type MenuItem, Tabs, useDocumentLanguage } from '@agnes/web-ui'
import { type Ref, useReducer } from 'react'

/**
 * The session's secondary actions, in one menu at the end of the bar. Each entry presses the
 * action's own (hidden) control, so the action keeps a single owner and a single handler: runtime
 * info belongs to the replaceable topbar unit and the goal popover to the goal card.
 */
function moreActions(): MenuItem[] {
  const press = (id: string) => () => document.getElementById(id)?.click()
  const goal = document.querySelector<HTMLButtonElement>(
    '#session-goal-host:not([hidden]) [data-testid="goal-toggle"]',
  )
  const workspace = document.getElementById('workspace-copy-path')
  return [
    // The workspace is named in the sidebar; the bar keeps only the copy of its path.
    ...(workspace
      ? [
          {
            id: 'workspace',
            label: workspace.getAttribute('aria-label') ?? '',
            testId: 'topbar-more-workspace',
            onSelect: () => workspace.click(),
          },
        ]
      : []),
    // Runtime info exists only while a session is open.
    ...(document.getElementById('session-runtime')
      ? [
          {
            id: 'runtime',
            label: tr('index-shell.runtimeInfo'),
            testId: 'topbar-more-runtime',
            onSelect: press('session-runtime'),
          },
        ]
      : []),
    // The goal card is there only where the session can hold a goal; its label says its state.
    ...(goal
      ? [
          {
            id: 'goal',
            label: goal.textContent?.trim() || tr('goal.create'),
            testId: 'topbar-more-goal',
            onSelect: () => goal.click(),
          },
        ]
      : []),
    {
      id: 'report',
      label: tr('index-shell.reportProblem'),
      testId: 'topbar-more-report',
      onSelect: press('report-problem'),
    },
  ]
}

/** What the bar's actions do is supplied by the controller layer; the view owns the buttons. */
export const sessionViewCommands: { reportProblem?: (trigger: HTMLElement) => void } = {}

/** The trace controller owns selection and visibility on these stable buttons; the view owns their keys. */
export function SessionViews({
  chatRef,
  traceRef,
}: {
  chatRef?: Ref<HTMLButtonElement>
  traceRef?: Ref<HTMLButtonElement>
}) {
  useDocumentLanguage()
  return (
    <Tabs
      className="session-view-tabs"
      items={['chat', 'trace'].map((key) => ({
        key,
        label: tr(`index-shell.tab${key === 'chat' ? 'Chat' : 'Trace'}`),
      }))}
      renderTabBar={() => (
        <div
          className="session-tabs session-view-switch"
          role="tablist"
          aria-label={tr('index-shell.tabsView')}
        >
          {(['chat', 'trace'] as const).map((view, index) => (
            <Button
              key={view}
              appearance="ghost"
              size="small"
              ref={view === 'chat' ? chatRef : traceRef}
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
  )
}

/**
 * The end of the bar: one menu for the secondary actions. The report button stays the owner of its
 * action and is pressed from the menu; its popover opens from the menu button.
 */
export function SessionMore() {
  useDocumentLanguage()
  // The entries depend on what the bar currently holds; re-read them when the menu is approached.
  const [, refresh] = useReducer((version: number) => version + 1, 0)
  return (
    <>
      <span className="topbar-more" onPointerEnter={refresh} onFocusCapture={refresh}>
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
          items={moreActions()}
        />
      </span>
      <IconButton
        id="report-problem"
        name="bug"
        tabIndex={-1}
        onClick={(event) => {
          const trigger = event.currentTarget
          const more = document.getElementById('topbar-more')
          sessionViewCommands.reportProblem?.(
            getComputedStyle(trigger).display === 'none' && more instanceof HTMLElement ? more : trigger,
          )
        }}
        label={tr('index-shell.reportProblem')}
        title={tr('index-shell.reportProblem')}
      />
    </>
  )
}
