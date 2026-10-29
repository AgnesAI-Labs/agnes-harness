import { Button, IconButton } from '@agnes/web-ui'
import { type ForwardedRef, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Translate } from './locales/index.js'
import { RunStatus, type TopbarStatusDetails } from './run-status.js'
import { type TitleEditRequest, TopbarTitleEditor } from './topbar-title.js'

export type { TopbarStatusDetails } from './run-status.js'
export type TopbarConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
/** Translate at render time: map status to key, resolving text inside the component using the current locale. */
const CONNECTION_LABEL_KEYS: Record<TopbarConnectionState, string> = {
  connecting: 'topbar.connection.connecting',
  connected: 'topbar.connection.connected',
  reconnecting: 'topbar.connection.reconnecting',
  closed: 'topbar.connection.closed',
}
export interface TopbarHandle {
  setTaskTitle(title: string): void
  setSession(id: string | undefined): void
  editTitle(request: TitleEditRequest): void
  setStatus(text: string, state?: string, details?: TopbarStatusDetails): void
  setStopAction(action: () => void): void
  setConnectionState(value: TopbarConnectionState): void
  /** The session's Agent (loop) name; omitted while no session is selected. */
  setAgent(name: string | undefined): void
}
interface TopbarProps {
  translate: Translate
  productTitle?: string
}
export const Topbar = forwardRef<TopbarHandle, TopbarProps>(function Topbar(
  { translate: t, productTitle = 'Agnes Harness' }: TopbarProps,
  ref: ForwardedRef<TopbarHandle>,
) {
  const [taskTitle, setTaskTitle] = useState<string>()
  const sessionId = useRef<string>()
  const [edit, setEdit] = useState<TitleEditRequest>()
  const [status, setStatus] = useState<{
    text: string
    state: string
    details?: TopbarStatusDetails | undefined
  }>()
  const [onStop, setOnStop] = useState<() => void>()
  const [connection, setConnection] = useState<TopbarConnectionState>('connecting')
  const [agent, setAgent] = useState<string>()
  useEffect(() => {
    const previous = document.title
    document.title = taskTitle ? `${taskTitle} · ${productTitle}` : productTitle
    return () => {
      document.title = previous
    }
  }, [taskTitle, productTitle])
  useImperativeHandle(
    ref,
    () => ({
      setSession(id) {
        if (id === sessionId.current) return
        sessionId.current = id
        flushSync(() => setEdit(undefined))
      },
      editTitle(request) {
        if (request.sessionId === sessionId.current) flushSync(() => setEdit(request))
      },
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
          {edit ? (
            <TopbarTitleEditor
              key={edit.sessionId}
              request={edit}
              t={t}
              onFinish={() => setEdit(undefined)}
            />
          ) : (
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
          )}
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
      <div className="connection-group">
        <span id="connection" role="status" aria-live="polite" data-state={connection}>
          {t(CONNECTION_LABEL_KEYS[connection])}
        </span>
      </div>
    </div>
  )
})
