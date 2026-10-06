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

const SIDEBAR_TOGGLE_ICON_PATHS = [
  'M16.4516 4.58065C16.4516 4.45594 16.3361 4.35484 16.1935 4.35484H3.80645C3.66393 4.35484 3.54839 4.45594 3.54839 4.58065V15.4194C3.54839 15.5441 3.66393 15.6452 3.80645 15.6452H16.1935C16.3361 15.6452 16.4516 15.5441 16.4516 15.4194V4.58065ZM18 15.4194C18 16.2923 17.1912 17 16.1935 17H3.80645C2.80878 17 2 16.2923 2 15.4194V4.58065C2 3.70768 2.80878 3 3.80645 3H16.1935C17.1912 3 18 3.70768 18 4.58065V15.4194Z',
  'M8.45161 16.3226H6.90322L6.90323 3.67742H8.45161L8.45161 16.3226Z',
]
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
  const taskTitle = useRef<HTMLHeadingElement>(null)
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
    createElement(
      'button',
      {
        className: 'icon-button sidebar-toggle',
        type: 'button',
        'aria-label': t('sidebar.openNav'),
        'aria-expanded': 'false',
      },
      createElement(
        'svg',
        {
          className: 'icon icon-fill',
          'data-agnes-region': 'icon',
          viewBox: '0 0 20 20',
          'aria-hidden': true,
        },
        ...SIDEBAR_TOGGLE_ICON_PATHS.map((path) => createElement('path', { key: path, d: path })),
      ),
    ),
    createElement(
      'div',
      { className: 'task-heading' },
      createElement('h1', { ref: taskTitle, className: 'task-title' }, t('topbar.defaultTitle')),
      createElement(
        'span',
        {
          ref: status,
          className: 'task-status',
          role: 'status',
          'aria-live': 'polite',
          'data-state': 'idle',
        },
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
          className: 'connection-status',
          role: 'status',
          'aria-live': 'polite',
          'data-state': 'connecting',
        },
        t(CONNECTION_LABEL_KEYS.connecting),
      ),
    ),
  )
})
