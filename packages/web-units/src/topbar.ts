import {
  createElement,
  type ForwardedRef,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'

export type TopbarConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'

const CONNECTION_LABELS: Record<TopbarConnectionState, string> = {
  connecting: '正在连接后台',
  connected: '本地后台已连接',
  reconnecting: '连接中断，正在重连',
  closed: '后台连接已关闭',
}

const SIDEBAR_TOGGLE_ICON_PATHS = [
  'M16.4516 4.58065C16.4516 4.45594 16.3361 4.35484 16.1935 4.35484H3.80645C3.66393 4.35484 3.54839 4.45594 3.54839 4.58065V15.4194C3.54839 15.5441 3.66393 15.6452 3.80645 15.6452H16.1935C16.3361 15.6452 16.4516 15.5441 16.4516 15.4194V4.58065ZM18 15.4194C18 16.2923 17.1912 17 16.1935 17H3.80645C2.80878 17 2 16.2923 2 15.4194V4.58065C2 3.70768 2.80878 3 3.80645 3H16.1935C17.1912 3 18 3.70768 18 4.58065V15.4194Z',
  'M8.45161 16.3226H6.90322L6.90323 3.67742H8.45161L8.45161 16.3226Z',
]
const DISCONNECT_ICON_PATH = 'M12 3v9M7.05 5.05a8 8 0 1 0 9.9 0'

export interface TopbarHandle {
  setTaskTitle(title: string): void
  setStatus(text: string, state?: string): void
  setConnectionState(value: TopbarConnectionState): void
  onDisconnect(listener: () => void): () => void
}

interface TopbarProps {
  disconnectListeners: Set<() => void>
}

export const Topbar = forwardRef<TopbarHandle, TopbarProps>(function Topbar(
  { disconnectListeners }: TopbarProps,
  ref: ForwardedRef<TopbarHandle>,
) {
  const taskTitle = useRef<HTMLHeadingElement>(null)
  const status = useRef<HTMLSpanElement>(null)
  const connection = useRef<HTMLSpanElement>(null)
  const disconnect = useRef<HTMLButtonElement>(null)

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
        connection.current.textContent = CONNECTION_LABELS[value]
      },
      onDisconnect(listener) {
        disconnectListeners.add(listener)
        return () => disconnectListeners.delete(listener)
      },
    }),
    [disconnectListeners],
  )

  useLayoutEffect(() => {
    const button = disconnect.current
    if (!button) return
    const onClick = () => {
      for (const listener of disconnectListeners) listener()
    }
    button.addEventListener('click', onClick)
    return () => button.removeEventListener('click', onClick)
  }, [disconnectListeners])

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
        id: 'sidebar-toggle',
        className: 'icon-button sidebar-toggle',
        type: 'button',
        'aria-label': '打开导航',
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
      createElement('h1', { ref: taskTitle, id: 'task-title' }, '新会话'),
      createElement(
        'span',
        { ref: status, id: 'status', role: 'status', 'aria-live': 'polite', 'data-state': 'idle' },
        '准备任务',
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
        CONNECTION_LABELS.connecting,
      ),
      createElement(
        'button',
        {
          ref: disconnect,
          id: 'disconnect',
          className: 'icon-button quiet-disconnect',
          type: 'button',
          'aria-label': '断开连接',
          title: '断开连接',
        },
        createElement(
          'svg',
          { className: 'icon', 'data-agnes-region': 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
          createElement('path', { d: DISCONNECT_ICON_PATH }),
        ),
      ),
    ),
  )
})
