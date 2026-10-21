import { homeNavigation } from '@agnes/web-client'
import {
  Badge,
  Banner,
  Button,
  Field,
  PageHeader,
  PushStack,
  Select,
  Table,
  usePushStack,
} from '@agnes/web-ui'
import React from 'react'

export const h = React.createElement
const POLL_MS = 10_000
export const ROLES = ['管理者', '协调员', '工程师', '质量安全']
const ROLE_KEY = 'devboard.demoRole'
const message = (error) => (error instanceof Error ? error.message : String(error))

/** First load, 10 s polling, manual refresh and reload after every write; failures keep the last view. */
export function useBoard(ctx) {
  const services = ctx.profile.services
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const alive = React.useRef(true)
  const load = React.useCallback(async () => {
    try {
      const next = await services.query('devboard.snapshot', {})
      if (alive.current) setData(next)
    } catch (e) {
      if (alive.current) setError(`读取看板失败：${message(e)}`)
    }
  }, [services])
  React.useEffect(() => {
    alive.current = true
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [load])
  const run = React.useCallback(
    async (service, input, done) => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        const receipt = await services.effect(service, input, { operationId: crypto.randomUUID() })
        const state = receipt.state ?? 'completed'
        if (state === 'completed' && receipt.output?.ok === false) setError(receipt.output.error)
        else if (state === 'completed') setNotice(done)
        else if (state === 'refused' || state === 'cancelled')
          setError(`操作未执行（${state}${receipt.code ? `：${receipt.code}` : ''}）`)
        else setNotice(`操作结果尚未确认（${state}），稍后刷新查看。`)
        return state === 'completed' && receipt.output?.ok !== false
      } catch (e) {
        setError(`操作失败：${message(e)}`)
        return false
      } finally {
        await load()
        if (alive.current) setBusy(false)
      }
    },
    [services, load],
  )
  const refresh = React.useCallback(async () => {
    setError('')
    await load()
  }, [load])
  return { data, error, notice, busy, refresh, run }
}

/** Demo identity only: it signs actions and hides a few buttons; it is not a security boundary. */
export function useRole() {
  const [role, setRole] = React.useState(() => {
    try {
      return ROLES.find((r) => r === window.sessionStorage.getItem(ROLE_KEY)) ?? ROLES[0]
    } catch {
      return ROLES[0]
    }
  })
  const change = (next) => {
    setRole(next)
    try {
      window.sessionStorage.setItem(ROLE_KEY, next)
    } catch {}
  }
  return [role, change]
}

const VERBS = {
  REFINED: (from) => (from === 'RAW' ? '细化' : '退回细化'),
  RAW: () => '打回',
  ASSIGNED: () => '分配',
  IN_PROGRESS: (from) => (from === 'BLOCKED' ? '解除阻塞' : '开始'),
  BLOCKED: () => '阻塞',
  COMPLETED: () => '完成',
  FAILED: () => '标记失败',
  PENDING: () => '重试',
  CANCELLED: () => '取消',
  CLAIMED: () => '认领',
  OPEN: () => '放弃认领',
  RESOLVED: () => '处理完成',
}
export const verb = (from, to) => VERBS[to]?.(from) ?? to

const TONES = {
  COMPLETED: 'ok',
  RESOLVED: 'ok',
  IN_PROGRESS: 'warn',
  CLAIMED: 'warn',
  REFINED: 'warn',
  ASSIGNED: 'warn',
  BLOCKED: 'bad',
  FAILED: 'bad',
  EXPIRED: 'bad',
}
export const stateBadge = (data, state) => h(Badge, { tone: TONES[state] ?? 'off' }, data.labels.state[state])
export const time = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, dateStyle: 'short', timeStyle: 'short' }) : '—'
export const options = (map, all = '全部') => [
  { value: '', label: all },
  ...Object.entries(map).map(([value, label]) => ({ value, label })),
]

/**
 * Page chrome shared by all four pages. Banners sit outside the push frame so a refusal stays
 * visible on an open detail page; the header with role switch and refresh belongs to the root page.
 */
export function Shell({ id, title, description, board, role, setRole, actions, children }) {
  return h(
    'main',
    { className: 'devboard-app' },
    h(
      Banner,
      { tone: 'info' },
      `虚构演示数据 · 概念验证（POC），非生产系统${board.data ? ` · 修订 ${board.data.revision}` : ''} · 每 10 秒自动刷新`,
    ),
    board.error && h(Banner, { tone: 'error' }, board.error),
    board.notice && h(Banner, { tone: 'info' }, board.notice),
    h(
      PushStack,
      { rootTitle: title, historyKey: `devboardPush-${id}` },
      h(ReturnOnReselect, { id }),
      h(PageHeader, {
        title,
        description,
        actions: h(
          'div',
          { className: 'devboard-toolbar' },
          h(Select, {
            'aria-label': '演示角色',
            value: role,
            onChange: setRole,
            options: ROLES.map((r) => ({ value: r, label: `演示角色：${r}` })),
            style: { minWidth: 160 },
          }),
          actions,
          h(Button, { onClick: board.refresh, disabled: board.busy }, '刷新'),
        ),
      }),
      board.data
        ? children
        : h('p', { role: 'status' }, board.error ? '暂无数据，请刷新重试。' : '正在读取看板…'),
    ),
  )
}

/** Selecting this page's sidebar entry again while a detail page is open returns to the list. */
function ReturnOnReselect({ id }) {
  const push = usePushStack()
  const current = React.useRef(push)
  current.current = push
  React.useEffect(() => {
    let last = homeNavigation.getSnapshot()
    return homeNavigation.subscribe(() => {
      const next = homeNavigation.getSnapshot()
      if (next !== last && next?.id === id && current.current.stack.length) current.current.backTo(0)
      last = next
    })
  }, [id])
  return null
}

/** One field row in a detail page. */
export const fact = (label, value) =>
  h('div', { className: 'devboard-fact', key: label }, h('dt', null, label), h('dd', null, value ?? '—'))

export function HistoryTable({ history }) {
  return h(Table, {
    captionRepeatsHeading: true,
    caption: '流转记录',
    rowKey: (_row, i) => String(i),
    pagination: false,
    size: 'small',
    dataSource: [...history].reverse(),
    columns: [
      { title: '时间', dataIndex: 'at', render: time, width: 140 },
      { title: '操作人', dataIndex: 'by', width: 120 },
      { title: '流转', render: (_v, r) => `${r.from ?? '—'} → ${r.to}` },
      { title: '备注', dataIndex: 'note', render: (v) => v ?? '' },
    ],
  })
}

/**
 * Legal moves as buttons, plus a free target picker so the refusal of an illegal move can be shown.
 * The server decides; the page never filters what it sends.
 */
export function TransitionBar({ data, kind, item, board, role, hidden = [], noteLabel = '备注（可选）' }) {
  const from = item.state
  const legal = (data.machines[kind][from] ?? []).filter((to) => !hidden.includes(to))
  const [note, setNote] = React.useState('')
  const [target, setTarget] = React.useState('')
  const noteId = `devboard-note-${item.id}`
  const go = async (to) => {
    const ok = await board.run(
      'devboard.transition',
      { kind, id: item.id, to, by: role, ...(note.trim() ? { note: note.trim() } : {}) },
      `${item.id} 已${verb(from, to)}`,
    )
    if (ok) {
      setNote('')
      setTarget('')
    }
  }
  const others = Object.keys(data.machines[kind]).filter(
    (s) => s !== from && s !== 'EXPIRED' && !hidden.includes(s),
  )
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '状态流转' },
    h(
      Field,
      { label: noteLabel, htmlFor: noteId },
      h('textarea', {
        id: noteId,
        className: 'devboard-note',
        rows: 2,
        value: note,
        maxLength: 2000,
        onChange: (e) => setNote(e.target.value),
      }),
    ),
    h(
      'div',
      { className: 'devboard-buttons' },
      legal.length
        ? legal.map((to, i) =>
            h(
              Button,
              {
                key: to,
                appearance: i === 0 ? 'primary' : 'secondary',
                disabled: board.busy,
                onClick: () => go(to),
              },
              verb(from, to),
            ),
          )
        : h('span', { className: 'devboard-muted' }, '当前状态为终态，没有可执行的流转。'),
    ),
    h(
      'div',
      { className: 'devboard-buttons' },
      h(Select, {
        'aria-label': '指定目标状态',
        value: target,
        onChange: setTarget,
        options: [
          { value: '', label: '指定目标状态…' },
          ...others.map((s) => ({ value: s, label: `${data.labels.state[s]}（${s}）` })),
        ],
        style: { minWidth: 200 },
      }),
      h(Button, { disabled: board.busy || !target, onClick: () => go(target) }, '尝试流转'),
    ),
  )
}
