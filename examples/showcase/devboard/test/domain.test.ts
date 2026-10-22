import { describe, expect, it } from 'vitest'
import { act, newFlow, view } from '../approvals.mjs'
import { BLOCKER_KINDS, blockers } from '../blockers.mjs'
import { entryFile, evidenceDocs, latestRuns, showCustomerChange, showDelivery } from '../client/delivery.js'
import { MAIN_STEPS } from '../client/guide-data.js'
import { mainProgress } from '../client/guide-progress.js'
import {
  actApproval,
  artifactBody,
  coverage,
  create,
  DOC_LIMIT_BYTES,
  decideGate,
  faultSummary,
  MACHINES,
  metrics,
  projectPath,
  read,
  recordArtifact,
  recordTestRun,
  registerApp,
  reset,
  roleOf,
  seed,
  snapshot,
  submitApproval,
  submitGate,
  traceImpact,
  transition,
  update,
  updateChange,
  upsertProblem,
  upsertReqs,
  upsertTrial,
} from '../domain.mjs'
import { FILES, fastForward, GATES, levelOf, UNIT_TOTAL } from '../fastforward.mjs'
import { GATE_PROFILES, LIVE_TAILORING, ORGS, ROLES } from '../profiles.mjs'
import { buildSeed } from '../seed-data.mjs'

const NOW = Date.parse('2026-10-21T08:00:00Z')
const STAGE_LIST = ['INITIATION', 'REQUIREMENTS', 'DESIGN', 'IMPLEMENTATION', 'VERIFICATION', 'RELEASE']
const HOUR = 3_600_000
const DAY = 24 * HOUR
// biome-ignore lint/suspicious/noExplicitAny: domain.mjs is untyped JavaScript
type Item = { id: string; [key: string]: any }
// biome-ignore lint/suspicious/noExplicitAny: the in-test state is a plain object of collections
type State = any

const COLLECTIONS = [
  'projects',
  'stages',
  'gates',
  'artifacts',
  'reqs',
  'changes',
  'defects',
  'testRuns',
  'trials',
  'faults',
  'problems',
  'items',
  'configBaselines',
  'requirements',
  'tasks',
  'interventions',
  'approvals',
]
/** A small in-test state shaped per the schema 4 data contract; no dependence on the seed. */
const blank = (): State => ({
  schema: 4,
  revision: 1,
  ...Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
})

function memoryStore() {
  const rows = new Map<string, unknown>()
  return {
    rows,
    get: (key: string) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    set: (key: string, value: unknown) => {
      // The host caps each value at 64 KiB of JSON.
      if (new TextEncoder().encode(JSON.stringify(value)).length > 65536) throw new Error('INVALID_PARAMS')
      rows.set(key, structuredClone(value))
    },
    delete: (key: string) => void rows.delete(key),
    transaction: <T>(work: () => T) => work(),
  }
}
const readOnly = () => ({
  ...memoryStore(),
  set: () => {
    throw new Error('CAPABILITY_DENIED')
  },
  delete: () => {
    throw new Error('CAPABILITY_DENIED')
  },
})
const byId = (list: Item[], id: string, projectId?: string) =>
  list.find((x) => x.id === id && (!projectId || x.projectId === projectId)) as Item

const newProject = (state: State, projectKind: string, extra = {}) =>
  create(state, { kind: 'project', name: `测试项目 ${projectKind}`, projectKind, ...extra }, NOW)
const sign = (state: State, gateId: string, role: string, extra = {}) =>
  decideGate(state, { gateId, decision: 'APPROVED', by: `${role} 测试员`, ...extra }, NOW)
const start = (state: State, id: string) =>
  transition(state, { kind: 'stage', id, to: 'IN_PROGRESS', by: '研发协调员' }, NOW)

/** Start a stage if needed and take it through every gate of its profile, every role signing, findings closed. */
function pass(state: State, projectId: string, stage: string) {
  const id = `${projectId}/${stage}`
  const current = byId(state.stages, id)
  if (current.state !== 'IN_PROGRESS') start(state, id)
  for (let guard = 0; guard < 6 && current.state !== 'PASSED'; guard++) {
    const { gate } = submitGate(state, { stageId: id, by: '研发协调员' }, NOW)
    // An auto gate (TR4) with no open findings has already passed.
    for (const role of gate.decision === 'PENDING' ? gate.approverRoles : []) {
      const closeFindings = gate.findings
        .filter((f: Item) => !f.closed)
        .map((f: Item) => ({ id: f.id, note: '已处理' }))
      sign(state, gate.id, role, { closeFindings })
    }
  }
  return current
}

/** Run a flow to its end: the node's roles approve in turn (an ALL node needs every role). */
function approveFlow(state: State, id: string) {
  const flow = byId(state.approvals, id)
  while (flow.state === 'RUNNING') {
    const node = flow.nodes[flow.current]
    for (const role of node.mode === 'ALL' ? node.roles : [node.roles[0]])
      actApproval(state, { id, by: `${role} 测试员`, action: 'APPROVE' }, NOW)
  }
  return flow
}
/** Start and fully approve one template for an object. */
const release = (state: State, template: string, subjectId: string) =>
  approveFlow(state, submitApproval(state, { template, subjectId, by: '测试员' }, NOW).id)
/** SUBMITTED → … → CCB_REVIEW, then the ECR flow approves it. */
function ccbApprove(state: State, id: string) {
  for (const to of ['ANALYZED', 'CCB_REVIEW']) transition(state, { kind: 'change', id, to, by: 'CCB' }, NOW)
  release(state, 'ECR', id)
}

/** A change approved through the CCB; field and type-test sources get a root cause first. */
function approvedChange(state: State, projectId: string, extra: Item = {}) {
  const cr = create(
    state,
    { kind: 'change', projectId, title: '变更', reason: '原因', impact: { reqs: ['CUS-001'] }, ...extra },
    NOW,
  )
  if (['FIELD', 'TYPE_TEST'].includes(extra.source?.type) && !extra.rootCause)
    updateChange(state, { id: cr.id, rootCause: '根因' })
  ccbApprove(state, cr.id)
  return cr
}

describe('DevBoard v1 state machines', () => {
  const v1 = () => {
    const state = blank()
    create(state, { kind: 'requirement', title: '需求一', by: 'x' }, NOW)
    create(state, { kind: 'task', requirementId: 'REQ-001', title: '任务一', type: 'DEVELOPMENT' }, NOW)
    return state
  }

  it('refuses a move absent from the table and allows one present', () => {
    const state = v1()
    expect(() =>
      transition(state, { kind: 'requirement', id: 'REQ-001', to: 'COMPLETED', by: 'x' }, NOW),
    ).toThrow('非法状态流转：RAW 不可流转至 COMPLETED')
    expect(transition(state, { kind: 'requirement', id: 'REQ-001', to: 'REFINED', by: 'x' }, NOW).state).toBe(
      'REFINED',
    )
    expect(() => transition(state, { kind: 'task', id: 'TASK-001', to: 'COMPLETED', by: 'x' }, NOW)).toThrow(
      '非法状态流转：PENDING 不可流转至 COMPLETED',
    )
  })

  it('moves ASSIGNED → IN_PROGRESS on the first started task and completes when all tasks finish', () => {
    const state = v1()
    for (const to of ['REFINED', 'ASSIGNED'])
      transition(state, { kind: 'requirement', id: 'REQ-001', to, by: 'x' }, NOW)
    transition(state, { kind: 'task', id: 'TASK-001', to: 'IN_PROGRESS', by: 'x' }, NOW)
    expect(byId(state.requirements, 'REQ-001').state).toBe('IN_PROGRESS')
    transition(state, { kind: 'task', id: 'TASK-001', to: 'COMPLETED', by: 'x' }, NOW)
    expect(byId(state.requirements, 'REQ-001')).toMatchObject({ state: 'COMPLETED' })
    expect(byId(state.requirements, 'REQ-001').history.at(-1)).toMatchObject({
      by: '系统联动',
      to: 'COMPLETED',
    })
  })

  it('never offers EXPIRED as a stored target; derives it from dueAt', () => {
    for (const targets of Object.values(MACHINES.intervention)) expect(targets).not.toContain('EXPIRED')
    const state = v1()
    const hi = create(
      state,
      {
        kind: 'intervention',
        type: 'RELEASE_APPROVAL',
        entity: { kind: 'task', id: 'TASK-001' },
        ask: '可以吗？',
        dueInHours: 1,
      },
      NOW,
    )
    expect(byId(snapshot(state, NOW).interventions, hi.id).state).toBe('OPEN')
    expect(snapshot(state, NOW + 2 * HOUR).interventions[0].state).toBe('EXPIRED')
    const claimed = transition(
      state,
      { kind: 'intervention', id: hi.id, to: 'CLAIMED', by: '管理者' },
      NOW + 2 * HOUR,
    )
    expect(claimed.history.at(-1)).toMatchObject({ from: 'EXPIRED', to: 'CLAIMED' })
  })
})

describe('gate profiles by project kind', () => {
  it('takes stage authors, labels and gates from the profile of the project kind', () => {
    const state = blank()
    const order = newProject(state, 'NEW_BUILD')
    const retrofit = newProject(state, 'RETROFIT')
    expect(order).toMatchObject({ kind: 'NEW_BUILD', org: '轨道车辆门分技术中心' })
    expect(order.live).toBeUndefined()
    expect(order.workspaceDir).toBeUndefined()
    expect(byId(state.stages, `${order.id}/REQUIREMENTS`).author).toBe('系统设计师')
    expect(byId(state.stages, `${order.id}/IMPLEMENTATION`).author).toBe('机械设计师')
    expect(byId(state.stages, `${order.id}/INITIATION`).state).toBe('IN_PROGRESS')
    expect(retrofit.kind).toBe('RETROFIT')
    const view = snapshot(state, NOW)
    expect(view.profiles.RETROFIT.DESIGN.label).toBe('改造方案设计')
    expect(view.profiles.NEW_BUILD.DESIGN.gates.map((g: Item) => g.code)).toEqual(['DL2', 'FREEZE'])
    expect(view.profiles).toEqual(JSON.parse(JSON.stringify(GATE_PROFILES)))
    expect(view.roles).toEqual(ROLES)
    expect(view.orgs).toEqual(ORGS)
    expect(view.liveTailoring).toEqual(JSON.parse(JSON.stringify(LIVE_TAILORING)))
  })

  it('creates a workspace and the default tailoring only for a software project', () => {
    const state = blank()
    const sw = create(state, { kind: 'project', name: '车门健康监测看板' }, NOW)
    expect(sw).toMatchObject({
      kind: 'SOFTWARE',
      org: '智能运维分技术中心',
      live: true,
      workspaceDir: `devboard-projects/${sw.id}`,
      tailoring: { skipped: ['TR2', 'TR6', 'PDCP'], reason: LIVE_TAILORING.reason },
    })
    expect(byId(state.stages, `${sw.id}/INITIATION`).author).toBe('产品经理')
    expect(() => newProject(state, 'SPACESHIP')).toThrow('projectKind 取值无效')
    expect(() => newProject(state, 'NEW_BUILD', { org: '随便' })).toThrow('org 取值无效')
    expect(newProject(state, 'NEW_BUILD', { org: '站台门分技术中心' }).org).toBe('站台门分技术中心')
  })

  it('names each gate GATE-<project>-<code>-<n> with its profile roles and type', () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    const { gate } = submitGate(state, { stageId: `${p.id}/INITIATION`, by: '研发协调员' }, NOW)
    expect(gate).toMatchObject({
      id: `GATE-${p.id}-CONTRACT-1`,
      code: 'CONTRACT',
      name: '合同评审',
      type: 'MILESTONE',
      approverRoles: ['分技术中心主任'],
      signatures: [],
      decision: 'PENDING',
    })
    expect(gate).not.toHaveProperty('approverRole')
  })
})

describe('multi-gate stages and tailoring', () => {
  const toDesign = () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    pass(state, p.id, 'INITIATION')
    pass(state, p.id, 'REQUIREMENTS')
    const design = byId(state.stages, `${p.id}/DESIGN`)
    start(state, design.id)
    return { state, p, design }
  }

  it('runs DL2 then FREEZE in order: approving a non-last gate returns the stage to IN_PROGRESS', () => {
    const { state, p, design } = toDesign()
    const dl2 = submitGate(state, { stageId: design.id, by: '研发协调员' }, NOW).gate
    expect(dl2.code).toBe('DL2')
    sign(state, dl2.id, '项目经理')
    sign(state, dl2.id, '客户代表')
    expect(design.state).toBe('IN_PROGRESS')
    expect(design.history.at(-1)).toMatchObject({
      from: 'IN_REVIEW',
      to: 'IN_PROGRESS',
      note: 'DL2 已通过，进入 FREEZE',
    })
    expect(design.baseline).toBeUndefined()
    const freeze = submitGate(state, { stageId: design.id, by: '研发协调员' }, NOW).gate
    expect(freeze).toMatchObject({ id: `GATE-${p.id}-FREEZE-1`, approverRoles: ['技术负责人'] })
    sign(state, freeze.id, '技术负责人')
    expect(design.state).toBe('PASSED')
    expect(design.baseline.at).toBeTruthy()
    expect(byId(state.projects, p.id).stage).toBe('IMPLEMENTATION')
  })

  it('resubmits the rejected gate, not the ones already approved', () => {
    const { state, p, design } = toDesign()
    const dl2 = submitGate(state, { stageId: design.id, by: 'x' }, NOW).gate
    sign(state, dl2.id, '项目经理')
    sign(state, dl2.id, '客户代表')
    const freeze = submitGate(state, { stageId: design.id, by: 'x' }, NOW).gate
    decideGate(
      state,
      { gateId: freeze.id, decision: 'REJECTED', by: '技术负责人', comment: '冻结条件不足' },
      NOW,
    )
    expect(design.state).toBe('REWORK')
    start(state, design.id)
    expect(submitGate(state, { stageId: design.id, by: 'x' }, NOW).gate.id).toBe(`GATE-${p.id}-FREEZE-2`)
  })

  it('skips the gates a project tailors out and runs the full IPD when untailored', () => {
    const state = blank()
    const live = create(state, { kind: 'project', name: '实时项目' }, NOW)
    pass(state, live.id, 'INITIATION')
    pass(state, live.id, 'REQUIREMENTS')
    const design = byId(state.stages, `${live.id}/DESIGN`)
    start(state, design.id)
    const tr3 = submitGate(state, { stageId: design.id, by: 'x' }, NOW).gate
    expect(tr3.code).toBe('TR3')
    sign(state, tr3.id, '技术负责人')
    expect(design.state).toBe('PASSED')
    expect(state.gates.some((g: Item) => g.code === 'TR2' || g.code === 'PDCP')).toBe(false)
    pass(state, live.id, 'IMPLEMENTATION')
    pass(state, live.id, 'VERIFICATION')
    const release = pass(state, live.id, 'RELEASE')
    expect(release.state).toBe('PASSED')
    expect(state.gates.filter((g: Item) => g.stageId === release.id).map((g: Item) => g.code)).toEqual([
      'ADCP',
    ])

    const full = create(state, { kind: 'project', name: '完整 IPD' }, NOW)
    full.tailoring = undefined
    pass(state, full.id, 'INITIATION')
    pass(state, full.id, 'REQUIREMENTS')
    pass(state, full.id, 'DESIGN')
    const codes = state.gates.filter((g: Item) => g.stageId === `${full.id}/DESIGN`).map((g: Item) => g.code)
    expect(codes).toEqual(['TR2', 'TR3', 'PDCP'])
  })

  it('passes the auto gate TR4 once every finding is closed, replacing the v2 special case', () => {
    const state = blank()
    const p = create(state, { kind: 'project', name: '自动门' }, NOW)
    const impl = byId(state.stages, `${p.id}/IMPLEMENTATION`)
    impl.state = 'IN_PROGRESS'
    const review = submitGate(
      state,
      { stageId: impl.id, by: '研发协调员', findings: ['缺少端口参数校验'] },
      NOW,
    )
    expect(review.gate).toMatchObject({ code: 'TR4', auto: true, approverRoles: ['技术负责人'] })
    expect(impl.state).toBe('IN_REVIEW')
    submitGate(
      state,
      { stageId: impl.id, by: '研发协调员', closeFindings: [{ id: 'F-01', note: '已补充' }] },
      NOW,
    )
    expect(impl.state).toBe('PASSED')
    expect(review.gate).toMatchObject({ decision: 'APPROVED', approver: '系统（代码评审意见已全部关闭）' })
    // Other gates are never automatic.
    const order = newProject(state, 'NEW_BUILD')
    const proto = byId(state.stages, `${order.id}/IMPLEMENTATION`)
    proto.state = 'IN_PROGRESS'
    const gate = submitGate(state, { stageId: proto.id, by: 'x' }, NOW).gate
    expect(gate).toMatchObject({ code: 'PROTO', decision: 'PENDING' })
    expect(gate.auto).toBeUndefined()
  })
})

describe('approver roles and co-signing', () => {
  const dl1 = () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    pass(state, p.id, 'INITIATION')
    const stage = byId(state.stages, `${p.id}/REQUIREMENTS`)
    start(state, stage.id)
    const gate = submitGate(
      state,
      { stageId: stage.id, by: '研发协调员', findings: ['补充偏离说明'] },
      NOW,
    ).gate
    return { state, p, stage, gate }
  }

  it('refuses an approver whose role the gate does not name', () => {
    const { state, gate } = dl1()
    expect(() => sign(state, gate.id, '质量工程师')).toThrow('评审门不满足：本门需由 项目经理、客户代表 审批')
    expect(() =>
      decideGate(state, { gateId: gate.id, decision: 'REJECTED', by: '技术负责人', comment: 'x' }, NOW),
    ).toThrow('本门需由')
    expect(() => sign(state, gate.id, '系统设计师')).toThrow('是该阶段的编写角色')
    expect(roleOf('RAMS 工程师 唐力')).toBe('RAMS 工程师')
    expect(roleOf('客户代表 方卫东')).toBe('客户代表')
  })

  it('needs every role to sign once and every finding closed before the last signature approves', () => {
    const { state, stage, gate } = dl1()
    const afterFirst = sign(state, gate.id, '客户代表').gate
    expect(afterFirst.decision).toBe('PENDING')
    expect(afterFirst.signatures).toEqual([
      expect.objectContaining({ role: '客户代表', by: '客户代表 测试员' }),
    ])
    expect(stage.state).toBe('IN_REVIEW')
    expect(() => sign(state, gate.id, '客户代表')).toThrow('已签署')
    const open = gate.findings.filter((f: Item) => !f.closed)
    expect(() => sign(state, gate.id, '项目经理')).toThrow(`还有 ${open.length} 条评审意见未关闭`)
    const done = sign(state, gate.id, '项目经理', {
      closeFindings: open.map((f: Item) => ({ id: f.id, note: '已补' })),
    })
    expect(done.gate).toMatchObject({ decision: 'APPROVED', approver: '项目经理 测试员' })
    expect(done.gate.signatures.map((s: Item) => s.role)).toEqual(['客户代表', '项目经理'])
    expect(stage.state).toBe('PASSED')
  })

  it('rejects when any approver role rejects, with a comment, into REWORK', () => {
    const { state, stage, gate } = dl1()
    sign(state, gate.id, '客户代表')
    const input = { gateId: gate.id, decision: 'REJECTED', by: '项目经理 测试员' }
    expect(() => decideGate(state, input, NOW)).toThrow('驳回需填写评审意见')
    const done = decideGate(state, { ...input, comment: '偏离项未澄清' }, NOW)
    expect(done.gate).toMatchObject({ decision: 'REJECTED', approver: '项目经理 测试员' })
    expect(stage.state).toBe('REWORK')
    expect(() => sign(state, gate.id, '项目经理')).toThrow('评审门不满足：阶段')
  })

  it('adds the CUS→SWR coverage finding to the requirements gate and refuses a stage not in review', () => {
    const { state, p, gate } = dl1()
    expect(gate.findings[0]).toMatchObject({ by: '系统检查', closed: false })
    expect(gate.findings[0].text).toContain('CUS→SWR 覆盖率')
    expect(gate.findings[1]).toMatchObject({ text: '补充偏离说明', closed: false })
    expect(() => sign(state, `GATE-${p.id}-CONTRACT-1`, '分技术中心主任')).toThrow('不在评审中')
  })

  it('refuses to start a stage before the previous one passed and PASSED by transition', () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    expect(() => start(state, `${p.id}/DESIGN`)).toThrow(
      '阶段顺序不满足：前一阶段「技术协议与需求」尚未通过评审',
    )
    expect(() =>
      transition(state, { kind: 'stage', id: `${p.id}/INITIATION`, to: 'PASSED', by: 'x' }, NOW),
    ).toThrow('只能通过评审门决议')
  })
})

describe('trials and first-article inspection', () => {
  const order = () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    upsertReqs(state, { projectId: p.id, items: [{ id: 'CUS-001', title: 'c', text: 'c' }] }, NOW)
    return { state, p }
  }
  const plan = (p: Item, extra = {}) => ({
    projectId: p.id,
    type: 'TYPE_TEST',
    title: '低温 -25 ℃ 夹紧力',
    standard: '项目技术规格书假设：夹紧力限值',
    sample: 'SN-0007',
    lab: 'CNAS 车门试验检测中心',
    plannedAt: '2026-11-02',
    ...extra,
  })

  it('assigns prefixed ids and walks PLANNED → IN_PROGRESS → REPORTED → APPROVED', () => {
    const { state, p } = order()
    const tt = upsertTrial(state, plan(p, { verifies: ['CUS-001'] }), NOW)
    const fai = upsertTrial(state, plan(p, { type: 'FAI', title: '首件' }), NOW)
    expect([tt.id, fai.id]).toEqual(['TT-2026-001', 'FAI-2026-001'])
    expect(tt).toMatchObject({ state: 'PLANNED', result: 'PENDING', verifies: ['CUS-001'] })
    expect(() => upsertTrial(state, { id: tt.id, to: 'REPORTED' }, NOW)).toThrow('非法状态流转：PLANNED')
    upsertTrial(state, { id: tt.id, to: 'IN_PROGRESS' }, NOW)
    expect(() => upsertTrial(state, { id: tt.id, to: 'REPORTED' }, NOW)).toThrow('缺少报告号')
    expect(() => upsertTrial(state, { id: tt.id, to: 'REPORTED', reportNo: 'R-1' }, NOW)).toThrow(
      '缺少试验结论',
    )
    upsertTrial(state, { id: tt.id, to: 'REPORTED', reportNo: 'R-1', result: 'PASS' }, NOW)
    expect(tt).toMatchObject({ state: 'REPORTED', reportNo: 'R-1', result: 'PASS' })
    expect(tt.at).toBeTruthy()
    expect(() => upsertTrial(state, { id: tt.id, to: 'APPROVED' }, NOW)).toThrow('需走 TRIAL_REPORT 审批')
    release(state, 'TRIAL_REPORT', tt.id)
    expect(tt.state).toBe('APPROVED')
    expect(() => upsertTrial(state, plan(p, { verifies: ['CUS-404'] }), NOW)).toThrow('未找到')
    expect(() => upsertTrial(state, plan(p, { type: 'X' }), NOW)).toThrow('type 取值无效')
  })

  it('refuses to approve a FAIL trial unless its change is approved, and a retest clears the report', () => {
    const { state, p } = order()
    const tt = upsertTrial(state, plan(p), NOW)
    upsertTrial(state, { id: tt.id, to: 'IN_PROGRESS' }, NOW)
    upsertTrial(
      state,
      { id: tt.id, to: 'REPORTED', reportNo: 'R-2', result: 'FAIL', deviations: ['夹紧力 182 N，超限'] },
      NOW,
    )
    expect(() => submitApproval(state, { template: 'TRIAL_REPORT', subjectId: tt.id, by: 'x' }, NOW)).toThrow(
      '需关联已批准的变更',
    )
    const cr = create(
      state,
      { kind: 'change', projectId: p.id, title: '改弹簧', reason: tt.id, impact: { reqs: ['CUS-001'] } },
      NOW,
    )
    upsertTrial(state, { id: tt.id, changeId: cr.id }, NOW)
    expect(() => submitApproval(state, { template: 'TRIAL_REPORT', subjectId: tt.id, by: 'x' }, NOW)).toThrow(
      '需关联已批准的变更',
    )
    ccbApprove(state, cr.id)
    release(state, 'TRIAL_REPORT', tt.id)
    expect(tt.state).toBe('APPROVED')

    // A change drafted with the trial as its source links itself to the trial.
    const drafted = upsertTrial(state, plan(p, { title: '寿命' }), NOW)
    const draft = create(
      state,
      {
        kind: 'change',
        projectId: p.id,
        title: 'd',
        reason: 'r',
        source: { type: 'TYPE_TEST', ref: drafted.id },
      },
      NOW,
    )
    expect(drafted.changeId).toBe(draft.id)

    const retest = upsertTrial(state, plan(p), NOW)
    upsertTrial(state, { id: retest.id, to: 'IN_PROGRESS' }, NOW)
    upsertTrial(state, { id: retest.id, to: 'REPORTED', reportNo: 'R-3', result: 'FAIL' }, NOW)
    upsertTrial(state, { id: retest.id, to: 'IN_PROGRESS' }, NOW)
    expect(retest).toMatchObject({ state: 'IN_PROGRESS', result: 'PENDING' })
    expect(retest.reportNo).toBeUndefined()
    expect(JSON.stringify(retest.history)).toContain('R-3')
  })

  it('adds a system finding to the TYPE and FAI gates for each unapproved trial of that type', () => {
    const { state, p } = order()
    const tt = upsertTrial(state, plan(p), NOW)
    const other = upsertTrial(state, plan(p, { title: '寿命' }), NOW)
    const fai = upsertTrial(state, plan(p, { type: 'FAI', title: '首件检验' }), NOW)
    for (const s of ['INITIATION', 'REQUIREMENTS', 'DESIGN', 'IMPLEMENTATION']) pass(state, p.id, s)
    const verification = `${p.id}/VERIFICATION`
    start(state, verification)
    const type = submitGate(state, { stageId: verification, by: 'x' }, NOW).gate
    expect(type.code).toBe('TYPE')
    expect(type.findings.map((f: Item) => [f.text, f.by, f.closed])).toEqual([
      [`型式试验 ${tt.id} 未关闭`, '系统检查', false],
      [`型式试验 ${other.id} 未关闭`, '系统检查', false],
    ])
    expect(() => sign(state, type.id, '质量工程师')).toThrow('评审意见未关闭')
    sign(state, type.id, '质量工程师', {
      closeFindings: type.findings.map((f: Item) => ({ id: f.id, note: '放行' })),
    })
    const gate = submitGate(state, { stageId: verification, by: 'x' }, NOW).gate
    expect(gate.code).toBe('FAI')
    expect(gate.findings.map((f: Item) => f.text)).toEqual([`首件 ${fai.id} 未关闭`])
  })
})

describe('faults and quality problems', () => {
  const service = () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    const fault = (id: string, signal: string, train: string, daysAgo: number) =>
      state.faults.push({
        id,
        projectId: p.id,
        source: 'PHM',
        signal,
        train,
        car: 'Mc1',
        door: 'L3',
        detail: '示例',
        detectedAt: new Date(NOW - daysAgo * DAY).toISOString(),
        state: 'NEW',
        history: [],
      })
    fault('FA-1', 'BUFFER_WEAR', '05017', 2)
    fault('FA-2', 'BUFFER_WEAR', '05017', 9)
    fault('FA-3', 'RESISTANCE', '05021', 20)
    fault('FA-4', 'COMM', '05021', 80)
    return { state, p }
  }

  it('moves a fault one step at a time and refuses a skip', () => {
    const { state } = service()
    expect(() => transition(state, { kind: 'fault', id: 'FA-1', to: 'HANDLED', by: 'x' }, NOW)).toThrow(
      '非法状态流转：NEW 不可流转至 HANDLED',
    )
    for (const to of ['DISPATCHED', 'HANDLED', 'CLOSED'])
      transition(state, { kind: 'fault', id: 'FA-1', to, by: '客服工程师' }, NOW)
    expect(byId(state.faults, 'FA-1').state).toBe('CLOSED')
  })

  it('aggregates faults by signal, state, train and week inside the window', () => {
    const { state, p } = service()
    const summary = faultSummary(state, { projectId: p.id, days: 30 }, NOW)
    expect(summary.total).toBe(3)
    expect(summary.bySignal).toEqual({ BUFFER_WEAR: 2, RESISTANCE: 1 })
    expect(summary.byTrain).toEqual({ '05017': 2, '05021': 1 })
    expect(summary.byState).toEqual({ NEW: 3 })
    expect(summary.byWeek.reduce((n: number, w: Item) => n + w.count, 0)).toBe(3)
    expect(summary.items[0].id).toBe('FA-1')
    expect(faultSummary(state, { projectId: p.id, days: 365 }, NOW).total).toBe(4)
    expect(faultSummary(state, { signal: 'SLIDE' }, NOW).total).toBe(0)
    expect(() => faultSummary(state, { signal: 'BOGUS' }, NOW)).toThrow('signal 取值无效')
    expect(metrics(state, p, NOW)).toMatchObject({
      faults30dTotal: 3,
      faults30d: { BUFFER_WEAR: 2, RESISTANCE: 1, SLIDE: 0 },
    })
  })

  it('creates a problem with D1–D8, links faults and enforces the ACTION and CLOSED rules', () => {
    const { state, p } = service()
    const qp = upsertProblem(
      state,
      { projectId: p.id, title: '缓冲头磨损集中', severity: 'B', faultIds: ['FA-1', 'FA-2'] },
      NOW,
    )
    expect(qp).toMatchObject({ id: 'QP-2026-001', state: 'OPEN', faultIds: ['FA-1', 'FA-2'] })
    expect(Object.keys(qp.steps)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'])
    expect(byId(state.faults, 'FA-1').problemId).toBe(qp.id)
    expect(() => upsertProblem(state, { projectId: p.id, title: 'x', faultIds: ['FA-1'] }, NOW)).toThrow(
      '已挂在质量问题',
    )
    upsertProblem(
      state,
      {
        id: qp.id,
        to: 'ANALYZING',
        steps: { D1: { done: true }, D2: { done: true, text: '5 列车 FA-1 FA-2' } },
      },
      NOW,
    )
    expect(() => upsertProblem(state, { id: qp.id, to: 'ACTION' }, NOW)).toThrow('缺少根本原因')
    expect(() =>
      upsertProblem(state, { id: qp.id, rootCause: '缓冲头材料 B 版耐磨不足', to: 'ACTION' }, NOW),
    ).toThrow('D4')
    upsertProblem(state, { id: qp.id, steps: { D4: { done: true } } }, NOW)
    upsertProblem(state, { id: qp.id, to: 'ACTION' }, NOW)
    upsertProblem(state, { id: qp.id, to: 'VERIFYING' }, NOW)
    const close = () => submitApproval(state, { template: 'PROBLEM_CLOSE', subjectId: qp.id, by: 'x' }, NOW)
    // closing is the flow's move: a direct move is refused, and the flow starts only when the 8D is complete
    expect(() => upsertProblem(state, { id: qp.id, to: 'CLOSED' }, NOW)).toThrow('需走 PROBLEM_CLOSE 审批')
    expect(close).toThrow('D8')
    upsertProblem(state, { id: qp.id, steps: { D8: { done: true } } }, NOW)
    expect(close).toThrow('没有关联变更')
    upsertProblem(state, { id: qp.id, noChangeReason: '仅更换耗材，无设计变更' }, NOW)
    expect(release(state, 'PROBLEM_CLOSE', qp.id).state).toBe('APPROVED')
    expect(qp.state).toBe('CLOSED')
    expect(() => upsertProblem(state, { id: qp.id, steps: { D9: { done: true } } }, NOW)).toThrow(
      '未知 8D 步骤',
    )
  })

  it('closes a problem only after its linked change is CLOSED', () => {
    const { state, p } = service()
    const qp = upsertProblem(
      state,
      { projectId: p.id, title: 'x', rootCause: 'r', steps: { D4: { done: true }, D8: { done: true } } },
      NOW,
    )
    for (const to of ['ANALYZING', 'ACTION', 'VERIFYING']) upsertProblem(state, { id: qp.id, to }, NOW)
    const cr = create(
      state,
      { kind: 'change', projectId: p.id, title: 'c', reason: 'r', impact: { reqs: ['CUS-001'] } },
      NOW,
    )
    upsertProblem(state, { id: qp.id, changeId: cr.id }, NOW)
    expect(() =>
      submitApproval(state, { template: 'PROBLEM_CLOSE', subjectId: qp.id, by: 'x' }, NOW),
    ).toThrow(`${cr.id} 尚未关闭`)
    expect(() => upsertProblem(state, { id: qp.id, changeId: 'CR-404' }, NOW)).toThrow('未找到')
  })
})

describe('change requests and the field-to-design loop', () => {
  const inService = () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    p.service = { phase: '质保期', trains: 40, doorsPerTrain: 48 }
    for (const s of state.stages) s.state = 'PASSED'
    state.items.push(
      { id: 'NC-BUF-01', projectId: p.id, name: '缓冲头', discipline: 'MECH', lru: true },
      { id: 'NC-MOT-02', projectId: p.id, name: '电机', discipline: 'ELEC', lru: true },
    )
    for (const type of ['AS_DESIGNED', 'AS_BUILT', 'AS_MAINTAINED'])
      state.configBaselines.push({
        id: `CB-${p.id}-${type}-01`,
        projectId: p.id,
        type,
        revs: { 'NC-BUF-01': 'B', 'NC-MOT-02': 'A' },
        at: new Date(NOW - 90 * DAY).toISOString(),
      })
    return { state, p }
  }
  const bufferChange = {
    source: { type: 'FIELD', ref: 'QP-2026-001' },
    impact: {
      items: [{ itemId: 'NC-BUF-01', fromRev: 'B', toRev: 'C' }],
      fleet: { doors: 1920, plan: '架修窗口分批更换' },
    },
  }

  it('requires a root cause for field and type-test sources before ANALYZED, not for internal ones', () => {
    const { state, p } = inService()
    const cr = create(
      state,
      {
        kind: 'change',
        projectId: p.id,
        title: '缓冲头 B → C',
        reason: 'r',
        ...bufferChange,
        note: '方案依据：模拟阈值 300 N',
        by: '软件设计师 张衡',
      },
      NOW,
    )
    expect(cr.source).toEqual({ type: 'FIELD', ref: 'QP-2026-001' })
    expect(cr.history[0]).toMatchObject({ by: '软件设计师 张衡', note: '方案依据：模拟阈值 300 N' })
    expect(() => transition(state, { kind: 'change', id: cr.id, to: 'ANALYZED', by: 'x' }, NOW)).toThrow(
      '缺少失效原因分析',
    )
    updateChange(
      state,
      { id: cr.id, rootCause: '材料耐磨不足', note: '补充根因依据', by: '质量工程师 韩雪' },
      NOW,
    )
    expect(cr.history.at(-1)).toMatchObject({
      from: 'SUBMITTED',
      to: 'SUBMITTED',
      by: '质量工程师 韩雪',
      note: '补充根因依据',
    })
    const moving = { id: cr.id, to: 'ANALYZED', note: '分析完成', by: 'x' }
    updateChange(state, moving, NOW)
    expect(transition(state, { kind: 'change', ...moving }, NOW).state).toBe('ANALYZED')
    expect(cr.history.filter((entry: Item) => entry.note === moving.note)).toHaveLength(1)
    const internal = create(
      state,
      {
        kind: 'change',
        projectId: p.id,
        title: 'i',
        reason: 'r',
        impact: { reqs: ['CUS-001'] },
        to: 'ANALYZED',
        note: '内部分析完成',
      },
      NOW,
    )
    expect(internal.source).toEqual({ type: 'INTERNAL' })
    expect(
      transition(
        state,
        { kind: 'change', id: internal.id, to: 'ANALYZED', by: 'x', note: '内部分析完成' },
        NOW,
      ).state,
    ).toBe('ANALYZED')
    expect(internal.history.filter((entry: Item) => entry.note === '内部分析完成')).toHaveLength(1)
    const typeTest = create(
      state,
      {
        kind: 'change',
        projectId: p.id,
        title: 't',
        reason: 'r',
        source: { type: 'TYPE_TEST', ref: 'TT-2026-001' },
        impact: { reqs: ['CUS-001'] },
      },
      NOW,
    )
    expect(() =>
      transition(state, { kind: 'change', id: typeTest.id, to: 'ANALYZED', by: 'x' }, NOW),
    ).toThrow('rootCause')
    expect(() =>
      create(state, { kind: 'change', projectId: p.id, title: 'b', reason: 'r', source: { type: 'X' } }, NOW),
    ).toThrow('source.type')
    expect(() =>
      create(
        state,
        {
          kind: 'change',
          projectId: p.id,
          title: 'b',
          reason: 'r',
          impact: { items: [{ itemId: 'NC-404', fromRev: 'A', toRev: 'B' }] },
        },
        NOW,
      ),
    ).toThrow('未找到')
  })

  it('on approval generates the ECN and a new as-designed baseline, and does not rework an in-service project', () => {
    const { state, p } = inService()
    const cr = approvedChange(state, p.id, {
      ...bufferChange,
      impact: { ...bufferChange.impact, reqs: ['CUS-001'] },
    })
    expect(cr).toMatchObject({
      ecn: `ECN-2026-${cr.id.slice(-3)}`,
      state: 'APPROVED',
      reworked: [],
      retrofit: { done: 0, total: 1920 },
    })
    // the ECR approval makes the ECN; the as-designed baseline comes with the ECN release flow
    expect(state.configBaselines.filter((b: Item) => b.type === 'AS_DESIGNED')).toHaveLength(1)
    release(state, 'ECN_RELEASE', cr.id)
    const designed = state.configBaselines.filter((b: Item) => b.type === 'AS_DESIGNED')
    expect(designed.map((b: Item) => b.id)).toEqual([
      `CB-${p.id}-AS_DESIGNED-01`,
      `CB-${p.id}-AS_DESIGNED-02`,
    ])
    expect(designed[1].revs).toEqual({ 'NC-BUF-01': 'C', 'NC-MOT-02': 'A' })
    expect(state.stages.every((s: Item) => s.state === 'PASSED')).toBe(true)
    expect(metrics(state, p, NOW)).toMatchObject({ baselineGap: 1, retrofit: { done: 0, total: 1920 } })
  })

  it('still sends passed stages of a project in development to rework, and they pass their gates again', () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    upsertReqs(state, { projectId: p.id, items: [{ id: 'CUS-001', title: 'c', text: 'c' }] }, NOW)
    pass(state, p.id, 'INITIATION')
    pass(state, p.id, 'REQUIREMENTS')
    const cr = approvedChange(state, p.id)
    expect(cr.reworked).toEqual([`${p.id}/REQUIREMENTS`])
    expect(byId(state.reqs, 'CUS-001', p.id).status).toBe('CHANGED')
    const stage = byId(state.stages, `${p.id}/REQUIREMENTS`)
    expect(stage.state).toBe('REWORK')
    start(state, stage.id)
    expect(submitGate(state, { stageId: stage.id, by: 'x' }, NOW).gate.id).toBe(`GATE-${p.id}-DL1-2`)
  })

  it('needs a verification before CLOSED; a rejected change may close without one', () => {
    const { state, p } = inService()
    const cr = approvedChange(state, p.id, { ...bufferChange, rootCause: '根因' })
    transition(state, { kind: 'change', id: cr.id, to: 'IMPLEMENTED', by: 'x' }, NOW)
    expect(() => transition(state, { kind: 'change', id: cr.id, to: 'CLOSED', by: 'x' }, NOW)).toThrow(
      '缺少验证记录',
    )
    expect(() =>
      updateChange(state, { id: cr.id, verification: { result: 'PASS', trialId: 'RT-404' } }),
    ).toThrow('未找到')
    const rt = upsertTrial(
      state,
      {
        projectId: p.id,
        type: 'ROUTINE',
        title: '例行',
        standard: 's',
        sample: 'x',
        lab: '主机厂现场',
        plannedAt: '2026-11-01',
      },
      NOW,
    )
    updateChange(
      state,
      { id: cr.id, verification: { result: 'PASS', trialId: rt.id }, by: '验证工程师' },
      NOW,
    )
    expect(cr.verification).toMatchObject({ result: 'PASS', by: '验证工程师', trialId: rt.id })
    expect(transition(state, { kind: 'change', id: cr.id, to: 'CLOSED', by: 'x' }, NOW).state).toBe('CLOSED')
    const rejected = create(
      state,
      { kind: 'change', projectId: p.id, title: 'r', reason: 'r', impact: { reqs: ['CUS-001'] } },
      NOW,
    )
    for (const to of ['ANALYZED', 'CCB_REVIEW', 'REJECTED', 'CLOSED'])
      transition(state, { kind: 'change', id: rejected.id, to, by: 'CCB' }, NOW)
    expect(rejected.state).toBe('CLOSED')
  })

  it('updates retrofit progress only upwards and creates the as-maintained baseline on completion', () => {
    const { state, p } = inService()
    const cr = approvedChange(state, p.id, { ...bufferChange, rootCause: '根因' })
    release(state, 'ECN_RELEASE', cr.id)
    const progress = (done: number, id = cr.id) =>
      transition(state, { kind: 'retrofit', id, done, by: '客服工程师' }, NOW)
    progress(480)
    expect(cr.retrofit).toEqual({ done: 480, total: 1920 })
    expect(() => progress(480)).toThrow('整改进度只能递增')
    expect(() => progress(100)).toThrow('整改进度只能递增')
    expect(() => progress(1921)).toThrow('done 需为 0–1920')
    expect(state.configBaselines.filter((b: Item) => b.type === 'AS_MAINTAINED')).toHaveLength(1)
    expect(metrics(state, p, NOW).baselineGap).toBe(1)
    progress(1920)
    const maintained = state.configBaselines.filter((b: Item) => b.type === 'AS_MAINTAINED')
    expect(maintained.map((b: Item) => b.id)).toEqual([
      `CB-${p.id}-AS_MAINTAINED-01`,
      `CB-${p.id}-AS_MAINTAINED-02`,
    ])
    expect(maintained[1].revs).toEqual({ 'NC-BUF-01': 'C', 'NC-MOT-02': 'A' })
    expect(metrics(state, p, NOW)).toMatchObject({ baselineGap: 0, retrofit: { done: 1920, total: 1920 } })
    const early = create(
      state,
      { kind: 'change', projectId: p.id, title: 'e', reason: 'r', ...bufferChange },
      NOW,
    )
    expect(() => progress(1, early.id)).toThrow('未设置整改总数')
    updateChange(state, { id: early.id, retrofit: { total: 10 } })
    expect(() => progress(1, early.id)).toThrow('批准后才能更新整改进度')
  })

  it('needs an impact analysis before CCB, counting affected items, and locks the analysis at CCB review', () => {
    const { state, p } = inService()
    const cr = create(state, { kind: 'change', projectId: p.id, title: '空', reason: 'r' }, NOW)
    expect(() => transition(state, { kind: 'change', id: cr.id, to: 'ANALYZED', by: 'x' }, NOW)).toThrow(
      '缺少影响分析',
    )
    updateChange(state, { id: cr.id, impact: { items: [{ itemId: 'NC-MOT-02', fromRev: 'A', toRev: 'B' }] } })
    expect(transition(state, { kind: 'change', id: cr.id, to: 'ANALYZED', by: 'x' }, NOW).state).toBe(
      'ANALYZED',
    )
    transition(state, { kind: 'change', id: cr.id, to: 'CCB_REVIEW', by: 'x' }, NOW)
    expect(() => updateChange(state, { id: cr.id, rootCause: '晚了' }, NOW)).toThrow('已进入 CCB_REVIEW')
  })
})

describe('traceability and deliverables', () => {
  it('registers MER/EER as sub-system requirements with a discipline and discipline-specific fields', () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    const items = [
      {
        id: 'CUS-001',
        title: '净开度',
        text: '净开度 ≥ 1300 mm',
        clause: 'TA-001 §3.2',
        compliance: 'DEVIATE',
        responseNote: '偏离说明',
      },
      { id: 'SYS-001', title: '门系统', text: '整门开度', parent: ['CUS-001'] },
      { id: 'MER-001', title: '承载', text: '机构承载', parent: ['SYS-001'] },
      { id: 'EER-001', title: '供电', text: 'DC 110 V', parent: ['SYS-001'] },
      { id: 'SWR-001', title: '门控逻辑', text: '开关门逻辑', parent: ['SYS-001'] },
      {
        id: 'DES-001',
        title: '锁闭装置',
        text: '锁闭',
        parent: ['MER-001'],
        discipline: 'MECH',
        partNo: 'NC-DR-1203',
        drawingNo: 'DWG-1203',
      },
      {
        id: 'DES-002',
        title: '门控模块',
        text: '模块',
        parent: ['SWR-001'],
        discipline: 'SW',
        module: 'door-ctrl',
      },
      { id: 'TC-001', title: '承载试验', text: '加载', parent: ['MER-001'] },
    ]
    upsertReqs(state, { projectId: p.id, items, by: 'x' }, NOW)
    const get = (id: string) => byId(state.reqs, id, p.id)
    expect(get('MER-001')).toMatchObject({ level: 'SWR', discipline: 'MECH' })
    expect(get('EER-001')).toMatchObject({ level: 'SWR', discipline: 'ELEC' })
    expect(get('SWR-001')).toMatchObject({ level: 'SWR', discipline: 'SW' })
    expect(get('DES-001')).toMatchObject({ partNo: 'NC-DR-1203', drawingNo: 'DWG-1203' })
    expect(get('DES-002').module).toBe('door-ctrl')
    expect(get('CUS-001')).toMatchObject({
      clause: 'TA-001 §3.2',
      compliance: 'DEVIATE',
      responseNote: '偏离说明',
    })
    const c = coverage(state, p.id)
    expect(c.cusSwr).toMatchObject({ covered: 1, total: 1 })
    expect(c.swrTc).toMatchObject({ total: 3, covered: 1 })
    for (const bad of [
      { id: 'CUS-002', title: 't', text: 't', partNo: 'x' },
      { id: 'SYS-002', title: 't', text: 't', discipline: 'MECH' },
      { id: 'CUS-003', title: 't', text: 't', compliance: 'MAYBE' },
    ])
      expect(() => upsertReqs(state, { projectId: p.id, items: [bad] }, NOW), bad.id).toThrow()
    expect(() =>
      upsertReqs(state, { projectId: p.id, items: [{ id: 'XYZ-001', title: 't', text: 't' }] }, NOW),
    ).toThrow('编号格式无效')
    expect(() =>
      upsertReqs(state, {
        projectId: p.id,
        items: [{ id: 'TC-002', title: 't', text: 't', parent: ['CUS-001'] }],
      }),
    ).toThrow('TC-002 的上游必须是 SWR')
  })

  it('allows several deliverables of one kind through a suffix, with the new kinds', () => {
    const state = blank()
    const p = create(state, { kind: 'project', name: '实时项目' }, NOW)
    const base = { projectId: p.id, stage: 'VERIFICATION', path: 'docs/a.md' }
    const a = recordArtifact(state, { ...base, kind: 'TYPE_TEST_REPORT', suffix: '07' }, NOW)
    const b = recordArtifact(
      state,
      { ...base, kind: 'TYPE_TEST_REPORT', suffix: '08', path: 'docs/b.md' },
      NOW,
    )
    const plain = recordArtifact(state, { ...base, kind: 'TYPE_TEST_PLAN' }, NOW)
    expect([a.id, b.id, plain.id]).toEqual([
      'DOC-001-TYPE-TEST-REPORT-07',
      'DOC-001-TYPE-TEST-REPORT-08',
      'DOC-001-TYPE-TEST-PLAN',
    ])
    expect(
      recordArtifact(state, { ...base, kind: 'TYPE_TEST_REPORT', suffix: '07', title: '改' }, NOW).title,
    ).toBe('改')
    expect(state.artifacts).toHaveLength(3)
    expect(a.authorRole).toBe('验证工程师')
    for (const kind of ['TA_RESPONSE', 'DL_MINUTES', 'FAI_REPORT', 'REPORT_8D', 'ECN', 'ACCEPTANCE'])
      expect(recordArtifact(state, { ...base, kind }, NOW).id).toBe(`DOC-001-${kind.replaceAll('_', '-')}`)
    expect(() => recordArtifact(state, { ...base, kind: 'ECN', suffix: 'a b' }, NOW)).toThrow(
      'suffix 格式无效',
    )
  })

  it.each([
    '../secrets.md',
    '/etc/passwd',
    'docs/../../x.md',
    'devboard-projects/PRJ-2026-001/docs/SRS.md',
    'C:/x.md',
    'docs\\SRS.md',
    '',
  ])('refuses the out-of-project path %j', (path) => {
    const project = { id: 'PRJ-2026-009', live: true, workspaceDir: 'devboard-projects/PRJ-2026-009' }
    expect(() => projectPath(project, path)).toThrow('交付物路径越界')
  })

  it('accepts project-relative paths and refuses order projects', () => {
    const project = { id: 'PRJ-2026-009', live: true, workspaceDir: 'devboard-projects/PRJ-2026-009' }
    expect(projectPath(project, 'src/a.js')).toBe('devboard-projects/PRJ-2026-009/src/a.js')
    expect(() => projectPath({ id: 'PRJ-2025-042', live: false }, 'docs/SRS.md')).toThrow('不是现场项目')
  })

  it('opens analysis/<object id>/ on any project, still refuses escapes, and never registers it', () => {
    const order = { id: 'PRJ-2025-042', live: false }
    expect(projectPath(order, 'analysis/QP-2026-007/D2-D4.md')).toBe(
      'devboard-projects/PRJ-2025-042/analysis/QP-2026-007/D2-D4.md',
    )
    expect(
      projectPath(
        { id: 'PRJ-2026-009', live: true, workspaceDir: 'devboard-projects/PRJ-2026-009' },
        'analysis/ECN-2026-003/a.md',
      ),
    ).toBe('devboard-projects/PRJ-2026-009/analysis/ECN-2026-003/a.md')
    for (const bad of [
      'analysis/x.md',
      'analysis/../x.md',
      'analysis/QP-1/../../x.md',
      'docs/analysis/QP-1/a.md',
    ])
      expect(() => projectPath(order, bad)).toThrow(/不是现场项目|交付物路径越界/)
    const state = blank()
    const p = create(state, { kind: 'project', name: '实时项目' }, NOW)
    expect(() =>
      recordArtifact(
        state,
        { projectId: p.id, kind: 'PLAN', stage: 'INITIATION', path: 'analysis/QP-2026-007/a.md' },
        NOW,
      ),
    ).toThrow('不登记为交付物')
  })
})

describe('live software project tool chain', () => {
  it('runs from the concept gate with the software profile, test runs and the app address', () => {
    const state = blank()
    const project = create(state, { kind: 'project', name: '车门健康监测看板', by: '研发协调员' }, NOW)
    recordArtifact(
      state,
      {
        projectId: project.id,
        stage: 'INITIATION',
        kind: 'PLAN',
        path: 'docs/PROJECT-PLAN.md',
        markdown: '# 计划',
      },
      NOW,
    )
    const { gate } = submitGate(state, { stageId: `${project.id}/INITIATION`, by: '研发协调员' }, NOW)
    expect(gate).toMatchObject({ code: 'CDCP', approverRoles: ['IPMT'] })
    expect(() => decideGate(state, { gateId: gate.id, decision: 'APPROVED', by: '产品经理' }, NOW)).toThrow(
      '编写角色',
    )
    expect(() => decideGate(state, { gateId: gate.id, decision: 'APPROVED', by: '技术负责人' }, NOW)).toThrow(
      '本门需由 IPMT 审批',
    )
    decideGate(state, { gateId: gate.id, decision: 'APPROVED', by: 'IPMT' }, NOW)
    expect(byId(state.artifacts, 'DOC-001-PLAN').status).toBe('BASELINED')
    expect(
      recordTestRun(
        state,
        { projectId: project.id, level: 'UNIT', total: 3, passed: 2, failed: 1, skipped: 0 },
        NOW,
      ),
    ).toMatchObject({ id: 'TR-001-01', source: 'live' })
    expect(() =>
      recordTestRun(state, { projectId: project.id, total: 3, passed: 3, failed: 1 }, NOW),
    ).toThrow('用例数不一致')
    expect(() => registerApp(state, { projectId: project.id, url: 'http://example.com/' }, NOW)).toThrow(
      '本机地址',
    )
    expect(registerApp(state, { projectId: project.id, url: 'http://127.0.0.1:5180/' }, NOW).appUrl).toBe(
      'http://127.0.0.1:5180/',
    )
    const order = newProject(state, 'NEW_BUILD')
    expect(() => registerApp(state, { projectId: order.id, url: 'http://127.0.0.1:5180/' }, NOW)).toThrow(
      '不是现场项目',
    )
  })
})

describe('approval flows', () => {
  const setup = () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    state.artifacts.push({
      id: 'DOC-1-SAD',
      projectId: p.id,
      stage: 'INITIATION',
      kind: 'SAD',
      title: '架构设计',
      version: 'V0.1',
      authorRole: '系统设计师',
      status: 'DRAFT',
      source: { type: 'seed', docId: 'DOC-1-SAD' },
    })
    return { state, p }
  }
  const doc = (state: State) =>
    submitApproval(state, { template: 'DOC_RELEASE', subjectId: 'DOC-1-SAD', by: '系统设计师 陈立' }, NOW)
  const act = (state: State, id: string, role: string, action: string, extra: Item = {}, now = NOW) =>
    actApproval(state, { id, by: `${role} 测试员`, action, ...extra }, now)
  const ccb = (state: State, p: Item, extra: Item = {}) => {
    const cr = create(
      state,
      {
        kind: 'change',
        projectId: p.id,
        title: '变更',
        reason: '原因',
        impact: { reqs: ['CUS-001'] },
        ...extra,
      },
      NOW,
    )
    for (const to of ['ANALYZED', 'CCB_REVIEW'])
      transition(state, { kind: 'change', id: cr.id, to, by: 'CCB' }, NOW)
    return cr
  }
  const ecr = (state: State, id: string) =>
    submitApproval(state, { template: 'ECR', subjectId: id, by: '客户代表 方卫东' }, NOW)

  it('starts with the first node active, skips the initiator role and allows one running flow per object', () => {
    const { state } = setup()
    const flow = doc(state)
    expect(flow).toMatchObject({
      id: 'AP-2026-0001',
      template: 'DOC_RELEASE',
      state: 'RUNNING',
      current: 0,
      subject: { type: 'artifact', id: 'DOC-1-SAD' },
      initiator: { role: '系统设计师', by: '系统设计师 陈立' },
    })
    expect(flow.nodes.map((n: Item) => n.state)).toEqual(['ACTIVE', 'WAITING', 'WAITING', 'WAITING'])
    expect(flow.nodes[0].roles).not.toContain('系统设计师')
    expect(() => doc(state)).toThrow('已有进行中的审批 AP-2026-0001')
    expect(() => submitApproval(state, { template: 'X', subjectId: 'DOC-1-SAD' }, NOW)).toThrow(
      '未知审批模板',
    )
    expect(() => submitApproval(state, { template: 'ECR', subjectId: 'CR-404' }, NOW)).toThrow('未找到')
    // a rejected flow frees the object for a new one
    act(state, flow.id, '机械设计师', 'REJECT', { comment: '不合格' })
    expect(doc(state).id).toBe('AP-2026-0002')
    for (const author of [
      '软件设计师',
      '软件设计师 张衡',
      '软件设计师（架构）',
      '软件设计师（开发） 张衡',
      '软件设计师(架构)',
    ]) {
      const other = setup().state
      other.artifacts[0].authorRole = author
      const release = doc(other)
      expect(release.initiator.role).toBe('软件设计师')
      expect(release.nodes[0].roles).not.toContain('软件设计师')
      expect(() => act(other, release.id, author, 'APPROVE')).toThrow('需由')
    }
    const unknown = setup().state
    unknown.artifacts[0].authorRole = '未知编制岗位'
    expect(() => doc(unknown)).toThrow('无法识别编制角色')
    expect(unknown.approvals).toEqual([])
    const legacy = setup().state
    delete legacy.artifacts[0].authorRole
    expect(doc(legacy).initiator.role).toBe('系统设计师')
  })

  it('walks SERIAL nodes to APPROVED, baselines the deliverable and refuses the wrong role, node and a finished flow', () => {
    const { state } = setup()
    const flow = doc(state)
    expect(() => act(state, flow.id, '技术负责人', 'APPROVE')).toThrow('当前节点「校对」需由')
    expect(() => act(state, flow.id, '系统设计师', 'APPROVE')).toThrow('需由')
    act(state, flow.id, '机械设计师', 'APPROVE')
    expect(flow).toMatchObject({ current: 1, state: 'RUNNING' })
    expect(() => act(state, flow.id, '机械设计师', 'APPROVE')).toThrow('当前节点「审核」需由 技术负责人')
    for (const role of ['技术负责人', '标准化工程师']) act(state, flow.id, role, 'APPROVE')
    expect(byId(state.artifacts, 'DOC-1-SAD').status).toBe('DRAFT')
    act(state, flow.id, '分技术中心主任', 'APPROVE')
    expect(flow).toMatchObject({ state: 'APPROVED', endedAt: new Date(NOW).toISOString() })
    expect(flow.nodes.every((n: Item) => n.state === 'DONE')).toBe(true)
    expect(byId(state.artifacts, 'DOC-1-SAD')).toMatchObject({ status: 'BASELINED', version: 'V1.0' })
    for (const action of ['APPROVE', 'REJECT', 'RETURN', 'TRANSFER', 'ADD_SIGN', 'COMMENT', 'WITHDRAW'])
      expect(() =>
        act(state, flow.id, '技术负责人', action, { comment: 'x', to: 'x', role: '质量工程师' }),
      ).toThrow('已批准，不能再')
    expect(() => doc(state)).toThrow('已基线')
  })

  it('needs every role of an ALL node once, takes either role of an ANY node and drives the change with the ECR flow', () => {
    const { state, p } = setup()
    const cr = ccb(state, p)
    const flow = ecr(state, cr.id)
    expect(() => submitApproval(state, { template: 'ECR', subjectId: cr.id }, NOW)).toThrow(
      '已有进行中的审批',
    )
    for (const role of ['机械设计师', '电气设计师', '软件设计师', '工艺工程师']) {
      act(state, flow.id, role, 'APPROVE')
      expect(flow.current).toBe(0)
    }
    expect(() => act(state, flow.id, '机械设计师', 'APPROVE')).toThrow('已在「专业会签」同意过')
    expect(() => act(state, flow.id, '技术负责人', 'APPROVE')).toThrow('当前节点「专业会签」需由')
    expect(view(flow, NOW).waitingRoles).toEqual(['质量工程师'])
    act(state, flow.id, '质量工程师', 'APPROVE')
    expect(flow).toMatchObject({ current: 1, state: 'RUNNING' })
    expect(cr.state).toBe('CCB_REVIEW')
    // ANY: one of the two roles is enough
    act(state, flow.id, '分技术中心主任', 'APPROVE')
    expect(flow.state).toBe('APPROVED')
    expect(cr).toMatchObject({ state: 'APPROVED', ecn: `ECN-2026-${cr.id.slice(-3)}` })
    expect(cr.ccb).toMatchObject({ decision: 'APPROVED' })
    expect(cr.ccb.members).toHaveLength(6)
  })

  it('rejects with a required comment, returns the object to an editable state and skips the rest', () => {
    const { state, p } = setup()
    const flow = doc(state)
    byId(state.artifacts, 'DOC-1-SAD').status = 'IN_REVIEW'
    expect(() => act(state, flow.id, '机械设计师', 'REJECT')).toThrow('comment')
    act(state, flow.id, '机械设计师', 'REJECT', { comment: '参数错误' })
    expect(flow.state).toBe('REJECTED')
    expect(flow.nodes.map((n: Item) => n.state)).toEqual(['RETURNED', 'SKIPPED', 'SKIPPED', 'SKIPPED'])
    expect(byId(state.artifacts, 'DOC-1-SAD').status).toBe('DRAFT')
    // an ECR rejection rejects the change
    const cr = ccb(state, p)
    const rejected = ecr(state, cr.id)
    act(state, rejected.id, '质量工程师', 'REJECT', { comment: '风险过高' })
    expect(cr.state).toBe('REJECTED')
    expect(cr.ccb).toMatchObject({ decision: 'REJECTED' })
  })

  it('sends back to the previous node, a named node or the initiator and keeps the voided approvals as trace', () => {
    const { state, p } = setup()
    const flow = doc(state)
    expect(() => act(state, flow.id, '机械设计师', 'RETURN')).toThrow('comment')
    act(state, flow.id, '机械设计师', 'APPROVE')
    act(state, flow.id, '技术负责人', 'APPROVE')
    expect(flow.current).toBe(2)
    // default: the previous node
    act(state, flow.id, '标准化工程师', 'RETURN', { comment: '图号缺失' })
    expect(flow.current).toBe(1)
    expect(flow.nodes.map((n: Item) => n.state)).toEqual(['DONE', 'ACTIVE', 'WAITING', 'WAITING'])
    expect(() => act(state, flow.id, '技术负责人', 'RETURN', { comment: 'x', to: 'standard' })).toThrow(
      '退回目标无效',
    )
    expect(() => act(state, flow.id, '技术负责人', 'RETURN', { comment: 'x', to: 'nope' })).toThrow(
      '退回目标无效',
    )
    // a named earlier node: it and everything after restart
    act(state, flow.id, '技术负责人', 'RETURN', { comment: '重新校对', to: 'proofread' })
    expect(flow.nodes.map((n: Item) => n.state)).toEqual(['ACTIVE', 'WAITING', 'WAITING', 'WAITING'])
    expect(flow.nodes[0].doneAt).toBeUndefined()
    // to the initiator: the whole flow starts again at node 0
    act(state, flow.id, '机械设计师', 'APPROVE')
    act(state, flow.id, '技术负责人', 'RETURN', { comment: '整体重做', to: 'INITIATOR' })
    expect(flow).toMatchObject({ current: 0, state: 'RUNNING' })
    expect(flow.nodes.map((n: Item) => n.state)).toEqual(['ACTIVE', 'WAITING', 'WAITING', 'WAITING'])
    expect(flow.actions.filter((a: Item) => a.action === 'APPROVE')).toHaveLength(3)
    expect(flow.actions.at(-1)).toMatchObject({ action: 'RETURN', to: 'INITIATOR', role: '技术负责人' })
    // returning from the first node goes to the initiator too, and clears an ALL node's signatures
    const cr = ccb(state, p)
    const co = ecr(state, cr.id)
    act(state, co.id, '机械设计师', 'APPROVE')
    act(state, co.id, '质量工程师', 'RETURN', { comment: '资料不全' })
    expect(co.nodes[0]).toMatchObject({ state: 'ACTIVE', signed: [] })
    expect(co.actions.at(-1)).toMatchObject({ to: 'INITIATOR' })
  })

  it('transfers within the role, adds a signer node and keeps comment as trace only', () => {
    const { state } = setup()
    const flow = doc(state)
    expect(() => act(state, flow.id, '机械设计师', 'TRANSFER')).toThrow('to')
    expect(() => act(state, flow.id, '机械设计师', 'TRANSFER', { to: '技术负责人 郑凯' })).toThrow('同角色')
    expect(() => act(state, flow.id, '机械设计师', 'TRANSFER', { to: '机械设计师 测试员' })).toThrow(
      '不能转办给自己',
    )
    act(state, flow.id, '机械设计师', 'TRANSFER', { to: '沈岳', comment: '出差' })
    expect(flow.current).toBe(0)
    expect(flow.actions.at(-1)).toMatchObject({ action: 'TRANSFER', to: '机械设计师 沈岳', comment: '出差' })
    // anyone comments; it needs text and changes nothing
    expect(() => act(state, flow.id, '质量工程师', 'COMMENT')).toThrow('comment')
    act(state, flow.id, '质量工程师', 'COMMENT', { comment: '请注意低温参数' })
    expect(flow).toMatchObject({ current: 0, state: 'RUNNING' })
    // add a signer: a SERIAL node right after the current one, which still has to finish first
    expect(() => act(state, flow.id, '机械设计师', 'ADD_SIGN', { role: '没有这个角色' })).toThrow(
      '加签角色无效',
    )
    act(state, flow.id, '机械设计师', 'ADD_SIGN', { role: 'RAMS 工程师' })
    act(state, flow.id, '机械设计师', 'ADD_SIGN', { role: '质量工程师' })
    expect(flow.nodes.map((n: Item) => n.id)).toEqual([
      'proofread',
      'add2',
      'add1',
      'review',
      'standard',
      'approve',
    ])
    expect(flow.nodes[2]).toMatchObject({
      mode: 'SERIAL',
      roles: ['RAMS 工程师'],
      addedBy: '机械设计师 测试员',
    })
    act(state, flow.id, '机械设计师', 'APPROVE')
    expect(flow.nodes[flow.current].id).toBe('add2')
    expect(() => act(state, flow.id, '技术负责人', 'APPROVE')).toThrow('当前节点「加签：质量工程师」')
  })

  it('lets only the initiator withdraw, and only before the first node is handled', () => {
    const { state } = setup()
    const flow = doc(state)
    expect(() => act(state, flow.id, '机械设计师', 'WITHDRAW')).toThrow('只有发起人')
    act(state, flow.id, '质量工程师', 'COMMENT', { comment: '看一下' })
    act(state, flow.id, '机械设计师', 'TRANSFER', { to: '沈岳' })
    expect(() => act(state, flow.id, '系统设计师', 'WITHDRAW')).toThrow('已有人处理')
    // sending the flow back to the initiator reopens the window
    act(state, flow.id, '机械设计师', 'RETURN', { comment: '请先补充', to: 'INITIATOR' })
    act(state, flow.id, '系统设计师', 'WITHDRAW')
    expect(flow).toMatchObject({ state: 'WITHDRAWN' })
    expect(byId(state.artifacts, 'DOC-1-SAD').status).toBe('DRAFT')
    expect(() => act(state, flow.id, '系统设计师', 'WITHDRAW')).toThrow('已撤回')
    // once node 0 has been approved the flow cannot be withdrawn
    const again = doc(state)
    act(state, again.id, '机械设计师', 'APPROVE')
    expect(() => act(state, again.id, '系统设计师', 'WITHDRAW')).toThrow('第一个节点已有人处理')
  })

  it('derives the timeout from the injected clock and never stores it', () => {
    const { state } = setup()
    const flow = doc(state)
    const due = 24 * HOUR
    const nodeAt = (now: number) => snapshot(state, now).approvals[0]
    expect(nodeAt(NOW + due).overdue).toBe(false)
    expect(nodeAt(NOW + due + 1)).toMatchObject({ overdue: true })
    expect(nodeAt(NOW + due + 1).nodes.map((n: Item) => n.overdue)).toEqual([true, false, false, false])
    expect(nodeAt(NOW + due + 1).nodes[0].elapsedHours).toBe(24)
    expect(JSON.stringify(state.approvals)).not.toContain('overdue')
    // the next node's clock starts when it is entered
    act(state, flow.id, '机械设计师', 'APPROVE', {}, NOW + 20 * HOUR)
    expect(nodeAt(NOW + 20 * HOUR + 48 * HOUR).overdue).toBe(false)
    expect(nodeAt(NOW + 20 * HOUR + 48 * HOUR + 1).overdue).toBe(true)
    // a finished flow is never overdue
    for (const role of ['技术负责人', '标准化工程师', '分技术中心主任'])
      act(state, flow.id, role, 'APPROVE', {}, NOW + 21 * HOUR)
    expect(nodeAt(NOW + 1000 * HOUR).overdue).toBe(false)
    expect(snapshot(state, NOW + 1000 * HOUR).counts).toMatchObject({
      approvalsRunning: 0,
      approvalsOverdue: 0,
    })
  })

  it('moves a change, a problem and a trial only through their flow, and freezes manual moves while one runs', () => {
    const { state, p } = setup()
    const cr = ccb(state, p)
    expect(() => transition(state, { kind: 'change', id: cr.id, to: 'APPROVED', by: 'CCB' }, NOW)).toThrow(
      '需走 ECR 审批',
    )
    const flow = ecr(state, cr.id)
    expect(() => transition(state, { kind: 'change', id: cr.id, to: 'REJECTED', by: 'CCB' }, NOW)).toThrow(
      `有进行中的审批 ${flow.id}`,
    )
    // an ECN is released only after the ECR approved the change, and only once
    expect(() => submitApproval(state, { template: 'ECN_RELEASE', subjectId: cr.id }, NOW)).toThrow(
      '已有进行中的审批',
    )
    approveFlow(state, flow.id)
    approveFlow(state, submitApproval(state, { template: 'ECN_RELEASE', subjectId: cr.id, by: 'x' }, NOW).id)
    expect(() => submitApproval(state, { template: 'ECN_RELEASE', subjectId: cr.id }, NOW)).toThrow('已发布')
    expect(cr.history.at(-1).note).toContain(`${cr.ecn} 已发布`)

    // a problem or a trial that is not in its starting state cannot start the flow
    const qp = upsertProblem(state, { projectId: p.id, title: 'x' }, NOW)
    expect(() => submitApproval(state, { template: 'PROBLEM_CLOSE', subjectId: qp.id }, NOW)).toThrow(
      '处于验证中',
    )
    const tt = upsertTrial(
      state,
      {
        projectId: p.id,
        type: 'TYPE_TEST',
        title: 't',
        standard: 's',
        sample: 'a',
        lab: 'l',
        plannedAt: 'x',
      },
      NOW,
    )
    expect(() => submitApproval(state, { template: 'TRIAL_REPORT', subjectId: tt.id }, NOW)).toThrow(
      '出具报告后',
    )
    upsertTrial(state, { id: tt.id, to: 'IN_PROGRESS' }, NOW)
    upsertTrial(state, { id: tt.id, to: 'REPORTED', reportNo: 'R-9', result: 'PASS' }, NOW)
    const report = submitApproval(
      state,
      { template: 'TRIAL_REPORT', subjectId: tt.id, by: '验证工程师 马骁' },
      NOW,
    )
    expect(report.initiator.role).toBe('验证工程师')
    expect(() => upsertTrial(state, { id: tt.id, to: 'IN_PROGRESS' }, NOW)).toThrow('有进行中的审批')
    // rejected: the trial goes back to be edited and re-reported
    act(state, report.id, '质量工程师', 'REJECT', { comment: '数据不全' })
    expect(tt.state).toBe('IN_PROGRESS')
  })

  it('returns a problem to ACTION when its closing is rejected', () => {
    const { state, p } = setup()
    const qp = upsertProblem(
      state,
      {
        projectId: p.id,
        title: 'x',
        rootCause: 'r',
        noChangeReason: '耗材',
        steps: { D4: { done: true }, D8: { done: true } },
      },
      NOW,
    )
    for (const to of ['ANALYZING', 'ACTION', 'VERIFYING']) upsertProblem(state, { id: qp.id, to }, NOW)
    const flow = submitApproval(
      state,
      { template: 'PROBLEM_CLOSE', subjectId: qp.id, by: '质量工程师 韩雪' },
      NOW,
    )
    act(state, flow.id, '质量工程师', 'APPROVE')
    act(state, flow.id, '分技术中心主任', 'REJECT', { comment: '验证数据不足' })
    expect(qp.state).toBe('ACTION')
  })

  it('adds a finding to the gate for an unapproved release flow, and baselines the document when the flow is approved', () => {
    const { state, p } = setup()
    const flow = doc(state)
    const { gate } = submitGate(state, { stageId: `${p.id}/INITIATION`, by: '研发协调员' }, NOW)
    expect(gate.findings).toEqual([
      expect.objectContaining({
        by: '系统检查',
        text: expect.stringContaining(`${flow.id} 审批中，尚未批准`),
      }),
    ])
    expect(() => sign(state, gate.id, '分技术中心主任')).toThrow('评审意见未关闭')
    const stage = sign(state, gate.id, '分技术中心主任', {
      closeFindings: [{ id: 'F-01', note: '已知' }],
    }).stage
    expect(stage.state).toBe('PASSED')
    expect(byId(state.artifacts, 'DOC-1-SAD').status).not.toBe('BASELINED')
    expect(stage.baseline.items).not.toContain('DOC-1-SAD')
    approveFlow(state, flow.id)
    expect(byId(state.artifacts, 'DOC-1-SAD')).toMatchObject({ status: 'BASELINED', version: 'V1.0' })
  })

  it('lets an agent start flows only for the objects it drafted', () => {
    const { state, p } = setup()
    const agent = { by: '研发协调员', agent: true }
    expect(() =>
      submitApproval(state, { template: 'DOC_RELEASE', subjectId: 'DOC-1-SAD', ...agent }, NOW),
    ).toThrow('不是智能体起草')
    const own = ccb(state, p, { by: '研发协调员' })
    expect(own.raisedBy).toBe('研发协调员')
    const flow = submitApproval(state, { template: 'ECR', subjectId: own.id, ...agent }, NOW)
    expect(flow.initiator).toEqual({ role: '系统设计师', by: '研发协调员' })
    const other = ccb(state, p, { by: '客户代表 方卫东' })
    expect(() => submitApproval(state, { template: 'ECR', subjectId: other.id, ...agent }, NOW)).toThrow(
      '不是智能体起草',
    )
  })
})

describe('snapshot', () => {
  it('lists every collection, the profile tables and the field metrics', () => {
    const state = blank()
    const p = newProject(state, 'NEW_BUILD')
    const view = snapshot(state, NOW)
    expect(Object.keys(view).sort()).toEqual(
      [
        'approvalTemplates',
        'approvals',
        'artifacts',
        'blockers',
        'changes',
        'configBaselines',
        'counts',
        'defects',
        'faults',
        'gates',
        'interventions',
        'items',
        'labels',
        'liveTailoring',
        'machines',
        'now',
        'orgs',
        'problems',
        'profiles',
        'projects',
        'reqs',
        'requirements',
        'revision',
        'roles',
        'stages',
        'synthetic',
        'tasks',
        'testRuns',
        'trials',
      ].sort(),
    )
    expect(view.projects[0].metrics).toMatchObject({
      faults30dTotal: 0,
      openProblems: 0,
      retrofit: { done: 0, total: 0 },
      baselineGap: 0,
      trials: { total: 0, approved: 0, failed: 0 },
    })
    expect(view.counts).toMatchObject({ trial: { PLANNED: 0 }, fault: { NEW: 0 }, problem: { OPEN: 0 } })
    expect(view.labels.level.SWR).toBe('子系统需求')
    expect(snapshot(state, NOW, p.id).stages).toHaveLength(6)
  })
})

describe('blockers', () => {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString()
  const kinds = (list: Item[]) => list.map((b) => b.kind)
  const clean = () => {
    const state = structuredClone(seed(NOW))
    state.gates = state.gates.map((g: Item) => ({
      ...g,
      decision: 'APPROVED',
      findings: g.findings.map((f: Item) => ({ ...f, closed: true })),
    }))
    for (const s of state.stages) s.plannedEnd = '2099-01-01T00:00:00.000Z'
    state.trials = state.trials.filter((t: Item) => t.result !== 'FAIL')
    state.changes = state.changes.filter((c: Item) => c.state !== 'CCB_REVIEW')
    state.problems = state.problems.filter((p: Item) => p.state !== 'ANALYZING')
    delete state.approvals
    return state
  }

  it('derives the seeded blockers and puts them into the snapshot, narrowed by project', () => {
    const list = blockers(seed(NOW), NOW) as Item[]
    expect(new Set(kinds(list))).toEqual(
      new Set([
        'GATE_PENDING',
        'GATE_FINDING',
        'STAGE_OVERDUE',
        'APPROVAL_ACTIVE',
        'APPROVAL_OVERDUE',
        'TRIAL_FAILED',
        'CHANGE_CCB',
        'PROBLEM_STALLED',
      ]),
    )
    expect(kinds(list).every((k) => k in BLOCKER_KINDS)).toBe(true)
    const late = list.filter((b) => b.kind === 'APPROVAL_OVERDUE')
    expect(late.map((b) => b.role)).toEqual(['软件设计师', '工艺工程师', '质量工程师'])
    expect(late.every((b) => b.ref.type === 'approval' && b.title.includes('CR-2026-031'))).toBe(true)
    expect(list.filter((b) => b.kind === 'GATE_PENDING').map((b) => b.role)).toEqual(['客户代表'])
    expect(snapshot(seed(NOW), NOW).blockers).toEqual(list)
    const one = snapshot(seed(NOW), NOW, 'PRJ-2025-042').blockers as Item[]
    expect(one.length).toBeGreaterThan(0)
    expect(one.every((b) => b.projectId === 'PRJ-2025-042')).toBe(true)
  })

  it('reads no blocker from a state without any', () => {
    expect(blockers(clean(), NOW)).toEqual([])
  })

  it('counts the waiting days of a pending gate from the stage entering review and drops signed roles', () => {
    const state = clean()
    const gate = state.gates.find((g: Item) => g.id === 'GATE-PRJ-2026-008-DL2-1')
    gate.decision = 'PENDING'
    gate.signatures = [{ role: '项目经理', by: '项目经理 王海涛', at: at(1) }]
    state.stages.find((s: Item) => s.id === gate.stageId).history.push({ at: at(3), to: 'IN_REVIEW' })
    const list = blockers(state, NOW) as Item[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'GATE_PENDING', role: '客户代表', days: 3 })
    gate.superseded = true
    expect(blockers(state, NOW)).toEqual([])
  })

  it('reports open review findings to the stage author and stage overdue until it passes', () => {
    const state = clean()
    state.gates[0].findings = [{ id: 'F-09', text: '缺少接口清单', by: '客户代表', closed: false }]
    const stage = state.stages.find((s: Item) => s.id === state.gates[0].stageId)
    stage.plannedEnd = at(5)
    stage.state = 'IN_PROGRESS'
    const list = blockers(state, NOW) as Item[]
    expect(kinds(list)).toEqual(['GATE_FINDING', 'STAGE_OVERDUE'])
    expect(list[0].role).toBe(stage.author)
    expect(list[1]).toMatchObject({ days: 5, ref: { type: 'stage', id: stage.id } })
    stage.state = 'PASSED'
    expect(kinds(blockers(state, NOW))).toEqual(['GATE_FINDING'])
  })

  it('derives a failed trial without a change, a change in CCB review and a stalled 8D', () => {
    const state = clean()
    const trial = seed(NOW).trials.find((t: Item) => t.id === 'TT-2026-011')
    const crs = seed(NOW).changes.find((c: Item) => c.id === 'CR-2026-031')
    const qp = seed(NOW).problems.find((p: Item) => p.id === 'QP-2026-007')
    state.trials.push(trial)
    state.changes.push(crs)
    state.problems.push(qp)
    expect(kinds(blockers(state, NOW))).toEqual(['TRIAL_FAILED', 'CHANGE_CCB', 'PROBLEM_STALLED'])
    state.trials[state.trials.length - 1] = { ...trial, changeId: crs.id }
    expect(kinds(blockers(state, NOW))).toEqual(['CHANGE_CCB', 'PROBLEM_STALLED'])
    // exactly 7 days in ANALYZING is still on time
    state.problems[state.problems.length - 1] = {
      ...qp,
      history: [{ at: at(7), from: 'OPEN', to: 'ANALYZING' }],
    }
    expect(kinds(blockers(state, NOW))).toEqual(['CHANGE_CCB'])
  })

  it('derives the maintained baseline lagging the designed one', () => {
    const state = clean()
    const project = 'PRJ-2023-011'
    const maintained = state.configBaselines.filter(
      (b: Item) => b.projectId === project && b.type === 'AS_MAINTAINED',
    )
    expect(blockers(state, NOW)).toEqual([])
    maintained[maintained.length - 1].revs['NC-DR-1218'] = 'A'
    const list = blockers(state, NOW) as Item[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'BASELINE_GAP', projectId: project, role: '配置管理员' })
    expect(list[0].reason).toContain('NC-DR-1218')
  })

  it('works without approvals and derives active, ALL-mode and overdue approval nodes when present', () => {
    const state = clean()
    expect(state.approvals).toBeUndefined()
    expect(blockers(state, NOW)).toEqual([])
    const ecr = newFlow({
      id: 'AP-1',
      projectId: 'PRJ-2025-042',
      template: 'ECR',
      subject: { type: 'change', id: 'CR-2026-031' },
      title: 'ECR CR-2026-031',
      initiator: { role: '项目经理', by: '项目经理 周宁' },
      now: Date.parse(at(1)),
    })
    act(ecr, { action: 'APPROVE', by: '机械设计师 沈岳' }, Date.parse(at(0.5)))
    const done = newFlow({
      id: 'AP-2',
      projectId: 'PRJ-2025-042',
      template: 'TRIAL_REPORT',
      subject: { type: 'trial', id: 'TR-1' },
      title: 'done',
      initiator: { role: '质量工程师', by: '质量工程师 林' },
      now: Date.parse(at(1)),
    })
    done.state = 'APPROVED'
    state.approvals = [ecr, done]
    let list = blockers(state, NOW) as Item[]
    expect(list.map((b) => [b.kind, b.role])).toEqual(
      ['电气设计师', '软件设计师', '工艺工程师', '质量工程师'].map((r) => ['APPROVAL_ACTIVE', r]),
    )
    ecr.nodes[0].enteredAt = at(4)
    list = blockers(state, NOW)
    expect(new Set(list.map((b) => b.kind))).toEqual(new Set(['APPROVAL_OVERDUE']))
    expect(list[0]).toMatchObject({ overdue: true, days: 4 })
  })
})

describe('store persistence', () => {
  it('reads an empty read-only store as the seed without writing', () => {
    const store = readOnly()
    const view = snapshot(read(store, NOW), NOW)
    expect(view.projects.map((p: Item) => p.id)).toEqual(buildSeed(NOW).projects.map((p: Item) => p.id))
    expect(read(store, NOW).revision).toBe(1)
    expect(store.rows.size).toBe(0)
  })

  it('reads a store of another schema (1 or 2) as the seed and replaces it on the first write', () => {
    for (const schema of [1, 2]) {
      const store = memoryStore()
      store.set('devboard/meta', { schema, revision: 9, chunks: { projects: 1 } })
      store.set('devboard/projects/0', [{ id: 'PRJ-OLD' }])
      store.set('devboard/requirements', [{ id: 'REQ-001' }])
      const before = read(store, NOW)
      expect(before.revision).toBe(1)
      expect(before.projects.map((p: Item) => p.id)).not.toContain('PRJ-OLD')
      expect(store.get('devboard/meta')).toMatchObject({ schema, revision: 9 })
      update(store, (s: State) => create(s, { kind: 'requirement', title: '新需求' }, NOW), NOW)
      expect(store.get('devboard/meta')).toMatchObject({ schema: 4, revision: 2 })
      expect(read(store, NOW).projects.map((p: Item) => p.id)).not.toContain('PRJ-OLD')
    }
  })

  it('persists every collection in chunks under the value cap, writes through one path and resets', () => {
    const store = memoryStore()
    const seeded = seed(NOW)
    const { revision, result } = update(
      store,
      (s: State) => create(s, { kind: 'requirement', title: '新需求', by: '研发协调员' }, NOW),
      NOW,
    )
    expect(revision).toBe(2)
    expect(result).toMatchObject({ state: 'RAW' })
    const back = read(store, NOW)
    for (const c of COLLECTIONS) if (c !== 'requirements') expect(back[c], c).toHaveLength(seeded[c].length)
    expect(back.requirements).toHaveLength(seeded.requirements.length + 1)
    expect(() =>
      create(read(store, NOW), { kind: 'task', requirementId: 'REQ-404', title: 'x', type: 'TESTING' }),
    ).toThrow('未找到 REQ-404')
    expect(reset(store, NOW).revision).toBe(3)
    expect(read(store, NOW).requirements).toHaveLength(seeded.requirements.length)
  })

  it('persists new-collection writes (a trial) and serves them from the snapshot', () => {
    const store = memoryStore()
    const pid = read(store, NOW).projects[0].id
    const { result } = update(
      store,
      (s: State) =>
        upsertTrial(
          s,
          {
            projectId: pid,
            type: 'ROUTINE',
            title: '例行试验',
            standard: 's',
            sample: 'x',
            lab: '主机厂现场',
            plannedAt: '2026-11-01',
          },
          NOW,
        ),
      NOW,
    )
    expect(snapshot(read(store, NOW), NOW).trials.map((t: Item) => t.id)).toContain(result.id)
  })

  it('caches a live document body, truncates it by bytes and serves it as the artifact body', () => {
    const store = memoryStore()
    const big = `# 需求规格\n${'需'.repeat(DOC_LIMIT_BYTES)}`
    const { result } = update(store, (s: State) => {
      const p = create(s, { kind: 'project', name: '车门健康监测看板' }, NOW)
      return recordArtifact(
        s,
        { projectId: p.id, stage: 'REQUIREMENTS', kind: 'SRS', path: 'docs/SRS.md', markdown: big },
        NOW,
      )
    })
    const body = artifactBody(store, result.id, NOW)
    expect(body).toMatchObject({ source: 'workspace', truncated: true })
    expect(new TextEncoder().encode(body.markdown).length).toBeLessThanOrEqual(DOC_LIMIT_BYTES)
    expect(body.markdown.startsWith('# 需求规格')).toBe(true)
    expect(() => artifactBody(store, 'DOC-404', NOW)).toThrow('未找到 DOC-404')
    reset(store, NOW)
    expect([...store.rows.keys()].some((k) => k.startsWith('devboard/doc/'))).toBe(false)
  })
})

describe('fast-forward from the shipped sample', () => {
  /** A file port that records writes; `existing` directories answer stat. */
  const fakeFs = (existing: string[] = []) => {
    const writes = new Map<string, string>()
    return {
      writes,
      stat: async (path: string) => {
        if (existing.some((dir) => path === dir || path.startsWith(`${dir}/`)))
          return { kind: 'dir', size: 0, mtimeMs: 0 }
        throw new Error('ENOENT')
      },
      write: async (path: string, data: string) => void writes.set(path, data),
    }
  }
  const run = (store: ReturnType<typeof memoryStore>, gate: string, fs = fakeFs()) =>
    fastForward({ gate }, { store, fs, signal: new AbortController().signal })
  const level = levelOf

  // [gate, pending gate code, state of each stage, ticked main steps, tasks, defects]
  const LEVELS = [
    ['CDCP', 'CDCP', 'I·····', ['m2', 'm3'], 0, 0],
    ['TR1', 'TR1', 'PI····', ['m2', 'm3', 'm4', 'm5'], 0, 0],
    ['TR3', 'TR3', 'PPI···', ['m2', 'm3', 'm4', 'm5', 'm6', 'm7'], 6, 0],
    ['TR5', 'TR5', 'PPPPI·', ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'], 6, 2],
    ['DONE', 'ADCP', 'PPPPPP', MAIN_STEPS.slice(1).map((m) => m.id), 6, 2],
    ['TR3_CHANGE', 'TR3', 'PPI···', ['m2', 'm3', 'm4', 'm5', 'm6', 'm7'], 6, 0],
  ] as const

  it.each(LEVELS)(
    '%s: stops at the right gate with the expected stage, tasks and defects',
    async (gate, code, shape, ticks, tasks, defects) => {
      const store = memoryStore()
      const { revision, data } = (await run(store, gate)) as Item
      const state = read(store)
      const live = state.projects.filter((p: Item) => p.live)
      expect(live).toHaveLength(1)
      const [project] = live
      expect(project).toMatchObject({
        id: data.projectId,
        workspaceDir: `devboard-projects/${data.projectId}`,
        stage: expect.any(String),
      })
      expect(data).toMatchObject({ gate: code, workspaceDir: project.workspaceDir })
      expect(revision).toBe(read(store).revision)
      // P passed, I in review, · not started: the six stages in profile order
      const stages = state.stages.filter((s: Item) => s.projectId === project.id)
      const letters = { PASSED: 'P', IN_REVIEW: 'I', NOT_STARTED: '·' } as Record<string, string>
      expect(stages.map((s: Item) => letters[s.state]).join('')).toBe(shape)
      const gates = state.gates.filter((g: Item) => g.stageId.startsWith(`${project.id}/`))
      const pending = gates.filter((g: Item) => g.decision === 'PENDING')
      if (gate === 'DONE') {
        expect(pending).toHaveLength(0)
        expect(gates.at(-1)).toMatchObject({ code: 'ADCP', decision: 'APPROVED' })
        expect(project.actualEnd).toBeDefined()
      } else {
        expect(pending.map((g: Item) => g.code)).toEqual([code])
        expect(snapshot(state).counts.pendingGates).toBeGreaterThanOrEqual(1)
      }
      expect(Object.keys(mainProgress(snapshot(state), MAIN_STEPS))).toEqual(ticks)
      expect(state.tasks.filter((t: Item) => t.projectId === project.id)).toHaveLength(tasks)
      const found = state.defects.filter((d: Item) => d.projectId === project.id)
      expect(found).toHaveLength(defects)
      if (defects) {
        expect(found.map((d: Item) => [d.severity, d.state])).toEqual([
          ['C', 'CLOSED'],
          ['B', 'RETEST'],
        ])
        expect(found.map((d: Item) => d.req)).toEqual(['SWR-002', 'SWR-003'])
        const runs = state.testRuns.filter((t: Item) => t.projectId === project.id)
        expect(runs.map((r: Item) => [r.level, r.total, r.failed])).toEqual([
          ['UNIT', UNIT_TOTAL, 1],
          ['UNIT', UNIT_TOTAL, 0],
          ['INTEGRATION', 8, 0],
          ['SYSTEM', 12, 1],
        ])
      }
      if (tasks) {
        const reqs = state.requirements.filter((r: Item) => r.projectId === project.id)
        expect(reqs.map((r: Item) => r.title.slice(0, 7))).toEqual(['SWR-001', 'SWR-003', 'SWR-005'])
        const types = state.tasks.filter((t: Item) => t.projectId === project.id).map((t: Item) => t.type)
        expect(types.filter((t: string) => t === 'DEVELOPMENT')).toHaveLength(3)
        expect(types.filter((t: string) => t === 'TESTING')).toHaveLength(3)
        const finished = level(gate) >= 3
        expect(
          state.tasks
            .filter((t: Item) => t.projectId === project.id)
            .every((t: Item) => t.state === (finished ? 'COMPLETED' : 'PENDING')),
        ).toBe(true)
        expect(reqs.every((r: Item) => r.state === (finished ? 'COMPLETED' : 'ASSIGNED'))).toBe(true)
      }
      // the traceability the requirements gate relies on is complete
      if (level(gate) >= 1)
        expect(coverage(state, project.id)).toMatchObject({ cusSwr: { pct: 100 }, swrTc: { pct: 100 } })
      // the timeline is back-dated by days and never runs backwards
      expect(Date.now() - Date.parse(project.createdAt)).toBeGreaterThan(DAY)
      const stamps = stages.flatMap((s: Item) => s.history.map((h: Item) => Date.parse(h.at)))
      expect(stamps.length).toBeGreaterThan(0)
      for (const [i, t] of stamps.entries())
        if (i) expect(t).toBeGreaterThanOrEqual(Math.min(...stamps.slice(0, i)))
    },
  )

  it('writes only the stage template files below the new project directory, with the template bytes', async () => {
    const store = memoryStore()
    for (const gate of GATES) {
      const fs = fakeFs()
      const { data } = (await run(store, gate, fs)) as Item
      const dir = `devboard-projects/${data.projectId}`
      const expected = FILES.filter(([from]) => from <= level(gate)).map(([, rel]) => `${dir}/${rel}`)
      expect([...fs.writes.keys()].sort(), gate).toEqual(expected.sort())
      for (const path of fs.writes.keys())
        expect(path.startsWith(`${dir}/`) && !path.includes('..'), path).toBe(true)
      // the cached preview of a registered document is the written text
      const doc = read(store).artifacts.find(
        (a: Item) => a.projectId === data.projectId && a.source.path === `${dir}/docs/PROJECT-PLAN.md`,
      )
      expect(artifactBody(store, doc.id).markdown).toBe(fs.writes.get(`${dir}/docs/PROJECT-PLAN.md`))
    }
  })

  it('creates a new project every time and never takes a directory that already exists', async () => {
    const store = memoryStore()
    const a = ((await run(store, 'TR1')) as Item).data.projectId
    const b = ((await run(store, 'TR1')) as Item).data.projectId
    expect(new Set([a, b]).size).toBe(2)
    expect(read(store).projects.filter((p: Item) => p.live)).toHaveLength(2)
    // a reset keeps the files on disk: the next number is taken from the first free directory
    reset(store, NOW)
    const taken = [`devboard-projects/${a}`, `devboard-projects/${b}`]
    const fs = fakeFs(taken)
    const c = ((await run(store, 'CDCP', fs)) as Item).data.projectId
    expect([a, b]).not.toContain(c)
    for (const path of fs.writes.keys()) expect(taken.some((dir) => path.startsWith(dir))).toBe(false)
    // a store that answers "exists" for everything is refused and nothing is written or saved
    const revision = read(store).revision
    const all = { ...fakeFs(), stat: async () => ({ kind: 'dir', size: 0, mtimeMs: 0 }) }
    await expect(run(store, 'TR3', all)).rejects.toThrow('已有太多旧项目目录')
    expect(all.writes.size).toBe(0)
    expect(read(store).revision).toBe(revision)
  })

  it('feeds the delivery card only from TR5 on: runs per level, evidence documents and the app address', async () => {
    const shown: Record<string, boolean> = {}
    for (const gate of GATES) {
      const store = memoryStore()
      await run(store, gate)
      const data = snapshot(read(store))
      const project = data.projects.find((p: Item) => p.live)
      shown[gate] = showDelivery(data, project)
      if (!shown[gate]) continue
      expect(entryFile(project)).toBe(`${project.workspaceDir}/server.js`)
      // the newest run of each level: the unit tests were fixed after the first failure
      expect(latestRuns(data, project.id).map((r: Item) => [r.level, r.passed, r.failed])).toEqual([
        ['UNIT', UNIT_TOTAL, 0],
        ['INTEGRATION', 8, 0],
        ['SYSTEM', 11, 1],
      ])
      expect(evidenceDocs(data, project.id).map((a: Item) => a.kind)).toEqual(['TEST_REPORT', 'ACCEPTANCE'])
      // an app address appears only once it is registered
      expect(project.appUrl).toBeUndefined()
    }
    expect(shown).toEqual({ CDCP: false, TR1: false, TR3: false, TR5: true, DONE: true, TR3_CHANGE: false })
    // seed and order projects never show it
    const seeded = snapshot(seed(NOW))
    expect(seeded.projects.some((p: Item) => showDelivery(seeded, p))).toBe(false)
  })

  it('TR3_CHANGE: a customer change waits in CCB review with its ECR flow, and approving it sends the stages back', async () => {
    const store = memoryStore()
    const { data } = (await run(store, 'TR3_CHANGE')) as Item
    const state = read(store)
    const cr = byId(state.changes, data.changeId)
    expect(cr).toMatchObject({
      projectId: data.projectId,
      state: 'CCB_REVIEW',
      source: { type: 'CUSTOMER', ref: 'TA §3.2' },
    })
    expect(cr.impact.reqs).toEqual(['CUS-002', 'DES-001', 'DES-003', 'SWR-004', 'SYS-003'])
    expect(cr.impact.tests).toEqual(['TC-004', 'TC-008'])
    const flow = byId(state.approvals, data.approvalId)
    expect(flow).toMatchObject({ template: 'ECR', state: 'RUNNING', subject: { id: cr.id } })
    expect(data.next).toContain('CCB')
    // the project page offers the customer change from design on, on a live project only
    const project = byId(state.projects, data.projectId)
    expect(showCustomerChange(project)).toBe(true)
    expect(showCustomerChange({ ...project, stage: 'REQUIREMENTS' })).toBe(false)
    expect(showCustomerChange({ ...project, stage: 'RELEASE' })).toBe(false)
    expect(showCustomerChange({ ...project, live: false })).toBe(false)
    // approving the flow: the change is applied, the passed and the in-review stage go back to rework
    approveFlow(state, flow.id)
    const applied = byId(state.changes, cr.id)
    expect(applied).toMatchObject({ state: 'APPROVED', ecn: expect.any(String) })
    const stage = (name: string) => byId(state.stages, `${data.projectId}/${name}`)
    expect([stage('REQUIREMENTS').state, stage('DESIGN').state]).toEqual(['REWORK', 'REWORK'])
    expect(applied.reworked).toEqual([`${data.projectId}/REQUIREMENTS`, `${data.projectId}/DESIGN`])
    const gates = state.gates.filter((g: Item) => g.stageId.startsWith(`${data.projectId}/`))
    expect(gates.filter((g: Item) => g.decision === 'PENDING')).toEqual([])
    expect(gates.filter((g: Item) => ['TR1', 'TR3'].includes(g.code)).every((g: Item) => g.superseded)).toBe(
      true,
    )
    const changed = state.reqs.filter((r: Item) => r.projectId === data.projectId && r.status === 'CHANGED')
    expect(changed.map((r: Item) => r.id).sort()).toEqual(applied.impact.reqs)
    // the stages run their gates again, and the old gate is not reused
    for (const name of ['REQUIREMENTS', 'DESIGN']) pass(state, data.projectId, name)
    expect([stage('REQUIREMENTS').state, stage('DESIGN').state]).toEqual(['PASSED', 'PASSED'])
    expect(gates.length).toBeLessThan(
      state.gates.filter((g: Item) => g.stageId.startsWith(`${data.projectId}/`)).length,
    )
  })

  it('refuses any input but the gate enum and leaves the board alone', async () => {
    const store = memoryStore()
    const fs = fakeFs()
    for (const gate of ['TR4', 'tr1', '../x', '', undefined])
      await expect(run(store, gate as string, fs), String(gate)).rejects.toThrow('gate 取值无效')
    expect(fs.writes.size).toBe(0)
    expect(read(store).projects.some((p: Item) => p.live)).toBe(false)
  })

  it.each(['CDCP', 'TR1', 'TR3', 'TR5'])(
    'continues from the pending %s gate through the normal rules',
    async (gate) => {
      const store = memoryStore()
      await run(store, gate)
      const state = read(store)
      const project = state.projects.find((p: Item) => p.live)
      const pending = state.gates.find(
        (g: Item) => g.decision === 'PENDING' && g.stageId.startsWith(`${project.id}/`),
      )
      const stage = byId(state.stages, pending.stageId)
      // the stage author cannot sign, a role the gate does not name cannot either
      expect(() =>
        decideGate(state, { gateId: pending.id, decision: 'APPROVED', by: `${stage.author} 测试员` }, NOW),
      ).toThrow('编写角色')
      expect(() =>
        decideGate(state, { gateId: pending.id, decision: 'APPROVED', by: '客户代表 测试员' }, NOW),
      ).toThrow('本门需由')
      sign(state, pending.id, pending.approverRoles[0])
      expect(byId(state.stages, pending.stageId).state).toBe('PASSED')
      // the remaining stages run the ordinary start / submit / sign loop
      for (const next of STAGE_LIST.slice(STAGE_LIST.indexOf(stage.stage) + 1)) pass(state, project.id, next)
      expect(
        state.stages.filter((s: Item) => s.projectId === project.id).every((s: Item) => s.state === 'PASSED'),
      ).toBe(true)
      expect(byId(state.projects, project.id).actualEnd).toBeDefined()
    },
  )
})

describe('tracing a change down the requirement chain', () => {
  const sample = async () => {
    const store = memoryStore()
    const fs = { stat: async () => Promise.reject(new Error('ENOENT')), write: async () => undefined }
    const { data } = (await fastForward(
      { gate: 'TR3' },
      { store, fs, signal: new AbortController().signal },
    )) as Item
    return { state: read(store), projectId: data.projectId as string }
  }

  it('finds the downstream items, deliverables and code modules of a customer clause', async () => {
    const { state, projectId } = await sample()
    expect(traceImpact(state, projectId, ['CUS-002'])).toEqual({
      reqs: ['CUS-002', 'DES-001', 'DES-003', 'SWR-004', 'SYS-003'],
      tests: ['TC-004', 'TC-008'],
      artifacts: [
        `DOC-${projectId.split('-').at(-1)}-RTM`,
        `DOC-${projectId.split('-').at(-1)}-SAD`,
        `DOC-${projectId.split('-').at(-1)}-SRS`,
        // no test report exists yet at TR3, so none is named
      ].sort(),
      modules: ['src/app.js', 'src/health.js'],
    })
    // a leaf traces to itself and a test case to the report; an unknown item is refused
    expect(traceImpact(state, projectId, ['TC-004']).tests).toEqual(['TC-004'])
    expect(() => traceImpact(state, projectId, ['SWR-999'])).toThrow('未找到')
  })

  it('merges traceFrom into what the caller gave, on create and on a later update', async () => {
    const { state, projectId } = await sample()
    const cr = create(
      state,
      {
        kind: 'change',
        projectId,
        title: '预警排行条数',
        reason: '客户变更',
        source: { type: 'CUSTOMER' },
        impact: { reqs: ['CUS-002'], tests: ['TC-001'], safety: true, effortDays: 2 },
        traceFrom: true,
        by: '研发协调员',
      },
      NOW,
    )
    expect(cr.impact.reqs).toEqual(['CUS-002', 'SYS-003', 'SWR-004', 'DES-001', 'DES-003'].sort())
    // what the caller named stays, the traced test cases join it
    expect(cr.impact.tests.sort()).toEqual(['TC-001', 'TC-004', 'TC-008'])
    expect(cr.impact).toMatchObject({ safety: true, effortDays: 2 })
    // it is also visible, traced live, on the snapshot
    expect(byId(snapshot(state).changes, cr.id).trace.modules).toEqual(['src/app.js', 'src/health.js'])
    // without traceFrom nothing is added; traceFrom with no starting point is refused
    const plain = create(
      state,
      { kind: 'change', projectId, title: 'b', reason: 'b', impact: { reqs: ['CUS-001'] }, by: 'x' },
      NOW,
    )
    expect(plain.impact.reqs).toEqual(['CUS-001'])
    // an id that does not exist is accepted as before and must not break the read model
    const stray = create(
      state,
      {
        kind: 'change',
        projectId,
        title: 'd',
        reason: 'd',
        impact: { reqs: ['SWR-999', 'CUS-002'] },
        by: 'x',
      },
      NOW,
    )
    expect(byId(snapshot(state).changes, stray.id).trace.reqs).toEqual(
      traceImpact(state, projectId, ['CUS-002']).reqs,
    )
    expect(() =>
      create(state, { kind: 'change', projectId, title: 'c', reason: 'c', traceFrom: true, by: 'x' }, NOW),
    ).toThrow('traceFrom')
    // an update traces from the requirements the change already names
    updateChange(state, { id: plain.id, traceFrom: true, by: 'x' }, NOW)
    expect(byId(state.changes, plain.id).impact.reqs).toEqual(traceImpact(state, projectId, ['CUS-001']).reqs)
  })
})
