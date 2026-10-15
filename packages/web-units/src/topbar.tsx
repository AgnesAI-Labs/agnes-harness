import { Button, IconButton } from '@agnes/web-ui'
import { type ForwardedRef, forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Translate } from './locales/index.js'
import { RunStatus, type TopbarStatusDetails } from './run-status.js'

export type { TopbarStatusDetails } from './run-status.js'
export type TopbarConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
/** 渲染时取词：状态 → key 表，文案在组件内按当前 locale 解析。 */
const CONNECTION_LABEL_KEYS: Record<TopbarConnectionState, string> = {
  connecting: 'topbar.connection.connecting',
  connected: 'topbar.connection.connected',
  reconnecting: 'topbar.connection.reconnecting',
  closed: 'topbar.connection.closed',
}
export interface TopbarHandle {
  setTaskTitle(title: string): void
  setStatus(text: string, state?: string, details?: TopbarStatusDetails): void
  setStopAction(action: () => void): void
  setConnectionState(value: TopbarConnectionState): void
  /** The session's Agent (loop) name; omitted while no session is selected. */
  setAgent(name: string | undefined): void
  /** Whether a live session can show its runtime information. */
  setRuntimeAvailable(available: boolean): void
}
interface TopbarProps {
  translate: Translate
}
export const Topbar = forwardRef<TopbarHandle, TopbarProps>(function Topbar(
  { translate: t }: TopbarProps,
  ref: ForwardedRef<TopbarHandle>,
) {
  const [taskTitle, setTaskTitle] = useState<string>()
  const [status, setStatus] = useState<{
    text: string
    state: string
    details?: TopbarStatusDetails | undefined
  }>()
  const [onStop, setOnStop] = useState<() => void>()
  const [connection, setConnection] = useState<TopbarConnectionState>('connecting')
  const [agent, setAgent] = useState<string>()
  const [runtimeAvailable, setRuntimeAvailable] = useState(false)
  useEffect(() => {
    const previous = document.title
    document.title = taskTitle ? `${taskTitle} · Agnes Harness` : 'Agnes Harness'
    return () => {
      document.title = previous
    }
  }, [taskTitle])
  useImperativeHandle(
    ref,
    () => ({
      setTaskTitle(title) {
        flushSync(() => setTaskTitle(title))
      },
      setStatus(text, state, details) {
        flushSync(() =>
          setStatus((previous) => ({ text, state: state ?? previous?.state ?? 'idle', details })),
        )
      },
      setStopAction(action) {
        flushSync(() => setOnStop(() => action))
      },
      setConnectionState(value) {
        flushSync(() => setConnection(value))
      },
      setAgent(name) {
        flushSync(() => setAgent(name))
      },
      setRuntimeAvailable(available) {
        flushSync(() => setRuntimeAvailable(available))
      },
    }),
    [],
  )

  return (
    <div style={{ display: 'contents' }} data-agnes-region-owner="builtin" data-agnes-region-unit="topbar">
      <IconButton
        id="sidebar-toggle"
        name="menu"
        className="sidebar-toggle"
        label={t('sidebar.openNav')}
        aria-expanded="false"
      />
      <div className="task-heading">
        <h1>
          <Button
            id="task-title"
            appearance="ghost"
            size="small"
            title={taskTitle ? `${taskTitle} · ${t('topbar.rename')}` : t('topbar.rename')}
            onClick={(event) =>
              event.currentTarget.dispatchEvent(
                new CustomEvent('agnes:rename-current-session', { bubbles: true }),
              )
            }
          >
            {taskTitle ?? t('topbar.defaultTitle')}
          </Button>
        </h1>
        {agent && (
          <span
            className="topbar-agent"
            data-testid="topbar-agent"
            title={t('topbar.agent', { name: agent })}
          >
            <span translate="no">{agent}</span>
          </span>
        )}
        <RunStatus
          key={`${status?.details?.sessionId ?? ''}:${status?.details?.startedAt ?? ''}`}
          text={status?.text ?? t('topbar.defaultStatus')}
          state={status?.state ?? 'idle'}
          details={status?.details}
          onStop={onStop}
          translate={t}
        />
      </div>
      {runtimeAvailable && (
        <IconButton
          id="session-runtime"
          name="info"
          className="topbar-runtime"
          label={t('topbar.runtime')}
          title={t('topbar.runtime')}
          onClick={(event) =>
            event.currentTarget.dispatchEvent(
              new CustomEvent('agnes:runtime-current-session', { bubbles: true }),
            )
          }
        />
      )}
      <div className="connection-group">
        <span id="connection" role="status" aria-live="polite" data-state={connection}>
          {t(CONNECTION_LABEL_KEYS[connection])}
        </span>
      </div>
    </div>
  )
})
