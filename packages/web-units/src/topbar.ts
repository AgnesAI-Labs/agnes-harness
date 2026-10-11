import { Button, IconButton } from '@agnes/web-ui'
import { createElement, type ForwardedRef, forwardRef, useImperativeHandle, useRef } from 'react'
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
  const taskTitle = useRef<HTMLButtonElement>(null)
  const status = useRef<HTMLSpanElement>(null)
  const connection = useRef<HTMLSpanElement>(null)

  useImperativeHandle(
    ref,
    () => ({
      setTaskTitle(title) {
        if (taskTitle.current) taskTitle.current.textContent = title
      },
      setStatus(text, state) {
        if (!status.current) return
        status.current.textContent = text
        if (state !== undefined) status.current.dataset.state = state
      },
      setConnectionState(value) {
        if (!connection.current) return
        connection.current.dataset.state = value
        connection.current.textContent = t(CONNECTION_LABEL_KEYS[value])
      },
    }),
    [t],
  )

  return createElement(
    'div',
    {
      style: { display: 'contents' },
      'data-agnes-region-owner': 'builtin',
      'data-agnes-region-unit': 'topbar',
    },
    createElement(IconButton, {
      id: 'sidebar-toggle',
      name: 'menu',
      className: 'sidebar-toggle',
      label: t('sidebar.openNav'),
      'aria-expanded': 'false',
    }),
    createElement(
      'div',
      { className: 'task-heading' },
      createElement(
        'h1',
        null,
        createElement(
          Button,
          {
            ref: taskTitle,
            id: 'task-title',
            appearance: 'ghost',
            size: 'small',
            title: t('topbar.rename'),
            onClick: (event) =>
              event.currentTarget.dispatchEvent(
                new CustomEvent('agnes:rename-current-session', { bubbles: true }),
              ),
          },
          t('topbar.defaultTitle'),
        ),
      ),
      createElement(
        'span',
        { ref: status, id: 'status', role: 'status', 'aria-live': 'polite', 'data-state': 'idle' },
        t('topbar.defaultStatus'),
      ),
    ),
    createElement(
      'div',
      { className: 'connection-group' },
      createElement(
        'span',
        {
          ref: connection,
          id: 'connection',
          role: 'status',
          'aria-live': 'polite',
          'data-state': 'connecting',
        },
        t(CONNECTION_LABEL_KEYS.connecting),
      ),
    ),
  )
})
