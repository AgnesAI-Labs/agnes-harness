import { describe, expect, it } from 'vitest'
import {
  artifactBody,
  coverage,
  create,
  DOC_LIMIT_BYTES,
  decideGate,
  MACHINES,
  projectPath,
  read,
  recordArtifact,
  recordTestRun,
  registerApp,
  reset,
  seed,
  snapshot,
  submitGate,
  transition,
  update,
  updateImpact,
  upsertReqs,
} from '../domain.mjs'

const NOW = Date.parse('2026-10-21T08:00:00Z')
const HOUR = 3_600_000
// biome-ignore lint/suspicious/noExplicitAny: domain.mjs is untyped JavaScript
type Item = { id: string; [key: string]: any }

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

describe('DevBoard v1 state machines', () => {
  it.each([
    ['requirement', 'REQ-006', 'REFINED'],
    ['requirement', 'REQ-005', 'RAW'],
    ['requirement', 'REQ-005', 'ASSIGNED'],
    ['task', 'TASK-008', 'PENDING'],
    ['task', 'TASK-010', 'IN_PROGRESS'],
    ['intervention', 'HI-003', 'OPEN'],
    ['defect', 'DEF-0132', 'CONFIRMED'],
    ['change', 'CR-2026-031', 'REJECTED'],
  ])('allows %s %s → %s', (kind, id, to) => {
    const state = seed(NOW)
    expect(transition(state, { kind, id, to, by: '项目经理' }, NOW).state).toBe(to)
  })

  it.each([
    ['requirement', 'REQ-006', 'COMPLETED', 'RAW'],
    ['task', 'TASK-001', 'IN_PROGRESS', 'COMPLETED'],
    ['task', 'TASK-007', 'COMPLETED', 'PENDING'],
    ['intervention', 'HI-004', 'OPEN', 'RESOLVED'],
    ['intervention', 'HI-001', 'RESOLVED', 'OPEN'],
    ['defect', 'DEF-0121', 'FIXING', 'CLOSED'],
  ])('refuses %s %s → %s', (kind, id, to, from) => {
    const state = seed(NOW)
    expect(() => transition(state, { kind, id, to, by: '协调员' }, NOW)).toThrow(
      `非法状态流转：${from} 不可流转至 ${to}`,
    )
  })

  it('never offers EXPIRED as a stored target and records history', () => {
    for (const targets of Object.values(MACHINES.intervention)) expect(targets).not.toContain('EXPIRED')
    const state = seed(NOW)
    const item = transition(state, { kind: 'intervention', id: 'HI-002', to: 'CLAIMED', by: '管理者' }, NOW)
    expect(item).toMatchObject({ state: 'CLAIMED', handler: '管理者' })
    expect(item.history.at(-1)).toMatchObject({ from: 'EXPIRED', to: 'CLAIMED', by: '管理者' })
    transition(
      state,
      { kind: 'intervention', id: 'HI-002', to: 'RESOLVED', by: '管理者', note: '同步验签' },
      NOW,
    )
    expect(item.resolution).toBe('同步验签')
  })

  it('moves ASSIGNED → IN_PROGRESS on the first started task and completes when all tasks finish', () => {
    const state = seed(NOW)
    const req = () => byId(state.requirements, 'REQ-004')
    expect(req().state).toBe('ASSIGNED')
    transition(state, { kind: 'task', id: 'TASK-013', to: 'IN_PROGRESS', by: 'x' }, NOW)
    expect(req().state).toBe('IN_PROGRESS')
    transition(state, { kind: 'task', id: 'TASK-013', to: 'COMPLETED', by: 'x' }, NOW)
    transition(state, { kind: 'task', id: 'TASK-014', to: 'CANCELLED', by: 'x' }, NOW)
    expect(req().state).toBe('IN_PROGRESS')
    transition(state, { kind: 'task', id: 'TASK-015', to: 'CANCELLED', by: 'x' }, NOW)
    expect(req().state).toBe('COMPLETED')
    expect(req().history.at(-1)).toMatchObject({ by: '系统联动', to: 'COMPLETED' })
  })

  it('derives EXPIRED from dueAt and lists overdue first, then newest first', () => {
    const view = snapshot(seed(NOW), NOW)
    expect(view.interventions[0]).toMatchObject({ id: 'HI-002', state: 'EXPIRED' })
    const rest = view.interventions.slice(1).map((i: Item) => Date.parse(i.createdAt))
    expect(rest).toEqual([...rest].sort((a, b) => b - a))
    expect(view.counts.intervention).toMatchObject({ EXPIRED: 1, OPEN: 2, CLAIMED: 1, RESOLVED: 2 })
    const state = seed(NOW)
    create(
      state,
      {
        kind: 'intervention',
        type: 'RELEASE_APPROVAL',
        entity: { kind: 'task', id: 'TASK-015' },
        ask: '可以发布吗？',
        dueInHours: 1,
      },
      NOW,
    )
    expect(byId(snapshot(state, NOW).interventions, 'HI-007').state).toBe('OPEN')
    expect(snapshot(state, NOW + 2 * HOUR).interventions[0].state).toBe('EXPIRED')
  })
})

describe('stages and review gates', () => {
  it('starts a stage only after the previous one has passed', () => {
    const state = seed(NOW)
    expect(() =>
      transition(
        state,
        { kind: 'stage', id: 'PRJ-2026-008/IMPLEMENTATION', to: 'IN_PROGRESS', by: 'x' },
        NOW,
      ),
    ).toThrow('阶段顺序不满足：前一阶段「架构设计」尚未通过评审')
    expect(() =>
      transition(state, { kind: 'stage', id: 'PRJ-2026-008/DESIGN', to: 'PASSED', by: '技术负责人' }, NOW),
    ).toThrow('只能通过评审门决议')
  })

  it.each([
    [
      'open findings',
      { gateId: 'GATE-PRJ-2026-008-DESIGN-1', by: '技术负责人 郑凯' },
      '评审门不满足：还有 2 条评审意见未关闭（F-02、F-03）',
    ],
    [
      'approver equals author',
      { gateId: 'GATE-PRJ-2026-008-DESIGN-1', by: '软件架构师' },
      '评审门不满足：审批人角色「软件架构师」是该阶段的编写角色',
    ],
    [
      'stage not in review',
      { gateId: 'GATE-PRJ-2025-042-DESIGN-2', by: '技术负责人' },
      '评审门不满足：阶段「架构设计」不在评审中',
    ],
  ])('refuses approval with %s', (_name, input, message) => {
    const state = seed(NOW)
    expect(() => decideGate(state, { ...input, decision: 'APPROVED' }, NOW)).toThrow(message)
  })

  it('approves once findings close: stage PASSED, artifacts BASELINED, a baseline and the next stage', () => {
    const state = seed(NOW)
    const { stage } = decideGate(
      state,
      {
        gateId: 'GATE-PRJ-2026-008-DESIGN-1',
        decision: 'APPROVED',
        by: '技术负责人 郑凯',
        comment: '同意',
        closeFindings: [
          { id: 'F-02', note: '补充 FMEA 摘要' },
          { id: 'F-03', note: '补充地址规划表' },
        ],
      },
      NOW,
    )
    expect(stage).toMatchObject({
      state: 'PASSED',
      baseline: { id: 'BL-008-SAD-V1.0', items: ['DOC-008-SAD'] },
    })
    expect(byId(state.artifacts, 'DOC-008-SAD').status).toBe('BASELINED')
    expect(byId(state.projects, 'PRJ-2026-008').stage).toBe('IMPLEMENTATION')
    expect(
      transition(state, { kind: 'stage', id: 'PRJ-2026-008/IMPLEMENTATION', to: 'IN_PROGRESS', by: 'x' }, NOW)
        .state,
    ).toBe('IN_PROGRESS')
  })

  it('rejects with a comment into REWORK and back to IN_PROGRESS', () => {
    const state = seed(NOW)
    const input = { gateId: 'GATE-PRJ-2026-008-DESIGN-1', decision: 'REJECTED', by: '技术负责人' }
    expect(() => decideGate(state, input, NOW)).toThrow('驳回需填写评审意见')
    const { stage, gate } = decideGate(state, { ...input, comment: '失效模式分析不足' }, NOW)
    expect(stage.state).toBe('REWORK')
    expect(gate).toMatchObject({ decision: 'REJECTED', approver: '技术负责人' })
    expect(byId(state.artifacts, 'DOC-008-SAD').status).toBe('DRAFT')
    transition(state, { kind: 'stage', id: stage.id, to: 'IN_PROGRESS', by: '软件架构师' }, NOW)
    expect(submitGate(state, { stageId: stage.id, by: '研发协调员' }, NOW).gate.id).toBe(
      'GATE-PRJ-2026-008-DESIGN-2',
    )
  })
})

describe('change requests', () => {
  it('needs an impact analysis before CCB and sends impacted passed stages to rework', () => {
    const state = seed(NOW)
    const cr = create(
      state,
      {
        kind: 'change',
        projectId: 'PRJ-2025-042',
        title: '增加门状态上报',
        reason: '客户要求',
        by: '客户代表',
      },
      NOW,
    )
    expect(cr).toMatchObject({ id: 'CR-2026-032', state: 'SUBMITTED' })
    expect(() => transition(state, { kind: 'change', id: cr.id, to: 'ANALYZED', by: 'x' }, NOW)).toThrow(
      '缺少影响分析',
    )
    updateImpact(state, {
      id: cr.id,
      impact: { reqs: ['SWR-017'], artifacts: ['DOC-042-SAD'], effortDays: 5 },
    })
    transition(state, { kind: 'change', id: cr.id, to: 'ANALYZED', by: '需求工程师' }, NOW)
    transition(state, { kind: 'change', id: cr.id, to: 'CCB_REVIEW', by: '配置管理员' }, NOW)
    transition(
      state,
      {
        kind: 'change',
        id: cr.id,
        to: 'APPROVED',
        by: 'CCB',
        note: '批准',
        members: ['项目经理', '技术负责人'],
      },
      NOW,
    )
    expect(cr.ccb).toMatchObject({ decision: 'APPROVED', members: ['项目经理', '技术负责人'] })
    expect(byId(state.reqs, 'SWR-017', 'PRJ-2025-042').status).toBe('CHANGED')
    expect(byId(state.stages, 'PRJ-2025-042/REQUIREMENTS').state).toBe('REWORK')
    expect(byId(state.stages, 'PRJ-2025-042/DESIGN').state).toBe('REWORK')
    expect(byId(state.stages, 'PRJ-2025-042/VERIFICATION').state).toBe('IN_PROGRESS')
  })
})

describe('traceability', () => {
  it('computes the three link coverages and lists intentional orphans', () => {
    const state = seed(NOW)
    const c = coverage(state, 'PRJ-2025-042')
    expect(c.cusSys.pct).toBe(100)
    expect(c.swrTc.missing).toEqual(['SWR-025'])
    expect(c.swrTc).toMatchObject({ covered: 24, total: 25, pct: 96 })
    expect(c.noSource).toEqual(['TC-038'])
    expect(coverage(state, 'PRJ-2026-008').swrTc.pct).toBe(0)
    const live = create(state, { kind: 'project', name: '车门健康监测看板', by: '研发协调员' }, NOW)
    expect(coverage(state, live.id).cusSys.pct).toBeNull()
  })

  it('registers items per project, links test cases back to SWR and refuses wrong parents', () => {
    const state = seed(NOW)
    const live = create(state, { kind: 'project', name: '车门健康监测看板' }, NOW)
    const items = [
      { id: 'CUS-001', title: '健康评分', text: '按车门给出健康评分' },
      { id: 'SYS-001', title: '评分计算', text: '按故障码计算评分', parent: ['CUS-001'] },
      { id: 'SWR-001', title: '评分接口', text: 'GET /api/health', parent: ['SYS-001'] },
      { id: 'TC-001', title: '评分接口用例', text: '返回 0–100', parent: ['SWR-001'] },
    ]
    expect(upsertReqs(state, { projectId: live.id, items, by: '研发协调员' }, NOW).created).toHaveLength(4)
    expect(byId(state.reqs, 'SWR-001', live.id).verifiedBy).toEqual(['TC-001'])
    expect(byId(state.reqs, 'CUS-001', 'PRJ-2025-042').title).not.toBe('健康评分')
    expect(coverage(state, live.id).swrTc.pct).toBe(100)
    expect(() =>
      upsertReqs(state, {
        projectId: live.id,
        items: [{ id: 'TC-002', title: 't', text: 't', parent: ['CUS-001'] }],
      }),
    ).toThrow('TC-002 的上游必须是 SWR')
    expect(() =>
      upsertReqs(state, { projectId: live.id, items: [{ id: 'REQ-1', title: 't', text: 't' }] }),
    ).toThrow('编号格式无效')
  })
})

describe('live project tool chain', () => {
  it('runs a project from initiation through an auto-passed implementation review', () => {
    const state = seed(NOW)
    const project = create(state, { kind: 'project', name: '车门健康监测看板', by: '研发协调员' }, NOW)
    expect(project).toMatchObject({
      id: 'PRJ-2026-009',
      live: true,
      workspaceDir: 'devboard-projects/PRJ-2026-009',
    })
    expect(byId(state.stages, `${project.id}/INITIATION`).state).toBe('IN_PROGRESS')
    const plan = recordArtifact(
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
    expect(plan).toMatchObject({
      id: 'DOC-009-PLAN',
      source: { type: 'workspace', path: `${project.workspaceDir}/docs/PROJECT-PLAN.md` },
    })
    const { gate } = submitGate(state, { stageId: `${project.id}/INITIATION`, by: '研发协调员' }, NOW)
    expect(gate).toMatchObject({ approverRole: '研发总监', decision: 'PENDING' })
    expect(() => decideGate(state, { gateId: gate.id, decision: 'APPROVED', by: '项目经理' }, NOW)).toThrow(
      '编写角色',
    )
    decideGate(state, { gateId: gate.id, decision: 'APPROVED', by: '研发总监' }, NOW)
    expect(byId(state.artifacts, 'DOC-009-PLAN').status).toBe('BASELINED')

    transition(state, { kind: 'stage', id: `${project.id}/REQUIREMENTS`, to: 'IN_PROGRESS', by: 'x' }, NOW)
    upsertReqs(state, { projectId: project.id, items: [{ id: 'CUS-001', title: 'c', text: 'c' }] }, NOW)
    const req = submitGate(state, { stageId: `${project.id}/REQUIREMENTS`, by: '研发协调员' }, NOW).gate
    expect(req.findings[0]).toMatchObject({ by: '系统检查', closed: false })
    expect(req.findings[0].text).toContain('CUS→SWR 覆盖率 0%')

    const impl = byId(state.stages, `${project.id}/IMPLEMENTATION`)
    Object.assign(impl, { state: 'IN_PROGRESS' })
    const review = submitGate(
      state,
      { stageId: impl.id, by: '研发协调员', findings: ['缺少端口参数校验'] },
      NOW,
    )
    expect(review.stage.state).toBe('IN_REVIEW')
    submitGate(
      state,
      { stageId: impl.id, by: '研发协调员', closeFindings: [{ id: 'F-01', note: '已补充' }] },
      NOW,
    )
    expect(impl.state).toBe('PASSED')
    expect(review.gate).toMatchObject({ decision: 'APPROVED', approver: '系统（代码评审意见已全部关闭）' })

    expect(
      recordTestRun(
        state,
        { projectId: project.id, level: 'UNIT', total: 3, passed: 2, failed: 1, skipped: 0 },
        NOW,
      ),
    ).toMatchObject({ id: 'TR-009-01', source: 'live' })
    expect(() =>
      recordTestRun(state, { projectId: project.id, total: 3, passed: 3, failed: 1 }, NOW),
    ).toThrow('用例数不一致')
    expect(() => registerApp(state, { projectId: project.id, url: 'http://example.com/' }, NOW)).toThrow(
      '本机地址',
    )
    expect(registerApp(state, { projectId: project.id, url: 'http://127.0.0.1:5180/' }, NOW).appUrl).toBe(
      'http://127.0.0.1:5180/',
    )
    expect(() =>
      registerApp(state, { projectId: 'PRJ-2025-042', url: 'http://127.0.0.1:5180/' }, NOW),
    ).toThrow('不是现场项目')
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

  it('accepts project-relative and workspace-relative paths and refuses seed projects', () => {
    const project = { id: 'PRJ-2026-009', live: true, workspaceDir: 'devboard-projects/PRJ-2026-009' }
    expect(projectPath(project, 'src/a.js')).toBe('devboard-projects/PRJ-2026-009/src/a.js')
    expect(projectPath(project, 'devboard-projects/PRJ-2026-009/README.md')).toBe(
      'devboard-projects/PRJ-2026-009/README.md',
    )
    expect(() => projectPath({ id: 'PRJ-2025-042', live: false }, 'docs/SRS.md')).toThrow('不是现场项目')
  })
})

describe('store persistence', () => {
  it('reads an empty read-only store as the seed without writing (query and effect preparation)', () => {
    const store = readOnly()
    const view = snapshot(read(store, NOW), NOW)
    expect(view.projects.map((p: Item) => p.id)).toEqual(['PRJ-2025-042', 'PRJ-2026-008', 'PRJ-2025-019'])
    expect(view.interventions[0]).toMatchObject({ id: 'HI-002', state: 'EXPIRED' })
    expect(read(store, NOW).revision).toBe(1)
    expect(artifactBody(store, 'DOC-042-SRS', NOW)).toMatchObject({ source: 'seed', truncated: false })
    expect(store.rows.size).toBe(0)
  })

  it('reads a schema 1 store as the seed and replaces it on the first write', () => {
    const store = memoryStore()
    store.set('devboard/meta', { schema: 1, revision: 9 })
    store.set('devboard/requirements', [{ id: 'REQ-001' }])
    expect(read(store, NOW)).toMatchObject({ schema: 2, revision: 1 })
    update(store, (s) => create(s, { kind: 'requirement', title: '新需求' }, NOW), NOW)
    expect(store.rows.has('devboard/requirements')).toBe(false)
    expect(read(store, NOW).requirements).toHaveLength(7)
  })

  it('persists the seed in chunks under the value cap, writes through one path and resets', () => {
    const store = memoryStore()
    expect(read(store, NOW).revision).toBe(1)
    const { revision, result } = update(
      store,
      (s) => create(s, { kind: 'requirement', title: '新需求', by: '研发协调员' }, NOW),
      NOW,
    )
    expect(revision).toBe(2)
    expect(result).toMatchObject({ id: 'REQ-007', state: 'RAW' })
    expect(read(store, NOW).reqs).toHaveLength(seed(NOW).reqs.length)
    expect(read(store, NOW).requirements).toHaveLength(7)
    expect(() =>
      create(read(store, NOW), { kind: 'task', requirementId: 'REQ-404', title: 'x', type: 'TESTING' }),
    ).toThrow('未找到 REQ-404')
    expect(reset(store, NOW).revision).toBe(3)
    const fresh = read(store, NOW)
    expect(fresh.requirements).toHaveLength(6)
    expect(fresh.revision).toBe(3)
  })

  it('caches a live document body, truncates it by bytes and serves it as the artifact body', () => {
    const store = memoryStore()
    const big = `# 需求规格\n${'需'.repeat(DOC_LIMIT_BYTES)}`
    const { result } = update(store, (s) => {
      const p = create(s, { kind: 'project', name: '车门健康监测看板' }, NOW)
      return recordArtifact(
        s,
        { projectId: p.id, stage: 'REQUIREMENTS', kind: 'SRS', path: 'docs/SRS.md', markdown: big },
        NOW,
      )
    })
    const body = artifactBody(store, result.id, NOW)
    expect(body).toMatchObject({
      source: 'workspace',
      truncated: true,
      path: 'devboard-projects/PRJ-2026-009/docs/SRS.md',
    })
    expect(new TextEncoder().encode(body.markdown).length).toBeLessThanOrEqual(DOC_LIMIT_BYTES)
    expect(body.markdown.startsWith('# 需求规格')).toBe(true)
    expect(() => artifactBody(store, 'DOC-404', NOW)).toThrow('未找到 DOC-404')
    reset(store, NOW)
    expect([...store.rows.keys()].some((k) => k.startsWith('devboard/doc/'))).toBe(false)
  })
})
