import { Button, Icon, Tooltip, useDocumentLanguage } from '@agnes/web-ui'
import { EMPTY_SIDEBAR_STATE, Sidebar, type SidebarHandle } from '@agnes/web-units/shell'
import { forwardRef, useEffect, useMemo, useRef } from 'react'
import { SESSION_SEARCH_EVENT, SessionSearchButton } from '../regions/session-tools.js'
import { bindSidebar } from '../shell.js'
import { type BackendGroupsProps, BackendSessionGroups } from './workbench-groups.js'
import { workbenchText } from './workbench-text.js'

/** The standard sidebar owns its brand, actions, shortcuts, collapse and footer. */
export const WorkbenchSidebar = forwardRef<SidebarHandle, BackendGroupsProps>(
  function WorkbenchSidebar(props, ref) {
    const language = useDocumentLanguage()
    const latest = useRef(props)
    latest.current = props
    const nativeText = useMemo(() => workbenchText(language), [language])
    const dependencies = useMemo(
      () => ({
        translate: nativeText,
        bindSidebar,
        renderNavigation: () => <BackendSessionGroups {...latest.current} language={language} />,
      }),
      [nativeText, language],
    )
    useEffect(() => {
      const search = () => latest.current.command(latest.current.active, { kind: 'search' })
      const shortcut = (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          !(event.metaKey || event.ctrlKey) ||
          event.shiftKey ||
          event.altKey ||
          event.key.toLowerCase() !== 'k'
        )
          return
        event.preventDefault()
        search()
      }
      document.addEventListener(SESSION_SEARCH_EVENT, search)
      document.addEventListener('keydown', shortcut)
      return () => {
        document.removeEventListener(SESSION_SEARCH_EVENT, search)
        document.removeEventListener('keydown', shortcut)
      }
    }, [])
    return (
      <aside className="sidebar" aria-label={props.t('projects')}>
        <Sidebar
          ref={ref}
          state={{ ...EMPTY_SIDEBAR_STATE, newDisabled: false }}
          dependencies={dependencies}
          actions={{
            newSession: () =>
              props.active === 'cloud' && !props.cloud
                ? props.configure()
                : props.command(props.active, { kind: 'new' }),
            addWorkspace: () => props.command(props.active, { kind: 'workspace' }),
            openSettings: () =>
              props.command(
                props.active === 'cloud' && !props.states.cloud?.connected ? 'local' : props.active,
                { kind: 'settings', section: 'model' },
              ),
          }}
          slots={{
            search: <SessionSearchButton t={nativeText} />,
            entries: (
              <nav className="home-entries">
                {(['plugins', 'agents', 'automation', 'mhs'] as const).map((page) => (
                  <Tooltip key={page} title={props.t(page)}>
                    <Button
                      appearance="ghost"
                      className="home-entry"
                      aria-label={props.t(page)}
                      aria-current={props.states[props.active]?.page === page ? 'page' : undefined}
                      onClick={() => props.command(props.active, { kind: 'home', page })}
                    >
                      <Icon
                        name={
                          page === 'plugins'
                            ? 'puzzle'
                            : page === 'agents'
                              ? 'bot'
                              : page === 'automation'
                                ? 'clock'
                                : 'route'
                        }
                      />
                      <span className="home-entry-label">{props.t(page)}</span>
                    </Button>
                  </Tooltip>
                ))}
              </nav>
            ),
          }}
        />
      </aside>
    )
  },
)
