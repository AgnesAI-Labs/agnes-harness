// DevBoard domain: the R&D lifecycle (projects, stages, review gates, traceability, changes, defects,
// test runs), trials, the field-to-design loop (faults, quality problems, configuration baselines) plus
// the v1 requirement / task / human-intervention machines, derived metrics and store persistence.
// No host imports, so tests run against a plain in-memory store.
import { readFileSync } from 'node:fs'
import { TEMPLATES } from './approval-templates.mjs'
import { act, DomainError, FLOW_LABELS, newFlow, roleOf, view } from './approvals.mjs'
import { blockers } from './blockers.mjs'
import { GATE_PROFILES, LIVE_TAILORING, ORGS, ROLES } from './profiles.mjs'
import { buildSeed } from './seed-data.mjs'

export { DomainError, roleOf }

export const STAGES = ['INITIATION', 'REQUIREMENTS', 'DESIGN', 'IMPLEMENTATION', 'VERIFICATION', 'RELEASE']
export const LEVELS = ['CUS', 'SYS', 'SWR', 'DES', 'TC']
const PARENT_LEVEL = { SYS: 'CUS', SWR: 'SYS', DES: 'SWR', TC: 'SWR' }
/** SWR-level items carry a discipline prefix: software, mechanical or electrical. */
const SWR_PREFIX_DISCIPLINE = { SWR: 'SW', MER: 'MECH', EER: 'ELEC' }
const DISCIPLINES = ['MECH', 'ELEC', 'SW']
const COMPLIANCE = ['COMPLY', 'DEVIATE', 'CLARIFY']
const TRIAL_TYPES = ['TYPE_TEST', 'ROUTINE', 'FAT', 'FAI']
const TRIAL_PREFIX = { TYPE_TEST: 'TT', ROUTINE: 'RT', FAT: 'FAT', FAI: 'FAI' }
const TRIAL_RESULTS = ['PENDING', 'PASS', 'FAIL', 'CONDITIONAL']
const FAULT_SIGNALS = ['SLIDE', 'RESISTANCE', 'BUFFER_WEAR', 'OBSTACLE', 'LOCK_SWITCH', 'COMM']
const PROBLEM_STEPS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']
const SEVERITIES = ['A', 'B', 'C']
const CHANGE_SOURCES = ['FIELD', 'TYPE_TEST', 'CUSTOMER', 'INTERNAL']

export const MACHINES = Object.freeze({
  requirement: {
    RAW: ['REFINED'],
    REFINED: ['RAW', 'ASSIGNED'],
    ASSIGNED: ['REFINED', 'IN_PROGRESS'],
    IN_PROGRESS: ['BLOCKED', 'COMPLETED'],
    BLOCKED: ['IN_PROGRESS'],
    COMPLETED: [],
  },
  task: {
    PENDING: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'FAILED', 'BLOCKED'],
    BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
    FAILED: ['PENDING', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  },
  // EXPIRED is never stored: an OPEN request past dueAt reads as EXPIRED and can still be claimed.
  intervention: {
    OPEN: ['CLAIMED'],
    EXPIRED: ['CLAIMED'],
    CLAIMED: ['OPEN', 'RESOLVED'],
    RESOLVED: [],
  },
  // IN_REVIEW is entered by submitting a gate; PASSED and REWORK only by a gate decision (the last gate
  // of the stage passes it; approving an earlier gate of a multi-gate stage returns it to IN_PROGRESS
  // internally), and a PASSED stage returns to REWORK only through an approved change request.
  stage: {
    NOT_STARTED: ['IN_PROGRESS'],
    IN_PROGRESS: ['IN_REVIEW'],
    IN_REVIEW: ['PASSED', 'REWORK'],
    REWORK: ['IN_PROGRESS'],
    PASSED: [],
  },
  change: {
    SUBMITTED: ['ANALYZED', 'REJECTED'],
    ANALYZED: ['CCB_REVIEW', 'SUBMITTED'],
    CCB_REVIEW: ['APPROVED', 'REJECTED'],
    APPROVED: ['IMPLEMENTED'],
    REJECTED: ['CLOSED'],
    IMPLEMENTED: ['CLOSED'],
    CLOSED: [],
  },
  defect: {
    NEW: ['CONFIRMED', 'DEFERRED', 'CLOSED'],
    CONFIRMED: ['FIXING', 'DEFERRED'],
    FIXING: ['RETEST'],
    RETEST: ['CLOSED', 'FIXING'],
    DEFERRED: ['CONFIRMED', 'CLOSED'],
    CLOSED: [],
  },
  trial: {
    PLANNED: ['IN_PROGRESS'],
    IN_PROGRESS: ['REPORTED'],
    REPORTED: ['IN_PROGRESS', 'APPROVED'],
    APPROVED: [],
  },
  fault: {
    NEW: ['DISPATCHED'],
    DISPATCHED: ['HANDLED'],
    HANDLED: ['CLOSED'],
    CLOSED: [],
  },
  problem: {
    OPEN: ['ANALYZING'],
    ANALYZING: ['ACTION'],
    ACTION: ['VERIFYING'],
    VERIFYING: ['CLOSED', 'ACTION'],
    CLOSED: [],
  },
})

export const LABELS = Object.freeze({
  state: {
    RAW: '原始',
    REFINED: '已细化',
    ASSIGNED: '已分配',
    IN_PROGRESS: '进行中',
    BLOCKED: '阻塞',
    COMPLETED: '已完成',
    PENDING: '待开始',
    FAILED: '失败',
    CANCELLED: '已取消',
    OPEN: '待处理',
    EXPIRED: '已超时',
    CLAIMED: '已认领',
    RESOLVED: '已处理',
    NOT_STARTED: '未开始',
    IN_REVIEW: '评审中',
    PASSED: '已通过',
    REWORK: '返工',
    SUBMITTED: '已提交',
    ANALYZED: '已分析',
    CCB_REVIEW: 'CCB 评审',
    APPROVED: '已批准',
    REJECTED: '已驳回',
    IMPLEMENTED: '已实施',
    CLOSED: '已关闭',
    NEW: '新建',
    CONFIRMED: '已确认',
    FIXING: '修复中',
    RETEST: '待回归',
    DEFERRED: '延期处理',
    DRAFT: '草稿',
    BASELINED: '已基线',
    CHANGED: '已变更',
    VERIFIED: '已验证',
    PLANNED: '已计划',
    REPORTED: '已出报告',
    DISPATCHED: '已派工',
    HANDLED: '已处理',
    ANALYZING: '分析中',
    ACTION: '措施中',
    VERIFYING: '验证中',
  },
  // Generic stage names; each project shows its own profile label (GATE_PROFILES[kind][stage].label).
  stage: {
    INITIATION: '立项',
    REQUIREMENTS: '需求分析',
    DESIGN: '设计',
    IMPLEMENTATION: '实现',
    VERIFICATION: '验证',
    RELEASE: '发布交付',
  },
  projectKind: { NEW_BUILD: '新造', RETROFIT: '更新改造', MAINTENANCE: '维保', SOFTWARE: '软件' },
  productLine: {
    VEHICLE_DOOR: '车辆门系统',
    PSD: '站台门',
    'O&M_PLATFORM': '智能运维平台',
  },
  artifactKind: {
    PLAN: '项目计划',
    SRS: '需求规格',
    RTM: '需求追溯',
    SAD: '架构设计',
    CODE: '源代码',
    TEST: '测试代码',
    ANALYSIS: '分析说明',
    TEST_PLAN: '测试计划',
    TEST_REPORT: '测试报告',
    RELEASE_NOTE: '发布说明',
    CCB_MINUTES: 'CCB 纪要',
    TA_RESPONSE: '技术协议应答',
    DL_MINUTES: '设计联络纪要',
    TYPE_TEST_PLAN: '型式试验大纲',
    TYPE_TEST_REPORT: '型式试验报告',
    FAI_REPORT: '首件检验报告',
    REPORT_8D: '8D 报告',
    ECN: '工程变更通知',
    ACCEPTANCE: '交付验收记录',
  },
  level: { CUS: '客户条款', SYS: '系统需求', SWR: '子系统需求', DES: '设计', TC: '测试用例' },
  gateType: { TR: '技术评审', DCP: '决策评审', MILESTONE: '订单里程碑' },
  discipline: { MECH: '机械', ELEC: '电气', SW: '软件' },
  compliance: { COMPLY: '满足', DEVIATE: '偏离', CLARIFY: '澄清' },
  trialType: { TYPE_TEST: '型式试验', ROUTINE: '例行试验', FAT: '工厂验收试验', FAI: '首件检验' },
  trialResult: { PENDING: '待定', PASS: '合格', FAIL: '不合格', CONDITIONAL: '有条件合格' },
  faultSignal: {
    SLIDE: '滑道异常',
    RESISTANCE: '阻力异常',
    BUFFER_WEAR: '缓冲头磨损',
    OBSTACLE: '障碍物检测',
    LOCK_SWITCH: '锁闭开关',
    COMM: '通信',
  },
  faultSource: { PHM: 'PHM 预警', 客服: '客服', 主机厂: '主机厂' },
  changeSource: { FIELD: '现场', TYPE_TEST: '型式试验', CUSTOMER: '客户', INTERNAL: '内部' },
  baselineType: { AS_DESIGNED: '设计态', AS_BUILT: '制造态', AS_MAINTAINED: '维护态' },
  severity: { A: 'A 致命', B: 'B 严重', C: 'C 一般', D: 'D 轻微' },
  testLevel: { UNIT: '单元', INTEGRATION: '集成', SYSTEM: '系统' },
  taskType: {
    REQUIREMENT_BREAKDOWN: '需求拆解',
    DEVELOPMENT: '研发',
    TESTING: '测试',
    SECURITY_CHECK: '安全校验',
    AUTO_RELEASE: '自动发布',
  },
  interventionType: {
    REQUIREMENT_APPROVAL: '需求审批',
    ARCHITECTURE_APPROVAL: '架构审批',
    SECURITY_APPROVAL: '安全审批',
    RELEASE_APPROVAL: '发布审批',
    INCIDENT_HANDLING: '故障处理',
  },
  priority: { P0: 'P0 紧急', P1: 'P1 重要', P2: 'P2 一般' },
  approvalState: FLOW_LABELS,
  approvalTemplate: Object.fromEntries(Object.entries(TEMPLATES).map(([k, t]) => [k, t.name])),
  approvalSubject: { artifact: '交付物', change: '变更', problem: '质量问题', trial: '试验' },
  nodeState: { WAITING: '待到达', ACTIVE: '处理中', DONE: '已完成', RETURNED: '已驳回', SKIPPED: '已跳过' },
  nodeMode: { SERIAL: '任一人', ALL: '全部会签', ANY: '或签' },
  approvalAction: {
    APPROVE: '同意',
    REJECT: '驳回',
    RETURN: '退回',
    TRANSFER: '转办',
    ADD_SIGN: '加签',
    COMMENT: '评论',
    WITHDRAW: '撤回',
  },
})

const COLLECTIONS = {
  project: 'projects',
  stage: 'stages',
  gate: 'gates',
  artifact: 'artifacts',
  req: 'reqs',
  change: 'changes',
  defect: 'defects',
  testRun: 'testRuns',
  trial: 'trials',
  fault: 'faults',
  problem: 'problems',
  item: 'items',
  configBaseline: 'configBaselines',
  requirement: 'requirements',
  task: 'tasks',
  intervention: 'interventions',
  approval: 'approvals',
  activity: 'activity',
  handback: 'handbacks',
}
const PREFIX = { requirement: 'REQ', task: 'TASK', intervention: 'HI' }
const HOUR = 3_600_000
const DAY = 24 * HOUR
const HISTORY_LIMIT = 30
const OPEN_CHANGE = ['SUBMITTED', 'ANALYZED', 'CCB_REVIEW', 'APPROVED', 'IMPLEMENTED']
/** Live document bodies are cached in the store, whose values are capped at 64 KiB. */
export const DOC_LIMIT_BYTES = 48 * 1024

const fail = (message) => {
  throw new DomainError(message)
}

/** Collections a store written by an older seed lacks read as empty. */
const ensure = (state) => {
  for (const name of Object.values(COLLECTIONS)) state[name] ??= []
  return state
}
export const seed = (now = Date.now()) => ensure(buildSeed(now))

export function effectiveState(item, kind, now) {
  return kind === 'intervention' && item.state === 'OPEN' && Date.parse(item.dueAt) < now
    ? 'EXPIRED'
    : item.state
}

/** An edit without a move keeps its note as a same-state history line, as a move would. */
function keepNote(item, input, at, by) {
  const note = optional(input.note, 2000)
  if (note) record(item, at, by, item.state, item.state, note)
}

/** Requirement-level items (CUS…TC) are unique per project, so they are found with their project. */
function find(state, kind, id, projectId) {
  const list = state[COLLECTIONS[kind]]
  if (!list) fail(`未知实体类型：${kind}`)
  return (
    list.find((item) => item.id === id && (!projectId || item.projectId === projectId)) ??
    fail(`未找到 ${projectId ? `${projectId} 的 ` : ''}${id}`)
  )
}
const projectOf = (state, id) => find(state, 'project', id)
const stageOf = (state, projectId, stage) => find(state, 'stage', `${projectId}/${stage}`)
const profileOf = (project) => GATE_PROFILES[project.kind] ?? GATE_PROFILES.NEW_BUILD
/** The gates of a stage in order, minus those the project's tailoring skips. */
const gatesOf = (project, stage) =>
  (profileOf(project)[stage]?.gates ?? []).filter((g) => !project.tailoring?.skipped?.includes(g.code))
const stageLabel = (state, stage) => {
  const project = state.projects.find((p) => p.id === stage.projectId)
  return (project && profileOf(project)[stage.stage]?.label) || LABELS.stage[stage.stage] || stage.stage
}
function record(item, at, by, from, to, note) {
  const all = [...(item.history ?? []), { at, by, from, to, ...(note ? { note } : {}) }]
  // The first line (who created it, and when) stays: approval rights and timelines read it.
  item.history = all.length > HISTORY_LIMIT ? [all[0], ...all.slice(1 - HISTORY_LIMIT)] : all
  item.state = to
}

const text = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim()) fail(`缺少字段：${name}`)
  return value.trim().slice(0, max)
}
const optional = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const oneOf = (value, allowed, name) =>
  allowed.includes(value) ? value : fail(`${name} 取值无效：${value}（可选 ${allowed.join(' / ')}）`)
const ids = (value, name) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) fail(`${name} 需为编号数组`)
  return [...new Set(value)]
}

// Moves only an approval flow may make: the flow's settlement calls transition with this key set.
const FLOW = Symbol('approvalFlow')
const FLOW_ONLY = {
  change: ['APPROVED', 'ECR'],
  problem: ['CLOSED', 'PROBLEM_CLOSE'],
  trial: ['APPROVED', 'TRIAL_REPORT'],
}
const SUBJECTS = { artifact: 'artifacts', change: 'changes', problem: 'problems', trial: 'trials' }
const runningFlow = (state, type, id) =>
  state.approvals.find((a) => a.state === 'RUNNING' && a.subject.type === type && a.subject.id === id)

/** Object states advance only through their approval flow; a running flow also freezes manual moves. */
function guardFlow(state, kind, item, to, input) {
  const [target, template] = FLOW_ONLY[kind] ?? []
  if (!target || input[FLOW]) return
  if (to === target) fail(`${item.id} 不能直接流转至 ${to}：需走 ${template} 审批`)
  const running = runningFlow(state, kind, item.id)
  if (running) fail(`${item.id} 有进行中的审批 ${running.id}，请先在流程中处理`)
}

/** Edits are refused on a record in its final state or under a running approval flow (what was signed must not change). */
function guardEditable(state, kind, item) {
  if (!MACHINES[kind][item.state]?.length) fail(`${item.id} 已进入 ${item.state}，不可再改`)
  const running = runningFlow(state, kind, item.id)
  if (running) fail(`${item.id} 有进行中的审批 ${running.id}，请先在流程中处理`)
}

/** The only write path for states. Refuses any move absent from the kind's table. */
export function transition(state, input, now = Date.now()) {
  const { kind, id, to, by, note } = input
  if (!MACHINES[kind] && kind !== 'retrofit') fail(`未知实体类型：${kind}`)
  if (kind === 'stage') return moveStage(state, find(state, 'stage', id), input, now)
  if (kind === 'retrofit') return setRetrofit(state, input, now)
  // Without a move a problem saves its analysis fields: in VERIFYING the close goes through PROBLEM_CLOSE.
  if (kind === 'problem' && to === undefined) {
    const fields = Object.keys(input).filter(
      (k) => !['kind', 'id', 'by'].includes(k) && input[k] !== undefined,
    )
    if (!fields.length || fields.some((k) => !['rootCause', 'noChangeReason'].includes(k)))
      fail(
        `不流转时只能保存 rootCause 或 noChangeReason${fields.length ? `，收到 ${fields.join('、')}` : ''}`,
      )
    return upsertProblem(
      state,
      { id, by, rootCause: input.rootCause, noChangeReason: input.noChangeReason },
      now,
    )
  }
  const item = find(state, kind, id)
  const from = effectiveState(item, kind, now)
  if (!MACHINES[kind][from]?.includes(to)) fail(`非法状态流转：${from} 不可流转至 ${to}`)
  guardFlow(state, kind, item, to, input)
  const at = new Date(now).toISOString()
  const actor = by || '未署名'
  if (kind === 'intervention') {
    if (to === 'CLAIMED') item.handler = actor
    if (to === 'OPEN') item.handler = null
    if (to === 'RESOLVED') item.resolution = note || '已处理'
  }
  if (kind === 'change') moveChange(item, to, actor, at, note, input.members)
  if (kind === 'trial') moveTrial(state, item, to, input, at)
  if (kind === 'problem') moveProblem(state, item, to, input)
  if (kind === 'defect') {
    if (to === 'CLOSED') item.closedAt = at
    else delete item.closedAt
  }
  if (kind === 'defect' && to === 'CLOSED') closeDefectFindings(state, item)
  record(item, at, actor, from, to, note)
  if (kind === 'task') link(state, item, at)
  if (kind === 'intervention' && to === 'RESOLVED')
    addHandback(
      state,
      {
        kind: 'intervention',
        subject: { type: 'intervention', id },
        ...(item.projectId ? { projectId: item.projectId } : {}),
        text: `${id} 已答复 → 交回研发协调员继续`,
        action: 'interventions',
        object: { type: 'intervention', id },
        watch: [item.entity?.id, id].filter(Boolean),
      },
      now,
    )
  if (kind === 'change' && to === 'APPROVED') applyChange(state, item, at)
  return item
}

// Two automatic requirement moves only; everything else is an explicit transition.
function link(state, task, at) {
  const requirement = state.requirements.find((r) => r.id === task.requirementId)
  if (!requirement) return
  if (task.state === 'IN_PROGRESS' && requirement.state === 'ASSIGNED')
    record(requirement, at, '系统联动', 'ASSIGNED', 'IN_PROGRESS', `${task.id} 已开始`)
  const related = state.tasks.filter((t) => t.requirementId === requirement.id)
  if (
    requirement.state === 'IN_PROGRESS' &&
    related.every((t) => t.state === 'COMPLETED' || t.state === 'CANCELLED')
  )
    record(requirement, at, '系统联动', 'IN_PROGRESS', 'COMPLETED', '关联任务全部完成或取消')
}

// ── Stages and review gates ────────────────────────────────────────────────────────────────────

function moveStage(state, stage, { to, by, note, author }, now) {
  if (to === 'IN_REVIEW') return submitGate(state, { stageId: stage.id, by, note }, now).stage
  if (to === 'PASSED' || to === 'REWORK')
    fail(`阶段「${stageLabel(state, stage)}」只能通过评审门决议进入${LABELS.state[to]}`)
  if (to !== 'IN_PROGRESS' || !MACHINES.stage[stage.state]?.includes(to))
    fail(`非法状态流转：${stage.state} 不可流转至 ${to}`)
  const index = STAGES.indexOf(stage.stage)
  if (stage.state === 'NOT_STARTED' && index > 0) {
    const previous = stageOf(state, stage.projectId, STAGES[index - 1])
    if (previous.state !== 'PASSED')
      fail(
        `阶段顺序不满足：前一阶段「${stageLabel(state, previous)}」尚未通过评审，不能开始「${stageLabel(state, stage)}」`,
      )
  }
  // The stage keeps the canonical role, so the self-approval check holds for "技术负责人 张三" too.
  if (author) stage.author = knownRole(author)
  record(stage, new Date(now).toISOString(), by || '未署名', stage.state, 'IN_PROGRESS', note)
  // Restarting a reworked earlier stage leaves the project at its furthest stage.
  const project = projectOf(state, stage.projectId)
  if (index > STAGES.indexOf(project.stage)) project.stage = stage.stage
  return stage
}

/** A named author is kept as its canonical role, so the self-approval check and approval flows can find it. */
function knownRole(value) {
  const role = roleOf(text(value, 'author', 32))
  return ROLES.includes(role) ? role : fail(`编写角色无效：${value}（可选 ${ROLES.join('、')}）`)
}

const pendingGate = (state, stageId) =>
  state.gates.find((g) => g.stageId === stageId && g.decision === 'PENDING')

/** The next gate of a stage still to be passed: gates approved before an approved change reopened the stage are superseded. */
function nextGate(state, project, stage) {
  const passed = new Set(
    state.gates
      .filter((g) => g.stageId === stage.id && g.decision === 'APPROVED' && !g.superseded)
      .map((g) => g.code),
  )
  return gatesOf(project, stage.stage).find((g) => !passed.has(g.code))
}

/** `link` ({ defectId } or { flowId, artifactId }) names what closes a system finding by itself. */
function addFindings(gate, texts, by, link = {}) {
  for (const raw of texts ?? []) {
    const n = gate.findings.length + 1
    gate.findings.push({
      id: `F-${String(n).padStart(2, '0')}`,
      text: text(raw, 'finding', 500),
      by,
      closed: false,
      ...link,
    })
  }
}

/** Gates that class-A defects hold: no approval while one is unclosed (a deferred defect is still unclosed). */
const DEFECT_GATES = ['TR5', 'ADCP']
const unclosedDefects = (state, projectId, severity) =>
  state.defects.filter((d) => d.projectId === projectId && d.severity === severity && d.state !== 'CLOSED')

/** A closed defect closes the system findings that name it on the gates still waiting. */
function closeDefectFindings(state, defect) {
  const by = '系统（缺陷已关闭）'
  for (const gate of state.gates) {
    if (gate.decision !== 'PENDING' || !gate.stageId.startsWith(`${defect.projectId}/`)) continue
    for (const f of gate.findings)
      if (f.defectId === defect.id && !f.closed) {
        f.closed = true
        f.closedNote = `缺陷 ${defect.id} 已关闭（${by}）`
      }
  }
}
/** An approved release flow closes the system findings that name it; an auto gate (TR4) left with none open passes. */
function closeReleaseFindings(state, flow, at) {
  for (const gate of state.gates) {
    const open =
      gate.decision === 'PENDING'
        ? gate.findings.filter(
            (f) => !f.closed && (f.artifactId ? f.artifactId === flow.subject.id : f.flowId === flow.id),
          )
        : []
    if (!open.length) continue
    for (const f of open) {
      f.closed = true
      f.closedNote = `发布审批 ${flow.id} 已批准（系统）`
    }
    if (gate.auto && gate.findings.every((f) => f.closed))
      approve(
        state,
        find(state, 'stage', gate.stageId),
        gate,
        '系统（评审意见已全部关闭）',
        '评审意见全部关闭，自动通过',
        at,
      )
  }
}
function closeFindings(gate, closes, by) {
  for (const close of closes ?? []) {
    const finding =
      gate.findings.find((f) => f.id === close?.id) ?? fail(`未找到评审意见 ${gate.id} ${close?.id}`)
    finding.closed = true
    finding.closedNote = `${text(close.note, 'closeFindings.note', 500)}（${by}）`
  }
}

/** Gates that check a kind of trial: any trial of that type not yet APPROVED is a system finding. */
const TRIAL_GATES = { TYPE: ['TYPE_TEST', '型式试验'], FAI: ['FAI', '首件'] }

/**
 * Submit a stage for review (IN_PROGRESS → IN_REVIEW with a new PENDING gate for the stage's next gate),
 * or add and close findings on the gate already pending. The requirements gate gets a system finding
 * while CUS→SWR is incomplete; the type-test and FAI gates get one per unapproved trial; a gate marked
 * `auto` (TR4) passes once every finding is closed.
 */
export function submitGate(state, { stageId, by, note, findings, closeFindings: closes }, now = Date.now()) {
  const stage = find(state, 'stage', stageId)
  const project = projectOf(state, stage.projectId)
  const at = new Date(now).toISOString()
  const actor = by || '未署名'
  let gate = pendingGate(state, stage.id)
  if (stage.state === 'IN_PROGRESS') {
    const def =
      nextGate(state, project, stage) ?? fail(`阶段「${stageLabel(state, stage)}」没有待提交的评审门`)
    const n = state.gates.filter((g) => g.stageId === stage.id && g.code === def.code).length + 1
    gate = {
      id: `GATE-${stage.projectId}-${def.code}-${n}`,
      stageId: stage.id,
      code: def.code,
      name: def.name,
      type: def.type,
      approverRoles: [...def.approverRoles],
      signatures: [],
      ...(def.auto ? { auto: true } : {}),
      decision: 'PENDING',
      findings: [],
      submittedAt: at,
      submittedBy: actor,
    }
    state.gates.push(gate)
    record(stage, at, actor, 'IN_PROGRESS', 'IN_REVIEW', note || `提交评审 ${def.code}`)
    for (const a of stageArtifacts(state, stage)) if (a.status === 'DRAFT') a.status = 'IN_REVIEW'
    if (stage.stage === 'REQUIREMENTS') {
      const cov = coverage(state, stage.projectId).cusSwr
      if (cov.pct !== 100)
        addFindings(
          gate,
          [`CUS→SWR 覆盖率 ${cov.pct ?? 0}%，未覆盖：${cov.missing.slice(0, 20).join('、') || '无客户条款'}`],
          '系统检查',
        )
    }
    for (const a of stageArtifacts(state, stage)) {
      const flow = latestRelease(state, a.id)
      if (flow && !['APPROVED', 'WITHDRAWN'].includes(flow.state))
        addFindings(
          gate,
          [`交付物 ${a.id} 的发布审批 ${flow.id} ${FLOW_LABELS[flow.state]}，尚未批准`],
          '系统检查',
          // Any later approved release of the deliverable closes it, not only this flow.
          { flowId: flow.id, artifactId: a.id },
        )
    }
    if (DEFECT_GATES.includes(def.code)) {
      // The rule itself is checked again at the decision, from the defects; these findings only show it.
      for (const d of unclosedDefects(state, project.id, 'A'))
        addFindings(gate, [`A 类缺陷 ${d.id} 未关闭：${d.title}`], '系统检查', { defectId: d.id })
      for (const d of unclosedDefects(state, project.id, 'B'))
        addFindings(gate, [`B 类缺陷 ${d.id} 未关闭（提示，可人工关闭）：${d.title}`], '系统检查', {
          defectId: d.id,
        })
    }
    const [type, label] = TRIAL_GATES[def.code] ?? []
    if (type) {
      const open = state.trials.filter(
        (t) => t.projectId === project.id && t.type === type && t.state !== 'APPROVED',
      )
      addFindings(
        gate,
        open.slice(0, 30).map((t) => `${label} ${t.id} 未关闭`),
        '系统检查',
      )
    }
  } else if (stage.state !== 'IN_REVIEW' || !gate) {
    fail(`阶段「${stageLabel(state, stage)}」当前为${LABELS.state[stage.state]}，需先开始该阶段再提交评审`)
  }
  addFindings(gate, findings, actor)
  // A system check is closed by the approver at the decision (or by its defect closing), never by the submitter.
  const system = (closes ?? []).filter((c) =>
    gate.findings.some((f) => f.id === c?.id && f.by === '系统检查'),
  )
  if (system.length)
    fail(
      `评审意见 ${system.map((c) => c.id).join('、')} 是系统检查意见：由审批人在决议时关闭，提交方不能关闭`,
    )
  closeFindings(gate, closes, actor)
  if (gate.auto && gate.findings.every((f) => f.closed))
    approve(state, stage, gate, '系统（代码评审意见已全部关闭）', '代码评审意见全部关闭，自动通过', at)
  return { stage, gate }
}

const stageArtifacts = (state, stage) =>
  state.artifacts.filter((a) => a.projectId === stage.projectId && a.stage === stage.stage)
/** The newest DOC_RELEASE flow of a deliverable. */
const latestRelease = (state, artifactId) =>
  state.approvals.findLast(
    (a) => a.template === 'DOC_RELEASE' && a.subject.type === 'artifact' && a.subject.id === artifactId,
  )

/** Approving a gate that is not the stage's last returns the stage to IN_PROGRESS for the next one. */
function approve(state, stage, gate, by, comment, at) {
  const project = projectOf(state, stage.projectId)
  Object.assign(gate, { decision: 'APPROVED', approver: by, decidedAt: at, comment })
  const gates = gatesOf(project, stage.stage)
  const next = gates[gates.findIndex((g) => g.code === gate.code) + 1]
  if (gate.code && next && gates.some((g) => g.code === gate.code)) {
    record(stage, at, by, 'IN_REVIEW', 'IN_PROGRESS', `${gate.code} 已通过，进入 ${next.code}`)
    return
  }
  record(stage, at, by, 'IN_REVIEW', 'PASSED', comment)
  stage.actualEnd = at
  // A deliverable whose release flow is still running is baselined when that flow is approved.
  const items = stageArtifacts(state, stage).filter((a) => !runningFlow(state, 'artifact', a.id))
  for (const a of items) {
    a.status = 'BASELINED'
    // A draft (V0.x) becomes the first released version when it is baselined.
    if (/^V0\./.test(a.version)) a.version = 'V1.0'
  }
  const main = items[0]
  const short = numberOf(state, stage.projectId)
  const n = state.gates.filter((g) => g.stageId === stage.id && g.decision === 'APPROVED').length
  stage.baseline = {
    id: main
      ? `BL-${short}-${main.kind.replaceAll('_', '-')}-${main.version}`
      : `BL-${short}-${stage.stage}-${n}`,
    at,
    items: items.map((a) => a.id),
  }
  const nextStage = STAGES[STAGES.indexOf(stage.stage) + 1]
  if (nextStage && project.stage === stage.stage) project.stage = nextStage
  if (!nextStage) project.actualEnd = at
}

/**
 * The gate rules: in review, approver ≠ author, the approver's role is one the gate names, every role of
 * a co-signed gate signs once, and every finding is closed before the last signature approves. TR5 and ADCP
 * also refuse the last signature while the project has an unclosed class-A defect, whatever happened to the findings.
 */
export function decideGate(state, input, now = Date.now()) {
  const gate = find(state, 'gate', input.gateId)
  const stage = find(state, 'stage', gate.stageId)
  const decision = oneOf(input.decision, ['APPROVED', 'REJECTED'], 'decision')
  const by = text(input.by, 'by', 64)
  if (gate.decision !== 'PENDING' || stage.state !== 'IN_REVIEW')
    fail(
      `评审门不满足：阶段「${stageLabel(state, stage)}」不在评审中（当前${LABELS.state[stage.state]}，该门${LABELS.state[gate.decision] ?? gate.decision}）`,
    )
  const role = roleOf(by)
  if (role === stage.author)
    fail(`评审门不满足：审批人角色「${role}」是该阶段的编写角色，编写人不能审批自己的交付物`)
  const roles = gate.approverRoles ?? []
  if (!roles.includes(role)) fail(`评审门不满足：本门需由 ${roles.join('、')} 审批（当前角色「${role}」）`)
  gate.signatures ??= []
  closeFindings(gate, input.closeFindings, by)
  const at = new Date(now).toISOString()
  const comment = optional(input.comment)
  if (decision === 'APPROVED') {
    if (gate.signatures.some((s) => s.role === role)) fail(`评审门不满足：角色「${role}」已签署本门`)
    const waiting = roles.filter((r) => r !== role && !gate.signatures.some((s) => s.role === r))
    const held =
      DEFECT_GATES.includes(gate.code) && !waiting.length ? unclosedDefects(state, stage.projectId, 'A') : []
    if (held.length)
      fail(
        `评审门不满足：A 类缺陷 ${held.map((d) => `${d.id}（${d.title}）`).join('、')} 未关闭，修复并回归通过后才能批准。请到「缺陷与测试」页把缺陷推进到已关闭，门上对应的系统意见会随之关闭。`,
      )
    const open = gate.findings.filter((f) => !f.closed)
    if (!waiting.length && open.length)
      fail(`评审门不满足：还有 ${open.length} 条评审意见未关闭（${open.map((f) => f.id).join('、')}）`)
    gate.signatures.push({ role, by, at, comment: comment || '批准' })
    if (!waiting.length) approve(state, stage, gate, by, comment || '批准', at)
  } else {
    if (!comment) fail('驳回需填写评审意见')
    Object.assign(gate, { decision, approver: by, decidedAt: at, comment })
    record(stage, at, by, 'IN_REVIEW', 'REWORK', comment)
    for (const a of stageArtifacts(state, stage)) if (a.status === 'IN_REVIEW') a.status = 'DRAFT'
  }
  // Only the decision that settles the gate hands work back; a first co-signature leaves it pending.
  if (gate.decision !== 'PENDING' && input.handback !== false && projectOf(state, stage.projectId).live)
    addHandback(
      state,
      {
        kind: 'gate',
        subject: { type: 'gate', id: gate.id },
        projectId: stage.projectId,
        text: `${gate.code} ${gate.decision === 'APPROVED' ? '已批准' : '已驳回'} → 交回研发协调员继续`,
        action: 'continue',
        object: { type: 'gate', id: gate.id },
        watch: [],
      },
      now,
    )
  return { gate, stage }
}

// ── Change requests ────────────────────────────────────────────────────────────────────────────

const intIn = (value, name, max) => {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fail(`${name} 需为 0–${max} 的整数`)
}

function moveChange(cr, to, by, at, note, members) {
  // The analysis stays editable while ANALYZED, so CCB review checks it again.
  if (to === 'ANALYZED' || to === 'CCB_REVIEW') {
    const impact = cr.impact
    const any = impact && [impact.reqs, impact.artifacts, impact.tests, impact.items].some((l) => l?.length)
    if (!any) fail(`${cr.id} 缺少影响分析：先登记受影响的需求、交付物、用例或物料`)
    if (['FIELD', 'TYPE_TEST'].includes(cr.source?.type) && !cr.rootCause)
      fail(`${cr.id} 缺少失效原因分析（rootCause）：来源为现场或型式试验的变更需先写明原因`)
  }
  if (to === 'CLOSED' && cr.state === 'IMPLEMENTED' && !cr.verification)
    fail(`${cr.id} 缺少验证记录（verification）：验证后才能关闭`)
  if (to === 'CLOSED' && cr.state === 'IMPLEMENTED' && cr.verification.result !== 'PASS')
    fail(`${cr.id} 验证未通过：重新验证通过后才能关闭`)
  if (to === 'APPROVED' || to === 'REJECTED')
    cr.ccb = {
      members: Array.isArray(members) && members.length ? members.slice(0, 12) : [by],
      decision: to,
      at,
      ...(note ? { note } : {}),
    }
}

const LEVEL_STAGE = { CUS: 'REQUIREMENTS', SYS: 'REQUIREMENTS', SWR: 'REQUIREMENTS', DES: 'DESIGN' }

/** The next number in a baseline series of one project and type, and the latest revs to build on. */
function addBaseline(state, projectId, type, fallbacks, bumps, at, note) {
  const seqOf = (b) => Number(/-(\d+)$/.exec(b.id)?.[1] ?? 0)
  const mine = (t) => state.configBaselines.filter((b) => b.projectId === projectId && b.type === t)
  const latest = (t) => mine(t).reduce((top, b) => (!top || seqOf(b) > seqOf(top) ? b : top), undefined)
  const base = [type, ...fallbacks].map(latest).find(Boolean)
  const revs = { ...(base?.revs ?? {}) }
  for (const { itemId, toRev } of bumps) revs[itemId] = toRev
  const seq = Math.max(0, ...mine(type).map(seqOf)) + 1
  const baseline = {
    id: `CB-${projectId}-${type}-${pad(seq, 2)}`,
    projectId,
    type,
    revs,
    at,
    ...(note ? { note } : {}),
  }
  state.configBaselines.push(baseline)
  return baseline
}

/** ECN numbers follow the change request's own number so the pair reads together. */
function ecnId(state, cr) {
  const m = /^CR-(\d{4})-(\d+)$/.exec(cr.id)
  if (m) return `ECN-${m[1]}-${m[2]}`
  const year = new Date().getUTCFullYear()
  return `ECN-${year}-${pad(
    yearSeq(
      state.changes.map((c) => ({ id: c.ecn ?? '' })),
      'ECN',
      year,
    ),
    3,
  )}`
}

/**
 * An approved change (its ECR flow) gets its ECN. It marks impacted requirements CHANGED and sends
 * impacted PASSED or IN_REVIEW stages to rework (the pending gate of the latter is withdrawn), except in a project already in service. The as-designed baseline
 * comes later, when the ECN_RELEASE flow is approved.
 */
function applyChange(state, cr, at) {
  const project = projectOf(state, cr.projectId)
  cr.ecn = ecnId(state, cr)
  if (cr.impact?.fleet && !cr.retrofit) cr.retrofit = { done: 0, total: cr.impact.fleet.doors }
  const stages = new Set()
  for (const id of cr.impact?.reqs ?? []) {
    const req = state.reqs.find((r) => r.id === id && r.projectId === cr.projectId)
    if (!req) continue
    req.status = 'CHANGED'
    if (LEVEL_STAGE[req.level]) stages.add(LEVEL_STAGE[req.level])
  }
  for (const id of cr.impact?.artifacts ?? []) {
    const artifact = state.artifacts.find((a) => a.id === id && a.projectId === cr.projectId)
    if (artifact) stages.add(artifact.stage)
  }
  const reworked = []
  for (const name of project.service ? [] : stages) {
    const stage = state.stages.find((s) => s.id === `${cr.projectId}/${name}`)
    if (!['PASSED', 'IN_REVIEW'].includes(stage?.state)) continue
    const note = `${cr.id} 已批准，受影响阶段返工`
    record(stage, at, 'CCB', stage.state, 'REWORK', note)
    for (const g of state.gates) {
      if (g.stageId !== stage.id) continue
      // The gates it passed through no longer count: the stage goes through its gates again.
      if (g.decision === 'APPROVED') g.superseded = true
      // A gate still waiting reviewed the old content: it is withdrawn, as a rejection would.
      if (g.decision === 'PENDING')
        Object.assign(g, {
          decision: 'REJECTED',
          approver: 'CCB',
          decidedAt: at,
          comment: note,
          superseded: true,
        })
    }
    for (const a of stageArtifacts(state, stage)) if (a.status === 'IN_REVIEW') a.status = 'DRAFT'
    reworked.push(stage.id)
  }
  cr.reworked = reworked
}

/** Releasing an ECN, when it names items, creates the new as-designed baseline. */
function releaseEcn(state, cr, at) {
  if (!cr.impact?.items?.length) return undefined
  return addBaseline(state, cr.projectId, 'AS_DESIGNED', [], cr.impact.items, at, `${cr.ecn}：${cr.title}`)
}

/** Retrofit progress only increases; the last door brings the as-maintained baseline up to the ECN. */
function setRetrofit(state, { id, done, by, note }, now) {
  const cr = find(state, 'change', id)
  if (!cr.retrofit) fail(`${cr.id} 未设置整改总数`)
  if (!['APPROVED', 'IMPLEMENTED'].includes(cr.state))
    fail(`${cr.id} 处于 ${cr.state}，批准后才能更新整改进度`)
  const next = intIn(done, 'done', cr.retrofit.total)
  if (next <= cr.retrofit.done) fail(`整改进度只能递增：当前 ${cr.retrofit.done}，收到 ${next}`)
  const at = new Date(now).toISOString()
  cr.retrofit.done = next
  record(cr, at, by || '未署名', cr.state, cr.state, note || `整改进度 ${next}/${cr.retrofit.total}`)
  if (next === cr.retrofit.total)
    addBaseline(
      state,
      cr.projectId,
      'AS_MAINTAINED',
      ['AS_BUILT'],
      cr.impact?.items ?? [],
      at,
      `${cr.ecn ?? cr.id} 整改完成`,
    )
  return cr
}

// ── Traceability ───────────────────────────────────────────────────────────────────────────────

/** Three link coverages plus CUS→SWR; orphans are items with no upstream and test cases with no source. */
export function coverage(state, projectId) {
  const reqs = state.reqs.filter((r) => r.projectId === projectId)
  const at = (level) => reqs.filter((r) => r.level === level)
  const children = new Map()
  for (const r of reqs) for (const p of r.parent ?? []) children.set(p, [...(children.get(p) ?? []), r])
  const below = (id, level) => (children.get(id) ?? []).filter((c) => c.level === level)
  const measure = (items, covered) => {
    const missing = items.filter((r) => !covered(r)).map((r) => r.id)
    return {
      covered: items.length - missing.length,
      total: items.length,
      pct: items.length ? Math.round(((items.length - missing.length) / items.length) * 1000) / 10 : null,
      missing,
    }
  }
  return {
    cusSys: measure(at('CUS'), (r) => below(r.id, 'SYS').length > 0),
    sysSwr: measure(at('SYS'), (r) => below(r.id, 'SWR').length > 0),
    swrTc: measure(at('SWR'), (r) => (r.verifiedBy?.length ?? 0) > 0 || below(r.id, 'TC').length > 0),
    cusSwr: measure(at('CUS'), (r) => below(r.id, 'SYS').some((s) => below(s.id, 'SWR').length > 0)),
    noSource: at('TC')
      .filter((r) => !r.parent?.length)
      .map((r) => r.id),
    noParent: reqs.filter((r) => r.level !== 'CUS' && r.level !== 'TC' && !r.parent?.length).map((r) => r.id),
  }
}

/** Deliverable kinds each trace level touches: requirements → SRS/RTM, design → SAD, test cases → test report. */
const LEVEL_KINDS = {
  CUS: ['SRS', 'RTM'],
  SYS: ['SRS', 'RTM'],
  SWR: ['SRS', 'RTM'],
  DES: ['SAD'],
  TC: ['TEST_REPORT'],
}

/**
 * Everything downstream of the given requirement-level items, found through the `parent` links:
 * `reqs` the start items and their downstream CUS/SYS/SWR/DES items, `tests` the test cases, `artifacts`
 * the project's deliverables of the kinds those levels touch, `modules` the code modules of the DES items.
 * All lists are sorted and unique.
 */
export function traceImpact(state, projectId, reqIds) {
  projectOf(state, projectId)
  const all = state.reqs.filter((r) => r.projectId === projectId)
  const children = new Map()
  for (const r of all) for (const p of r.parent ?? []) children.set(p, [...(children.get(p) ?? []), r])
  const seen = new Map()
  const walk = (r) => {
    if (seen.has(r.id)) return
    seen.set(r.id, r)
    for (const c of children.get(r.id) ?? []) walk(c)
  }
  for (const id of reqIds ?? [])
    walk(all.find((r) => r.id === id) ?? fail(`未找到 ${projectId} 的条目 ${id}`))
  const found = [...seen.values()]
  const sorted = (list) => [...new Set(list)].sort()
  const kinds = new Set(found.flatMap((r) => LEVEL_KINDS[r.level] ?? []))
  return {
    reqs: sorted(found.filter((r) => r.level !== 'TC').map((r) => r.id)),
    tests: sorted(found.filter((r) => r.level === 'TC').map((r) => r.id)),
    artifacts: sorted(
      state.artifacts.filter((a) => a.projectId === projectId && kinds.has(a.kind)).map((a) => a.id),
    ),
    modules: sorted(found.filter((r) => r.module).map((r) => r.module)),
  }
}

/** `traceFrom`: the impact's requirements are starting points; what lies downstream is added, nothing given is removed. */
function traced(state, projectId, impact, traceFrom) {
  if (!traceFrom) return impact
  const start = impact?.reqs ?? []
  if (!start.length) fail('traceFrom 需要 impact.reqs 作为追溯起点')
  const found = traceImpact(state, projectId, start)
  const merge = (key) => [...new Set([...(impact[key] ?? []), ...found[key]])]
  return { ...impact, reqs: merge('reqs'), artifacts: merge('artifacts'), tests: merge('tests') }
}

const onlyOn = (item, levels, name) =>
  levels.includes(item.level) ? true : fail(`${item.id} 不能设置 ${name}：仅 ${levels.join('/')} 条目可用`)

/** Discipline, part and drawing numbers, and the customer-clause response (design §4.3). */
function reqFields(item, input) {
  if (input.discipline !== undefined && onlyOn(item, ['SWR', 'DES'], 'discipline'))
    item.discipline = oneOf(input.discipline, DISCIPLINES, 'discipline')
  for (const [key, max] of [
    ['partNo', 32],
    ['drawingNo', 32],
    ['module', 64],
  ])
    if (input[key] !== undefined && onlyOn(item, ['DES'], key)) item[key] = text(input[key], key, max)
  if (input.clause !== undefined && onlyOn(item, ['CUS'], 'clause'))
    item.clause = text(input.clause, 'clause', 64)
  if (input.compliance !== undefined && onlyOn(item, ['CUS'], 'compliance'))
    item.compliance = oneOf(input.compliance, COMPLIANCE, 'compliance')
  if (input.responseNote !== undefined && onlyOn(item, ['CUS'], 'responseNote'))
    item.responseNote = text(input.responseNote, 'responseNote', 500)
}

/** Register or update CUS/SYS/SWR(MER/EER)/DES/TC items; parents must exist one level up in the same project. */
export function upsertReqs(state, { projectId, items, by }, now = Date.now()) {
  projectOf(state, projectId)
  if (!Array.isArray(items) || !items.length || items.length > 100) fail('items 需为 1–100 条')
  const at = new Date(now).toISOString()
  const touched = { created: [], updated: [] }
  for (const input of items) {
    const id = text(input?.id, 'id', 16)
    const match =
      /^(CUS|SYS|SWR|MER|EER|DES|TC)-\d{3,4}$/.exec(id) ??
      fail(`编号格式无效：${id}（如 CUS-001、SWR-012、MER-004、EER-007、TC-020）`)
    // SWR, MER and EER are the sub-system requirement level, one prefix per discipline.
    const level = match[1] in SWR_PREFIX_DISCIPLINE ? 'SWR' : match[1]
    const existing = state.reqs.find((r) => r.id === id && r.projectId === projectId)
    const item = existing ?? { id, projectId, level, parent: [], verifiedBy: [], status: 'DRAFT' }
    item.title = input.title === undefined && existing ? existing.title : text(input.title, 'title', 200)
    item.text = input.text === undefined && existing ? existing.text : text(input.text, 'text', 2000)
    if (input.parent !== undefined) {
      const parent = ids(input.parent, 'parent')
      // A test case moved off an SWR no longer verifies it.
      for (const p of (item.parent ?? []).filter((x) => !parent.includes(x))) {
        const old = state.reqs.find((r) => r.id === p && r.projectId === projectId)
        if (old?.verifiedBy) old.verifiedBy = old.verifiedBy.filter((x) => x !== id)
      }
      item.parent = parent
    }
    if (input.safety !== undefined) item.safety = Boolean(input.safety)
    if (!existing && level === 'SWR') item.discipline = SWR_PREFIX_DISCIPLINE[match[1]]
    reqFields(item, input)
    if (input.status !== undefined) {
      const status = oneOf(input.status, ['DRAFT', 'APPROVED', 'CHANGED', 'VERIFIED'], 'status')
      if (status === 'VERIFIED' && item.status !== 'VERIFIED' && ['SWR', 'TC'].includes(item.level))
        fail(`${item.id} 的 VERIFIED 由测试运行判定：用 devboard_test_record 登记按用例的结果`)
      item.status = status
    }
    item.updatedAt = at
    item.updatedBy = by || '未署名'
    if (!existing) state.reqs.push(item)
    touched[existing ? 'updated' : 'created'].push(id)
  }
  const mine = state.reqs.filter((r) => r.projectId === projectId)
  for (const r of mine) {
    if (!touched.created.includes(r.id) && !touched.updated.includes(r.id)) continue
    for (const p of r.parent) {
      const parent = mine.find((x) => x.id === p) ?? fail(`${r.id} 的上游 ${p} 不存在于 ${projectId}`)
      if (parent.level !== PARENT_LEVEL[r.level])
        fail(`${r.id} 的上游必须是 ${PARENT_LEVEL[r.level] ?? '（客户条款没有上游）'}，收到 ${p}`)
      if (r.level === 'TC' && !parent.verifiedBy.includes(r.id)) parent.verifiedBy.push(r.id)
    }
  }
  return touched
}

// ── Live projects, artifacts, tests, defects, app address ──────────────────────────────────────

/** Role working files for one object (QP-…, ECN-…, TT-…): analysis/<object id>/<file>; read and written, never registered. */
const ANALYSIS_PATH = /^analysis\/[A-Za-z0-9][A-Za-z0-9-]*\/[^/]/

/** A workspace path inside the project's directory, normalised to the workspace-relative form. Live projects take any file there; other projects only the analysis/ prefix. */
export function projectPath(project, path) {
  const raw = typeof path === 'string' ? path.trim() : ''
  const live = project.live && project.workspaceDir
  const dir = live ? project.workspaceDir : `devboard-projects/${project.id}`
  if (!live && !ANALYSIS_PATH.test(raw.startsWith(`${dir}/`) ? raw.slice(dir.length + 1) : raw))
    fail(`${project.id} 不是现场项目，不能登记工作区文件`)
  const refuse = () => fail(`交付物路径越界：${raw || '（空）'} 必须是 ${dir}/ 内的相对路径`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || /[\\\x00-\x1f]/.test(raw)) refuse()
  const inside = raw === dir || raw.startsWith(`${dir}/`)
  if (!inside && raw.startsWith('devboard-projects/')) refuse()
  const full = inside ? raw : `${dir}/${raw}`
  if (full === dir || full.split('/').some((p) => !p || p === '.' || p === '..')) refuse()
  return full
}

/**
 * Cut to at most DOC_LIMIT_BYTES as stored (JSON-encoded UTF-8) without splitting a character: newlines,
 * quotes and control characters take 2–6 bytes there, so a raw-byte cut could still overflow the store's value cap.
 */
export function clip(markdown) {
  const size = (s) => new TextEncoder().encode(JSON.stringify(s)).length
  if (size(markdown) <= DOC_LIMIT_BYTES) return { markdown, truncated: false }
  let lo = 0
  let hi = markdown.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (size(markdown.slice(0, mid)) <= DOC_LIMIT_BYTES) lo = mid
    else hi = mid - 1
  }
  const cut = /[\uD800-\uDBFF]$/.test(markdown.slice(0, lo)) ? lo - 1 : lo
  return { markdown: markdown.slice(0, cut), truncated: true }
}

/** The analysis file's object (a change, its ECN, a problem, a trial or a fault of the project) must exist on the board. */
const analysisSubject = (state, projectId, id) =>
  [...state.changes, ...state.problems, ...state.trials, ...state.faults].some(
    (x) => x.projectId === projectId && (x.id === id || x.ecn === id),
  )
/** CODE, TEST and ANALYSIS previews are plain text: a file that is not text is not registered. */
const SOURCE_KINDS = ['CODE', 'TEST', 'ANALYSIS']

/** One artifact per project, kind and optional suffix (DOC-<n>-<KIND>[-<SUFFIX>]); a live body read by the tool is cached alongside the state. */
export function recordArtifact(state, input, now = Date.now()) {
  const project = projectOf(state, text(input.projectId, 'projectId', 64))
  const path = projectPath(project, input.path)
  const kind = oneOf(input.kind, Object.keys(LABELS.artifactKind), 'kind')
  const dir = project.workspaceDir ?? `devboard-projects/${project.id}`
  const analysis = /^analysis\/([A-Za-z0-9][A-Za-z0-9-]*)\/./.exec(path.slice(dir.length + 1))
  if (kind === 'ANALYSIS') {
    if (!analysis) fail(`分析文件必须在 ${dir}/analysis/<对象编号>/ 下：${input.path}`)
    if (!analysisSubject(state, project.id, analysis[1]))
      fail(`未找到 ${project.id} 的对象 ${analysis[1]}：分析文件只登记在已有的变更、质量问题、试验或预警名下`)
  } else if (analysis) fail(`${input.path} 在 analysis/ 下，只能用 kind ANALYSIS 登记`)
  if (SOURCE_KINDS.includes(kind) && typeof input.markdown === 'string' && input.markdown.includes('\u0000'))
    fail(`${input.path} 含二进制内容，只登记文本文件`)
  const stage = oneOf(input.stage, STAGES, 'stage')
  // Several analysis files hang on one object, so an analysis file without a suffix gets one from its file name.
  const named = path
    .split('/')
    .at(-1)
    .replace(/\.[^.]*$/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
    .replace(/-$/, '')
  const suffix = optional(input.suffix, 24).toUpperCase() || (kind === 'ANALYSIS' ? named : '')
  if (suffix && !/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(suffix))
    fail(`suffix 格式无效：${suffix}（大写字母、数字与连字符）`)
  const name = `${kind.replaceAll('_', '-')}${suffix ? `-${suffix}` : ''}`
  // A deliverable registered before the year joined the number keeps its DOC-<seq>- id.
  const ids = [`DOC-${numberOf(state, project.id)}-${name}`, `DOC-${project.id.split('-').at(-1)}-${name}`]
  const existing = state.artifacts.find((a) => ids.includes(a.id) && a.projectId === project.id)
  const id = existing?.id ?? ids[0]
  // The release flow approves the content it was started on; sent back to the initiator, it waits for the revision.
  const running = existing && runningFlow(state, 'artifact', existing.id)
  const revising =
    running?.current === 0 &&
    running.actions[running.since - 1]?.to === 'INITIATOR' &&
    !running.actions.slice(running.since).some((a) => a.action === 'APPROVE')
  if (running && !revising)
    fail(`${existing.id} 有进行中的发布审批 ${running.id}：审批结束或退回发起人后再登记新内容`)
  // A file kind's id names one file: another file under the same id would replace the first one's record.
  if (SOURCE_KINDS.includes(kind) && existing?.source?.path && existing.source.path !== path)
    fail(`${existing.id} 已登记为 ${existing.source.path}：${path} 请传另一个 suffix 登记`)
  const artifact = existing ?? { id, projectId: project.id, kind, status: 'DRAFT' }
  Object.assign(artifact, {
    stage,
    // A file kind says which file in its default title; the other kinds have one deliverable per project.
    title: text(
      input.title ??
        existing?.title ??
        (SOURCE_KINDS.includes(kind)
          ? `${LABELS.artifactKind[kind]} ${path.split('/').at(-1)}`
          : LABELS.artifactKind[kind]),
      'title',
      200,
    ),
    version: text(input.version ?? existing?.version ?? 'V0.1', 'version', 16),
    authorRole:
      input.authorRole === undefined
        ? optional(existing?.authorRole ?? profileOf(project)[stage]?.author, 32)
        : knownRole(input.authorRole),
    source: { type: 'workspace', path },
    updatedAt: new Date(now).toISOString(),
  })
  if (artifact.status === 'BASELINED') artifact.status = 'DRAFT'
  if (!existing) state.artifacts.push(artifact)
  if (typeof input.markdown === 'string') {
    state.docs ??= {}
    state.docs[id] = { ...clip(input.markdown), path, at: artifact.updatedAt }
  }
  return artifact
}

/**
 * The project number inside artifact, test-run and baseline ids (DOC-019-SRS). Sequence numbers restart
 * every year, so a later project that repeats an earlier one's number takes its year too (DOC-2026-019-SRS).
 */
function numberOf(state, projectId) {
  const seq = projectId.split('-').at(-1)
  const repeats = state.projects.some((p) => p.id < projectId && p.id.split('-').at(-1) === seq)
  return repeats ? projectId.replace(/^PRJ-/, '') : seq
}

const yearSeq = (list, prefix, year) =>
  list.reduce((max, item) => {
    const m = new RegExp(`^${prefix}-${year}-(\\d+)$`).exec(item.id)
    return m ? Math.max(max, Number(m[1])) : max
  }, 0) + 1
const pad = (n, width) => String(n).padStart(width, '0')

function createProject(state, input, at, now) {
  const year = new Date(now).getUTCFullYear()
  // minSeq is for internal callers only (fast-forward skips project numbers whose directory exists on disk).
  const id = `PRJ-${year}-${pad(Math.max(yearSeq(state.projects, 'PRJ', year), Number(input.minSeq) || 0), 3)}`
  const by = input.by || '研发协调员'
  const kind = oneOf(input.projectKind ?? 'SOFTWARE', Object.keys(GATE_PROFILES), 'projectKind')
  // Only a software project is run live (workspace, files, app); order projects are records only.
  const live = kind === 'SOFTWARE'
  const project = {
    id,
    name: text(input.name ?? input.title, 'name', 120),
    kind,
    org: oneOf(input.org ?? (live ? '智能运维分技术中心' : '轨道车辆门分技术中心'), ORGS, 'org'),
    customer:
      optional(input.customer, 120) || (live ? '宁川交通装备股份有限公司 运维事业部（内部）' : '待确认客户'),
    productLine: oneOf(
      input.productLine ?? (live ? 'O&M_PLATFORM' : 'VEHICLE_DOOR'),
      Object.keys(LABELS.productLine),
      'productLine',
    ),
    manager: optional(input.manager, 64) || '项目经理（演示）',
    description: optional(input.description, 2000),
    stage: 'INITIATION',
    plannedStart: at,
    plannedEnd: new Date(now + 18 * DAY).toISOString(),
    risks: [],
    ...(live
      ? {
          workspaceDir: `devboard-projects/${id}`,
          live: true,
          tailoring: { skipped: [...LIVE_TAILORING.skipped], reason: LIVE_TAILORING.reason },
        }
      : {}),
    createdAt: at,
  }
  state.projects.push(project)
  STAGES.forEach((stage, i) => {
    const item = {
      id: `${id}/${stage}`,
      projectId: id,
      stage,
      state: 'NOT_STARTED',
      author: profileOf(project)[stage].author,
      plannedEnd: new Date(now + (i + 1) * 3 * DAY).toISOString(),
      history: [],
    }
    if (i === 0) record(item, at, by, 'NOT_STARTED', 'IN_PROGRESS', '立项启动')
    state.stages.push(item)
  })
  return project
}

const revOf = (value, name) => text(value, name, 8)

/** The impact analysis; items and the fleet figure are the field-loop additions (design §4.5). */
export function impactOf(raw, state, projectId) {
  const impact = raw ?? {}
  const days = Number(impact.effortDays ?? 0)
  if (!Number.isFinite(days) || days < 0 || days > 1000) fail('effortDays 需在 0–1000 之间')
  if (impact.items !== undefined && (!Array.isArray(impact.items) || impact.items.length > 100))
    fail('impact.items 需为不超过 100 条的数组')
  const items = (impact.items ?? []).map((it) => {
    const itemId = text(it?.itemId, 'impact.items.itemId', 64)
    if (state && !state.items.some((x) => x.id === itemId && x.projectId === projectId))
      fail(`未找到 ${projectId} 的物料 ${itemId}`)
    return {
      itemId,
      fromRev: revOf(it.fromRev, 'impact.items.fromRev'),
      toRev: revOf(it.toRev, 'impact.items.toRev'),
    }
  })
  return {
    reqs: ids(impact.reqs, 'impact.reqs'),
    artifacts: ids(impact.artifacts, 'impact.artifacts'),
    tests: ids(impact.tests, 'impact.tests'),
    items,
    ...(impact.fleet
      ? {
          fleet: {
            doors: intIn(impact.fleet.doors, 'impact.fleet.doors', 1_000_000),
            plan: optional(impact.fleet.plan, 500),
          },
        }
      : {}),
    safety: Boolean(impact.safety),
    effortDays: days,
  }
}

function sourceOf(raw) {
  if (raw === undefined) return { type: 'INTERNAL' }
  const ref = optional(raw?.ref, 64)
  return { type: oneOf(raw?.type, CHANGE_SOURCES, 'source.type'), ...(ref ? { ref } : {}) }
}

function createChange(state, input, at, now) {
  const project = projectOf(state, text(input.projectId, 'projectId', 64))
  if (input.verification !== undefined) fail('变更批准后才能登记验证（verification）')
  const year = new Date(now).getUTCFullYear()
  const by = input.by || '未署名'
  const item = {
    id: `CR-${year}-${pad(yearSeq(state.changes, 'CR', year), 3)}`,
    projectId: project.id,
    title: text(input.title, 'title', 200),
    reason: text(input.reason ?? input.description, 'reason', 2000),
    raisedBy: by,
    source: sourceOf(input.source),
    ...(input.rootCause ? { rootCause: text(input.rootCause, 'rootCause', 2000) } : {}),
    impact: impactOf(traced(state, project.id, input.impact, input.traceFrom), state, project.id),
    ...(input.retrofit
      ? { retrofit: { done: 0, total: intIn(input.retrofit.total, 'retrofit.total', 1_000_000) } }
      : {}),
    state: 'SUBMITTED',
    history: [],
  }
  record(item, at, by, null, 'SUBMITTED', (!input.to && optional(input.note, 2000)) || '提交')
  state.changes.push(item)
  // A change drafted from a trial (source TYPE_TEST, ref = trial id) becomes that trial's linked change.
  const trial = item.source.type === 'TYPE_TEST' && state.trials.find((t) => t.id === item.source.ref)
  // An approved trial and one under a running flow refuse edits, so they keep their record as it is.
  const editable = trial && MACHINES.trial[trial.state]?.length && !runningFlow(state, 'trial', trial.id)
  // A change the CCB rejected never releases the trial, so the new draft replaces it.
  const linked = editable && state.changes.find((c) => c.id === trial.changeId)
  const free = !linked || linked.state === 'REJECTED' || linked.ccb?.decision === 'REJECTED'
  if (editable && trial.projectId === project.id && free) trial.changeId = item.id
  return item
}

const EDITABLE_CHANGE = ['SUBMITTED', 'ANALYZED']

/** Edit a change's impact analysis while it is still before CCB review. */
export function updateImpact(state, { id, impact, traceFrom }) {
  const cr = find(state, 'change', id)
  if (!EDITABLE_CHANGE.includes(cr.state)) fail(`${cr.id} 已进入 ${cr.state}，影响分析不可再改`)
  cr.impact = impactOf(traced(state, cr.projectId, impact, traceFrom), state, cr.projectId)
  return cr
}

/**
 * Edit the field-loop parts of a change: impact, source and root cause before CCB review, the retrofit
 * total before closing while no flow runs, and the verification record once approved.
 */
export function updateChange(state, input, now = Date.now()) {
  const cr = find(state, 'change', input.id, input.projectId)
  // traceFrom without an impact traces from the requirements the change already names.
  // The fields an impact edit names replace those fields; the ones it leaves out are kept.
  if (input.impact || input.traceFrom)
    updateImpact(state, { ...input, impact: { ...cr.impact, ...input.impact } })
  const early = (name) =>
    EDITABLE_CHANGE.includes(cr.state) ? true : fail(`${cr.id} 已进入 ${cr.state}，${name}不可再改`)
  // Sending back the current title or reason is no edit, so it is not refused after CCB review.
  const title = input.title === undefined ? cr.title : text(input.title, 'title', 200)
  const reason = input.reason === undefined ? cr.reason : text(input.reason, 'reason', 2000)
  if (title !== cr.title && early('标题')) cr.title = title
  if (reason !== cr.reason && early('理由')) cr.reason = reason
  if (input.source !== undefined && early('来源')) cr.source = sourceOf(input.source)
  if (input.rootCause !== undefined && early('失效原因'))
    cr.rootCause = text(input.rootCause, 'rootCause', 2000)
  if (input.retrofit?.total !== undefined) {
    if (cr.state === 'CLOSED') fail(`${cr.id} 已关闭`)
    const running = runningFlow(state, 'change', cr.id)
    if (running) fail(`${cr.id} 有进行中的审批 ${running.id}，整改总数待流程结束后再改`)
    const done = cr.retrofit?.done ?? 0
    // Completion (and its as-maintained baseline) happens once, on the last door's progress update.
    if (done && done === cr.retrofit.total) fail(`${cr.id} 整改已完成（${done}/${done}），总数不可再改`)
    const total = intIn(input.retrofit.total, 'retrofit.total', 1_000_000)
    if (done && total <= done) fail(`整改总数需大于已完成数 ${done}`)
    if (total < done) fail('整改总数不能小于已完成数')
    cr.retrofit = { done, total }
  }
  if (input.verification !== undefined) {
    if (!['APPROVED', 'IMPLEMENTED'].includes(cr.state)) fail(`${cr.id} 批准后才能登记验证`)
    const trialId = optional(input.verification.trialId, 32)
    if (trialId && !state.trials.some((t) => t.id === trialId && t.projectId === cr.projectId))
      fail(`未找到 ${cr.projectId} 的试验 ${trialId}`)
    cr.verification = {
      result: oneOf(input.verification.result, ['PASS', 'FAIL'], 'verification.result'),
      by: input.by || '未署名',
      at: new Date(now).toISOString(),
      ...(trialId ? { trialId } : {}),
    }
  }
  const note = optional(input.note, 2000)
  // A transition records its own note; an analysis-only update must preserve it too.
  if (note && !input.to)
    record(cr, new Date(now).toISOString(), input.by || '未署名', cr.state, cr.state, note)
  return cr
}

// ── Trials, faults and quality problems ────────────────────────────────────────────────────────

/** Trial moves: REPORTED needs a report number and a result; a failed trial is approved only with an approved change. */
function moveTrial(state, trial, to, input, at) {
  if (trial.state === 'REPORTED' && to === 'IN_PROGRESS') {
    // A retest: the previous report and result stay in the history, the new report starts empty.
    trial.history.push({
      at,
      by: input.by || '未署名',
      from: 'REPORTED',
      to: 'REPORTED',
      note: `上次报告 ${trial.reportNo}（${trial.result}）`,
    })
    delete trial.reportNo
    // The test date of the next report is the retest's, unless this call gives one.
    if (input.at === undefined) delete trial.at
    trial.result = 'PENDING'
  }
  trialFields(state, trial, input)
  if (to === 'REPORTED') {
    if (!trial.reportNo) fail(`${trial.id} 缺少报告号（reportNo）：出具报告前需填写`)
    if (!trial.result || trial.result === 'PENDING')
      fail(`${trial.id} 缺少试验结论：出具报告前需判定合格或不合格`)
    trial.at ??= at
  }
  if (to === 'APPROVED') trialApprovable(state, trial)
}

/** A trial is approved on a report with a result; a failed one only with an approved change (conditional release). */
function trialApprovable(state, trial) {
  if (!trial.reportNo) fail(`${trial.id} 缺少报告号（reportNo）`)
  if (!trial.result || trial.result === 'PENDING') fail(`${trial.id} 缺少试验结论：需判定合格或不合格`)
  if (trial.result !== 'FAIL') return
  const change = state.changes.find((c) => c.id === trial.changeId)
  // A change rejected by the CCB and then closed was never approved.
  if (
    !change ||
    !['APPROVED', 'IMPLEMENTED', 'CLOSED'].includes(change.state) ||
    change.ccb?.decision === 'REJECTED'
  )
    fail(`${trial.id} 结论为不合格，需关联已批准的变更后才能批准（条件放行）`)
}

/** The report fields a trial move or edit may carry. */
function trialFields(state, trial, input) {
  if (input.reportNo !== undefined) trial.reportNo = text(input.reportNo, 'reportNo', 48)
  if (input.result !== undefined) trial.result = oneOf(input.result, TRIAL_RESULTS, 'result')
  if (input.deviations !== undefined) trial.deviations = trialList(input.deviations, 'deviations')
  if (input.changeId !== undefined) trial.changeId = trialChange(state, trial, input.changeId)
}
const trialList = (value, name) =>
  Array.isArray(value) && value.length <= 50
    ? value.map((v) => text(v, name, 300))
    : fail(`${name} 需为字符串数组`)
function trialChange(state, trial, changeId) {
  if (!state.changes.some((c) => c.id === changeId && c.projectId === trial.projectId))
    fail(`未找到 ${trial.projectId} 的变更 ${changeId}`)
  return changeId
}

/**
 * Register a trial (omit id) or edit its fields, and optionally move it (to). The kind of trial picks the
 * id prefix: TT type test, RT routine, FAT, FAI.
 */
export function upsertTrial(state, input, now = Date.now()) {
  const at = new Date(now).toISOString()
  const by = input.by || '未署名'
  let trial = input.id ? find(state, 'trial', input.id, input.projectId) : undefined
  if (trial) {
    guardEditable(state, 'trial', trial)
    // The type made the id's prefix, so it stays.
    if (input.type !== undefined && input.type !== trial.type)
      fail(`${trial.id} 的类型 ${trial.type} 不可更改`)
  } else {
    const project = projectOf(state, text(input.projectId, 'projectId', 64))
    const type = oneOf(input.type, TRIAL_TYPES, 'type')
    const year = new Date(now).getUTCFullYear()
    const prefix = TRIAL_PREFIX[type]
    trial = {
      id: `${prefix}-${year}-${pad(yearSeq(state.trials, prefix, year), 3)}`,
      projectId: project.id,
      type,
      title: text(input.title, 'title', 200),
      standard: text(input.standard, 'standard', 200),
      sample: text(input.sample, 'sample', 100),
      lab: text(input.lab, 'lab', 100),
      plannedAt: text(input.plannedAt, 'plannedAt', 40),
      result: 'PENDING',
      deviations: [],
      verifies: [],
      state: 'PLANNED',
      history: [],
    }
    record(trial, at, by, null, 'PLANNED', '登记')
    state.trials.push(trial)
  }
  for (const [key, max] of [
    ['title', 200],
    ['standard', 200],
    ['sample', 100],
    ['lab', 100],
    ['witness', 100],
    ['plannedAt', 40],
  ])
    if (input[key] !== undefined) trial[key] = text(input[key], key, max)
  if (input.at !== undefined) trial.at = text(input.at, 'at', 40)
  if (input.verifies !== undefined) {
    const list = ids(input.verifies, 'verifies')
    for (const r of list)
      if (!state.reqs.some((x) => x.id === r && x.projectId === trial.projectId))
        fail(`未找到 ${trial.projectId} 的需求 ${r}`)
    trial.verifies = list
  }
  // A move applies the report fields itself, after a retest has put the previous report in the history.
  if (input.to) transition(state, { ...input, kind: 'trial', id: trial.id, to: input.to, by }, now)
  else {
    trialFields(state, trial, input)
    keepNote(trial, input, at, by)
  }
  return trial
}

/** Register a quality problem (omit id) or edit its 8D steps, root cause and links, and optionally move it (to). */
export function upsertProblem(state, input, now = Date.now()) {
  const at = new Date(now).toISOString()
  const by = input.by || '未署名'
  let problem = input.id ? find(state, 'problem', input.id, input.projectId) : undefined
  if (problem) guardEditable(state, 'problem', problem)
  else {
    const project = projectOf(state, text(input.projectId, 'projectId', 64))
    const year = new Date(now).getUTCFullYear()
    problem = {
      id: `QP-${year}-${pad(yearSeq(state.problems, 'QP', year), 3)}`,
      projectId: project.id,
      title: text(input.title, 'title', 200),
      faultIds: [],
      severity: oneOf(input.severity ?? 'C', SEVERITIES, 'severity'),
      steps: Object.fromEntries(PROBLEM_STEPS.map((d) => [d, { done: false }])),
      state: 'OPEN',
      owner: optional(input.owner, 64) || '质量工程师',
      history: [],
    }
    record(problem, at, by, null, 'OPEN', '登记')
    state.problems.push(problem)
  }
  if (input.title !== undefined) problem.title = text(input.title, 'title', 200)
  if (input.severity !== undefined) problem.severity = oneOf(input.severity, SEVERITIES, 'severity')
  if (input.owner !== undefined) problem.owner = text(input.owner, 'owner', 64)
  if (input.rootCause !== undefined) problem.rootCause = text(input.rootCause, 'rootCause', 2000)
  if (input.containment !== undefined) problem.containment = text(input.containment, 'containment', 2000)
  if (input.noChangeReason !== undefined)
    problem.noChangeReason = text(input.noChangeReason, 'noChangeReason', 500)
  if (input.changeId !== undefined) {
    if (!state.changes.some((c) => c.id === input.changeId && c.projectId === problem.projectId))
      fail(`未找到 ${problem.projectId} 的变更 ${input.changeId}`)
    problem.changeId = input.changeId
  }
  for (const [step, value] of Object.entries(input.steps ?? {})) {
    if (!PROBLEM_STEPS.includes(step)) fail(`未知 8D 步骤：${step}（可选 ${PROBLEM_STEPS.join('/')}）`)
    const cur = problem.steps[step] ?? { done: false }
    problem.steps[step] = {
      done: value?.done === undefined ? cur.done : Boolean(value.done),
      ...(value?.text !== undefined || cur.text
        ? { text: value?.text === undefined ? cur.text : text(value.text, `steps.${step}.text`, 1000) }
        : {}),
    }
  }
  if (input.faultIds !== undefined) {
    const list = ids(input.faultIds, 'faultIds')
    for (const fid of list) {
      const fault =
        state.faults.find((f) => f.id === fid && f.projectId === problem.projectId) ??
        fail(`未找到 ${problem.projectId} 的预警 ${fid}`)
      if (fault.problemId && fault.problemId !== problem.id) fail(`${fid} 已挂在质量问题 ${fault.problemId}`)
    }
    for (const fid of list) state.faults.find((f) => f.id === fid).problemId = problem.id
    problem.faultIds = [...new Set([...problem.faultIds, ...list])]
  }
  if (input.to) transition(state, { ...input, kind: 'problem', id: problem.id, to: input.to, by }, now)
  else keepNote(problem, input, at, by)
  return problem
}

/** ACTION needs a root cause and D4; CLOSED needs D8 and either a closed change or a stated reason. */
function moveProblem(state, problem, to, input) {
  if (input.rootCause !== undefined) problem.rootCause = text(input.rootCause, 'rootCause', 2000)
  if (input.noChangeReason !== undefined)
    problem.noChangeReason = text(input.noChangeReason, 'noChangeReason', 500)
  if (to === 'ACTION' && problem.state === 'ANALYZING') {
    if (!problem.rootCause) fail(`${problem.id} 缺少根本原因（rootCause）：进入措施阶段前需完成原因分析`)
    if (!problem.steps?.D4?.done) fail(`${problem.id} 的 D4（根本原因）尚未完成`)
  }
  if (to === 'CLOSED') problemClosable(state, problem)
}

function problemClosable(state, problem) {
  if (!problem.steps?.D8?.done) fail(`${problem.id} 的 D8（总结与关闭）尚未完成`)
  if (problem.changeId) {
    const change = state.changes.find((c) => c.id === problem.changeId)
    if (change?.state !== 'CLOSED') fail(`${problem.id} 关联的变更 ${problem.changeId} 尚未关闭`)
    if (change.ccb?.decision === 'REJECTED')
      fail(
        `${problem.id} 关联的变更 ${problem.changeId} 已被 CCB 驳回：请关联新的变更，或写明不需要设计变更的理由`,
      )
  } else if (!problem.noChangeReason)
    fail(`${problem.id} 没有关联变更：请写明不需要设计变更的理由（noChangeReason）`)
}

/** Faults in a time window, aggregated by signal, week and train, for the analysis step of an 8D. */
export function faultSummary(
  state,
  { projectId, signal, state: faultState, days = 30, limit = 30 } = {},
  now = Date.now(),
) {
  if (signal) oneOf(signal, FAULT_SIGNALS, 'signal')
  const span = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.min(Number(days), 365) : 30
  const from = now - span * DAY
  const list = state.faults
    .filter(
      (f) =>
        (!projectId || f.projectId === projectId) &&
        (!signal || f.signal === signal) &&
        (!faultState || f.state === faultState) &&
        Date.parse(f.detectedAt) > from &&
        Date.parse(f.detectedAt) <= now,
    )
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
  const tally = (key) => {
    const out = {}
    for (const f of list) out[key(f)] = (out[key(f)] ?? 0) + 1
    return out
  }
  const weeks = Math.ceil(span / 7)
  return {
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days: span },
    total: list.length,
    bySignal: tally((f) => f.signal),
    byState: tally((f) => f.state),
    byTrain: Object.fromEntries(
      Object.entries(tally((f) => f.train))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
    ),
    byWeek: Array.from({ length: weeks }, (_, k) => {
      const end = now - (weeks - 1 - k) * 7 * DAY
      return {
        weekEnding: new Date(end).toISOString(),
        count: list.filter((f) => Date.parse(f.detectedAt) > end - 7 * DAY && Date.parse(f.detectedAt) <= end)
          .length,
      }
    }),
    items: list.slice(0, Math.min(Math.max(Number(limit) || 30, 1), 100)),
  }
}

/** A defect names a test case or requirement that exists in its project; free text from an older board still reads as it was. */
function knownReq(state, project, value, name, level) {
  const id = text(value, name, 16)
  if (!state.reqs.some((x) => x.projectId === project.id && x.id === id && (!level || x.level === level)))
    fail(
      `${name} ${id} 不存在于 ${project.id}${level ? `（需为 ${level} 条目）` : ''}：先用 devboard_req_upsert 登记，或核对编号`,
    )
  return id
}

function createDefect(state, input, at) {
  const project = projectOf(state, text(input.projectId, 'projectId', 64))
  const n = state.defects.reduce((max, d) => Math.max(max, Number(/^DEF-(\d+)$/.exec(d.id)?.[1] ?? 0)), 0)
  const by = input.by || '未署名'
  const item = {
    id: `DEF-${pad(n + 1, 4)}`,
    projectId: project.id,
    title: text(input.title, 'title', 200),
    severity: oneOf(input.severity ?? 'C', Object.keys(LABELS.severity), 'severity'),
    foundIn: oneOf(input.foundIn ?? 'VERIFICATION', STAGES, 'foundIn'),
    ...(input.testCase ? { testCase: knownReq(state, project, input.testCase, 'testCase', 'TC') } : {}),
    ...(input.req ? { req: knownReq(state, project, input.req, 'req') } : {}),
    state: 'NEW',
    owner: optional(input.owner, 64) || '软件设计师',
    createdAt: at,
    history: [],
  }
  record(item, at, by, null, 'NEW', optional(input.description, 500) || '登记')
  state.defects.push(item)
  return item
}

const TC_STATUS = ['pass', 'fail', 'skip']
const RESULTS_LIMIT = 500

/** The test cases of one run, checked against the project's registered TC items; the counts follow from them. */
function runResults(state, project, input) {
  const list = input.results
  if (!Array.isArray(list) || !list.length || list.length > RESULTS_LIMIT)
    fail(`results 需为 1–${RESULTS_LIMIT} 条 { tc, status }`)
  const seen = new Set()
  const results = list.map((r, i) => {
    const tc = text(r?.tc, `results[${i}].tc`, 16)
    const status = oneOf(r?.status, TC_STATUS, `results[${i}].status`)
    if (seen.has(tc)) fail(`results 中 ${tc} 重复`)
    seen.add(tc)
    if (!state.reqs.some((x) => x.projectId === project.id && x.id === tc && x.level === 'TC'))
      fail(`未找到测试用例 ${tc}：先用 devboard_req_upsert 登记 TC，再登记测试结果`)
    return { tc, status }
  })
  const n = (k) => results.filter((r) => r.status === k).length
  const counts = { total: results.length, passed: n('pass'), failed: n('fail'), skipped: n('skip') }
  for (const [k, v] of Object.entries(counts))
    if (input[k] !== undefined && Number(input[k]) !== v)
      fail(`自报的 ${k}=${input[k]} 与 results 算出的 ${v} 不符：总数由 results 决定，请核对后重新登记`)
  return { results, counts }
}

/**
 * Apply a run's per-case results to the requirement chain: a passing TC is VERIFIED, a failing one that
 * was VERIFIED goes back to APPROVED, and an SWR is VERIFIED exactly when all its TCs are. Failed cases that
 * have an open defect get the run in the defect's history; the others are reported, never turned into defects.
 */
function applyResults(state, project, run, by, at) {
  const own = state.reqs.filter((x) => x.projectId === project.id)
  const verified = []
  const reverted = []
  const touched = new Set()
  for (const { tc, status } of run.results) {
    const item = own.find((x) => x.id === tc && x.level === 'TC')
    if (status === 'pass' && item.status !== 'VERIFIED') {
      item.status = 'VERIFIED'
      verified.push(tc)
    }
    if (status === 'fail' && item.status === 'VERIFIED') {
      item.status = 'APPROVED'
      reverted.push(tc)
    }
    for (const parent of item.parent ?? []) touched.add(parent)
  }
  const swrs = []
  for (const id of touched) {
    const swr = own.find((x) => x.id === id && x.level === 'SWR')
    if (!swr) continue
    const tcs = own.filter((x) => x.level === 'TC' && x.parent?.includes(id))
    const all = tcs.length > 0 && tcs.every((x) => x.status === 'VERIFIED')
    if (all && swr.status !== 'VERIFIED') {
      swr.status = 'VERIFIED'
      swrs.push(id)
    } else if (!all && swr.status === 'VERIFIED') swr.status = 'APPROVED'
  }
  const noted = []
  const needsDefect = []
  for (const { tc, status } of run.results) {
    if (status !== 'fail') continue
    const defect = state.defects.find(
      (d) => d.projectId === project.id && d.testCase === tc && OPEN_DEFECT.includes(d.state),
    )
    if (defect) {
      record(defect, at, by, defect.state, defect.state, `测试运行 ${run.id} 中 ${tc} 失败`)
      noted.push(defect.id)
    } else needsDefect.push(tc)
  }
  return {
    verifiedTcs: verified,
    revertedTcs: reverted,
    verifiedSwrs: swrs,
    defectsNoted: noted,
    needsDefect,
  }
}

export function recordTestRun(state, input, now = Date.now()) {
  const project = projectOf(state, text(input.projectId, 'projectId', 64))
  const level = oneOf(input.level ?? 'UNIT', Object.keys(LABELS.testLevel), 'level')
  const given = input.results !== undefined ? runResults(state, project, input) : undefined
  const [total, passed, failed, skipped] = given
    ? [given.counts.total, given.counts.passed, given.counts.failed, given.counts.skipped]
    : ['total', 'passed', 'failed', 'skipped'].map((k) => {
        const v = Number(input[k] ?? 0)
        return Number.isInteger(v) && v >= 0 && v <= 100000 ? v : fail(`${k} 需为非负整数`)
      })
  if (passed + failed + skipped !== total)
    fail(`用例数不一致：通过 ${passed} + 失败 ${failed} + 跳过 ${skipped} ≠ 总数 ${total}`)
  const short = numberOf(state, project.id)
  const n = state.testRuns.filter((t) => t.projectId === project.id).length + 1
  const at = new Date(now).toISOString()
  const run = {
    id: `TR-${short}-${pad(n, 2)}`,
    projectId: project.id,
    level,
    at,
    total,
    passed,
    failed,
    skipped,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    ...(given ? { results: given.results } : {}),
    source: 'live',
    log: optional(input.log, 4000),
  }
  state.testRuns.push(run)
  // The effects of a per-case run are returned with it, never stored on it.
  return given ? { ...run, effects: applyResults(state, project, run, input.by || '研发协调员', at) } : run
}

export function registerApp(state, { projectId, url }, now = Date.now()) {
  const project = projectOf(state, projectId)
  if (!project.live) fail(`${project.id} 不是现场项目`)
  if (typeof url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}(\/\S*)?$/.test(url))
    fail('运行地址需为本机地址，例如 http://127.0.0.1:5180/')
  project.appUrl = url
  project.appRegisteredAt = new Date(now).toISOString()
  return project
}

function nextId(state, kind) {
  const n = state[COLLECTIONS[kind]].reduce((max, item) => Math.max(max, Number(item.id.split('-')[1])), 0)
  return `${PREFIX[kind]}-${String(n + 1).padStart(3, '0')}`
}

/** New requirements start RAW, tasks PENDING, interventions OPEN, projects at INITIATION. */
export function create(state, input, now = Date.now()) {
  const at = new Date(now).toISOString()
  const by = input.by || '未署名'
  if (input.kind === 'project') return createProject(state, input, at, now)
  if (input.kind === 'change') return createChange(state, input, at, now)
  if (input.kind === 'defect') return createDefect(state, input, at)
  const base = (kind, initial) => ({
    id: nextId(state, kind),
    ...(input.projectId ? { projectId: projectOf(state, input.projectId).id } : {}),
    state: initial,
    createdAt: at,
    history: [{ at, by, from: null, to: initial, note: '创建' }],
  })
  if (input.kind === 'requirement') {
    const item = {
      ...base('requirement', 'RAW'),
      title: text(input.title, 'title', 200),
      description: optional(input.description),
      priority: oneOf(input.priority ?? 'P1', Object.keys(LABELS.priority), 'priority'),
      owner: input.owner || '产品经理智能体',
    }
    state.requirements.push(item)
    return item
  }
  if (input.kind === 'task') {
    const requirement = find(state, 'requirement', text(input.requirementId, 'requirementId', 64))
    const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn : []
    for (const dep of dependsOn) find(state, 'task', dep)
    const item = {
      ...base('task', 'PENDING'),
      ...(requirement.projectId ? { projectId: requirement.projectId } : {}),
      requirementId: requirement.id,
      title: text(input.title, 'title', 200),
      type: oneOf(input.type, Object.keys(LABELS.taskType), 'type'),
      owner: input.owner || '研发协调员',
      dependsOn,
    }
    state.tasks.push(item)
    return item
  }
  if (input.kind === 'intervention') {
    const entity = input.entity ?? fail('缺少字段：entity')
    oneOf(entity.kind, ['requirement', 'task'], 'entity.kind')
    const target = find(state, entity.kind, entity.id)
    const hours = Number(input.dueInHours ?? 24)
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) fail('dueInHours 需在 0–720 之间')
    const item = {
      ...base('intervention', 'OPEN'),
      ...(target.projectId ? { projectId: target.projectId } : {}),
      type: oneOf(input.type, Object.keys(LABELS.interventionType), 'type'),
      entity: { kind: entity.kind, id: entity.id },
      ask: text(input.ask, 'ask'),
      dueAt: new Date(now + hours * HOUR).toISOString(),
      handler: null,
      resolution: null,
      requestedBy: by,
    }
    state.interventions.push(item)
    return item
  }
  return fail(`未知实体类型：${input.kind}`)
}

// ── Approval flows ─────────────────────────────────────────────────────────────────────────────
// The rules of a flow live in approvals.mjs; this is the link to the objects whose state it advances.

const AUTHOR_FALLBACK = {
  artifact: '系统设计师',
  change: '系统设计师',
  problem: '质量工程师',
  trial: '验证工程师',
}
function authorRole(type, subject) {
  const by =
    type === 'artifact'
      ? subject.authorRole
      : type === 'change'
        ? subject.raisedBy
        : type === 'problem'
          ? subject.owner
          : subject.history?.[0]?.by
  // The coordinator signs as 「研发协调员 · <role>」: the role it acted as is the author.
  const role = roleOf(String(by ?? '').replace(`${AGENT_NAME} · `, ''))
  if (ROLES.includes(role)) return role
  if (type === 'artifact' && subject.authorRole != null) fail('无法识别编制角色，请填写已知岗位后再发起审批')
  return AUTHOR_FALLBACK[type]
}

/** What a subject must look like for its template to start. */
function startable(state, template, subject) {
  const same = (s) => `${subject.id} 当前${LABELS.state[s] ?? s}`
  if (template === 'DOC_RELEASE' && subject.status === 'BASELINED')
    fail(`${subject.id} 已基线，修改后才能再次发起发布审批`)
  if (template === 'ECR' && subject.state !== 'CCB_REVIEW')
    fail(`${same(subject.state)}，需先提交 CCB 才能发起 ECR 审批`)
  if (template === 'ECN_RELEASE') {
    // A closed change can still release its ECN: closing does not wait for the release flow.
    if (!subject.ecn || !['APPROVED', 'IMPLEMENTED', 'CLOSED'].includes(subject.state))
      fail(`${same(subject.state)}，ECR 批准并生成 ECN 后才能发起 ECN 发布`)
    if (
      state.approvals.some(
        (a) => a.template === template && a.subject.id === subject.id && a.state === 'APPROVED',
      )
    )
      fail(`${subject.ecn} 已发布`)
  }
  if (template === 'PROBLEM_CLOSE') {
    if (subject.state !== 'VERIFYING') fail(`${same(subject.state)}，处于验证中才能发起关闭审批`)
    problemClosable(state, subject)
  }
  if (template === 'TRIAL_REPORT') {
    if (subject.state !== 'REPORTED') fail(`${same(subject.state)}，出具报告后才能发起试验报告审批`)
    trialApprovable(state, subject)
  }
}

/**
 * Start the flow of a template for an object. One RUNNING flow per object; the initiator is the role that
 * wrote or raised it. An agent (`agent: true`) may start flows only for objects it drafted itself.
 */
export function submitApproval(state, { template, subjectId, by, agent }, now = Date.now()) {
  const def =
    TEMPLATES[template] ?? fail(`未知审批模板：${template}（可选 ${Object.keys(TEMPLATES).join(' / ')}）`)
  const type = def.subject
  const actor = by || '未署名'
  const subject =
    state[SUBJECTS[type]].find((x) => x.id === text(subjectId, 'subjectId', 64)) ??
    fail(`未找到${LABELS.approvalSubject[type]} ${subjectId}`)
  const running = runningFlow(state, type, subject.id)
  if (running) fail(`${subject.id} 已有进行中的审批 ${running.id}：一个对象同一时间只能有一个进行中的流程`)
  startable(state, template, subject)
  if (agent) {
    // The coordinator drafted it (under any acting role). A change it sent to CCB itself also counts: the
    // customer change the presenter registered and handed over is analysed and sent to CCB by the agent.
    const byAgent = (who) => who === AGENT_NAME || String(who ?? '').startsWith(`${AGENT_NAME} · `)
    const sentToCcb =
      type === 'change' &&
      byAgent(subject.history?.findLast((h) => h.to === 'CCB_REVIEW' && h.from !== 'CCB_REVIEW')?.by)
    const mine =
      type === 'artifact'
        ? subject.source?.type === 'workspace'
        : byAgent(type === 'change' ? subject.raisedBy : subject.history?.[0]?.by) || sentToCcb
    if (!mine) fail(`${subject.id} 不是智能体起草的对象：请让用户在看板上发起审批`)
  }
  const year = new Date(now).getUTCFullYear()
  const flow = newFlow({
    id: `AP-${year}-${pad(yearSeq(state.approvals, 'AP', year), 4)}`,
    projectId: subject.projectId,
    template,
    subject: { type, id: subject.id },
    title: `${def.name}：${subject.id} ${subject.title ?? ''}`.trim(),
    initiator: { role: authorRole(type, subject), by: actor },
    now,
  })
  state.approvals.push(flow)
  return flow
}

/** Handle the current node of a flow; the end of the flow settles its object. A refused action or settlement leaves the flow untouched. */
export function actApproval(state, input, now = Date.now()) {
  const flow = state.approvals.find((a) => a.id === input.id) ?? fail(`未找到审批 ${input.id}`)
  const draft = structuredClone(flow)
  const outcome = act(draft, input, now)
  if (outcome) settle(state, draft, outcome, now)
  for (const key of Object.keys(flow)) delete flow[key]
  return Object.assign(flow, draft)
}

/** Who agreed and still stands: a send-back voids the agreements of the node it returns to and of every later one. */
function standingSigners(flow) {
  const order = flow.nodes.map((n) => n.id)
  let standing = []
  for (const a of flow.actions) {
    if (a.action === 'APPROVE') standing.push(a)
    if (a.action === 'RETURN') {
      const back = a.to === 'INITIATOR' ? 0 : order.indexOf(a.to)
      standing = standing.filter((s) => order.indexOf(s.nodeId) < back)
    }
  }
  return [...new Set(standing.map((a) => a.by))]
}

function settle(state, flow, outcome, now) {
  const { type, id } = flow.subject
  const subject = state[SUBJECTS[type]].find((x) => x.id === id)
  if (!subject || outcome === 'WITHDRAWN') return
  const at = new Date(now).toISOString()
  const last = flow.actions.at(-1)
  const by = last.by
  const project = state.projects.find((p) => p.id === (flow.projectId ?? subject.projectId))
  if (project?.live)
    addHandback(
      state,
      {
        kind: 'approval',
        subject: { type: 'approval', id: flow.id },
        projectId: project.id,
        text: `${flow.template} ${id} 审批${outcome === 'APPROVED' ? '已通过' : '已驳回'} → 交回研发协调员继续`,
        action: 'continue',
        object: { type: 'project', id: project.id },
        watch: [],
      },
      now,
    )
  const move = (to, extra = {}) =>
    transition(
      state,
      { kind: type, id, to, by, [FLOW]: true, note: `${flow.id} ${FLOW_LABELS[outcome]}`, ...extra },
      now,
    )
  if (outcome === 'APPROVED') {
    if (type === 'artifact') {
      subject.status = 'BASELINED'
      if (/^V0\./.test(subject.version)) subject.version = 'V1.0'
      subject.updatedAt = at
      closeReleaseFindings(state, flow, at)
    } else if (flow.template === 'ECR') {
      move('APPROVED', { members: standingSigners(flow) })
    } else if (flow.template === 'ECN_RELEASE') {
      const baseline = releaseEcn(state, subject, at)
      record(
        subject,
        at,
        by,
        subject.state,
        subject.state,
        `${subject.ecn} 已发布${baseline ? `，生成设计态基线 ${baseline.id}` : ''}`,
      )
    } else move(type === 'problem' ? 'CLOSED' : 'APPROVED')
    return
  }
  // Rejected: the object returns to an editable state and needs a new flow.
  if (type === 'artifact') {
    if (subject.status === 'IN_REVIEW') subject.status = 'DRAFT'
  } else if (flow.template === 'ECR') move('REJECTED')
  else if (flow.template === 'PROBLEM_CLOSE') move('ACTION')
  else if (flow.template === 'TRIAL_REPORT') move('IN_PROGRESS')
}

// ── Read model ─────────────────────────────────────────────────────────────────────────────────

const OPEN_DEFECT = ['NEW', 'CONFIRMED', 'FIXING', 'RETEST']

/** Derived per-project figures; nothing here is stored. */
export function metrics(state, project, now = Date.now()) {
  const own = (list) => list.filter((x) => x.projectId === project.id)
  const stages = STAGES.map((s) => state.stages.find((x) => x.id === `${project.id}/${s}`)).filter(Boolean)
  const current = stages.find((s) => s.stage === project.stage) ?? stages.at(-1)
  // A reworked stage keeps its old actualEnd; it is late against now until it passes again.
  const end = current?.actualEnd && current.state === 'PASSED' ? Date.parse(current.actualEnd) : now
  const delayDays = current?.plannedEnd ? Math.round((end - Date.parse(current.plannedEnd)) / DAY) : 0
  const defects = own(state.defects)
  const open = defects.filter((d) => OPEN_DEFECT.includes(d.state))
  const trend = Array.from({ length: 8 }, (_, k) => {
    const to = now - (7 - k) * 7 * DAY
    const from = to - 7 * DAY
    const inside = (iso) => Boolean(iso) && Date.parse(iso) > from && Date.parse(iso) <= to
    return {
      weekEnding: new Date(to).toISOString(),
      opened: defects.filter((d) => inside(d.createdAt)).length,
      closed: defects.filter((d) => inside(d.closedAt)).length,
    }
  })
  const runs = own(state.testRuns).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const latestTests = Object.keys(LABELS.testLevel)
    .map((level) => runs.filter((r) => r.level === level).at(-1))
    .filter(Boolean)
    .map((r) => ({
      id: r.id,
      level: r.level,
      at: r.at,
      passRate: r.total ? Math.round((r.passed / r.total) * 1000) / 10 : null,
    }))
  return {
    passedStages: stages.filter((s) => s.state === 'PASSED').length,
    stageCount: stages.length,
    currentStage: current?.stage,
    currentState: current?.state,
    delayDays,
    overdue: Boolean(current && current.state !== 'PASSED' && Date.parse(current.plannedEnd) < now),
    coverage: coverage(state, project.id),
    openDefects: Object.fromEntries(
      Object.keys(LABELS.severity).map((s) => [s, open.filter((d) => d.severity === s).length]),
    ),
    deferredDefects: defects.filter((d) => d.state === 'DEFERRED').length,
    defectTrend: trend,
    latestTests,
    openChanges: own(state.changes).filter((c) => OPEN_CHANGE.includes(c.state)).length,
    openRisks: (project.risks ?? []).filter((r) => r.status !== 'CLOSED').length,
    pendingGates: state.gates.filter(
      (g) => g.decision === 'PENDING' && g.stageId.startsWith(`${project.id}/`),
    ).length,
    ...fieldMetrics(state, project, now),
  }
}

const latestBaseline = (state, projectId, type) =>
  state.configBaselines
    .filter((b) => b.projectId === projectId && b.type === type)
    .reduce((top, b) => (!top || Date.parse(b.at) >= Date.parse(top.at) ? b : top), undefined)

/** Field, trial and baseline figures; zero for a project with none of them. */
function fieldMetrics(state, project, now) {
  const own = (list) => list.filter((x) => x.projectId === project.id)
  const recent = state.faults.filter(
    (f) =>
      f.projectId === project.id &&
      Date.parse(f.detectedAt) > now - 30 * DAY &&
      Date.parse(f.detectedAt) <= now,
  )
  const retrofits = own(state.changes).filter((c) => c.retrofit)
  const designed = latestBaseline(state, project.id, 'AS_DESIGNED')?.revs ?? {}
  const maintained = latestBaseline(state, project.id, 'AS_MAINTAINED')?.revs
  const trials = own(state.trials)
  return {
    faults30d: Object.fromEntries(
      FAULT_SIGNALS.map((signal) => [signal, recent.filter((f) => f.signal === signal).length]),
    ),
    faults30dTotal: recent.length,
    openProblems: own(state.problems).filter((p) => p.state !== 'CLOSED').length,
    retrofit: {
      done: retrofits.reduce((n, c) => n + c.retrofit.done, 0),
      total: retrofits.reduce((n, c) => n + c.retrofit.total, 0),
    },
    // Without an as-maintained baseline nothing in service lags the design yet.
    baselineGap: maintained
      ? Object.keys(designed).filter((itemId) => maintained[itemId] !== designed[itemId]).length
      : 0,
    trials: {
      total: trials.length,
      approved: trials.filter((t) => t.state === 'APPROVED').length,
      failed: trials.filter((t) => t.result === 'FAIL' && t.state !== 'APPROVED').length,
    },
  }
}

/** Read model: every collection (or one project's), effective states, counts and metrics. */
export function snapshot(state, now = Date.now(), projectId) {
  const pick = (list) => (projectId ? list.filter((x) => x.projectId === projectId) : list)
  const interventions = pick(state.interventions)
    .map((item) => ({ ...item, state: effectiveState(item, 'intervention', now) }))
    .sort(
      (a, b) =>
        Number(b.state === 'EXPIRED') - Number(a.state === 'EXPIRED') ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
  const count = (list, kind) =>
    Object.fromEntries(Object.keys(MACHINES[kind]).map((s) => [s, list.filter((i) => i.state === s).length]))
  const projects = projectId ? [projectOf(state, projectId)] : state.projects
  const gates = state.gates.filter((g) => !projectId || g.stageId.startsWith(`${projectId}/`))
  return {
    revision: state.revision,
    synthetic: true,
    now: new Date(now).toISOString(),
    projects: projects.map((p) => ({ ...p, metrics: metrics(state, p, now) })),
    stages: pick(state.stages),
    gates,
    artifacts: pick(state.artifacts),
    reqs: pick(state.reqs),
    // The impact tree is traced live, so it follows the requirement links as they are now. Ids a change
    // names that do not exist (impact.reqs is free text) are left out so one bad id cannot break the read model.
    changes: pick(state.changes).map((c) => {
      const known = (c.impact?.reqs ?? []).filter((id) =>
        state.reqs.some((r) => r.id === id && r.projectId === c.projectId),
      )
      return known.length ? { ...c, trace: traceImpact(state, c.projectId, known) } : c
    }),
    defects: pick(state.defects),
    testRuns: pick(state.testRuns),
    trials: pick(state.trials),
    faults: pick(state.faults),
    problems: pick(state.problems),
    items: pick(state.items),
    configBaselines: pick(state.configBaselines),
    requirements: pick(state.requirements),
    tasks: pick(state.tasks),
    interventions,
    approvals: pick(state.approvals).map((a) => view(a, now)),
    activity: pick(state.activity ?? []).toReversed(),
    handbacks: pick(pendingHandbacks(state)),
    blockers: blockers(state, now, projectId),
    counts: {
      requirement: count(pick(state.requirements), 'requirement'),
      task: count(pick(state.tasks), 'task'),
      intervention: count(interventions, 'intervention'),
      trial: count(pick(state.trials), 'trial'),
      fault: count(pick(state.faults), 'fault'),
      problem: count(pick(state.problems), 'problem'),
      pendingGates: gates.filter((g) => g.decision === 'PENDING').length,
      approvalsRunning: pick(state.approvals).filter((a) => a.state === 'RUNNING').length,
      approvalsOverdue: pick(state.approvals).filter((a) => view(a, now).overdue).length,
    },
    machines: MACHINES,
    labels: LABELS,
    roles: ROLES,
    orgs: ORGS,
    profiles: GATE_PROFILES,
    liveTailoring: LIVE_TAILORING,
    approvalTemplates: TEMPLATES,
  }
}

// ── Store ──────────────────────────────────────────────────────────────────────────────────────
// One meta key, each collection split into chunks under the 64 KiB per-value limit, and one key per
// cached live document body.

const META = 'devboard/meta'
const SCHEMA = 4
const CHUNK_BYTES = 56 * 1024
const V1_KEYS = ['devboard/requirements', 'devboard/tasks', 'devboard/interventions']
const NAMES = Object.values(COLLECTIONS)
const docKey = (id) => `devboard/doc/${id}`

function chunks(list) {
  const out = [[]]
  let size = 2
  for (const item of list) {
    const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1
    if (bytes > CHUNK_BYTES) fail(`单条数据过大：${item.id}`)
    if (size + bytes > CHUNK_BYTES) {
      out.push([])
      size = 2
    }
    out.at(-1).push(item)
    size += bytes
  }
  return out
}

/** A store written by another schema (v1, v2) reads as empty, so the caller falls back to the seed. */
function load(store) {
  const meta = store.get(META)
  // Schema 3 (before approval flows) loads with an empty approvals collection.
  if (!meta || ![3, SCHEMA].includes(meta.schema)) return undefined
  const state = { schema: SCHEMA, revision: meta.revision }
  for (const c of NAMES)
    state[c] = Array.from(
      { length: meta.chunks?.[c] ?? 0 },
      (_, i) => store.get(`devboard/${c}/${i}`) ?? [],
    ).flat()
  return state
}
function save(store, state, previous) {
  const counts = {}
  for (const c of NAMES) {
    const parts = chunks(state[c] ?? [])
    parts.forEach((part, i) => {
      store.set(`devboard/${c}/${i}`, part)
    })
    for (let i = parts.length; i < (previous?.chunks?.[c] ?? 0); i++) store.delete(`devboard/${c}/${i}`)
    counts[c] = parts.length
  }
  for (const [id, doc] of Object.entries(state.docs ?? {})) store.set(docKey(id), doc)
  if (previous?.schema === 1) for (const key of V1_KEYS) store.delete(key)
  store.set(META, { schema: SCHEMA, revision: state.revision, chunks: counts })
}
const need = (store) => store ?? fail('档案存储不可用')

/**
 * Never writes: query services and effect preparation get a read-only store. An empty store reads
 * as the seed relative to now (so overdue items stay overdue); the first write or reset persists it.
 */
export function read(store, now = Date.now()) {
  return need(store).transaction(() => load(store) ?? seed(now))
}

/** A cached live document body, or undefined. Read-only. */
export function readDoc(store, id) {
  return need(store).transaction(() => store.get(docKey(id)))
}

/**
 * An artifact's body for the Markdown preview: seed documents ship in the package, live documents
 * are the bodies the coordinator's tool read from the workspace when it recorded them.
 */
export function artifactBody(store, artifactId, now = Date.now()) {
  const artifact = read(store, now).artifacts.find((a) => a.id === artifactId) ?? fail(`未找到 ${artifactId}`)
  const head = { id: artifact.id, title: artifact.title, version: artifact.version, status: artifact.status }
  if (artifact.source?.type === 'seed') {
    const { docId } = artifact.source
    if (!/^DOC-[A-Z0-9-]{1,40}$/.test(docId) || !/^PRJ-\d{4}-\d{3}$/.test(artifact.projectId))
      fail(`种子文档编号无效：${docId}`)
    const url = new URL(`./seed-docs/${artifact.projectId}/${docId}.md`, import.meta.url)
    return { ...head, source: 'seed', ...clip(readFileSync(url, 'utf8')) }
  }
  const doc = readDoc(store, artifact.id)
  const path = artifact.source?.path
  return {
    ...head,
    source: 'workspace',
    // Source, test and analysis files that are not Markdown preview as plain text; the page never renders them as HTML.
    format: SOURCE_KINDS.includes(artifact.kind) && !/\.md$/i.test(path ?? '') ? 'text' : 'markdown',
    path,
    markdown:
      doc?.markdown ??
      `> 尚未读取到 ${artifact.source?.path ?? '该文件'} 的内容，请让研发协调员重新登记交付物。`,
    truncated: doc?.truncated ?? false,
  }
}

// ── Agent activity ─────────────────────────────────────────────────────────────────────────────
// Every board write a tool makes leaves one line. The summary is built here from the tool and the entity,
// never from text the model supplied, so the feed cannot carry instructions or claims.

export const AGENT_NAME = '研发协调员'
/** The roles the playbook lets the coordinator write on behalf of (the ids of its role table). */
export const ACTING_ROLES = Object.freeze({
  requirements: '系统设计师（需求）',
  architect: '软件设计师（架构）',
  developer: '软件设计师（开发）',
  reviewer: '代码评审员',
  tester: '验证工程师',
  mechanical: '机械设计师',
  electrical: '电气设计师',
  diagnostics: '诊断工程师',
  rams: 'RAMS 工程师',
  quality: '质量工程师',
  config: '配置管理员',
})
export const ACTIVITY_LIMIT = 200
export const SUMMARY_LIMIT = 160
/** The author of a tool write: the coordinator, with the role it acted as when it named one. */
export function actorOf(role) {
  if (role === undefined || role === null) return AGENT_NAME
  if (typeof role !== 'string' || !Object.hasOwn(ACTING_ROLES, role))
    fail(`actingRole 无效：${String(role).slice(0, 32)}（可选 ${Object.keys(ACTING_ROLES).join(' / ')}）`)
  return `${AGENT_NAME} · ${ACTING_ROLES[role]}`
}
/** tool → [verb, entity kind or a function of the input]. */
const ACTIVITY_VERBS = {
  devboard_create_requirement: ['录入需求', 'requirement'],
  devboard_create_task: ['创建任务', 'task'],
  devboard_transition: ['推进', (input) => input.kind],
  devboard_request_human: ['发起人工介入', 'intervention'],
  devboard_project_create: ['创建项目', 'project'],
  devboard_stage_update: ['开始阶段', 'stage'],
  devboard_artifact_record: ['登记交付物', 'artifact'],
  devboard_req_upsert: ['登记追溯条目', 'project'],
  devboard_gate_submit: ['提交评审', 'gate'],
  devboard_test_record: ['登记测试运行', 'testRun'],
  devboard_defect_upsert: ['登记缺陷', 'defect'],
  devboard_change_upsert: ['登记变更', 'change'],
  devboard_trial_upsert: ['登记试验', 'trial'],
  devboard_problem_upsert: ['登记质量问题', 'problem'],
  devboard_approval_submit: ['发起审批', 'approval'],
  devboard_app_register: ['登记运行地址', 'project'],
  devboard_fastforward: ['快进演示项目', 'project'],
}
export const ACTIVITY_TOOLS = Object.keys(ACTIVITY_VERBS)

/** Append one activity line for a finished tool write; keeps the newest ACTIVITY_LIMIT. */
function logActivity(state, { tool, actor, input = {} }, result, now) {
  const [verb, kindOf] = ACTIVITY_VERBS[tool] ?? []
  if (!verb) return
  const kind = typeof kindOf === 'function' ? kindOf(input) : kindOf
  // a gate submission answers { stage, gate }; every other write answers its entity (or a list, then the project)
  const id = String(
    (kind === 'gate' ? result?.gate?.id : undefined) ?? result?.id ?? input.projectId ?? '',
  ).slice(0, 64)
  if (!kind || !id) return
  const to = typeof input.to === 'string' ? LABELS.state[input.to] : undefined
  const projectId =
    result?.projectId ?? result?.stage?.projectId ?? (kind === 'project' ? id : input.projectId)
  const rev = state.revision + 1
  state.activity ??= []
  state.activity.push({
    id: `ACT-${rev}`,
    rev,
    at: new Date(now).toISOString(),
    actor,
    tool,
    entity: { kind, id },
    ...(typeof projectId === 'string' ? { projectId: projectId.slice(0, 64) } : {}),
    summary: `${verb} ${id}${to ? ` → ${to}` : ''}`.slice(0, SUMMARY_LIMIT),
  })
  if (state.activity.length > ACTIVITY_LIMIT) state.activity.splice(0, state.activity.length - ACTIVITY_LIMIT)
  // The feed is capped, so a card is marked when its follow-up is written instead of being re-derived from the feed later.
  const line = state.activity.at(-1)
  for (const card of state.handbacks ?? [])
    if (card.state === 'OPEN' && followedBy(card, line)) card.state = 'FOLLOWED'
}

// ── Hand-backs ────────────────────────────────────────────────────────────────────────────────
// A person's decision on a live project (a gate, a finished approval flow) or an answered human-intervention
// request leaves one card that hands the work back to the coordinator. The card opens the composer with the
// hand-off attached; it is never sent for the person. It stays on the board until the coordinator writes
// something for the same project (or the objects it names) afterwards, or until someone dismisses it.

export const HANDBACK_LIMIT = 50

function addHandback(state, card, now) {
  const rev = state.revision + 1
  state.handbacks ??= []
  state.handbacks.push({
    id: `HB-${rev}`,
    rev,
    at: new Date(now).toISOString(),
    state: 'OPEN',
    ...card,
  })
  // Handled cards go first, so a card still waiting is not dropped while older handled ones remain.
  while (state.handbacks.length > HANDBACK_LIMIT) {
    const handled = state.handbacks.findIndex((c) => c.state !== 'OPEN')
    state.handbacks.splice(Math.max(handled, 0), 1)
  }
}

const followedBy = (card, a) =>
  a.rev > card.rev &&
  ((card.projectId && a.projectId === card.projectId) || card.watch?.includes(a.entity?.id))
/** Whether the coordinator has written for this card's project or objects since the card was made. */
const followedUp = (state, card) => (state.activity ?? []).some((a) => followedBy(card, a))

/** The cards still waiting for the coordinator, newest first. */
export const pendingHandbacks = (state) =>
  (state.handbacks ?? []).filter((card) => card.state === 'OPEN' && !followedUp(state, card)).toReversed()

export function dismissHandback(state, { id, by }) {
  const card = state.handbacks?.find((c) => c.id === id) ?? fail(`未找到 ${id}`)
  card.state = 'DISMISSED'
  card.dismissedBy = text(by, 'by', 64)
  return card
}

/** One transaction per write: load, mutate, bump revision, persist. `activity` ({ tool, actor, input }) adds the feed line of a tool write. */
export function update(store, work, now = Date.now(), activity) {
  return need(store).transaction(() => {
    const previous = store.get(META)
    if (previous?.schema > SCHEMA)
      fail(
        `档案由更新版本的 DevBoard 写入（schema ${previous.schema}），本版本不会覆盖：请安装更新版本，或在总览页重置演示数据`,
      )
    const state = load(store) ?? seed(now)
    const result = work(state)
    if (activity) logActivity(state, activity, result, now)
    state.revision += 1
    save(store, state, previous)
    return { revision: state.revision, result }
  })
}

export function reset(store, now = Date.now()) {
  return need(store).transaction(() => {
    const previous = store.get(META)
    const old = load(store)
    // Cached live bodies belong to live projects, which a reset removes.
    for (const a of old?.artifacts ?? []) if (a.source?.type === 'workspace') store.delete(docKey(a.id))
    const fresh = { ...seed(now), revision: (old?.revision ?? previous?.revision ?? 0) + 1 }
    save(store, fresh, previous)
    return { revision: fresh.revision }
  })
}
