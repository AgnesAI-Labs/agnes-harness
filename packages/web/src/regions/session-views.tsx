import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, Icon, IconButton, Tabs, useDocumentLanguage } from '@agnes/web-ui'
import { type Ref, useLayoutEffect, useRef, useState } from 'react'

/** The controller supplies the existing report flow; the button remains its real focus anchor. */
export const sessionViewCommands: { reportProblem?: (trigger: HTMLElement) => void } = {}

/** Selection is owned by Trace; observe its public tab state, including restored/programmatic views. */
export function SessionViews({
  chatRef,
  traceRef,
}: {
  chatRef?: Ref<HTMLButtonElement>
  traceRef?: Ref<HTMLButtonElement>
}) {
  useDocumentLanguage()
  const host = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState('chat')
  useLayoutEffect(() => {
    const trace = host.current?.querySelector('#view-trace')
    if (!trace) return
    const sync = () => {
      const view = trace.getAttribute('aria-selected') === 'true' ? 'trace' : 'chat'
      setSelected(view)
      const button = host.current?.querySelector<HTMLElement>(`#view-${view}`)
      if (button && button.offsetWidth > 0) {
        host.current?.style.setProperty('--session-view-thumb-left', `${button.offsetLeft}px`)
        host.current?.style.setProperty('--session-view-thumb-width', `${button.offsetWidth}px`)
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(trace, { attributes: true, attributeFilter: ['aria-selected'] })
    const resize = new ResizeObserver(sync)
    if (host.current) resize.observe(host.current)
    sync()
    return () => {
      observer.disconnect()
      resize.disconnect()
    }
  }, [])
  return (
    <Tabs
      className="session-view-tabs"
      items={['chat', 'trace'].map((key) => ({
        key,
        label: tr(`index-shell.tab${key === 'chat' ? 'Chat' : 'Trace'}`),
      }))}
      renderTabBar={() => (
        <div
          ref={host}
          className="session-tabs session-view-switch"
          data-view={selected}
          role="tablist"
          aria-label={tr('index-shell.tabsView')}
        >
          <span className="session-view-thumb" aria-hidden="true" />
          {(['chat', 'trace'] as const).map((view, index) => (
            <Button
              key={view}
              appearance="ghost"
              size="small"
              ref={view === 'chat' ? chatRef : traceRef}
              id={`view-${view}`}
              role="tab"
              aria-selected={selected === view}
              aria-controls={view === 'chat' ? 'conversation-shell' : 'trace-panel'}
              aria-posinset={index + 1}
              aria-setsize={2}
              tabIndex={selected === view ? 0 : -1}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const targetView =
                  event.key === 'Home'
                    ? 'chat'
                    : event.key === 'End'
                      ? 'trace'
                      : view === 'chat'
                        ? 'trace'
                        : 'chat'
                const target = document.getElementById(`view-${targetView}`)
                target?.focus()
                if (target?.getAttribute('aria-selected') !== 'true') target?.click()
              }}
            >
              <Icon name={view === 'chat' ? 'message-square' : 'route'} size={16} />
              {tr(view === 'chat' ? 'index-shell.tabChat' : 'index-shell.tabTrace')}
              {view === 'trace' && <span className="session-view-live" aria-hidden="true" />}
            </Button>
          ))}
        </div>
      )}
    />
  )
}

export function SessionReport() {
  useDocumentLanguage()
  return (
    <IconButton
      id="report-problem"
      className="topbar-report"
      name="bug"
      onClick={(event) => sessionViewCommands.reportProblem?.(event.currentTarget)}
      label={tr('index-shell.reportProblem')}
      title={tr('index-shell.reportProblem')}
    />
  )
}
