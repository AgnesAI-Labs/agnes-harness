import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, IconButton, renderRegion, Tabs, unmountRegion } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'

const subscribe = (listener: () => void) => {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  window.addEventListener('agnes:locale-changed', listener)
  return () => {
    observer.disconnect()
    window.removeEventListener('agnes:locale-changed', listener)
  }
}

/** The trace controller still owns selection and visibility on these stable button nodes. */
export function SessionViews() {
  useSyncExternalStore(subscribe, () => document.documentElement.lang)
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

/** Materialize before controllers capture the tab nodes; topbar disposal owns the root. */
export function renderSessionViews(): void {
  const host = document.getElementById('session-view-controls')
  if (host && !host.querySelector('#view-chat')) renderRegion(host, <SessionViews />)
}

export function unmountSessionViews(): void {
  const host = document.getElementById('session-view-controls')
  if (host) unmountRegion(host)
}
