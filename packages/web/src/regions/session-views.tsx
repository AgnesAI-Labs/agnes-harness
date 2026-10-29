import { tr } from '@agnes/web-foundation/locale-bridge'
import { Icon, IconButton, Segmented, useDocumentLanguage } from '@agnes/web-ui'
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
    <div className="session-view-tabs">
      <Segmented
        navigation="tabs"
        hostRef={host}
        className="session-tabs session-view-switch"
        label={tr('index-shell.tabsView')}
        value={selected}
        onChange={setSelected}
        options={(['chat', 'trace'] as const).map((view) => ({
          value: view,
          id: `view-${view}`,
          buttonRef: view === 'chat' ? chatRef : traceRef,
          controls: view === 'chat' ? 'conversation-shell' : 'trace-panel',
          label: (
            <>
              <Icon name={view === 'chat' ? 'message-square' : 'route'} size={16} />
              {tr(view === 'chat' ? 'index-shell.tabChat' : 'index-shell.tabTrace')}
              {view === 'trace' && <span className="session-view-live" aria-hidden="true" />}
            </>
          ),
        }))}
      />
    </div>
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
    />
  )
}
