import { homeNavigation } from '@agnes/web-client'
import { Badge, Button, Select } from '@agnes/web-ui'
import React from 'react'
import { byId, day, gateBadge, gateName, h, options, resubmitted, stageName, stateBadge } from './board.js'

// 研发全景: one lane per project (or per blocking role / discipline), like `git log --graph` over a
// timeline. Plain SVG and CSS; every node is a keyboard-focusable button that opens the drawer.

const DAY = 86_400_000
const ROW = 28
const TRUNK = 52
const GROUP = 26
const VIEWS = { project: '按项目', role: '按卡点责任角色', discipline: '按专业' }
const RANGES = { week: '周', month: '月', all: '全程' }
/** Where a record lives in the other pages. */
const PAGE_OF = {
  gate: 'devboard-reviews',
  approval: 'devboard-reviews',
  stage: 'devboard-projects',
  trial: 'trials',
  change: 'devboard-changes',
  problem: 'service',
  baseline: 'devboard-projects',
}
/** Snapshot collection holding each selectable record type (anything else is a blocker). */
const LIST_OF = { stage: 'stages', gate: 'gates', change: 'changes', problem: 'problems', trial: 'trials' }
const DISCIPLINES = ['机械', '电气', '软件', '试验', '质量', '综合']
const DISCIPLINE_OF = {
  机械设计师: '机械',
  电气设计师: '电气',
  软件设计师: '软件',
  系统设计师: '软件',
  验证工程师: '试验',
  质量工程师: '质量',
  'RAMS 工程师': '质量',
}
const disciplineOf = (b) => (b.kind === 'TRIAL_FAILED' ? '试验' : (DISCIPLINE_OF[b.role] ?? '综合'))
const CLOSED_CHANGE = ['CLOSED', 'IMPLEMENTED', 'REJECTED']
const ms = (iso) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const md = (t) => `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`

function useWidth() {
  const ref = React.useRef(null)
  const [width, setWidth] = React.useState(1000)
  React.useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/** Branches of one project: changes, field problems and failed-trial retests. */
function branchesOf(data, project, now) {
  const stages = data.stages.filter((s) => s.projectId === project.id)
  const stageAt = (t) =>
    (stages.find((s) => t <= (ms(s.actualEnd ?? s.plannedEnd) ?? 0)) ?? stages.at(-1))?.stage
  const blocked = (id) => data.blockers.some((b) => b.ref.id === id)
  const out = []
  for (const c of data.changes.filter((x) => x.projectId === project.id)) {
    const from = ms(c.history?.[0]?.at)
    if (from === undefined) continue
    const closed = CLOSED_CHANGE.includes(c.state)
    out.push({
      type: 'change',
      id: c.id,
      label: c.id,
      from,
      to: closed ? (ms(c.history.at(-1).at) ?? now) : now,
      fork: c.reworked?.[0]?.split('/')[1] ?? stageAt(from),
      tone: c.state === 'REJECTED' ? 'off' : closed ? 'ok' : 'warn',
      merged: closed && c.state !== 'REJECTED',
      bad: blocked(c.id),
      nodes: [],
    })
  }
  const gap = data.blockers.some((b) => b.projectId === project.id && b.kind === 'BASELINE_GAP')
  for (const p of data.problems.filter((x) => x.projectId === project.id)) {
    const from = ms(p.history?.[0]?.at)
    if (from === undefined) continue
    const closed = p.state === 'CLOSED'
    const change = p.changeId && byId(data.changes, p.changeId)
    const nodes = []
    const analyzing = p.history.find((e) => e.to === 'ANALYZING')
    if (analyzing) nodes.push({ at: ms(analyzing.at), text: '8D' })
    if (change?.history?.[0]) nodes.push({ at: ms(change.history[0].at), text: 'ECR' })
    const approved = change?.history?.find((e) => e.to === 'APPROVED')
    if (approved) nodes.push({ at: ms(approved.at), text: 'ECN' })
    out.push({
      type: 'problem',
      id: p.id,
      label: p.id,
      from,
      to: closed ? (ms(p.history.at(-1).at) ?? now) : now,
      fork: stageAt(from),
      tone: closed ? 'ok' : 'warn',
      merged: closed,
      mergeText: closed && !gap ? '基线追平' : '',
      bad: blocked(p.id) || (closed && gap),
      nodes,
    })
  }
  for (const t of data.trials.filter((x) => x.projectId === project.id)) {
    const retest = t.history?.some((e) => e.from === 'REPORTED' && e.to === 'IN_PROGRESS')
    if (t.result !== 'FAIL' && !retest) continue
    const from = ms(t.at) ?? ms(t.plannedAt)
    if (from === undefined) continue
    const approved = t.state === 'APPROVED'
    out.push({
      type: 'trial',
      id: t.id,
      label: `${t.id}${t.result === 'FAIL' ? ' 不合格' : ' 补试'}`,
      from,
      to: approved ? (ms(t.history.at(-1).at) ?? now) : now,
      fork: stageAt(from),
      tone: approved ? 'ok' : 'bad',
      merged: approved,
      bad: blocked(t.id),
      nodes: [],
    })
  }
  return out.sort((a, b) => a.from - b.from)
}

/** Everything the drawer shows for the selected node. */
function describeSelection(data, sel) {
  const rows = []
  const blockers = []
  let title = sel.id
  let badge = null
  let page = PAGE_OF[sel.type]
  const stageOfId = (id) => byId(data.stages, id)
  if (sel.type === 'stage') {
    const s = stageOfId(sel.id)
    const p = byId(data.projects, s.projectId)
    title = `${p.id} · ${stageName(data, p.id, s.stage)}`
    badge = stateBadge(data, s.state)
    rows.push(['项目', p.name], ['负责人', s.author ?? p.manager])
    rows.push(['计划完成', day(s.plannedEnd)], ['实际完成', day(s.actualEnd)])
    for (const g of data.gates.filter((x) => x.stageId === s.id && !x.superseded && !resubmitted(data, x)))
      rows.push([gateName(g), gateBadge(data, g.decision)])
    blockers.push(...data.blockers.filter((b) => b.projectId === p.id && b.stage === s.stage))
  } else if (sel.type === 'gate') {
    const g = byId(data.gates, sel.id)
    const s = stageOfId(g.stageId)
    title = gateName(g)
    badge = gateBadge(data, g.decision)
    rows.push(['项目', byId(data.projects, s.projectId).name])
    rows.push(['审批角色', g.approverRoles.join('、')])
    rows.push(['已签', (g.signatures ?? []).map((x) => x.role).join('、') || '—'])
    rows.push(['未关闭意见', String((g.findings ?? []).filter((f) => !f.closed).length)])
    rows.push(['决议时间', day(g.decidedAt)])
    blockers.push(...data.blockers.filter((b) => b.ref.id === g.id))
  } else if (sel.type === 'change') {
    const c = byId(data.changes, sel.id)
    title = `${c.id} ${c.title}`
    badge = stateBadge(data, c.state)
    rows.push(
      ['提出人', c.raisedBy],
      ['来源', `${data.labels.changeSource[c.source?.type] ?? '—'} ${c.source?.ref ?? ''}`],
    )
    rows.push(
      ['ECN', c.ecn ?? '—'],
      ['返工阶段', (c.reworked ?? []).map((id) => id.split('/')[1]).join('、') || '—'],
    )
    blockers.push(...data.blockers.filter((b) => b.ref.id === c.id))
  } else if (sel.type === 'problem') {
    const p = byId(data.problems, sel.id)
    title = `${p.id} ${p.title}`
    badge = stateBadge(data, p.state)
    rows.push(['负责人', p.owner ?? '—'], ['严重度', p.severity ?? '—'])
    rows.push(['8D 进度', `${Object.values(p.steps ?? {}).filter((s) => s.done).length}/8`])
    rows.push(['关联变更', p.changeId ?? '—'])
    blockers.push(...data.blockers.filter((b) => b.ref.id === p.id))
    const project = byId(data.projects, p.projectId)
    blockers.push(...data.blockers.filter((b) => b.projectId === project?.id && b.kind === 'BASELINE_GAP'))
  } else if (sel.type === 'trial') {
    const t = byId(data.trials, sel.id)
    title = `${t.id} ${t.title}`
    badge = stateBadge(data, t.state)
    rows.push(
      ['类型', data.labels.trialType[t.type]],
      ['结论', data.labels.trialResult[t.result] ?? t.result],
    )
    rows.push(['试验室', t.lab ?? '—'], ['关联变更', t.changeId ?? '—'], ['试验日期', day(t.at)])
    blockers.push(...data.blockers.filter((b) => b.ref.id === t.id))
  } else {
    const b = byId(data.blockers, sel.id)
    title = b.title
    badge = h(Badge, { tone: b.kind.endsWith('OVERDUE') ? 'bad' : 'warn' }, b.label)
    page = PAGE_OF[b.ref.type]
    rows.push(['项目', byId(data.projects, b.projectId)?.name ?? b.projectId], ['责任角色', b.role])
    rows.push(['等待', `${b.days} 天`], ['起算', day(b.since)])
    blockers.push(b)
  }
  return { title, badge, rows, blockers, page }
}

function Drawer({ data, sel, onClose }) {
  const { title, badge, rows, blockers, page } = describeSelection(data, sel)
  const jump = () => {
    try {
      homeNavigation.open(page)
    } catch {}
  }
  return h(
    'aside',
    { className: 'pano-drawer', 'aria-label': '节点详情' },
    h(
      'div',
      { className: 'pano-drawer-head' },
      h('strong', null, title),
      h(Button, { size: 'small', onClick: onClose, 'aria-label': '关闭详情' }, '关闭'),
    ),
    badge,
    h(
      'dl',
      { className: 'pano-facts' },
      rows.map(([k, v]) => h(React.Fragment, { key: k }, h('dt', null, k), h('dd', null, v))),
    ),
    h('h3', { className: 'pano-drawer-sub' }, `卡点原因（${blockers.length}）`),
    blockers.length
      ? h(
          'ul',
          { className: 'pano-reasons' },
          blockers.map((b) =>
            h(
              'li',
              { key: b.id },
              h(Badge, { tone: 'bad' }, b.role),
              ` ${b.reason}${b.days ? `（${b.days} 天）` : ''}`,
            ),
          ),
        )
      : h('p', { className: 'devboard-muted' }, '当前没有卡点。'),
    page && h(Button, { appearance: 'primary', onClick: jump }, '前往对应页面'),
  )
}

/** A focusable SVG node. */
function Node({ x, y, shape = 'circle', r = 7, cls, title, onPick, selected }) {
  const key = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick()
    }
  }
  const body =
    shape === 'diamond'
      ? h('path', { d: `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z` })
      : shape === 'square'
        ? h('rect', { x: x - r, y: y - r, width: 2 * r, height: 2 * r, rx: 2 })
        : h('circle', { cx: x, cy: y, r })
  return h(
    'g',
    {
      className: `pano-node ${cls}${selected ? ' is-selected' : ''}`,
      tabIndex: 0,
      role: 'button',
      'aria-label': title,
      'aria-pressed': Boolean(selected),
      onClick: onPick,
      onKeyDown: key,
    },
    h('title', null, title),
    body,
  )
}

export function Panorama({ data, role: demoRole }) {
  const [view, setView] = React.useState('project')
  const [range, setRange] = React.useState('all')
  const [kind, setKind] = React.useState('')
  const [org, setOrg] = React.useState('')
  const [onlyBlocked, setOnlyBlocked] = React.useState(false)
  const blockers = data.blockers ?? []
  // The blocker role filter starts at the demo role (none when it has no blockers) and again when the demo role changes.
  const fallback = blockers.some((b) => b.role === demoRole) ? demoRole : ''
  const [picked, setPicked] = React.useState({ demo: demoRole, role: fallback })
  // Adjusting state while rendering: leaving a demo role drops its pick, so coming back to it starts at the demo role.
  if (picked.demo !== demoRole) setPicked({ demo: demoRole, role: fallback })
  const role = picked.demo === demoRole ? picked.role : fallback
  const setRole = (next) => setPicked({ demo: demoRole, role: next })
  const [open, setOpen] = React.useState({})
  const [sel, setSel] = React.useState(null)
  const [wrap, width] = useWidth()
  const now = Date.parse(data.now)
  const scoped = data.projects.filter((p) => (!kind || p.kind === kind) && (!org || p.org === org))
  const scopedIds = new Set(scoped.map((p) => p.id))
  const inScope = blockers.filter((b) => scopedIds.has(b.projectId))
  const shown = role ? inScope.filter((b) => b.role === role) : inScope
  const roleCounts = Object.entries(
    inScope.reduce((m, b) => Object.assign(m, { [b.role]: (m[b.role] ?? 0) + 1 }), {}),
  ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
  const withBlockers = new Set(shown.map((b) => b.projectId))
  const projects = scoped.filter((p) => !(onlyBlocked || role) || withBlockers.has(p.id))
  const view2 = { ...data, blockers }
  const pick = (type, id) => () => setSel({ type, id })
  // A record can vanish from the snapshot (gate signed, board reset): then nothing is selected.
  const shownSel = sel && byId(view2[LIST_OF[sel.type] ?? 'blockers'] ?? [], sel.id) ? sel : null

  // Plot geometry.
  const W = Math.max(width, 620)
  const LABEL = W < 700 ? 128 : 208
  const X0 = LABEL + 12
  const X1 = W - 16
  const stamps = [now]
  for (const p of projects) stamps.push(ms(p.plannedStart), ms(p.plannedEnd))
  for (const s of data.stages) if (scopedIds.has(s.projectId)) stamps.push(ms(s.plannedEnd), ms(s.actualEnd))
  for (const b of shown) stamps.push(ms(b.since))
  const known = stamps.filter((t) => t !== undefined)
  const pad = 14 * DAY
  const [w0, w1] =
    range === 'week'
      ? [now - 7 * DAY, now + 21 * DAY]
      : range === 'month'
        ? [now - 30 * DAY, now + 90 * DAY]
        : [Math.min(...known) - pad, Math.max(...known) + pad]
  const X = (t) => X0 + ((t - w0) / (w1 - w0)) * (X1 - X0)
  const visible = (t) => t >= w0 && t <= w1
  const cx = (t) => Math.max(X0, Math.min(X1, X(t)))

  // A narrow window scrolls the plot: keep today in view when the view, range or width changes.
  const todayX = X(now)
  React.useEffect(() => {
    const el = wrap.current
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, todayX - el.clientWidth / 2)
  }, [view, range, W, wrap, todayX])

  // Ticks: Mondays for the week window, month starts (every n-th) otherwise.
  const ticks = []
  if (range === 'week') {
    const d = new Date(w0)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7))
    if (d.getTime() < w0) d.setDate(d.getDate() + 7)
    for (let t = d.getTime(); t <= w1; t += 7 * DAY) ticks.push([t, md(t)])
  } else {
    const months = Math.ceil((w1 - w0) / (30 * DAY))
    const stride = Math.max(1, Math.ceil(months / Math.max(3, Math.floor((X1 - X0) / 78))))
    const d = new Date(w0)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    for (let i = 0; d.getTime() <= w1; d.setMonth(d.getMonth() + 1), i++)
      if (d.getTime() >= w0 && i % stride === 0)
        ticks.push([d.getTime(), `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`])
  }

  // Lanes → rows.
  const rows = []
  if (view === 'project') {
    for (const g of [...new Set(projects.map((p) => p.org))]) {
      rows.push({ type: 'group', label: g })
      for (const p of projects.filter((x) => x.org === g)) {
        const branches = branchesOf(view2, p, now)
        const expanded = Boolean(open[p.id]) && branches.length > 0
        rows.push({
          type: 'project',
          project: p,
          branches,
          expanded,
          height: TRUNK + (expanded ? 20 + branches.length * ROW : 0),
        })
      }
    }
  } else {
    const keyOf = view === 'role' ? (b) => b.role : disciplineOf
    const names =
      view === 'role'
        ? [...new Set(shown.map(keyOf))]
        : DISCIPLINES.filter((d) => shown.some((b) => disciplineOf(b) === d))
    names.sort((a, b) =>
      view === 'role'
        ? shown.filter((x) => keyOf(x) === b).length - shown.filter((x) => keyOf(x) === a).length
        : 0,
    )
    for (const name of names) {
      const list = shown
        .filter((b) => keyOf(b) === name)
        .sort((a, b) => (ms(a.since) ?? now) - (ms(b.since) ?? now))
      rows.push({ type: 'lane', name, list, height: 12 + list.length * ROW })
    }
  }
  let y = 30
  for (const r of rows) {
    r.y = y
    y += r.type === 'group' ? GROUP : r.height + 6
  }
  const H = y + 18

  const drawProject = (r) => {
    const p = r.project
    const ty = r.y + 26
    const stages = data.stages.filter((s) => s.projectId === p.id)
    const pBlockers = shown.filter((b) => b.projectId === p.id)
    const dim = role && !pBlockers.length
    const lastPassed = Math.max(
      ...stages.filter((s) => s.state === 'PASSED').map((s) => ms(s.actualEnd ?? s.plannedEnd) ?? 0),
      ms(p.plannedStart) ?? 0,
    )
    const end = ms(p.plannedEnd) ?? now
    const start = ms(p.plannedStart) ?? now
    const name = clip(p.name, Math.floor((LABEL - 10) / 12))
    const togW = LABEL < 150 ? 40 : 74
    const out = [
      h(
        'g',
        { key: 'label', className: dim ? 'pano-dim' : undefined },
        h('text', { x: 4, y: r.y + 13, className: 'pano-id' }, p.id),
        h('text', { x: 4, y: r.y + 29, className: 'pano-name' }, h('title', null, p.name), name),
        h(
          'text',
          { x: 4, y: r.y + 44, className: 'pano-sub' },
          clip(
            `${data.labels.projectKind[p.kind] ?? p.kind} · ${stageName(data, p.id, p.stage)}`,
            Math.floor((LABEL - togW - 12) / 10),
          ),
        ),
      ),
    ]
    if (pBlockers.length)
      out.push(
        h(
          'text',
          { key: 'cnt', x: LABEL - 4, y: r.y + 13, textAnchor: 'end', className: 'pano-bad-text' },
          `卡点 ${pBlockers.length}`,
        ),
      )
    if (r.branches.length)
      out.push(
        h(
          'g',
          {
            key: 'tog',
            className: 'pano-toggle',
            tabIndex: 0,
            role: 'button',
            'aria-expanded': r.expanded,
            'aria-label': `${r.expanded ? '折叠' : '展开'} ${p.id} 的分支`,
            onClick: () => setOpen({ ...open, [p.id]: !r.expanded }),
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setOpen({ ...open, [p.id]: !r.expanded })
              }
            },
          },
          h('rect', { x: LABEL - togW, y: r.y + 33, width: togW, height: 18, rx: 4 }),
          h(
            'text',
            { x: LABEL - togW / 2, y: r.y + 45, textAnchor: 'middle' },
            `${r.expanded ? '▾' : '▸'} ${togW > 50 ? '分支 ' : ''}${r.branches.length}`,
          ),
        ),
      )
    const drawn = []
    drawn.push(
      h('line', {
        key: 'trunk0',
        x1: cx(start),
        x2: cx(lastPassed),
        y1: ty,
        y2: ty,
        className: 'pano-trunk',
      }),
    )
    drawn.push(
      h('line', {
        key: 'trunk1',
        x1: cx(lastPassed),
        x2: cx(end),
        y1: ty,
        y2: ty,
        className: 'pano-trunk is-planned',
      }),
    )
    let lastGateX = -99
    let lastLabelX = -99
    for (const s of stages) {
      const t = ms(s.actualEnd ?? s.plannedEnd)
      if (t === undefined) continue
      const bad = pBlockers.some((b) => b.stage === s.stage)
      const cls = `${s.state === 'PASSED' ? 'is-done' : s.state === 'NOT_STARTED' ? 'is-todo' : 'is-active is-pulse'}${bad ? ' is-bad' : ''}`
      for (const g of data.gates.filter((x) => x.stageId === s.id)) {
        const gt = ms(g.decidedAt) ?? Math.min(now, t)
        if (!visible(gt)) continue
        let gx = X(gt)
        if (Math.abs(gx - lastGateX) < 10) gx += 10
        lastGateX = gx
        const gBad = pBlockers.some((b) => b.ref.id === g.id)
        const history = g.superseded || resubmitted(data, g)
        const gCls = `${history ? 'is-todo is-faded' : g.decision === 'APPROVED' ? 'is-done' : g.decision === 'PENDING' ? 'is-active is-pulse' : 'is-bad'}${gBad ? ' is-bad' : ''}`
        drawn.push(
          h(Node, {
            key: g.id,
            x: gx,
            y: ty - 15,
            shape: 'diamond',
            r: 5,
            cls: gCls,
            title: `${gateName(g)} · ${g.superseded ? '已作废（返工）' : history ? '已驳回（已重新提交）' : (data.labels.state[g.decision] ?? '待决议')}`,
            selected: sel?.id === g.id,
            onPick: pick('gate', g.id),
          }),
        )
      }
      if (!visible(t)) continue
      drawn.push(
        h(Node, {
          key: s.id,
          x: X(t),
          y: ty,
          r: 8,
          cls,
          title: `${stageName(data, p.id, s.stage)} · ${data.labels.state[s.state]}`,
          selected: sel?.id === s.id,
          onPick: pick('stage', s.id),
        }),
      )
      if (X(t) - lastLabelX >= 46) {
        lastLabelX = X(t)
        drawn.push(
          h(
            'text',
            { key: `${s.id}-t`, x: X(t), y: ty + 22, textAnchor: 'middle', className: 'pano-tick-label' },
            data.labels.stage[s.stage],
          ),
        )
      }
    }
    if (!r.expanded)
      for (const b of r.branches) {
        if (!visible(b.from)) continue
        drawn.push(
          h(
            'rect',
            {
              key: `m-${b.id}`,
              x: X(b.from) - 3,
              y: ty + 11,
              width: 6,
              height: 6,
              className: `pano-mark pano-tone-${b.bad ? 'bad' : b.tone}`,
            },
            h('title', null, `${b.label}（展开分支查看）`),
          ),
        )
      }
    out.push(h('g', { key: 'trunk', className: dim ? 'pano-dim' : undefined }, drawn))
    if (r.expanded) {
      r.branches.forEach((b, i) => {
        const by = ty + 46 + i * ROW
        const x0 = cx(b.from)
        const x1 = cx(b.to)
        const tone = b.bad ? 'bad' : b.tone
        const d = `M${x0} ${ty}C${x0} ${by} ${x0} ${by} ${x0 + 9} ${by}L${Math.max(x0 + 9, x1 - 9)} ${by}${b.merged ? `C${x1} ${by} ${x1} ${by} ${x1} ${ty}` : ''}`
        out.push(
          h(
            'g',
            { key: `b-${b.id}`, className: `pano-branch pano-tone-${tone}` },
            h('path', { d, className: b.merged ? '' : 'is-open' }),
            ...b.nodes
              .filter(
                (n, k, all) =>
                  n.at !== undefined &&
                  visible(n.at) &&
                  (k === 0 || Math.abs(X(n.at) - X(all[k - 1].at)) > 20),
              )
              .map((n) =>
                h(
                  'g',
                  { key: `${n.text}-${n.at}` },
                  h('circle', { cx: X(n.at), cy: by, r: 3 }),
                  h(
                    'text',
                    { x: X(n.at), y: by + 12, textAnchor: 'middle', className: 'pano-tick-label' },
                    n.text,
                  ),
                ),
              ),
            b.mergeText &&
              h(
                'text',
                { x: x1 - 4, y: by - 6, textAnchor: 'end', className: 'pano-tick-label' },
                b.mergeText,
              ),
            h(Node, {
              x: x0 + 9,
              y: by,
              r: 5,
              shape: 'square',
              cls: `is-tone-${tone}${b.merged ? '' : ' is-pulse'}`,
              title: `${b.label} · ${b.fork ? `从「${data.labels.stage[b.fork] ?? b.fork}」分出` : ''}`,
              selected: sel?.id === b.id,
              onPick: pick(b.type, b.id),
            }),
            h('text', { x: x0 + 18, y: by - 7, className: 'pano-branch-label' }, b.label),
          ),
        )
      })
    }
    return out
  }

  const drawLane = (r) => {
    const out = [
      h(
        'text',
        { key: 'n', x: 4, y: r.y + 20, className: 'pano-name' },
        clip(r.name, Math.floor((LABEL - 10) / 12)),
      ),
      h('text', { key: 'c', x: 4, y: r.y + 36, className: 'pano-bad-text' }, `卡点 ${r.list.length}`),
    ]
    r.list.forEach((b, i) => {
      const by = r.y + 12 + i * ROW + 10
      const t = ms(b.since) ?? now
      const x0 = cx(t)
      const bad = b.kind.endsWith('OVERDUE') || b.kind === 'STAGE_OVERDUE'
      const right = x0 > (X0 + X1) / 2
      const proj = byId(data.projects, b.projectId)
      out.push(
        h(
          'g',
          { key: b.id, className: `pano-wait pano-tone-${bad ? 'bad' : 'warn'}` },
          h('line', { x1: x0, x2: cx(now), y1: by, y2: by }),
          h(Node, {
            x: x0,
            y: by,
            r: 5,
            cls: `is-tone-${bad ? 'bad' : 'warn'}`,
            title: `${b.label} · ${b.title} · ${proj?.id ?? ''} · 等待 ${b.days} 天`,
            selected: sel?.id === b.id,
            onPick: pick('blocker', b.id),
          }),
          h(
            'text',
            {
              x: right ? x0 - 9 : x0 + 9,
              y: by - 7,
              textAnchor: right ? 'end' : 'start',
              className: 'pano-branch-label',
            },
            `${b.label} · ${proj?.id ?? ''} · ${b.days} 天`,
          ),
        ),
      )
    })
    return out
  }

  const toolbar = h(
    'div',
    { className: 'devboard-filters', role: 'group', 'aria-label': '视图与筛选' },
    h(Segment, { value: view, set: setView, items: VIEWS, label: '视图' }),
    h(Segment, { value: range, set: setRange, items: RANGES, label: '时间范围' }),
    h(Select, {
      'aria-label': '项目类型',
      value: kind,
      onChange: setKind,
      options: options(data.labels.projectKind, '全部项目类型'),
      style: { minWidth: 150 },
    }),
    h(Select, {
      'aria-label': '归属技术中心',
      value: org,
      onChange: setOrg,
      options: [{ value: '', label: '全部技术中心' }, ...data.orgs.map((o) => ({ value: o, label: o }))],
      style: { minWidth: 190 },
    }),
    h(
      'label',
      { className: 'pano-check' },
      h('input', {
        type: 'checkbox',
        checked: onlyBlocked,
        onChange: (e) => setOnlyBlocked(e.target.checked),
      }),
      '只看卡点',
    ),
  )

  const summary = h(
    'section',
    { className: 'pano-summary', 'aria-label': '卡点汇总' },
    h('strong', null, `卡点 ${inScope.length}`),
    roleCounts.length
      ? roleCounts.map(([r, n]) =>
          h(
            'button',
            {
              type: 'button',
              key: r,
              className: `pano-chip${role === r ? ' is-on' : ''}`,
              'aria-pressed': role === r,
              onClick: () => setRole(role === r ? '' : r),
            },
            `${r} `,
            h('b', null, n),
          ),
        )
      : h('span', { className: 'devboard-muted' }, '当前没有卡点。'),
    role && h(Button, { size: 'small', onClick: () => setRole('') }, '清除角色筛选'),
  )

  const legend = h(
    'p',
    { className: 'devboard-muted pano-legend' },
    '实心：已通过 · 空心：未到 · 脉动：进行中或评审中 · 红色：卡住 · 菱形：评审门 · 方块：分支（变更、质量问题、试验补试） · 竖线：今天',
  )

  return h(
    'div',
    { className: 'pano', onKeyDown: (e) => e.key === 'Escape' && setSel(null) },
    summary,
    toolbar,
    h(
      'div',
      { className: `pano-body${sel ? ' has-drawer' : ''}` },
      h(
        'div',
        { className: 'pano-plot', ref: wrap, 'data-guide': 'panorama-lanes' },
        rows.length
          ? h(
              'svg',
              {
                className: 'pano-svg',
                width: W,
                height: H,
                viewBox: `0 0 ${W} ${H}`,
                role: 'group',
                'aria-label': `研发全景（${VIEWS[view]}）`,
              },
              h(
                'g',
                { className: 'pano-axis' },
                ticks.map(([t, text]) =>
                  h(
                    'g',
                    { key: t },
                    h('line', { x1: X(t), x2: X(t), y1: 22, y2: H }),
                    h('text', { x: X(t), y: 14, textAnchor: 'middle' }, text),
                  ),
                ),
              ),
              rows.map((r) =>
                r.type === 'group'
                  ? h('text', { key: `g-${r.label}`, x: 4, y: r.y + 16, className: 'pano-group' }, r.label)
                  : h(
                      'g',
                      { key: r.project?.id ?? r.name },
                      r.type === 'project' ? drawProject(r) : drawLane(r),
                    ),
              ),
              visible(now) &&
                h(
                  'g',
                  { className: 'pano-today' },
                  h('line', { x1: X(now), x2: X(now), y1: 20, y2: H - 14 }),
                  h('text', { x: X(now), y: H - 3, textAnchor: 'middle' }, `今天 ${md(now)}`),
                ),
            )
          : h('p', { className: 'devboard-muted', role: 'status' }, '没有符合筛选条件的项目或卡点。'),
      ),
      shownSel && h(Drawer, { data: view2, sel: shownSel, onClose: () => setSel(null) }),
    ),
    legend,
  )
}

function Segment({ value, set, items, label }) {
  return h(
    'div',
    { className: 'pano-segment', role: 'group', 'aria-label': label },
    Object.entries(items).map(([k, text]) =>
      h(
        'button',
        {
          type: 'button',
          key: k,
          className: value === k ? 'is-on' : '',
          'aria-pressed': value === k,
          onClick: () => set(k),
        },
        text,
      ),
    ),
  )
}
