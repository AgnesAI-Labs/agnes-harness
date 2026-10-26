// DevBoard blockers: everything currently standing in a project's way, derived from state on every
// read and never stored. One blocker = one role that has to act, so "who is in the way" is a group-by.
// No host imports and no import of domain.mjs (which includes this in its snapshot).
import { isOverdue, waitingRoles } from './approvals.mjs'
import { ROLES } from './profiles.mjs'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ANALYZING_LIMIT_DAYS = 7

/** Kinds in display order; every blocker carries its kind's label. */
export const BLOCKER_KINDS = Object.freeze({
  GATE_PENDING: { label: '评审门待决议' },
  GATE_FINDING: { label: '评审意见未关闭' },
  STAGE_OVERDUE: { label: '阶段超期' },
  APPROVAL_ACTIVE: { label: '审批待处理' },
  APPROVAL_OVERDUE: { label: '审批超时' },
  TRIAL_FAILED: { label: '试验不合格未立变更' },
  CHANGE_CCB: { label: '变更待 CCB' },
  PROBLEM_STALLED: { label: '质量问题分析超期' },
  BASELINE_GAP: { label: '整改未完成' },
})

const roleOf = (by) => {
  const text = String(by ?? '').trim()
  return ROLES.find((r) => text === r || text.startsWith(`${r} `)) ?? text.split(/\s+/)[0] ?? ''
}
const ms = (iso) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}
/** When the item last moved into `to`, or undefined; a note kept without a move is not an entry. */
const enteredAt = (item, to) =>
  [...(item.history ?? [])].reverse().find((e) => e.to === to && e.from !== to)?.at
const latest = (list, projectId, type) =>
  list
    .filter((b) => b.projectId === projectId && b.type === type)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]

/**
 * Every blocker in `state` at `now` (ms), oldest first within a kind. `projectId` narrows the result.
 * Approvals are read only when the state carries them, so older stores and seeds still work.
 */
export function blockers(state, now = Date.now(), projectId) {
  const out = []
  const projects = state.projects ?? []
  const projectOf = (id) => projects.find((p) => p.id === id)
  const add = (kind, projectId, role, ref, title, reason, since, extra = {}) => {
    const t = ms(since)
    out.push({
      id: `${kind}:${ref.id}${ref.sub ? `:${ref.sub}` : ''}:${role}`,
      kind,
      label: BLOCKER_KINDS[kind].label,
      projectId,
      role,
      ref,
      title,
      reason,
      since: t === undefined ? undefined : new Date(t).toISOString(),
      days: t === undefined ? 0 : Math.max(0, Math.floor((now - t) / DAY)),
      ...extra,
    })
  }
  const stageById = (id) => (state.stages ?? []).find((s) => s.id === id)
  const ownerRole = (stage, project) => stage?.author || roleOf(project?.manager)

  // Submitting a stage again opens a new gate: the rejected one's open findings are history then.
  const newest = new Map((state.gates ?? []).map((g) => [g.stageId, g]))
  for (const g of state.gates ?? []) {
    if (g.superseded || (g.decision === 'REJECTED' && newest.get(g.stageId) !== g)) continue
    const stage = stageById(g.stageId)
    const project = projectOf(stage?.projectId ?? g.stageId.split('/')[0])
    if (!project) continue
    const name = `${g.code} · ${g.name}`
    if (g.decision === 'PENDING') {
      const signed = (g.signatures ?? []).map((s) => s.role)
      for (const role of g.approverRoles.filter((r) => !signed.includes(r)))
        add(
          'GATE_PENDING',
          project.id,
          role,
          { type: 'gate', id: g.id },
          name,
          `评审门待 ${role} 签署`,
          enteredAt(stage ?? {}, 'IN_REVIEW'),
          { stage: stage?.stage },
        )
    }
    for (const f of (g.findings ?? []).filter((x) => !x.closed))
      add(
        'GATE_FINDING',
        project.id,
        ownerRole(stage, project),
        { type: 'gate', id: g.id, sub: f.id },
        name,
        `评审意见 ${f.id} 未关闭：${f.text}`,
        f.at,
        { stage: stage?.stage },
      )
  }

  for (const s of state.stages ?? []) {
    const project = projectOf(s.projectId)
    const due = ms(s.plannedEnd)
    if (!project || s.state === 'PASSED' || due === undefined || due >= now) continue
    add(
      'STAGE_OVERDUE',
      project.id,
      ownerRole(s, project),
      { type: 'stage', id: s.id },
      s.stage,
      `计划完成日 ${s.plannedEnd.slice(0, 10)} 已过，阶段尚未通过`,
      s.plannedEnd,
      { stage: s.stage },
    )
  }

  for (const a of state.approvals ?? []) {
    const node = a.nodes?.[a.current]
    const waiting = waitingRoles(a)
    if (!waiting.length) continue
    const overdue = isOverdue(a, node, now)
    const due = ms(node.enteredAt) + node.dueHours * HOUR
    for (const role of waiting)
      add(
        overdue ? 'APPROVAL_OVERDUE' : 'APPROVAL_ACTIVE',
        a.projectId,
        role,
        { type: 'approval', id: a.id },
        a.title ?? a.id,
        `审批节点「${node.name}」待 ${role} 处理${overdue ? `，已超时 ${Math.floor((now - due) / HOUR)} 小时` : ''}`,
        node.enteredAt,
        { overdue },
      )
  }

  for (const t of state.trials ?? []) {
    const change = t.changeId && (state.changes ?? []).find((c) => c.id === t.changeId)
    // A change the CCB rejected never releases the trial, so it stands as no change.
    const rejected = change && (change.state === 'REJECTED' || change.ccb?.decision === 'REJECTED')
    if (t.result !== 'FAIL' || t.state === 'APPROVED' || (change && !rejected)) continue
    add(
      'TRIAL_FAILED',
      t.projectId,
      '质量工程师',
      { type: 'trial', id: t.id },
      t.title ?? t.id,
      rejected ? `型式试验不合格，关联变更 ${change.id} 已驳回` : '型式试验不合格，尚未关联变更',
      enteredAt(t, 'REPORTED') ?? t.at,
    )
  }

  for (const c of state.changes ?? []) {
    if (c.state !== 'CCB_REVIEW') continue
    add(
      'CHANGE_CCB',
      c.projectId,
      '项目经理',
      { type: 'change', id: c.id },
      c.title,
      `${c.id} 已提交 CCB，待决议`,
      enteredAt(c, 'CCB_REVIEW'),
    )
  }

  for (const p of state.problems ?? []) {
    const since = enteredAt(p, 'ANALYZING')
    if (p.state !== 'ANALYZING' || ms(since) === undefined || now - ms(since) <= ANALYZING_LIMIT_DAYS * DAY)
      continue
    add(
      'PROBLEM_STALLED',
      p.projectId,
      roleOf(p.owner) || '质量工程师',
      { type: 'problem', id: p.id },
      p.title,
      `停在 ANALYZING 已超过 ${ANALYZING_LIMIT_DAYS} 天`,
      since,
    )
  }

  const baselines = state.configBaselines ?? []
  for (const project of projects) {
    const designed = latest(baselines, project.id, 'AS_DESIGNED')?.revs ?? {}
    const maintained = latest(baselines, project.id, 'AS_MAINTAINED')?.revs
    if (!maintained) continue
    const gap = Object.keys(designed).filter((id) => maintained[id] !== designed[id])
    if (gap.length)
      add(
        'BASELINE_GAP',
        project.id,
        '配置管理员',
        { type: 'baseline', id: project.id },
        project.name,
        `维护态落后设计态 ${gap.length} 项：${gap.join('、')}`,
        latest(baselines, project.id, 'AS_DESIGNED').at,
      )
  }

  const order = Object.keys(BLOCKER_KINDS)
  return out
    .filter((b) => !projectId || b.projectId === projectId)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.days - a.days)
}
