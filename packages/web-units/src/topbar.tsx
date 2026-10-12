import { Button, IconButton } from '@agnes/web-ui'
import { type ForwardedRef, forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Translate } from './locales/index.js'
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
  setStatus(text: string, state?: string): void
  setConnectionState(value: TopbarConnectionState): void
}
interface TopbarProps {
  translate: Translate
}
export const Topbar = forwardRef<TopbarHandle, TopbarProps>(function Topbar(
  { translate: t }: TopbarProps,
  ref: ForwardedRef<TopbarHandle>,
) {
  const [taskTitle, setTaskTitle] = useState<string>()
  const [status, setStatus] = useState<{ text: string; state: string }>()
  const [connection, setConnection] = useState<TopbarConnectionState>('connecting')
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
      setStatus(text, state) {
        flushSync(() => setStatus((previous) => ({ text, state: state ?? previous?.state ?? 'idle' })))
      },
      setConnectionState(value) {
        flushSync(() => setConnection(value))
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
            title={t('topbar.rename')}
            onClick={(event) =>
              event.currentTarget.dispatchEvent(
                new CustomEvent('agnes:rename-current-session', { bubbles: true }),
              )
            }
          >
            {taskTitle ?? t('topbar.defaultTitle')}
          </Button>
        </h1>
        <span id="status" role="status" aria-live="polite" data-state={status?.state ?? 'idle'}>
          {status?.text ?? t('topbar.defaultStatus')}
        </span>
      </div>
      <div className="connection-group">
        <span id="connection" role="status" aria-live="polite" data-state={connection}>
          {t(CONNECTION_LABEL_KEYS[connection])}
        </span>
      </div>
    </div>
  )
})
