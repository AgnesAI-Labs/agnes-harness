import { homeNavigation, openApplicationWork } from '@agnes/web-client'
import {
  Badge,
  Banner,
  Button,
  Field,
  PageHeader,
  PushStack,
  Segmented,
  Select,
  Table,
  usePushStack,
} from '@agnes/web-ui'
import React from 'react'
import { GuideButton, GuidePanel } from './guide.js'
import { relevant } from './lens.js'

export const h = React.createElement
const POLL_MS = 10_000
const ROLE_KEY = 'devboard.demoRole'
const PROJECT_KEY = 'devboard.project'
const message = (error) => (error instanceof Error ? error.message : String(error))

/** First load, 10 s polling, manual refresh and reload after every write; failures keep the last view. */
export function useBoard(ctx) {
  const services = ctx.profile.services
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState('')
  // A failed poll clears itself on the next good one; an action error stays until the next action.
  const [loadError, setLoadError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const alive = React.useRef(true)
  // Polls and post-action reloads can finish out of order: only the latest-started request is applied.
  const latest = React.useRef(0)
  const load = React.useCallback(async () => {
    const mine = ++latest.current
    try {
      const next = await services.query('devboard.snapshot', {})
      if (!alive.current || mine !== latest.current) return
      setData(next)
      setLoadError('')
    } catch (e) {
      if (alive.current && mine === latest.current) setLoadError(`读取看板失败：${message(e)}`)
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
  return { data, error: error || loadError, notice, busy, refresh, run, query, setError, setNotice }
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
export const useRole = () => useStored(ROLE_KEY, '项目经理', (r) => r.length > 0 && r.length <= 32)

/** A record another page asked to open ({ id, detail }); the first useDetail of the page opens it. */
export const JumpContext = React.createContext(undefined)

/** Open a record on another page (for example from the role home): the page opens its detail. */
export function jumpTo(entry, id, detail) {
  try {
    homeNavigation.open(entry, { devboard: { id, detail } })
  } catch {}
}

/** Open a detail page of a list: remember which row and push the page by id. */
export function useDetail() {
  const push = usePushStack()
  const jump = React.useContext(JumpContext)
  const [selected, setSelected] = React.useState('')
  const taken = React.useRef(false)
  React.useEffect(() => {
    if (taken.current || typeof jump?.id !== 'string' || typeof jump.detail !== 'string') return
    taken.current = true
    setSelected(jump.id)
    push.open(jump.detail)
  }, [jump, push])
  return [
    selected,
    (id, page = 'detail') => {
      setSelected(id)
      push.open(page)
    },
  ]
}

/**
 * The role lens of a list page: "only mine" by default, back to it when the demo role changes. `scope`
 * maps a record kind to the page's records before its own filters. `pick` narrows one list; `empty`
 * replaces the tables when nothing in scope concerns the role. A lens is a view, it never gates actions.
 */
export function useLens(role, data, scope) {
  const [state, setState] = React.useState({ role, all: false })
  // Adjusting state while rendering: a role change drops the old choice, so coming back to a role starts at "mine".
  if (state.role !== role) setState({ role, all: false })
  const all = state.role === role && state.all
  const setAll = (next) => setState({ role, all: next })
  const concerns = (kind) => (item) => relevant(role, kind, item, data)
  const lists = Object.entries(scope)
  const mine = lists.reduce((n, [kind, list]) => n + list.filter(concerns(kind)).length, 0)
  const total = lists.reduce((n, [, list]) => n + list.length, 0)
  return {
    all,
    pick: (kind, list) => (all ? list : list.filter(concerns(kind))),
    toggle: h(Segmented, {
      label: '角色视角',
      value: all ? 'all' : 'mine',
      onChange: (value) => setAll(value === 'all'),
      options: [
        { value: 'mine', label: `只看与我相关（${mine}）` },
        { value: 'all', label: `全部（${total}）` },
      ],
    }),
    empty:
      !all && total > 0 && mine === 0
        ? h(
            'section',
            { className: 'devboard-card', role: 'status' },
            h('p', null, `${role}在本页没有直接相关的记录`),
            h(Button, { onClick: () => setAll(true) }, '看全部'),
          )
        : null,
  }
}

/** The project selected on one page stays selected on the others in this tab. */
export function useProject(data, allowAll = false) {
  const ids = data.projects.map((p) => p.id)
  const [value, setValue] = useStored(
    PROJECT_KEY,
    allowAll ? '' : ids[0],
    (v) => (allowAll && !v) || ids.includes(v),
  )
  const current = ids.includes(value) || (allowAll && !value) ? value : (ids[0] ?? '')
  // A guide jump to the page already open does not remount it, so take the project a new jump names.
  // The jump present at mount is skipped: the guide already stored its project, and replaying it later
  // would undo a project the person picked since.
  const jump = React.useContext(JumpContext)
  const mounted = React.useRef(jump)
  React.useEffect(() => {
    if (jump !== mounted.current && typeof jump?.project === 'string') setValue(jump.project)
  }, [jump])
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

/** Opens the coordinator with an application action and a draft; never sent automatically. */
export function openWork(board, actionId, object) {
  try {
    openApplicationWork(actionId, object)
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
const KIND_VERBS = {
  trial: {
    IN_PROGRESS: (from) => (from === 'REPORTED' ? '补试' : '开始试验'),
    REPORTED: () => '出具报告',
    APPROVED: () => '批准试验',
  },
  fault: { DISPATCHED: () => '派工', HANDLED: () => '处理完成', CLOSED: () => '关闭' },
  problem: {
    ANALYZING: () => '开始分析',
    ACTION: (from) => (from === 'VERIFYING' ? '退回措施' : '进入措施'),
    VERIFYING: () => '提交验证',
    CLOSED: () => '关闭问题',
  },
}
export const verb = (from, to, kind) => KIND_VERBS[kind]?.[to]?.(from) ?? VERBS[to]?.(from) ?? to

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
  REPORTED: 'warn',
  DISPATCHED: 'warn',
  HANDLED: 'warn',
  ANALYZING: 'warn',
  ACTION: 'warn',
  VERIFYING: 'warn',
  PASS: 'ok',
  FAIL: 'bad',
  CONDITIONAL: 'warn',
}
export const stateBadge = (data, state) =>
  h(Badge, { tone: TONES[state] ?? 'off' }, data.labels.state[state] ?? state)
/** A gate that has not been decided is awaiting a decision, not "not started". */
export const gateLabel = (data, decision) =>
  decision === 'PENDING' ? '待决议' : (data.labels.state[decision] ?? decision)
export const gateBadge = (data, decision) =>
  h(Badge, { tone: TONES[decision] ?? 'off' }, gateLabel(data, decision))
/** A gate voided by a change rework reads as such, whatever its old decision was. */
export const gateOutcome = (data, g) => (g.superseded ? '已作废（返工）' : gateLabel(data, g.decision))
export const gateOutcomeBadge = (data, g) =>
  g.superseded ? h(Badge, { tone: 'off' }, gateOutcome(data, g)) : gateBadge(data, g.decision)
export const time = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, dateStyle: 'short', timeStyle: 'short' }) : '—'
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString('zh-CN') : '—')
export const pct = (value) => (value === null || value === undefined ? '—' : `${value}%`)
export const options = (map, all = '全部') => [
  { value: '', label: all },
  ...Object.entries(map).map(([value, label]) => ({ value, label })),
]
export const byId = (list, id) => list.find((item) => item.id === id)
/** A gate always reads as "code · name", for example "DL2 · 设计联络（二）". */
export const gateName = (g) => `${g.code} · ${g.name}`
/** A stage shows its project's profile label (订单项目、软件平台 and 改造 each name them differently). */
export const stageName = (data, projectId, stage) =>
  data.profiles?.[byId(data.projects, projectId)?.kind]?.[stage]?.label ?? data.labels.stage[stage] ?? stage
export const signedRoles = (gate) => (gate.signatures ?? []).map((s) => s.role)
/** "1/2 已签：项目经理" — the co-sign progress of a gate. */
export const signProgress = (gate) =>
  `${signedRoles(gate).length}/${gate.approverRoles.length}${signedRoles(gate).length ? ` 已签：${signedRoles(gate).join('、')}` : ''}`

/**
 * Who may decide a pending gate: the demo role must be one of the gate's approver roles and not yet
 * have signed. Every other role sees who has to approve and a one-click switch per unsigned role.
 */
export function RoleHint({ gate, role, setRole, children }) {
  const waiting = gate.approverRoles.filter((r) => !signedRoles(gate).includes(r))
  if (gate.decision !== 'PENDING') return null
  if (waiting.includes(role)) return children ?? null
  return h(
    'span',
    { className: 'devboard-buttons' },
    signedRoles(gate).includes(role)
      ? h(Badge, { tone: 'ok' }, `「${role}」已签署`)
      : h(Badge, { tone: 'warn' }, `需由 ${waiting.join('、')} 审批`),
    waiting.map((r) => h(Button, { key: r, size: 'small', onClick: () => setRole(r) }, `切换为 ${r}`)),
  )
}
/** Marks the element a demo-guide step can point at (see guide.js); the wrapper adds no styling. */
export const guided = (id, node) => (node ? h('div', { 'data-guide': id }, node) : node)
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
  const jump = React.useContext(JumpContext)
  const page = h(
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
      guided(
        'page-title',
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
              options: (board.data?.roles ?? [role]).map((r) => ({ value: r, label: `演示角色：${r}` })),
              style: { minWidth: 190 },
            }),
            h(GuideButton),
            actions,
            h(Button, { onClick: board.refresh, disabled: board.busy }, '刷新'),
          ),
        }),
      ),
      board.data
        ? children
        : h('p', { role: 'status' }, board.error ? '暂无数据，请刷新重试。' : '正在读取看板…'),
    ),
  )
  return h(
    'div',
    { className: 'devboard-frame' },
    page,
    h(GuidePanel, { board, role, setRole, page: id, jump }),
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
export function TransitionBar({
  data,
  kind,
  item,
  board,
  role,
  hidden = [],
  noteLabel = '备注（可选）',
  fields = [],
}) {
  const from = item.state
  const legal = (data.machines[kind][from] ?? []).filter((to) => !hidden.includes(to))
  const [note, setNote] = React.useState('')
  const [target, setTarget] = React.useState('')
  const [extra, setExtra] = React.useState({})
  const go = async (to) => {
    const ok = await board.run(
      'devboard.transition',
      {
        kind,
        id: item.id,
        to,
        by: role,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...Object.fromEntries(
          fields
            .filter((f) => (extra[f.key] ?? '').trim())
            .map((f) => [
              f.key,
              f.lines
                ? extra[f.key]
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)
                : extra[f.key].trim(),
            ]),
        ),
      },
      `${item.id} 已${verb(from, to, kind)}`,
    )
    if (ok) {
      setNote('')
      setTarget('')
      setExtra({})
    }
  }
  const others = Object.keys(data.machines[kind]).filter(
    (s) => s !== from && s !== 'EXPIRED' && !hidden.includes(s),
  )
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '状态流转' },
    fields.map((f) =>
      f.options
        ? h(
            Field,
            { key: f.key, label: f.label },
            h(Select, {
              'aria-label': f.label,
              value: extra[f.key] ?? '',
              onChange: (v) => setExtra({ ...extra, [f.key]: v }),
              options: [{ value: '', label: '不填写' }, ...f.options],
              style: { minWidth: 200 },
            }),
          )
        : f.lines
          ? h(NoteField, {
              key: f.key,
              id: `devboard-${f.key}-${item.id}`,
              label: f.label,
              value: extra[f.key] ?? '',
              onChange: (v) => setExtra({ ...extra, [f.key]: v }),
            })
          : h(
              Field,
              { key: f.key, label: f.label, htmlFor: `devboard-${f.key}-${item.id}` },
              h('input', {
                id: `devboard-${f.key}-${item.id}`,
                className: 'devboard-note',
                value: extra[f.key] ?? '',
                maxLength: f.max ?? 500,
                onChange: (e) => setExtra({ ...extra, [f.key]: e.target.value }),
              }),
            ),
    ),
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
              verb(from, to, kind),
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
          ...others.map((s) => ({ value: s, label: data.labels.state[s] ?? s })),
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
