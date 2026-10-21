import { homeNavigation, openApplicationWork } from '@agnes/web-client'
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
/** Demo signatures: approvers first, then the stage authors (signing as an author shows rule 2). */
export const ROLES = [
  '项目经理',
  '研发总监',
  '技术负责人',
  '质量负责人',
  '客户代表',
  '需求工程师',
  '软件架构师',
  '软件开发工程师',
  '测试工程师',
  '配置管理员',
]
const ROLE_KEY = 'devboard.demoRole'
const PROJECT_KEY = 'devboard.project'
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
        return state === 'completed' && receipt.output?.ok !== false ? (receipt.output ?? {}) : null
      } catch (e) {
        setError(`操作失败：${message(e)}`)
        return null
      } finally {
        await load()
        if (alive.current) setBusy(false)
      }
    },
    [services, load],
  )
  const query = React.useCallback((service, input) => services.query(service, input), [services])
  const refresh = React.useCallback(async () => {
    setError('')
    await load()
  }, [load])
  return { data, error, notice, busy, refresh, run, query, setError, setNotice }
}

function useStored(key, fallback, valid) {
  const [value, setValue] = React.useState(() => {
    try {
      const saved = window.sessionStorage.getItem(key)
      return saved !== null && valid(saved) ? saved : fallback
    } catch {
      return fallback
    }
  })
  const change = (next) => {
    setValue(next)
    try {
      window.sessionStorage.setItem(key, next)
    } catch {}
  }
  return [value, change]
}

/** Demo identity only: it signs actions and gates a few buttons; it is not a security boundary. */
export const useRole = () => useStored(ROLE_KEY, ROLES[0], (r) => ROLES.includes(r))

/** The project selected on one page stays selected on the others in this tab. */
export function useProject(data, allowAll = false) {
  const ids = data.projects.map((p) => p.id)
  const [value, setValue] = useStored(
    PROJECT_KEY,
    allowAll ? '' : ids[0],
    (v) => (allowAll && !v) || ids.includes(v),
  )
  const current = ids.includes(value) || (allowAll && !value) ? value : (ids[0] ?? '')
  return [current, setValue]
}
export function ProjectSelect({ data, value, onChange, allowAll = false }) {
  return h(Select, {
    'aria-label': '选择项目',
    value,
    onChange,
    options: [
      ...(allowAll ? [{ value: '', label: '全部项目' }] : []),
      ...data.projects.map((p) => ({ value: p.id, label: `${p.id} ${p.name}` })),
    ],
    style: { minWidth: 280 },
  })
}

/** Opens the coordinator with the "continue" action; the object names the gate or project. Never sent automatically. */
export function continueWork(board, object) {
  try {
    openApplicationWork('continue', object)
  } catch (e) {
    board.setError(`无法打开研发协调员：${message(e)}。请先在智能体页采纳 DevBoard。`)
  }
}

const VERBS = {
  REFINED: (from) => (from === 'RAW' ? '细化' : '退回细化'),
  RAW: () => '打回',
  ASSIGNED: () => '分配',
  IN_PROGRESS: (from) => (from === 'BLOCKED' ? '解除阻塞' : from === 'NOT_STARTED' ? '开始阶段' : '开始'),
  IN_REVIEW: () => '提交评审',
  BLOCKED: () => '阻塞',
  COMPLETED: () => '完成',
  FAILED: () => '标记失败',
  PENDING: () => '重试',
  CANCELLED: () => '取消',
  CLAIMED: () => '认领',
  OPEN: () => '放弃认领',
  RESOLVED: () => '处理完成',
  ANALYZED: () => '完成影响分析',
  CCB_REVIEW: () => '提交 CCB',
  SUBMITTED: () => '退回补充',
  APPROVED: () => 'CCB 批准',
  REJECTED: () => '驳回',
  IMPLEMENTED: () => '已实施',
  CLOSED: () => '关闭',
  CONFIRMED: () => '确认',
  FIXING: () => '开始修复',
  RETEST: () => '提交回归',
  DEFERRED: () => '延期处理',
}
export const verb = (from, to) => VERBS[to]?.(from) ?? to

const TONES = {
  COMPLETED: 'ok',
  RESOLVED: 'ok',
  PASSED: 'ok',
  APPROVED: 'ok',
  BASELINED: 'ok',
  VERIFIED: 'ok',
  CLOSED: 'ok',
  IMPLEMENTED: 'ok',
  IN_PROGRESS: 'warn',
  IN_REVIEW: 'warn',
  CLAIMED: 'warn',
  REFINED: 'warn',
  ASSIGNED: 'warn',
  PENDING: 'warn',
  CCB_REVIEW: 'warn',
  ANALYZED: 'warn',
  RETEST: 'warn',
  FIXING: 'warn',
  CHANGED: 'warn',
  BLOCKED: 'bad',
  FAILED: 'bad',
  EXPIRED: 'bad',
  REWORK: 'bad',
  REJECTED: 'bad',
  NEW: 'bad',
}
export const stateBadge = (data, state) =>
  h(Badge, { tone: TONES[state] ?? 'off' }, data.labels.state[state] ?? state)
/** A gate that has not been decided is awaiting a decision, not "not started". */
export const gateLabel = (data, decision) =>
  decision === 'PENDING' ? '待决议' : (data.labels.state[decision] ?? decision)
export const gateBadge = (data, decision) =>
  h(Badge, { tone: TONES[decision] ?? 'off' }, gateLabel(data, decision))
export const time = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, dateStyle: 'short', timeStyle: 'short' }) : '—'
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString('zh-CN') : '—')
export const pct = (value) => (value === null || value === undefined ? '—' : `${value}%`)
export const options = (map, all = '全部') => [
  { value: '', label: all },
  ...Object.entries(map).map(([value, label]) => ({ value, label })),
]
export const byId = (list, id) => list.find((item) => item.id === id)
export const idLink = (open) => (id) => h(Button, { appearance: 'link', onClick: () => open(id) }, id)

/** A text-and-bar meter; no chart library. */
export function Meter({ label, value, tone }) {
  const width = Math.max(0, Math.min(100, value ?? 0))
  return h(
    'div',
    { className: 'devboard-meter' },
    h('span', { className: 'devboard-meter-label' }, label),
    h(
      'span',
      { className: 'devboard-meter-track', role: 'img', 'aria-label': `${label} ${pct(value)}` },
      h('span', {
        className: `devboard-meter-fill devboard-tone-${tone ?? (width === 100 ? 'ok' : width >= 80 ? 'warn' : 'bad')}`,
        style: { width: `${width}%` },
      }),
    ),
    h('strong', null, pct(value)),
  )
}

/**
 * Page chrome shared by all pages. Banners sit outside the push frame so a refusal stays visible on
 * an open detail page; the header with role switch and refresh belongs to the root page.
 */
export function Shell({ id, title, description, board, role, setRole, actions, children }) {
  return h(
    'main',
    { className: 'devboard-app', 'data-devboard-page': id },
    h(
      Banner,
      { tone: 'info' },
      `虚构企业「宁川交通装备股份有限公司」与模拟数据，仅供演示${board.data ? ` · 修订 ${board.data.revision}` : ''} · 每 10 秒自动刷新`,
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
            style: { minWidth: 190 },
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

export function HistoryTable({ data, history }) {
  const name = (s) => (s ? (data?.labels.state[s] ?? s) : '—')
  return h(Table, {
    captionRepeatsHeading: true,
    caption: '流转记录',
    rowKey: (_row, i) => String(i),
    pagination: false,
    size: 'small',
    dataSource: [...(history ?? [])].reverse(),
    empty: '暂无记录',
    columns: [
      { title: '时间', dataIndex: 'at', render: time, width: 140 },
      { title: '操作人', dataIndex: 'by', width: 150 },
      { title: '流转', render: (_v, r) => `${name(r.from)} → ${name(r.to)}`, width: 180 },
      { title: '备注', dataIndex: 'note', render: (v) => v ?? '' },
    ],
  })
}

export const NoteField = ({ id, label, value, onChange, rows = 2 }) =>
  h(
    Field,
    { label, htmlFor: id },
    h('textarea', {
      id,
      className: 'devboard-note',
      rows,
      value,
      maxLength: 2000,
      onChange: (e) => onChange(e.target.value),
    }),
  )

/**
 * Legal moves as buttons, plus a free target picker so the refusal of an illegal move can be shown.
 * The server decides; the page never filters what it sends.
 */
export function TransitionBar({ data, kind, item, board, role, hidden = [], noteLabel = '备注（可选）' }) {
  const from = item.state
  const legal = (data.machines[kind][from] ?? []).filter((to) => !hidden.includes(to))
  const [note, setNote] = React.useState('')
  const [target, setTarget] = React.useState('')
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
    h(NoteField, { id: `devboard-note-${item.id}`, label: noteLabel, value: note, onChange: setNote }),
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
        : h('span', { className: 'devboard-muted' }, '当前状态没有可直接执行的流转。'),
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

// ── Markdown preview: React elements only, never innerHTML ───────────────────────────────────────

function inline(text, key) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    const k = `${key}-${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return h('strong', { key: k }, part.slice(2, -2))
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return h('code', { key: k }, part.slice(1, -1))
    return part
  })
}
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

export function Markdown({ text }) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const key = `b${i}`
    if (line.startsWith('```')) {
      const body = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
      i++
      out.push(h('pre', { key, className: 'devboard-md-code' }, body.join('\n')))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(h(`h${Math.min(6, heading[1].length + 1)}`, { key }, inline(heading[2], key)))
      i++
      continue
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line)
      const rows = []
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]))
      out.push(
        h(
          'div',
          { key, className: 'devboard-md-table' },
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                head.map((c, j) => h('th', { key: j }, inline(c, `${key}h${j}`))),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((r, n) =>
                h(
                  'tr',
                  { key: n },
                  r.map((c, j) => h('td', { key: j }, inline(c, `${key}${n}${j}`))),
                ),
              ),
            ),
          ),
        ),
      )
      continue
    }
    const list = /^\s*([-*]|\d+\.)\s+/.exec(line)
    if (list) {
      const ordered = /\d/.test(list[1])
      const items = []
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++)
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))
      out.push(
        h(
          ordered ? 'ol' : 'ul',
          { key },
          items.map((t, n) => h('li', { key: n }, inline(t, `${key}${n}`))),
        ),
      )
      continue
    }
    if (line.startsWith('>')) {
      const quote = []
      for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^>\s?/, ''))
      out.push(h('blockquote', { key }, inline(quote.join(' '), key)))
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(h('hr', { key }))
      i++
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para = []
    for (; i < lines.length && lines[i].trim() && !/^(#|```|>|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i]); i++)
      para.push(lines[i])
    if (!para.length) {
      para.push(line)
      i++
    }
    out.push(h('p', { key }, inline(para.join(' '), key)))
  }
  return h('div', { className: 'devboard-md' }, out)
}
