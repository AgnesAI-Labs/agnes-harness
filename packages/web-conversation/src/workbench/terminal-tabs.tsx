import type { SessionJob } from '@agnes/protocol'
import type { UiExtensionContext } from '@agnes/web-client'
import {
  Button,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  Popover,
  SettingsInput,
  StatusDot,
} from '@agnes/web-ui'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

type Props = {
  tabs: SessionJob[]
  active: string
  busy: boolean
  t: UiExtensionContext['t']
  name(job: SessionJob): string
  select(id: string): void
  rename(id: string, name: string): void
  close(job: SessionJob): void
  interrupt(job: SessionJob): void
  kill(job: SessionJob): void
}
export function TerminalTabs(props: Props) {
  const { tabs, active, busy, t, name, select, rename, close, interrupt, kill } = props
  const observed = useRef(new Map<string, number>())
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const [editing, setEditing] = useState('')
  const [details, setDetails] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])
  const edit = (id: string) => {
    cancelled.current = false
    setEditing(id)
  }
  return (
    <div role="toolbar" aria-label={t('workbench.terminal.tabs')} className="workbench-terminal-tabs">
      {tabs.map((tab, index) => {
        if (!observed.current.has(tab.id)) observed.current.set(tab.id, now)
        const human = tab.owner === 'human',
          running = tab.status === 'running'
        const actions: MenuItem[] = [
          ...(human
            ? [
                { id: 'rename', label: t('workbench.terminal.rename'), onSelect: () => edit(tab.id) },
                {
                  id: 'interrupt',
                  label: `${t('workbench.terminal.interrupt')} (⌃C)`,
                  disabled: busy || !running,
                  testId: 'terminal-interrupt',
                  onSelect: () => interrupt(tab),
                },
              ]
            : []),
          {
            id: 'details',
            label: t('workbench.terminal.detailsShort'),
            testId: 'terminal-details',
            onSelect: () => setDetails(tab.id),
          },
          {
            id: 'close',
            label: t(human ? 'workbench.terminal.kill' : 'workbench.terminal.unfollow'),
            danger: human,
            dividerBefore: true,
            disabled: human && (busy || !running),
            testId: human ? 'terminal-kill' : 'terminal-unfollow',
            onSelect: () => (human ? kill(tab) : close(tab)),
          },
        ]
        return (
          <div key={tab.id} role="presentation">
            {((index === 0 && tab.owner === 'agent') ||
              (index > 0 && tabs[index - 1]?.owner !== tab.owner && tab.owner === 'agent')) && (
              <div className="workbench-terminal-group">{t('workbench.terminal.agentGroup')}</div>
            )}
            <span
              className="workbench-terminal-pill"
              data-active={active === tab.id}
              data-editing={editing === tab.id}
            >
              <Popover
                open={details === tab.id}
                onOpenChange={(open) => {
                  if (!open) setDetails('')
                }}
                trigger="click"
                content={
                  <dl className="workbench-terminal-details" data-testid="terminal-details-content">
                    <dt>{t('workbench.terminal.session')}</dt>
                    <dd>{tab.ownerSessionId}</dd>
                    <dt>{t('workbench.terminal.id')}</dt>
                    <dd>{tab.id}</dd>
                    <dt>{t('workbench.terminal.cwd')}</dt>
                    <dd>{tab.cwd}</dd>
                  </dl>
                }
              >
                <span>
                  <Menu
                    triggerMode="contextMenu"
                    label={t('workbench.terminal.actions')}
                    items={actions}
                    trigger={
                      <Button
                        type="text"
                        size="small"
                        className="workbench-terminal-select"
                        data-testid="terminal-tab"
                        id={`terminal-tab-${tab.id}`}
                        aria-controls="terminal-job-content"
                        aria-pressed={active === tab.id}
                        tabIndex={
                          active === tab.id || (!tabs.some((row) => row.id === active) && index === 0)
                            ? 0
                            : -1
                        }
                        onClick={() => select(tab.id)}
                        onDoubleClick={() => {
                          if (human) edit(tab.id)
                        }}
                        onKeyDown={(event) => {
                          const step = ['ArrowLeft', 'ArrowUp'].includes(event.key)
                            ? -1
                            : ['ArrowRight', 'ArrowDown'].includes(event.key)
                              ? 1
                              : 0
                          if (!step && event.key !== 'Home' && event.key !== 'End') return
                          event.preventDefault()
                          const next =
                            tabs[
                              event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? tabs.length - 1
                                  : (index + step + tabs.length) % tabs.length
                            ]
                          if (next) {
                            select(next.id)
                            document.getElementById(`terminal-tab-${next.id}`)?.focus()
                          }
                        }}
                      >
                        <StatusDot
                          running={running}
                          tone={running ? 'success' : tab.code === 0 ? 'neutral' : 'danger'}
                        />
                        <span
                          className="workbench-terminal-prompt"
                          role="img"
                          title={human ? undefined : t('workbench.terminal.agentTooltip')}
                          aria-label={
                            human ? t('workbench.terminal.title') : t('workbench.terminal.agentTooltip')
                          }
                        >
                          {!human && <Icon name="sparkles" />}
                        </span>
                        <span className="workbench-terminal-name">{name(tab)}</span>
                        <small className="workbench-terminal-runtime">
                          {running
                            ? `${Math.max(0, Math.floor((now - (observed.current.get(tab.id) ?? now)) / 1000))}s`
                            : t('workbench.terminal.exitCode', { code: tab.code ?? '–' })}
                        </small>
                      </Button>
                    }
                  />
                </span>
              </Popover>
              {editing === tab.id && (
                <SettingsInput
                  ref={input}
                  className="workbench-terminal-rename"
                  aria-label={t('workbench.terminal.rename')}
                  defaultValue={name(tab)}
                  maxLength={120}
                  onBlur={(event) => {
                    if (!cancelled.current && event.currentTarget.value.trim())
                      rename(tab.id, event.currentTarget.value.trim())
                    setEditing('')
                    document.getElementById(`terminal-tab-${tab.id}`)?.focus()
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                    if (event.key === 'Escape') {
                      cancelled.current = true
                      event.currentTarget.blur()
                    } else if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                />
              )}
              <IconButton
                name="x"
                data-testid="terminal-tab-close"
                disabled={busy}
                label={t(human ? 'workbench.terminal.close' : 'workbench.terminal.unfollow')}
                onClick={() => close(tab)}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}
