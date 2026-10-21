// DevBoard domain: the R&D lifecycle (projects, stages, review gates, traceability, changes, defects,
// test runs) plus the v1 requirement / task / human-intervention machines, derived metrics and store
// persistence. No host imports, so tests run against a plain in-memory store.
import { readFileSync } from 'node:fs'
import { buildSeed } from './seed-data.mjs'

export const STAGES = ['INITIATION', 'REQUIREMENTS', 'DESIGN', 'IMPLEMENTATION', 'VERIFICATION', 'RELEASE']
/** Default writing and approving roles per stage; the approver is never the stage's author. */
export const STAGE_AUTHOR = {
  INITIATION: '项目经理',
  REQUIREMENTS: '需求工程师',
  DESIGN: '软件架构师',
  IMPLEMENTATION: '软件开发工程师',
  VERIFICATION: '测试工程师',
  RELEASE: '项目经理',
}
export const STAGE_APPROVER = {
  INITIATION: '研发总监',
  REQUIREMENTS: '项目经理',
  DESIGN: '技术负责人',
  IMPLEMENTATION: '技术负责人',
  VERIFICATION: '质量负责人',
  RELEASE: '质量负责人',
}
export const LEVELS = ['CUS', 'SYS', 'SWR', 'DES', 'TC']
const PARENT_LEVEL = { SYS: 'CUS', SWR: 'SYS', DES: 'SWR', TC: 'SWR' }

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
  // IN_REVIEW is entered by submitting a gate; PASSED and REWORK only by a gate decision, and a PASSED
  // stage returns to REWORK only through an approved change request.
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
  },
  stage: {
    INITIATION: '立项',
    REQUIREMENTS: '需求分析',
    DESIGN: '架构设计',
    IMPLEMENTATION: '开发实现',
    VERIFICATION: '测试验证',
    RELEASE: '发布验收',
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
    TEST_PLAN: '测试计划',
    TEST_REPORT: '测试报告',
    RELEASE_NOTE: '发布说明',
    CCB_MINUTES: 'CCB 纪要',
  },
  level: { CUS: '客户条款', SYS: '系统需求', SWR: '软件需求', DES: '设计', TC: '测试用例' },
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
  requirement: 'requirements',
  task: 'tasks',
  intervention: 'interventions',
}
const PREFIX = { requirement: 'REQ', task: 'TASK', intervention: 'HI' }
const HOUR = 3_600_000
const DAY = 24 * HOUR
const HISTORY_LIMIT = 30
const OPEN_CHANGE = ['SUBMITTED', 'ANALYZED', 'CCB_REVIEW', 'APPROVED', 'IMPLEMENTED']
/** Live document bodies are cached in the store, whose values are capped at 64 KiB. */
export const DOC_LIMIT_BYTES = 48 * 1024

export class DomainError extends Error {}
const fail = (message) => {
  throw new DomainError(message)
}

export const seed = (now = Date.now()) => buildSeed(now)

export function effectiveState(item, kind, now) {
  return kind === 'intervention' && item.state === 'OPEN' && Date.parse(item.dueAt) < now
    ? 'EXPIRED'
    : item.state
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
const stageLabel = (stage) => LABELS.stage[stage] ?? stage
/** "质量负责人 韩雪" and "质量负责人" both sign as the role 质量负责人. */
export const roleOf = (by) =>
  String(by ?? '')
    .trim()
    .split(/\s+/)[0]

function record(item, at, by, from, to, note) {
  item.history = [...(item.history ?? []), { at, by, from, to, ...(note ? { note } : {}) }].slice(
    -HISTORY_LIMIT,
  )
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

/** The only write path for states. Refuses any move absent from the kind's table. */
export function transition(state, input, now = Date.now()) {
  const { kind, id, to, by, note } = input
  if (!MACHINES[kind]) fail(`未知实体类型：${kind}`)
  if (kind === 'stage') return moveStage(state, find(state, 'stage', id), input, now)
  const item = find(state, kind, id)
  const from = effectiveState(item, kind, now)
  if (!MACHINES[kind][from]?.includes(to)) fail(`非法状态流转：${from} 不可流转至 ${to}`)
  const at = new Date(now).toISOString()
  const actor = by || '未署名'
  if (kind === 'intervention') {
    if (to === 'CLAIMED') item.handler = actor
    if (to === 'OPEN') item.handler = null
    if (to === 'RESOLVED') item.resolution = note || '已处理'
  }
  if (kind === 'change') moveChange(item, to, actor, at, note, input.members)
  if (kind === 'defect') {
    if (to === 'CLOSED') item.closedAt = at
    else delete item.closedAt
  }
  record(item, at, actor, from, to, note)
  if (kind === 'task') link(state, item, at)
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
    fail(`阶段「${stageLabel(stage.stage)}」只能通过评审门决议进入${LABELS.state[to]}`)
  if (to !== 'IN_PROGRESS' || !MACHINES.stage[stage.state]?.includes(to))
    fail(`非法状态流转：${stage.state} 不可流转至 ${to}`)
  const index = STAGES.indexOf(stage.stage)
  if (stage.state === 'NOT_STARTED' && index > 0) {
    const previous = stageOf(state, stage.projectId, STAGES[index - 1])
    if (previous.state !== 'PASSED')
      fail(
        `阶段顺序不满足：前一阶段「${stageLabel(previous.stage)}」尚未通过评审，不能开始「${stageLabel(stage.stage)}」`,
      )
  }
  if (author) stage.author = text(author, 'author', 32)
  record(stage, new Date(now).toISOString(), by || '未署名', stage.state, 'IN_PROGRESS', note)
  projectOf(state, stage.projectId).stage = stage.stage
  return stage
}

const pendingGate = (state, stageId) =>
  state.gates.find((g) => g.stageId === stageId && g.decision === 'PENDING')

function addFindings(gate, texts, by) {
  for (const raw of texts ?? []) {
    const n = gate.findings.length + 1
    gate.findings.push({
      id: `F-${String(n).padStart(2, '0')}`,
      text: text(raw, 'finding', 500),
      by,
      closed: false,
    })
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

/**
 * Submit a stage for review (IN_PROGRESS → IN_REVIEW with a new PENDING gate), or add and close
 * findings on the gate already pending. Requirements gates get a system finding while CUS→SWR is
 * incomplete; the implementation stage has no human gate and passes once every finding is closed.
 */
export function submitGate(state, { stageId, by, note, findings, closeFindings: closes }, now = Date.now()) {
  const stage = find(state, 'stage', stageId)
  const at = new Date(now).toISOString()
  const actor = by || '未署名'
  let gate = pendingGate(state, stage.id)
  if (stage.state === 'IN_PROGRESS') {
    const n = state.gates.filter((g) => g.stageId === stage.id).length + 1
    gate = {
      id: `GATE-${stage.projectId}-${stage.stage}-${n}`,
      stageId: stage.id,
      approverRole: STAGE_APPROVER[stage.stage],
      decision: 'PENDING',
      findings: [],
      submittedAt: at,
      submittedBy: actor,
    }
    state.gates.push(gate)
    record(stage, at, actor, 'IN_PROGRESS', 'IN_REVIEW', note || '提交评审')
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
  } else if (stage.state !== 'IN_REVIEW' || !gate) {
    fail(`阶段「${stageLabel(stage.stage)}」当前为${LABELS.state[stage.state]}，需先开始该阶段再提交评审`)
  }
  addFindings(gate, findings, actor)
  closeFindings(gate, closes, actor)
  if (stage.stage === 'IMPLEMENTATION' && gate.findings.every((f) => f.closed))
    approve(state, stage, gate, '系统（代码评审意见已全部关闭）', '代码评审意见全部关闭，自动通过', at)
  return { stage, gate }
}

const stageArtifacts = (state, stage) =>
  state.artifacts.filter((a) => a.projectId === stage.projectId && a.stage === stage.stage)

function approve(state, stage, gate, by, comment, at) {
  Object.assign(gate, { decision: 'APPROVED', approver: by, decidedAt: at, comment })
  record(stage, at, by, 'IN_REVIEW', 'PASSED', comment)
  stage.actualEnd = at
  const items = stageArtifacts(state, stage)
  for (const a of items) {
    a.status = 'BASELINED'
    // A draft (V0.x) becomes the first released version when it is baselined.
    if (/^V0\./.test(a.version)) a.version = 'V1.0'
  }
  const main = items[0]
  const short = stage.projectId.split('-').at(-1)
  const n = state.gates.filter((g) => g.stageId === stage.id && g.decision === 'APPROVED').length
  stage.baseline = {
    id: main
      ? `BL-${short}-${main.kind.replace('_', '-')}-${main.version}`
      : `BL-${short}-${stage.stage}-${n}`,
    at,
    items: items.map((a) => a.id),
  }
  const project = projectOf(state, stage.projectId)
  const next = STAGES[STAGES.indexOf(stage.stage) + 1]
  if (next && project.stage === stage.stage) project.stage = next
  if (!next) project.actualEnd = at
}

/** The three gate rules: in review, approver ≠ author, every finding closed before approval. */
export function decideGate(state, input, now = Date.now()) {
  const gate = find(state, 'gate', input.gateId)
  const stage = find(state, 'stage', gate.stageId)
  const decision = oneOf(input.decision, ['APPROVED', 'REJECTED'], 'decision')
  const by = text(input.by, 'by', 64)
  if (gate.decision !== 'PENDING' || stage.state !== 'IN_REVIEW')
    fail(
      `评审门不满足：阶段「${stageLabel(stage.stage)}」不在评审中（当前${LABELS.state[stage.state]}，该门${LABELS.state[gate.decision] ?? gate.decision}）`,
    )
  const role = roleOf(by)
  if (role === stage.author)
    fail(`评审门不满足：审批人角色「${role}」是该阶段的编写角色，编写人不能审批自己的交付物`)
  closeFindings(gate, input.closeFindings, by)
  const at = new Date(now).toISOString()
  const comment = optional(input.comment)
  if (decision === 'APPROVED') {
    const open = gate.findings.filter((f) => !f.closed)
    if (open.length)
      fail(`评审门不满足：还有 ${open.length} 条评审意见未关闭（${open.map((f) => f.id).join('、')}）`)
    approve(state, stage, gate, by, comment || '批准', at)
  } else {
    if (!comment) fail('驳回需填写评审意见')
    Object.assign(gate, { decision, approver: by, decidedAt: at, comment })
    record(stage, at, by, 'IN_REVIEW', 'REWORK', comment)
    for (const a of stageArtifacts(state, stage)) if (a.status === 'IN_REVIEW') a.status = 'DRAFT'
  }
  return { gate, stage }
}

// ── Change requests ────────────────────────────────────────────────────────────────────────────

function moveChange(cr, to, by, at, note, members) {
  if (to === 'ANALYZED') {
    const impact = cr.impact
    const any = impact && [impact.reqs, impact.artifacts, impact.tests].some((list) => list?.length)
    if (!any) fail(`${cr.id} 缺少影响分析：先登记受影响的需求、交付物或用例`)
  }
  if (to === 'APPROVED' || to === 'REJECTED')
    cr.ccb = {
      members: Array.isArray(members) && members.length ? members.slice(0, 12) : [by],
      decision: to,
      at,
      ...(note ? { note } : {}),
    }
}

const LEVEL_STAGE = { CUS: 'REQUIREMENTS', SYS: 'REQUIREMENTS', SWR: 'REQUIREMENTS', DES: 'DESIGN' }

/** An approved change marks impacted requirements CHANGED and sends impacted PASSED stages to rework. */
function applyChange(state, cr, at) {
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
  for (const name of stages) {
    const stage = state.stages.find((s) => s.id === `${cr.projectId}/${name}`)
    if (stage?.state !== 'PASSED') continue
    record(stage, at, 'CCB', 'PASSED', 'REWORK', `${cr.id} 已批准，受影响阶段返工`)
    reworked.push(stage.id)
  }
  cr.reworked = reworked
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

/** Register or update CUS/SYS/SWR/DES/TC items; parents must exist one level up in the same project. */
export function upsertReqs(state, { projectId, items, by }, now = Date.now()) {
  projectOf(state, projectId)
  if (!Array.isArray(items) || !items.length || items.length > 100) fail('items 需为 1–100 条')
  const at = new Date(now).toISOString()
  const touched = { created: [], updated: [] }
  for (const input of items) {
    const id = text(input?.id, 'id', 16)
    const match =
      /^(CUS|SYS|SWR|DES|TC)-\d{3,4}$/.exec(id) ?? fail(`编号格式无效：${id}（如 CUS-001、SWR-012、TC-020）`)
    const level = match[1]
    const existing = state.reqs.find((r) => r.id === id && r.projectId === projectId)
    const item = existing ?? { id, projectId, level, parent: [], verifiedBy: [], status: 'DRAFT' }
    item.title = input.title === undefined && existing ? existing.title : text(input.title, 'title', 200)
    item.text = input.text === undefined && existing ? existing.text : text(input.text, 'text', 2000)
    if (input.parent !== undefined) item.parent = ids(input.parent, 'parent')
    if (input.safety !== undefined) item.safety = Boolean(input.safety)
    if (input.status !== undefined)
      item.status = oneOf(input.status, ['DRAFT', 'APPROVED', 'CHANGED', 'VERIFIED'], 'status')
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

/** A workspace path inside the live project's directory, normalised to the workspace-relative form. */
export function projectPath(project, path) {
  if (!project.live || !project.workspaceDir) fail(`${project.id} 不是现场项目，不能登记工作区文件`)
  const dir = project.workspaceDir
  const raw = typeof path === 'string' ? path.trim() : ''
  const refuse = () => fail(`交付物路径越界：${raw || '（空）'} 必须是 ${dir}/ 内的相对路径`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || /[\\\x00-\x1f]/.test(raw)) refuse()
  const inside = raw === dir || raw.startsWith(`${dir}/`)
  if (!inside && raw.startsWith('devboard-projects/')) refuse()
  const full = inside ? raw : `${dir}/${raw}`
  if (full === dir || full.split('/').some((p) => !p || p === '.' || p === '..')) refuse()
  return full
}

/** Cut to at most DOC_LIMIT_BYTES of UTF-8 without splitting a character. */
export function clip(markdown) {
  const bytes = new TextEncoder().encode(markdown)
  if (bytes.length <= DOC_LIMIT_BYTES) return { markdown, truncated: false }
  return {
    markdown: new TextDecoder().decode(bytes.slice(0, DOC_LIMIT_BYTES)).replace(/�+$/, ''),
    truncated: true,
  }
}

/** One artifact per project and kind; a live body read by the tool is cached alongside the state. */
export function recordArtifact(state, input, now = Date.now()) {
  const project = projectOf(state, text(input.projectId, 'projectId', 64))
  const path = projectPath(project, input.path)
  const kind = oneOf(input.kind, Object.keys(LABELS.artifactKind), 'kind')
  const stage = oneOf(input.stage, STAGES, 'stage')
  const id = `DOC-${project.id.split('-').at(-1)}-${kind.replace('_', '-')}`
  const existing = state.artifacts.find((a) => a.id === id && a.projectId === project.id)
  const artifact = existing ?? { id, projectId: project.id, kind, status: 'DRAFT' }
  Object.assign(artifact, {
    stage,
    title: text(input.title ?? existing?.title ?? LABELS.artifactKind[kind], 'title', 200),
    version: text(input.version ?? existing?.version ?? 'V0.1', 'version', 16),
    authorRole: optional(input.authorRole ?? existing?.authorRole ?? STAGE_AUTHOR[stage], 32),
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

const yearSeq = (list, prefix, year) =>
  list.reduce((max, item) => {
    const m = new RegExp(`^${prefix}-${year}-(\\d+)$`).exec(item.id)
    return m ? Math.max(max, Number(m[1])) : max
  }, 0) + 1
const pad = (n, width) => String(n).padStart(width, '0')

function createProject(state, input, at, now) {
  const year = new Date(now).getUTCFullYear()
  const id = `PRJ-${year}-${pad(yearSeq(state.projects, 'PRJ', year), 3)}`
  const by = input.by || '研发协调员'
  const project = {
    id,
    name: text(input.name ?? input.title, 'name', 120),
    kind: oneOf(input.projectKind ?? 'SOFTWARE', Object.keys(LABELS.projectKind), 'projectKind'),
    customer: optional(input.customer, 120) || '宁川交通装备股份有限公司 运维事业部（内部）',
    productLine: oneOf(input.productLine ?? 'O&M_PLATFORM', Object.keys(LABELS.productLine), 'productLine'),
    manager: optional(input.manager, 64) || '项目经理（演示）',
    description: optional(input.description, 2000),
    stage: 'INITIATION',
    plannedStart: at,
    plannedEnd: new Date(now + 18 * DAY).toISOString(),
    risks: [],
    workspaceDir: `devboard-projects/${id}`,
    live: true,
    createdAt: at,
  }
  state.projects.push(project)
  STAGES.forEach((stage, i) => {
    const item = {
      id: `${id}/${stage}`,
      projectId: id,
      stage,
      state: 'NOT_STARTED',
      author: STAGE_AUTHOR[stage],
      plannedEnd: new Date(now + (i + 1) * 3 * DAY).toISOString(),
      history: [],
    }
    if (i === 0) record(item, at, by, 'NOT_STARTED', 'IN_PROGRESS', '立项启动')
    state.stages.push(item)
  })
  return project
}

export function impactOf(raw) {
  const impact = raw ?? {}
  const days = Number(impact.effortDays ?? 0)
  if (!Number.isFinite(days) || days < 0 || days > 1000) fail('effortDays 需在 0–1000 之间')
  return {
    reqs: ids(impact.reqs, 'impact.reqs'),
    artifacts: ids(impact.artifacts, 'impact.artifacts'),
    tests: ids(impact.tests, 'impact.tests'),
    safety: Boolean(impact.safety),
    effortDays: days,
  }
}

function createChange(state, input, at, now) {
  const project = projectOf(state, text(input.projectId, 'projectId', 64))
  const year = new Date(now).getUTCFullYear()
  const by = input.by || '未署名'
  const item = {
    id: `CR-${year}-${pad(yearSeq(state.changes, 'CR', year), 3)}`,
    projectId: project.id,
    title: text(input.title, 'title', 200),
    reason: text(input.reason ?? input.description, 'reason', 2000),
    raisedBy: by,
    impact: impactOf(input.impact),
    state: 'SUBMITTED',
    history: [],
  }
  record(item, at, by, null, 'SUBMITTED', '提交')
  state.changes.push(item)
  return item
}

/** Edit a change's impact analysis while it is still before CCB review. */
export function updateImpact(state, { id, impact }) {
  const cr = find(state, 'change', id)
  if (!['SUBMITTED', 'ANALYZED'].includes(cr.state)) fail(`${cr.id} 已进入 ${cr.state}，影响分析不可再改`)
  cr.impact = impactOf(impact)
  return cr
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
    ...(input.testCase ? { testCase: text(input.testCase, 'testCase', 16) } : {}),
    ...(input.req ? { req: text(input.req, 'req', 16) } : {}),
    state: 'NEW',
    owner: optional(input.owner, 64) || '软件开发工程师',
    createdAt: at,
    history: [],
  }
  record(item, at, by, null, 'NEW', optional(input.description, 500) || '登记')
  state.defects.push(item)
  return item
}

export function recordTestRun(state, input, now = Date.now()) {
  const project = projectOf(state, text(input.projectId, 'projectId', 64))
  const level = oneOf(input.level ?? 'UNIT', Object.keys(LABELS.testLevel), 'level')
  const [total, passed, failed, skipped] = ['total', 'passed', 'failed', 'skipped'].map((k) => {
    const v = Number(input[k] ?? 0)
    return Number.isInteger(v) && v >= 0 && v <= 100000 ? v : fail(`${k} 需为非负整数`)
  })
  if (passed + failed + skipped !== total)
    fail(`用例数不一致：通过 ${passed} + 失败 ${failed} + 跳过 ${skipped} ≠ 总数 ${total}`)
  const short = project.id.split('-').at(-1)
  const n = state.testRuns.filter((t) => t.projectId === project.id).length + 1
  const run = {
    id: `TR-${short}-${pad(n, 2)}`,
    projectId: project.id,
    level,
    at: new Date(now).toISOString(),
    total,
    passed,
    failed,
    skipped,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    source: 'live',
    log: optional(input.log, 4000),
  }
  state.testRuns.push(run)
  return run
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

// ── Read model ─────────────────────────────────────────────────────────────────────────────────

const OPEN_DEFECT = ['NEW', 'CONFIRMED', 'FIXING', 'RETEST']

/** Derived per-project figures; nothing here is stored. */
export function metrics(state, project, now = Date.now()) {
  const own = (list) => list.filter((x) => x.projectId === project.id)
  const stages = STAGES.map((s) => state.stages.find((x) => x.id === `${project.id}/${s}`)).filter(Boolean)
  const current = stages.find((s) => s.stage === project.stage) ?? stages.at(-1)
  const end = current?.actualEnd ? Date.parse(current.actualEnd) : now
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
    overdue: Boolean(current && current.state !== 'PASSED' && delayDays > 0),
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
    changes: pick(state.changes),
    defects: pick(state.defects),
    testRuns: pick(state.testRuns),
    requirements: pick(state.requirements),
    tasks: pick(state.tasks),
    interventions,
    counts: {
      requirement: count(pick(state.requirements), 'requirement'),
      task: count(pick(state.tasks), 'task'),
      intervention: count(interventions, 'intervention'),
      pendingGates: gates.filter((g) => g.decision === 'PENDING').length,
    },
    machines: MACHINES,
    labels: LABELS,
    roles: { author: STAGE_AUTHOR, approver: STAGE_APPROVER },
  }
}

// ── Store ──────────────────────────────────────────────────────────────────────────────────────
// One meta key, each collection split into chunks under the 64 KiB per-value limit, and one key per
// cached live document body.

const META = 'devboard/meta'
const SCHEMA = 2
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

/** A store written by another schema (v1) reads as empty, so the caller falls back to the seed. */
function load(store) {
  const meta = store.get(META)
  if (!meta || meta.schema !== SCHEMA) return undefined
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
  return {
    ...head,
    source: 'workspace',
    path: artifact.source?.path,
    markdown:
      doc?.markdown ??
      `> 尚未读取到 ${artifact.source?.path ?? '该文件'} 的内容，请让研发协调员重新登记交付物。`,
    truncated: doc?.truncated ?? false,
  }
}

/** One transaction per write: load, mutate, bump revision, persist. */
export function update(store, work, now = Date.now()) {
  return need(store).transaction(() => {
    const previous = store.get(META)
    const state = load(store) ?? seed(now)
    const result = work(state)
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
    const fresh = { ...seed(now), revision: (old?.revision ?? 0) + 1 }
    save(store, fresh, previous)
    return { revision: fresh.revision }
  })
}
