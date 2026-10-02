import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'

const h = createElement

function createOperationStore(ctx) {
  const listeners = new Set()
  let state = { sessionId: ctx.session.sessionId, snapshot: null, error: '' }
  let timer
  let disposed = false
  let generation = 0
  const publish = (next) => {
    state = next
    for (const listener of listeners) listener()
  }
  const poll = async () => {
    if (disposed || !state.sessionId) return
    const requestGeneration = generation
    try {
      const snapshot = await ctx.agnes.services.call('mhs.operation.snapshot', {})
      if (
        !disposed &&
        requestGeneration === generation &&
        (state.error || state.snapshot?.revision !== snapshot.revision)
      )
        publish({ sessionId: state.sessionId, snapshot, error: '' })
    } catch {
      if (!disposed && requestGeneration === generation && !state.error)
        publish({ ...state, error: '控制事件暂不可用，正在重试' })
    } finally {
      if (!disposed && requestGeneration === generation) timer = window.setTimeout(poll, 350)
    }
  }
  const onSessionChange = () => {
    generation++
    if (timer !== undefined) window.clearTimeout(timer)
    publish({ sessionId: ctx.session.sessionId, snapshot: null, error: '' })
    if (state.sessionId) void poll()
  }
  const unsubscribeSession = ctx.session.subscribe(onSessionChange)
  if (state.sessionId) void poll()
  ctx.effect(() => () => {
    disposed = true
    generation++
    if (timer !== undefined) window.clearTimeout(timer)
    unsubscribeSession()
    listeners.clear()
  })
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
  }
}

const useOperationState = (store) => useSyncExternalStore(store.subscribe, store.getSnapshot)
const text = (value, fallback = '—') =>
  value === undefined || value === null || value === '' ? fallback : String(value)
const label = (operation) =>
  operation?.actionLabel ?? String(operation?.action ?? '设备动作').replaceAll('_', ' ')
const statusLabel = (status) =>
  ({
    planning: '规划中',
    queued: '排队中',
    dispatched: '已下发',
    executing: '执行中',
    settling: '生成回执',
    succeeded: '执行成功',
    failed: '执行失败',
  })[status] ?? '等待指令'

function clock(timestamp) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour12: false })
}

function ProgressBar({ progress }) {
  const value = Math.max(0, Math.min(100, Number(progress) || 0))
  return h(
    'div',
    {
      className: 'mhs-progress',
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': value,
    },
    h('span', { style: { width: `${value}%` } }),
  )
}

function TodoSteps({ todos, compact = false }) {
  return h(
    'ol',
    { className: `mhs-todo-list${compact ? ' is-compact' : ''}`, 'aria-label': '控制步骤' },
    ...(todos ?? []).map((todo, index) =>
      h(
        'li',
        { key: todo.id, className: `is-${todo.status}` },
        h('span', { className: 'mhs-todo-index' }, todo.status === 'completed' ? '✓' : index + 1),
        h('span', null, todo.title),
        h(
          'small',
          null,
          todo.status === 'running'
            ? '进行中'
            : todo.status === 'completed'
              ? '完成'
              : todo.status === 'failed'
                ? '失败'
                : '待执行',
        ),
      ),
    ),
  )
}

function EventFeed({ events }) {
  const list = useRef(null)
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight
  }, [events?.length])
  return h(
    'ol',
    { ref: list, className: 'mhs-event-list', 'aria-label': '详细控制事件', 'aria-live': 'polite' },
    ...(events ?? []).map((event) =>
      h(
        'li',
        {
          key: event.eventId,
          className: event.status === 'succeeded' || event.status === 'completed' ? 'is-success' : '',
        },
        h('time', null, clock(event.timestamp)),
        h(
          'div',
          { className: 'mhs-event-body' },
          h('strong', null, event.type.replaceAll('_', ' ')),
          h('span', null, text(event.message, event.status)),
          h(
            'details',
            null,
            h('summary', null, `字段 · #${event.sequence}`),
            h('pre', null, JSON.stringify(event, null, 2)),
          ),
        ),
      ),
    ),
  )
}

function DeviceIcon({ type }) {
  return h(
    'svg',
    {
      viewBox: '0 0 32 32',
      width: 28,
      height: 28,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    type === 'robot_dog'
      ? [
          h('path', { key: 'body', d: 'M7 13h14l3 4v5H7z' }),
          h('path', { key: 'head', d: 'M21 13l3-5h5v8h-5' }),
          h('path', { key: 'legs', d: 'M10 22v5m11-5v5M7 15H4' }),
        ]
      : [
          h('path', { key: 'body', d: 'M5 12h22l2 7v5H3v-5z' }),
          h('path', { key: 'roof', d: 'M9 12l3-5h8l3 5' }),
          h('circle', { key: 'left-wheel', cx: 9, cy: 24, r: 2 }),
          h('circle', { key: 'right-wheel', cx: 23, cy: 24, r: 2 }),
        ],
  )
}

function DeviceCard({ device, active, dimmed }) {
  return h(
    'article',
    {
      className: `mhs-device-card${active ? ' is-active' : ''}${dimmed ? ' is-standby' : ''}`,
      'aria-label': `${device.displayName}，${active ? '当前控制设备' : '待命设备'}`,
    },
    h('div', { className: 'mhs-device-icon' }, h(DeviceIcon, { type: device.deviceType })),
    h(
      'div',
      { className: 'mhs-device-copy' },
      h('strong', null, device.displayName),
      h('span', null, device.deviceId),
    ),
    active ? h('span', { className: 'mhs-device-selected' }, '当前控制') : null,
    h(
      'div',
      { className: 'mhs-device-meta' },
      h('span', { className: `mhs-state-dot ${device.online ? 'is-online' : ''}` }),
      h('span', null, device.online ? 'ONLINE' : 'OFFLINE'),
      h('span', null, `${text(device.batteryPercent, '0')}%`),
    ),
  )
}

function OperationView({ operation }) {
  if (!operation)
    return h(
      'section',
      { className: 'mhs-operation mhs-operation-empty' },
      h('div', { className: 'mhs-radar', 'aria-hidden': true }, h('span')),
      h('strong', null, '等待控制指令'),
      h('p', null, '在对话中下达动作，控制步骤与事件将在这里逐条出现。'),
    )
  const events = Array.isArray(operation.events) ? operation.events : []
  return h(
    'section',
    { className: `mhs-operation is-${operation.status}` },
    h(
      'div',
      { className: 'mhs-operation-heading' },
      h(
        'div',
        null,
        h('span', { className: 'mhs-eyebrow' }, 'CURRENT OPERATION'),
        h('h3', null, label(operation)),
      ),
      h('span', { className: `mhs-operation-status is-${operation.status}` }, statusLabel(operation.status)),
    ),
    h('p', { className: 'mhs-operation-device' }, `${operation.deviceName} · ${operation.deviceId}`),
    h(
      'div',
      { className: 'mhs-progress-copy' },
      h('span', null, '执行进度'),
      h('strong', null, `${operation.progress ?? 0}%`),
    ),
    h(ProgressBar, { progress: operation.progress }),
    h(TodoSteps, { todos: operation.todos }),
    h(
      'div',
      { className: 'mhs-event-header' },
      h('strong', null, '实时控制事件'),
      h('span', null, `${events.length} 条`),
    ),
    h(EventFeed, { events }),
    h(
      'div',
      { className: 'mhs-receipt' },
      h('span', null, 'OPERATION ID'),
      h('code', null, operation.operationId),
      h('span', null, 'RECEIPT'),
      h('code', null, text(operation.receiptId)),
    ),
  )
}

function MhsDevicePanel({ store, title }) {
  const { sessionId, snapshot, error } = useOperationState(store)
  const [selectedId, setSelectedId] = useState(null)
  useEffect(() => setSelectedId(null), [sessionId])
  const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : []
  const recent = Array.isArray(snapshot?.recentOperations) ? snapshot.recentOperations : []
  const operation =
    recent.find((item) => item.operationId === selectedId) ?? snapshot?.currentOperation ?? null
  return h(
    'aside',
    { className: 'mhs-control-panel', 'aria-label': title },
    h(
      'header',
      { className: 'mhs-panel-header' },
      h('div', null, h('span', { className: 'mhs-eyebrow' }, 'AGNES HARNESS'), h('h2', null, title)),
      h(
        'span',
        { className: `mhs-channel-status${snapshot && !error ? ' is-connected' : ''}` },
        !sessionId ? '等待会话' : error || (snapshot ? 'CONTROL LINK ACTIVE' : 'CONNECTING'),
      ),
    ),
    h(
      'section',
      { className: 'mhs-device-list', 'aria-label': 'Devices' },
      ...devices.map((device) =>
        h(DeviceCard, {
          key: device.deviceId,
          device,
          active: operation?.deviceId === device.deviceId,
          dimmed: !!operation && operation.deviceId !== device.deviceId,
        }),
      ),
    ),
    h(OperationView, { operation }),
    recent.length > 1
      ? h(
          'nav',
          { className: 'mhs-history', 'aria-label': '最近控制命令' },
          h('strong', null, '最近命令'),
          ...recent.slice(0, 8).map((item) =>
            h(
              'button',
              {
                key: item.operationId,
                type: 'button',
                className: item.operationId === operation?.operationId ? 'is-selected' : '',
                onClick: () => setSelectedId(item.operationId),
              },
              `${clock(item.startedAt)}  ${label(item)}  ${statusLabel(item.status)}`,
            ),
          ),
        )
      : null,
    h(
      'footer',
      { className: 'mhs-panel-footer' },
      h('span', null, `Session ${text(sessionId)}`),
      h('span', null, `Rev ${text(snapshot?.revision, '0')}`),
    ),
  )
}

function MhsToolCard({ owner, store }) {
  const { snapshot } = useOperationState(store)
  const operations = Array.isArray(snapshot?.recentOperations) ? snapshot.recentOperations : []
  const operation = operations.find((item) => item.toolUseId === owner?.callId)
  if (!operation)
    return h(
      'div',
      { className: 'mhs-inline-card' },
      h('strong', null, 'MHS 设备控制'),
      h(
        'span',
        null,
        owner?.block?.status === 'completed' ? '该命令已完成，可在右侧查看近期记录' : '正在建立控制计划…',
      ),
    )
  return h(
    'article',
    {
      className: `mhs-inline-card is-${operation.status}`,
      'aria-label': `${label(operation)}：${statusLabel(operation.status)}`,
    },
    h(
      'div',
      { className: 'mhs-inline-heading' },
      h('strong', null, `${operation.deviceName} · ${label(operation)}`),
      h('span', null, statusLabel(operation.status)),
    ),
    h(ProgressBar, { progress: operation.progress }),
    h(TodoSteps, { todos: operation.todos, compact: true }),
    h('small', null, operation.receiptId ? `回执 ${operation.receiptId}` : `指令 ${operation.commandId}`),
  )
}

export function apply(ctx, config) {
  if (!ctx.agnes?.services) throw new Error('MHS device control requires the host service relay')
  const store = createOperationStore(ctx)
  const title = config?.publicConfig?.title ?? 'MHS Device Control'
  ctx.slots.register('workbench.panel', () => h(MhsDevicePanel, { store, title }), { priority: -10 })
  ctx.slots.register(
    { name: 'tool.call.toolview', key: 'mhs_control_device', id: 'mhs-control-steps', priority: -10 },
    ({ owner }) => h(MhsToolCard, { owner, store }),
  )
}
