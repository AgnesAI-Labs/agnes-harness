import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  checkServiceDef,
  checkToolDef,
  type ServiceDef,
  type ToolDef,
} from '../../../../packages/extension-api/src/index.js'
import {
  createPackageManager,
  emptyLock,
  parsePackageBundleContract,
  parseSource,
  writeLock,
} from '../../../../packages/package-manager/src/index.js'
import { ENTRIES, handbackWork, workOf } from '../client/entries.js'
import { create, read, seed, update, upsertReqs } from '../domain.mjs'
import { FILES, GATES } from '../fastforward.mjs'
import { HANDOFF_TYPES } from '../handoff.mjs'
import { main } from '../index.mjs'
import { buildSeed } from '../seed-data.mjs'

// The plugin imports the host-provided runtime; tests resolve it from source.
vi.mock('@agnes/plugin-runtime', () => import('../../../../packages/plugin-runtime/src/author.js'))
vi.mock(
  '@sinclair/typebox',
  () => import('../../../../packages/plugin-runtime/node_modules/@sinclair/typebox/build/esm/index.mjs'),
)

// biome-ignore lint/suspicious/noExplicitAny: plugin entry and store are untyped JavaScript
type Any = any

function memoryStore(readOnly = false) {
  const rows = new Map<string, unknown>()
  const deny = () => {
    throw new Error('CAPABILITY_DENIED')
  }
  return {
    rows,
    get: (key: string) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    set: readOnly ? deny : (key: string, value: unknown) => void rows.set(key, structuredClone(value)),
    delete: readOnly ? deny : (key: string) => void rows.delete(key),
    transaction: <T>(work: () => T) => work(),
  }
}

const tools: ToolDef[] = []
const services: ServiceDef[] = []
const skills: { name: string }[] = []
;(main as Any).apply({
  tools: { register: (d: ToolDef) => tools.push(d) },
  services: { register: (d: ServiceDef) => services.push(d) },
  skills: { register: (d: { name: string }) => skills.push(d) },
})
const tool = (name: string) => tools.find((t) => t.name === name) as Any
const service = (name: string) => services.find((s) => s.name === name) as Any
const signal = new AbortController().signal

/** Start a flow through devboard.approval and approve every node with the roles of its node. */
async function runFlow(ctx: Any, template: string, subjectId: string, running?: string) {
  const approval = (input: Any) => service('devboard.approval').handler(input, ctx)
  let id = running
  if (!id) {
    const started = await approval({ action: 'SUBMIT', template, subjectId, by: '客户代表 方卫东' })
    expect(started, template).toMatchObject({ ok: true })
    id = started.result.id
  }
  for (let guard = 0; guard < 12; guard++) {
    const flow = read(ctx.store).approvals.find((a: Any) => a.id === id)
    if (flow.state !== 'RUNNING') return flow
    const node = flow.nodes[flow.current]
    for (const role of node.mode === 'ALL'
      ? node.roles.filter((r: string) => !node.signed.includes(r))
      : [node.roles[0]])
      expect(await approval({ action: 'APPROVE', id, by: role }), `${template} ${node.id}`).toMatchObject({
        ok: true,
      })
  }
  throw new Error(`${template} did not finish`)
}

describe('DevBoard plugin contract', () => {
  it('registers well-formed tools, services and the playbook skill', () => {
    expect(tools).toHaveLength(21)
    expect(services.map((s) => s.name).sort()).toEqual([
      'devboard.approval',
      'devboard.artifact',
      'devboard.create',
      'devboard.gate',
      'devboard.handback',
      'devboard.handoff',
      'devboard.reset',
      'devboard.snapshot',
      'devboard.transition',
    ])
    for (const t of tools) {
      expect(checkToolDef(t, { prefix: 'devboard_' }), t.name).toMatchObject({ ok: true })
      expect(t.meta.presentation?.title, t.name).toMatch(/[\u4e00-\u9fff]/u)
    }
    for (const s of services) expect(checkServiceDef(s), s.name).toMatchObject({ ok: true })
    expect(skills.map((s) => s.name)).toEqual(['devboard-playbook'])
  })

  it('serves a seed document from a read-only store without writing', async () => {
    const store = memoryStore(true)
    const snap = await service('devboard.snapshot').handler({}, { store })
    expect(snap.projects).toHaveLength(buildSeed(Date.now()).projects.length)
    expect(snap.profiles.SOFTWARE.IMPLEMENTATION.gates[0]).toMatchObject({ code: 'TR4', auto: true })
    const body = await service('devboard.artifact').handler({ artifactId: 'DOC-042-SRS' }, { store })
    expect(body).toMatchObject({ source: 'seed', truncated: false })
    expect(body.markdown).toContain('SWR-')
    expect(await service('devboard.artifact').handler({ artifactId: 'DOC-404' }, { store })).toMatchObject({
      ok: false,
    })
    const prepared = await service('devboard.gate').prepare({}, { store })
    expect(prepared.resourceRevision).toBe('1')
  })

  it('refuses an illegal gate decision as an answer, not a failure, and writes through update only', async () => {
    const store = memoryStore()
    const gate = read(store).gates.find(
      (g: Any) => g.decision === 'PENDING' && g.findings.some((f: Any) => !f.closed),
    )
    const ctx = { store, signal }
    const refused = await service('devboard.gate').handler(
      { gateId: gate.id, decision: 'APPROVED', by: '任意审批人' },
      ctx,
    )
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('评审门不满足')
    expect(await service('devboard.reset').handler({}, ctx)).toMatchObject({ ok: true })
  })

  it('creates a record-only order project and a live software project through devboard.create', async () => {
    const store = memoryStore()
    const ctx = { store, signal }
    const order = await service('devboard.create').handler(
      { kind: 'project', by: '项目经理', name: '订单项目', projectKind: 'RETROFIT', org: '站台门分技术中心' },
      ctx,
    )
    expect(order.ok).toBe(true)
    expect(order.result).toMatchObject({ kind: 'RETROFIT', org: '站台门分技术中心' })
    expect(order.result.live).toBeUndefined()
    const sw = await service('devboard.create').handler(
      { kind: 'project', by: '项目经理', name: '软件' },
      ctx,
    )
    expect(sw.result).toMatchObject({
      kind: 'SOFTWARE',
      live: true,
      tailoring: { skipped: ['TR2', 'TR6', 'PDCP'] },
    })
    const bad = await service('devboard.create').handler(
      { kind: 'project', by: 'x', name: 'y', projectKind: 'NOPE' },
      ctx,
    )
    expect(bad).toMatchObject({ ok: false })
  })

  it('co-signs a gate through devboard.gate and moves trials, faults, problems and retrofit through devboard.transition', async () => {
    const store = memoryStore()
    const ctx = { store, signal }
    const { result: p } = update(store, (s: Any) => {
      const project = create(s, { kind: 'project', name: '订单', projectKind: 'NEW_BUILD', by: 'x' })
      project.service = { phase: '质保期' }
      s.items.push({ id: 'NC-BUF-01', projectId: project.id, name: '缓冲头', discipline: 'MECH', lru: true })
      s.faults.push({
        id: 'FA-T1',
        projectId: project.id,
        source: 'PHM',
        signal: 'SLIDE',
        train: '1',
        detectedAt: new Date().toISOString(),
        state: 'NEW',
        history: [],
      })
      return project
    })
    const transition = (input: Any) =>
      service('devboard.transition').handler({ by: '客服工程师', ...input }, ctx)
    expect(await transition({ kind: 'fault', id: 'FA-T1', to: 'DISPATCHED' })).toMatchObject({ ok: true })
    expect(await transition({ kind: 'fault', id: 'FA-T1', to: 'CLOSED' })).toMatchObject({ ok: false })

    const trial = await tool('devboard_trial_upsert').execute(
      {
        projectId: p.id,
        type: 'TYPE_TEST',
        title: '低温夹紧力',
        standard: 's',
        sample: 'SN-1',
        lab: 'x',
        plannedAt: '2026-11-02',
      },
      ctx as Any,
    )
    const tid = trial.structured.data.id
    expect(await transition({ kind: 'trial', id: tid, to: 'IN_PROGRESS' })).toMatchObject({ ok: true })
    const reported = await transition({
      kind: 'trial',
      id: tid,
      to: 'REPORTED',
      reportNo: 'R-1',
      result: 'PASS',
    })
    expect(reported.result).toMatchObject({ state: 'REPORTED', reportNo: 'R-1', result: 'PASS' })

    const problem = await tool('devboard_problem_upsert').execute(
      {
        projectId: p.id,
        title: '滑道异常',
        faultIds: ['FA-T1'],
        steps: { D4: { done: true } },
        rootCause: '导轨磨损',
      },
      ctx as Any,
    )
    const qid = problem.structured.data.id
    expect(await transition({ kind: 'problem', id: qid, to: 'ANALYZING' })).toMatchObject({ ok: true })
    expect(await transition({ kind: 'problem', id: qid, to: 'ACTION' })).toMatchObject({ ok: true })

    const change = await tool('devboard_change_upsert').execute(
      {
        projectId: p.id,
        title: '导轨 B → C',
        reason: '滑道异常',
        source: { type: 'FIELD', ref: qid },
        rootCause: '导轨磨损',
        impact: { items: [{ itemId: 'NC-BUF-01', fromRev: 'B', toRev: 'C' }], fleet: { doors: 10 } },
      },
      ctx as Any,
    )
    const cid = change.structured.data.id
    for (const to of ['ANALYZED', 'CCB_REVIEW'])
      expect(await transition({ kind: 'change', id: cid, to, by: 'CCB' })).toMatchObject({ ok: true })
    // CCB approval is the ECR flow's move; the as-designed baseline comes with the ECN release
    expect(await transition({ kind: 'change', id: cid, to: 'APPROVED', by: 'CCB' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('需走 ECR 审批'),
    })
    await runFlow(ctx, 'ECR', cid)
    await runFlow(ctx, 'ECN_RELEASE', cid)
    expect(await transition({ kind: 'retrofit', id: cid, done: 4 })).toMatchObject({ ok: true })
    expect(await transition({ kind: 'retrofit', id: cid, done: 4 })).toMatchObject({ ok: false })
    expect(await transition({ kind: 'retrofit', id: cid, done: 10 })).toMatchObject({ ok: true })
    const state = read(store)
    expect(state.configBaselines.filter((b: Any) => b.projectId === p.id).map((b: Any) => b.type)).toEqual([
      'AS_DESIGNED',
      'AS_MAINTAINED',
    ])
    expect(state.changes.find((c: Any) => c.id === cid)).toMatchObject({
      state: 'APPROVED',
      ecn: expect.any(String),
    })
    expect((await service('devboard.snapshot').handler({ projectId: p.id }, { store })).trials[0].id).toBe(
      tid,
    )
  })

  it('keeps people in charge of decisions the agent only drafts', async () => {
    const store = memoryStore()
    const ctx = { store, signal } as Any
    const { result: p } = update(store, (s: Any) =>
      create(s, { kind: 'project', name: '订单', projectKind: 'NEW_BUILD' }),
    )
    const base = {
      projectId: p.id,
      type: 'TYPE_TEST',
      title: 't',
      standard: 's',
      sample: 'x',
      lab: 'l',
      plannedAt: '2026-11-02',
    }
    const trial = (await tool('devboard_trial_upsert').execute(base, ctx)).structured.data
    const approve = await tool('devboard_trial_upsert').execute({ id: trial.id, to: 'APPROVED' }, ctx)
    expect(approve.isError).toBe(true)
    const problem = (await tool('devboard_problem_upsert').execute({ projectId: p.id, title: 'x' }, ctx))
      .structured.data
    const close = await tool('devboard_problem_upsert').execute({ id: problem.id, to: 'CLOSED' }, ctx)
    expect(close.isError).toBe(true)
    expect(read(store).problems.find((q: Any) => q.id === problem.id).state).toBe('OPEN')
  })

  it('handles approvals through devboard.approval and lets the agent only start flows of its own drafts', async () => {
    const store = memoryStore()
    const ctx = { store, signal } as Any
    const approval = (input: Any) => service('devboard.approval').handler(input, ctx)
    const prepared = await service('devboard.approval').prepare(
      { action: 'SUBMIT' },
      { store: memoryStore(true) },
    )
    expect(prepared.resourceRevision).toBe('1')
    // seeded: CR-2026-031's ECR is running at the co-sign node, quality overdue
    const running = read(store).approvals.find((a: Any) => a.subject.id === 'CR-2026-031')
    expect(running).toMatchObject({ state: 'RUNNING', template: 'ECR' })
    expect(await approval({ action: 'APPROVE', id: running.id, by: '技术负责人' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('审批不满足：当前节点「专业会签」需由'),
    })
    expect(await approval({ action: 'APPROVE', id: running.id, by: '机械设计师' })).toMatchObject({
      ok: false,
    })
    expect(
      await approval({ action: 'TRANSFER', id: running.id, by: '软件设计师', to: '邓超' }),
    ).toMatchObject({
      ok: true,
    })
    expect(
      await approval({ action: 'SUBMIT', template: 'ECR', subjectId: 'CR-2026-031', by: '客户代表' }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('已有进行中的审批'),
    })
    const finished = await runFlow(ctx, 'ECR', 'CR-2026-031', running.id)
    expect(finished.state).toBe('APPROVED')
    expect(
      await approval({ action: 'COMMENT', id: running.id, by: '质量工程师', comment: 'x' }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('已批准，不能再'),
    })

    // the tool starts flows for objects the agent drafted and nothing else
    const submit = tool('devboard_approval_submit')
    expect(tool('devboard_approval_submit').parameters.properties).not.toHaveProperty('action')
    const other = await submit.execute({ template: 'ECN_RELEASE', subjectId: 'CR-2026-012' }, ctx)
    expect(other.isError).toBe(true)
    const { result: p } = update(store, (s: Any) =>
      create(s, { kind: 'project', name: '订单', projectKind: 'NEW_BUILD' }),
    )
    const drafted = (
      await tool('devboard_change_upsert').execute(
        { projectId: p.id, title: '改', reason: 'r', impact: { reqs: ['CUS-001'] } },
        ctx,
      )
    ).structured.data
    for (const to of ['ANALYZED', 'CCB_REVIEW'])
      await tool('devboard_change_upsert').execute({ id: drafted.id, to }, ctx)
    const started = await submit.execute({ template: 'ECR', subjectId: drafted.id }, ctx)
    expect(started.isError).toBeUndefined()
    expect(started.structured.data).toMatchObject({ state: 'RUNNING', initiator: { by: '研发协调员' } })
    const direct = await tool('devboard_change_upsert').execute({ id: drafted.id, to: 'APPROVED' }, ctx)
    expect(direct.isError).toBe(true)
  })

  it('aggregates faults by signal and time window and writes nothing', async () => {
    const store = memoryStore()
    const day = 24 * 3_600_000
    const { result: p } = update(store, (s: Any) => {
      const project = create(s, { kind: 'project', name: '订单', projectKind: 'NEW_BUILD' })
      for (const [i, [signal, age]] of [
        ['SLIDE', 1],
        ['SLIDE', 3],
        ['COMM', 40],
      ].entries())
        s.faults.push({
          id: `FA-${i}`,
          projectId: project.id,
          source: 'PHM',
          signal,
          train: '1',
          detectedAt: new Date(Date.now() - Number(age) * day).toISOString(),
          state: 'NEW',
          history: [],
        })
      return project
    })
    const before = read(store).revision
    const out = await tool('devboard_fault_list').execute({ projectId: p.id, days: 30 }, {
      store,
      signal,
    } as Any)
    expect(out.structured.data).toMatchObject({ total: 2, bySignal: { SLIDE: 2 } })
    expect(read(store).revision).toBe(before)
    const wide = await tool('devboard_fault_list').execute({ projectId: p.id, days: 90 }, {
      store,
      signal,
    } as Any)
    expect(wide.structured.data.bySignal).toEqual({ SLIDE: 2, COMM: 1 })
  })

  it('registers each deliverable of one kind under its suffix and each sub-system requirement prefix', async () => {
    const store = memoryStore()
    const { result: p } = update(store, (s: Any) => create(s, { kind: 'project', name: '软件' }))
    const files = new Map([
      [`${p.workspaceDir}/docs/a.md`, '# a'],
      [`${p.workspaceDir}/docs/b.md`, '# b'],
    ])
    const fs = {
      read: async (path: string) =>
        new TextEncoder().encode(files.get(path) ?? (Promise.reject(new Error('ENOENT')) as Any)),
    }
    const ctx = { store, signal, fs } as Any
    const base = { projectId: p.id, stage: 'VERIFICATION', kind: 'TYPE_TEST_REPORT' }
    const a = await tool('devboard_artifact_record').execute(
      { ...base, suffix: '07', path: 'docs/a.md' },
      ctx,
    )
    const b = await tool('devboard_artifact_record').execute(
      { ...base, suffix: '08', path: 'docs/b.md' },
      ctx,
    )
    expect(
      [a.structured.data.id, b.structured.data.id].map((id: string) => id.replace(/^DOC-\d+-/, '')),
    ).toEqual(['TYPE-TEST-REPORT-07', 'TYPE-TEST-REPORT-08'])
    const reqs = await tool('devboard_req_upsert').execute(
      {
        projectId: p.id,
        items: [
          { id: 'CUS-001', title: 'c', text: 'c', clause: 'TA §1', compliance: 'COMPLY' },
          { id: 'SYS-001', title: 's', text: 's', parent: ['CUS-001'] },
          { id: 'MER-001', title: 'm', text: 'm', parent: ['SYS-001'] },
        ],
      },
      ctx,
    )
    expect(reqs.isError).toBeFalsy()
    expect(read(store).reqs.find((r: Any) => r.id === 'MER-001')).toMatchObject({
      level: 'SWR',
      discipline: 'MECH',
    })
    expect(upsertReqs).toBeTypeOf('function')
  })

  it('reads a live document in the tool, keeps it inside the project directory and previews it', async () => {
    const store = memoryStore()
    const created = await tool('devboard_project_create').execute({ name: '车门健康监测看板' }, {
      store,
      signal,
    } as Any)
    const project = created.structured.data
    const files = new Map([[`${project.workspaceDir}/docs/PROJECT-PLAN.md`, '# 项目计划\n\n范围与里程碑']])
    const fs = {
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return new TextEncoder().encode(text)
      },
    }
    const ctx = { store, signal, fs } as Any
    const base = { projectId: project.id, stage: 'INITIATION', kind: 'PLAN' }
    const recorded = await tool('devboard_artifact_record').execute(
      { ...base, path: 'docs/PROJECT-PLAN.md' },
      ctx,
    )
    expect(recorded.isError).toBeFalsy()
    const preview = await service('devboard.artifact').handler(
      { artifactId: recorded.structured.data.id },
      { store },
    )
    expect(preview).toMatchObject({ source: 'workspace', markdown: '# 项目计划\n\n范围与里程碑' })
    for (const path of ['../PRJ-2025-042/x.md', '/etc/passwd', 'docs/../../x.md', 'docs/missing.md'])
      expect((await tool('devboard_artifact_record').execute({ ...base, path }, ctx)).isError, path).toBe(
        true,
      )
    expect(update(store, (s: Any) => s.artifacts.length).result).toBe(seed(Date.now()).artifacts.length + 1)
  })

  it('labels a tool write with its acting role, logs it in the feed and refuses other roles', async () => {
    const store = memoryStore()
    const ctx = { store, signal } as Any
    const writers = tools.filter((t) => !t.meta.isReadOnly && t.name !== 'devboard_fastforward')
    expect(writers.length).toBeGreaterThan(10)
    for (const t of writers)
      expect(JSON.parse(JSON.stringify(t.parameters)).properties.actingRole, t.name).toBeDefined()
    for (const t of tools.filter((x) => x.meta.isReadOnly || x.name === 'devboard_fastforward'))
      expect(JSON.parse(JSON.stringify(t.parameters)).properties.actingRole, t.name).toBeUndefined()
    const created = await tool('devboard_create_requirement').execute(
      { title: '预警排行', actingRole: 'requirements' },
      ctx,
    )
    expect(created.isError).toBeFalsy()
    const req = created.structured.data
    expect(req.history[0].by).toBe('研发协调员 · 系统设计师（需求）')
    expect(req.actingRole).toBeUndefined()
    for (const actingRole of ['admin', '开发', '研发协调员'])
      expect(
        (await tool('devboard_create_requirement').execute({ title: 'x', actingRole }, ctx)).isError,
      ).toBe(true)
    const [line] = read(store).activity
    expect(line).toMatchObject({
      actor: '研发协调员 · 系统设计师（需求）',
      tool: 'devboard_create_requirement',
      entity: { kind: 'requirement', id: req.id },
      summary: `录入需求 ${req.id}`,
    })
    expect(read(store).activity).toHaveLength(1)
    // the portfolio and project reads the model gets do not carry the feed
    const board = await tool('devboard_board').execute({}, ctx)
    expect(board.structured.data.activity).toBeUndefined()
    const view = await service('devboard.snapshot').handler({}, { store })
    expect(view.activity).toHaveLength(1)
  })

  it('reads a hand-off through the tool and the query service and refuses a bad object', async () => {
    const store = memoryStore(true)
    const gate = read(store).gates.find((g: Any) => g.decision === 'PENDING')
    const def = tool('devboard_handoff')
    expect(def.meta.isReadOnly).toBe(true)
    expect(Object.keys(JSON.parse(JSON.stringify(def.parameters)).properties)).toEqual(['type', 'id'])
    const out = await def.execute({ type: 'gate', id: gate.id }, { store, signal } as Any)
    expect(out.isError).toBeFalsy()
    expect(out.structured.data).toMatchObject({ type: 'gate', id: gate.id })
    const viaService = await service('devboard.handoff').handler({ type: 'gate', id: gate.id }, { store })
    expect(viaService.summary).toBe(out.structured.data.summary)
    for (const input of [
      { type: 'task', id: 'TASK-001' },
      { type: 'gate', id: 'GATE-404' },
      { type: 'gate' },
    ])
      expect((await def.execute(input, { store, signal } as Any)).isError, JSON.stringify(input)).toBe(true)
    expect(
      await service('devboard.handoff').handler({ type: 'gate', id: 'GATE-404' }, { store }),
    ).toMatchObject({
      ok: false,
    })
  })

  it('registers the customer change a presenter typed and hands that very change over', async () => {
    const store = memoryStore()
    const ctx = { store, signal } as Any
    const project = (
      await service('devboard.create').handler({ kind: 'project', by: '项目经理', name: '车门' }, ctx)
    ).result
    const typed = {
      kind: 'change',
      by: '项目经理',
      projectId: project.id,
      title: '预警排行默认条数改为 20',
      reason: '客户：现场每次都要手动改条数',
      source: { type: 'CUSTOMER', ref: 'TA §3.2' },
    }
    const made = await service('devboard.create').handler(typed, ctx)
    expect(made).toMatchObject({ ok: true, result: { state: 'SUBMITTED', title: typed.title } })
    const out = await service('devboard.handoff').handler({ type: 'change', id: made.result.id }, { store })
    expect(out.change).toMatchObject({ title: typed.title, source: { type: 'CUSTOMER', ref: 'TA §3.2' } })
    expect(out.summary).toContain('TA §3.2')
    // a form with no reason is refused by the board, not sent on
    expect(await service('devboard.create').handler({ ...typed, reason: '' }, ctx)).toMatchObject({
      ok: false,
    })
  })

  it('tells the coordinator to read the hand-off first in every action that carries an object', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const actions = pkg.agnes.application.workbench.actions
    const handed = [
      'continue',
      'customer-change',
      'run-app',
      'change',
      'progress',
      'interventions',
      'phm-8d',
      'trial-change',
    ]
    for (const id of handed)
      for (const lang of ['en', 'zh-CN'])
        expect(actions.find((a: Any) => a.id === id).prompt[lang], `${id} ${lang}`).toContain(
          'devboard_handoff',
        )
    for (const id of ['new-project', 'fast-forward'])
      expect(actions.find((a: Any) => a.id === id).prompt['zh-CN']).not.toContain('devboard_handoff')
    expect(pkg.files).toContain('handoff.mjs')
    expect(pkg.scripts.build).toContain('handoff.mjs')
  })

  it('ships and checks every module the server code imports', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const modules = pkg.files.filter((f: string) => f.endsWith('.mjs'))
    const imported = new Set(
      modules.flatMap((f: string) =>
        [
          ...readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').matchAll(/from '\.\/([\w-]+\.mjs)'/g),
        ].map((m) => m[1]),
      ),
    )
    for (const file of imported) {
      expect(pkg.files, file).toContain(file)
      expect(pkg.scripts.build, file).toContain(`node --check ${file}`)
    }
  })

  it.each(Object.entries(ENTRIES))(
    'opens the %s button with a declared action and a hand-off type',
    (_name, entry) => {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      const action = pkg.agnes.application.workbench.actions.find((a: Any) => a.id === entry.action)
      expect(action, entry.action).toBeDefined()
      expect(HANDOFF_TYPES).toContain(entry.type)
      // the platform accepts a work object like this one
      expect({ type: entry.type, id: 'X-1' }.type).toMatch(/^[A-Za-z][A-Za-z0-9.-]{0,63}$/)
      expect(entry.label).toMatch(/[\u4e00-\u9fff]/u)
    },
  )

  it.each([
    [
      'faultEightD',
      { id: 'FA-1', state: 'NEW' },
      { action: 'phm-8d', object: { type: 'fault', id: 'FA-1' } },
    ],
    ['faultEightD', { id: 'FA-1', state: 'CLOSED' }, undefined],
    [
      'problemEightD',
      { id: 'QP-1', state: 'OPEN' },
      { action: 'phm-8d', object: { type: 'problem', id: 'QP-1' } },
    ],
    ['problemEightD', { id: 'QP-1', state: 'CLOSED' }, undefined],
    [
      'trialChange',
      { id: 'TT-1', state: 'REPORTED' },
      { action: 'trial-change', object: { type: 'trial', id: 'TT-1' } },
    ],
    [
      'changeImpact',
      { id: 'CR-1', state: 'SUBMITTED' },
      { action: 'change', object: { type: 'change', id: 'CR-1' } },
    ],
    [
      'changeImpact',
      { id: 'CR-1', state: 'ANALYZED' },
      { action: 'change', object: { type: 'change', id: 'CR-1' } },
    ],
    ['changeImpact', { id: 'CR-1', state: 'CCB_REVIEW' }, undefined],
    [
      'interventionContinue',
      { id: 'HI-1', state: 'RESOLVED' },
      { action: 'interventions', object: { type: 'intervention', id: 'HI-1' } },
    ],
    ['interventionContinue', { id: 'HI-1', state: 'OPEN' }, undefined],
    ['projectProgress', { id: 'PRJ-1' }, { action: 'progress', object: { type: 'project', id: 'PRJ-1' } }],
    ['customerChange', { id: 'CR-9' }, { action: 'customer-change', object: { type: 'change', id: 'CR-9' } }],
    [
      'continueGate',
      { id: 'G-1', decision: 'APPROVED' },
      { action: 'continue', object: { type: 'gate', id: 'G-1' } },
    ],
    ['continueGate', { id: 'G-1', decision: 'PENDING' }, undefined],
    ['runApp', { id: 'PRJ-1' }, { action: 'run-app', object: { type: 'project', id: 'PRJ-1' } }],
  ])('offers %s for %j as %j', (name, item, expected) => {
    const got = workOf(name, item)
    if (expected) expect(got).toMatchObject(expected)
    else expect(got).toBeUndefined()
  })

  it('records per-case results through the tool, refuses disagreeing counts and keeps the old form', async () => {
    const store = memoryStore()
    const ctx = { store, signal } as Any
    const project = (await tool('devboard_project_create').execute({ name: '车门' }, ctx)).structured.data
    const items = [
      { id: 'CUS-001', title: 'c', text: 'c' },
      { id: 'SYS-001', title: 's', text: 's', parent: ['CUS-001'] },
      { id: 'SWR-001', title: 'w', text: 'w', parent: ['SYS-001'] },
      { id: 'TC-001', title: 't', text: 't', parent: ['SWR-001'] },
    ]
    await tool('devboard_req_upsert').execute({ projectId: project.id, items }, ctx)
    const record = (input: Any) =>
      tool('devboard_test_record').execute({ projectId: project.id, level: 'UNIT', ...input }, ctx)
    const schema = JSON.parse(JSON.stringify(tool('devboard_test_record').parameters))
    expect(schema.required).toEqual(['projectId', 'level'])
    expect(schema.properties.results.maxItems).toBe(500)
    expect((await record({})).isError).toBe(true)
    expect((await record({ total: 2, passed: 1, failed: 0 })).isError).toBe(true)
    expect((await record({ results: [{ tc: 'TC-001', status: 'pass' }], total: 5 })).isError).toBe(true)
    expect((await record({ results: [{ tc: 'TC-9', status: 'pass' }] })).isError).toBe(true)
    expect(read(store).testRuns.filter((t: Any) => t.projectId === project.id)).toEqual([])
    const ok = await record({ results: [{ tc: 'TC-001', status: 'pass' }], total: 1, actingRole: 'tester' })
    expect(ok.structured.data).toMatchObject({ total: 1, passed: 1, effects: { verifiedSwrs: ['SWR-001'] } })
    const state = read(store)
    expect(state.reqs.find((r: Any) => r.id === 'SWR-001' && r.projectId === project.id).status).toBe(
      'VERIFIED',
    )
    expect(state.activity.at(-1)).toMatchObject({
      actor: '研发协调员 · 验证工程师',
      entity: { kind: 'testRun' },
    })
    const old = await record({ total: 18, passed: 17, failed: 1 })
    expect(old.structured.data).toMatchObject({ total: 18, failed: 1 })
    expect(old.structured.data.results).toBeUndefined()
  })

  it('registers code, test and analysis files through the tool and previews them as text', async () => {
    const store = memoryStore()
    const project = (
      await tool('devboard_project_create').execute({ name: '车门' }, { store, signal } as Any)
    ).structured.data
    const cr = (
      await tool('devboard_change_upsert').execute({ projectId: project.id, title: '变更', reason: '原因' }, {
        store,
        signal,
      } as Any)
    ).structured.data
    const dir = project.workspaceDir
    const files = new Map([
      [`${dir}/src/app.js`, 'export const app = "<b>x</b>"'],
      [`${dir}/test/app.test.js`, 'test("x", () => {})'],
      [`${dir}/analysis/${cr.id}/${cr.id}-electrical.md`, '# 电气影响'],
    ])
    const fs = {
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return new TextEncoder().encode(text)
      },
    }
    const ctx = { store, signal, fs } as Any
    const record = (input: Any) =>
      tool('devboard_artifact_record').execute(
        { projectId: project.id, stage: 'IMPLEMENTATION', ...input },
        ctx,
      )
    const kinds = JSON.parse(
      JSON.stringify(tool('devboard_artifact_record').parameters),
    ).properties.kind.anyOf.map((k: Any) => k.const)
    expect(kinds).toEqual(expect.arrayContaining(['CODE', 'TEST', 'ANALYSIS']))
    const code = await record({ kind: 'CODE', suffix: 'app', path: 'src/app.js', actingRole: 'developer' })
    const test = await record({ kind: 'TEST', suffix: 'app', path: 'test/app.test.js' })
    const analysis = await record({
      kind: 'ANALYSIS',
      path: `analysis/${cr.id}/${cr.id}-electrical.md`,
      actingRole: 'electrical',
    })
    for (const out of [code, test, analysis]) expect(out.isError).toBeFalsy()
    expect(
      await service('devboard.artifact').handler({ artifactId: code.structured.data.id }, { store }),
    ).toMatchObject({
      format: 'text',
      markdown: 'export const app = "<b>x</b>"',
    })
    expect(
      await service('devboard.artifact').handler({ artifactId: analysis.structured.data.id }, { store }),
    ).toMatchObject({
      format: 'markdown',
    })
    // other kinds under analysis/, other projects' directories and missing files are refused
    for (const input of [
      { kind: 'CODE', path: `analysis/${cr.id}/${cr.id}-electrical.md` },
      { kind: 'ANALYSIS', path: 'devboard-projects/PRJ-2025-042/analysis/CR-2026-019/a.md' },
      { kind: 'ANALYSIS', path: 'analysis/CR-404/a.md' },
      { kind: 'TEST', path: 'test/missing.test.js' },
    ])
      expect((await record(input)).isError, JSON.stringify(input)).toBe(true)
    expect(read(store).activity.at(-1)).toMatchObject({
      actor: '研发协调员 · 电气设计师',
      entity: { kind: 'artifact' },
    })
  })

  it('closes the loop board → composer → coordinator → board with a scripted coordinator', async () => {
    // The platform cannot be driven here, so the coordinator's turns are scripted: each turn calls the tools
    // exactly as the playbook says, and the page's side is the real query and effect services.
    const store = memoryStore()
    const files = new Map<string, string>()
    const fs = {
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return new TextEncoder().encode(text)
      },
    }
    const ctx = { store, signal, fs } as Any
    const turn = async (name: string, input: Any) => {
      const out = await tool(name).execute(input, ctx)
      expect(out.isError, `${name} ${out.content?.[0]?.text}`).toBeFalsy()
      return out.structured.data
    }
    const page = () => service('devboard.snapshot').handler({}, { store })

    // turn 1 (the new-project action): create, write and record the plan, submit CDCP, stop
    const project = await turn('devboard_project_create', { name: '车门健康监测看板' })
    files.set(`${project.workspaceDir}/docs/PROJECT-PLAN.md`, '# 项目计划')
    await turn('devboard_artifact_record', {
      projectId: project.id,
      stage: 'INITIATION',
      kind: 'PLAN',
      path: 'docs/PROJECT-PLAN.md',
      actingRole: 'requirements',
    })
    const submitted = await turn('devboard_gate_submit', { projectId: project.id, stage: 'INITIATION' })
    expect((await page()).handbacks).toEqual([])

    // the person approves CDCP on the board
    const gateId = submitted.gate.id
    const decided = await service('devboard.gate').handler(
      { gateId, decision: 'APPROVED', by: 'IPMT 周明远', comment: '同意立项' },
      ctx,
    )
    expect(decided).toMatchObject({ ok: true })

    // the board shows the hand-back card; its button opens the composer with the gate attached
    const [card] = (await page()).handbacks
    expect(card).toMatchObject({
      text: 'CDCP 已批准 → 交回研发协调员继续',
      action: 'continue',
      object: { type: 'gate', id: gateId },
    })
    expect(workOf('continueGate', { id: gateId, decision: 'APPROVED' })).toMatchObject({
      action: card.action,
      object: card.object,
    })
    const action = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).agnes.application.workbench.actions.find((a: Any) => a.id === card.action)
    expect(action.prompt['zh-CN']).toContain('devboard_handoff')

    // turn 2: the coordinator reads the hand-off first
    const handoff = await turn('devboard_handoff', card.object)
    expect(handoff).toMatchObject({
      type: 'gate',
      gate: { code: 'CDCP', decision: 'APPROVED', comment: '同意立项' },
      project: { id: project.id },
    })
    expect(handoff.nextStep).toMatchObject({
      stage: 'REQUIREMENTS',
      state: 'NOT_STARTED',
      nextGate: { code: 'TR1' },
    })
    expect(handoff.nextStep.deliverables.join(' ')).toContain('docs/SRS.md')
    // the summary the page shows before sending is the same one
    expect((await service('devboard.handoff').handler(card.object, { store })).summary).toBe(handoff.summary)

    // then the coordinator does what the hand-off says, as the roles it delegated to
    await turn('devboard_stage_update', {
      projectId: project.id,
      stage: 'REQUIREMENTS',
      actingRole: 'requirements',
    })
    await turn('devboard_req_upsert', {
      projectId: project.id,
      actingRole: 'requirements',
      items: [
        { id: 'CUS-001', title: '客户', text: '客户要求' },
        { id: 'SYS-001', title: '系统', text: '系统', parent: ['CUS-001'] },
        { id: 'SWR-001', title: '软需', text: '软需', parent: ['SYS-001'] },
        { id: 'TC-001', title: '用例', text: '用例', parent: ['SWR-001'] },
      ],
    })
    files.set(`${project.workspaceDir}/docs/SRS.md`, '# SRS')
    await turn('devboard_artifact_record', {
      projectId: project.id,
      stage: 'REQUIREMENTS',
      kind: 'SRS',
      path: 'docs/SRS.md',
      actingRole: 'requirements',
    })
    await turn('devboard_test_record', {
      projectId: project.id,
      level: 'UNIT',
      actingRole: 'tester',
      results: [{ tc: 'TC-001', status: 'pass' }],
    })

    // the board now shows the work, by role, and the card is gone
    const after = await page()
    expect(after.handbacks).toEqual([])
    const mine = after.activity.filter((a: Any) => a.projectId === project.id)
    expect(mine.map((a: Any) => a.actor)).toEqual([
      '研发协调员 · 验证工程师',
      '研发协调员 · 系统设计师（需求）',
      '研发协调员 · 系统设计师（需求）',
      '研发协调员 · 系统设计师（需求）',
      '研发协调员',
      '研发协调员 · 系统设计师（需求）',
      '研发协调员',
    ])
    expect(mine[0]).toMatchObject({
      summary: expect.stringContaining('登记测试运行'),
      entity: { kind: 'testRun' },
    })
    expect(after.reqs.find((r: Any) => r.id === 'SWR-001' && r.projectId === project.id).status).toBe(
      'VERIFIED',
    )
    expect(after.stages.find((st: Any) => st.id === `${project.id}/REQUIREMENTS`)).toMatchObject({
      state: 'IN_PROGRESS',
    })
    expect(after.artifacts.filter((a: Any) => a.projectId === project.id).map((a: Any) => a.kind)).toEqual([
      'PLAN',
      'SRS',
    ])
  })

  it('dismisses a hand-back card through the service and opens only a card that names its work', async () => {
    const store = memoryStore()
    const ctx = { store, signal } as Any
    const req = (
      await service('devboard.create').handler({ kind: 'requirement', by: '产品经理', title: '需求' }, ctx)
    ).result
    const hi = (
      await service('devboard.create').handler(
        {
          kind: 'intervention',
          by: '研发协调员',
          type: 'REQUIREMENT_APPROVAL',
          entity: { kind: 'requirement', id: req.id },
          ask: '怎么办',
        },
        ctx,
      )
    ).result
    for (const to of ['CLAIMED', 'RESOLVED'])
      await service('devboard.transition').handler(
        { kind: 'intervention', id: hi.id, to, by: '项目经理', note: '方案二' },
        ctx,
      )
    const [card] = (await service('devboard.snapshot').handler({}, { store })).handbacks
    expect(handbackWork(card)).toMatchObject({
      action: 'interventions',
      object: { type: 'intervention', id: hi.id },
    })
    for (const bad of [
      undefined,
      {},
      { action: 'continue' },
      { action: 'continue', object: { type: 'gate' } },
    ])
      expect(handbackWork(bad as Any)).toBeUndefined()
    expect(await service('devboard.handback').handler({ id: 'HB-404', by: '项目经理' }, ctx)).toMatchObject({
      ok: false,
    })
    expect(await service('devboard.handback').handler({ id: card.id, by: '项目经理' }, ctx)).toMatchObject({
      ok: true,
    })
    expect((await service('devboard.snapshot').handler({}, { store })).handbacks).toEqual([])
  })

  it('registers every tool in the capability names and the coordinator profile, plus the new pages and actions', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const names = tools.map((t) => t.name)
    expect(pkg.version).toMatch(/^3\.\d+\.\d+$/)
    expect(names).toContain('devboard_approval_submit')
    // the page may call only the services its client descriptor lists
    const client = JSON.parse(readFileSync(new URL('../client/agnes.client.json', import.meta.url), 'utf8'))
    expect([...client.client.services].sort()).toEqual(services.map((s) => s.name).sort())
    expect(names).toEqual(
      expect.arrayContaining(['devboard_trial_upsert', 'devboard_problem_upsert', 'devboard_fault_list']),
    )
    expect(pkg.agnes.plugins[0].capabilities.tools.names).toEqual(names)
    const profile = pkg.agnes.bundles.coordinator.profile.tools
    for (const name of names) expect(profile, name).toContain(name)
    const launch = pkg.agnes.bundles.coordinator.launch
    expect(launch.pages).toEqual(expect.arrayContaining(['trials', 'service']))
    expect(pkg.agnes.application.presentation.navigation.entries).toEqual(
      expect.arrayContaining(['@agnes-showcase/devboard#trials', '@agnes-showcase/devboard#service']),
    )
    const titles = pkg.agnes.application.workbench.actions.map((a: Any) => a.title['zh-CN'])
    expect(titles).toEqual(expect.arrayContaining(['分析 PHM 预警并起草 8D', '型式试验不合格 → 起草变更']))
    expect(pkg.files).toContain('profiles.mjs')
  })

  it('adds exactly one capability, the project-directory write, and the fast-forward and hand-off tool names', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const caps = pkg.agnes.plugins[0].capabilities
    expect(caps.filesystem).toEqual({ read: ['devboard-projects/**'], write: ['devboard-projects/**'] })
    expect(Object.keys(caps).sort()).toEqual(['filesystem', 'store', 'tools', 'ui'])
    expect(caps.tools.names.slice(-2)).toEqual(['devboard_fastforward', 'devboard_handoff'])
    const policy = pkg.agnes.bundles.coordinator.profile.toolPolicy.allow
    expect(policy).toContain('devboard_fastforward')
    expect(pkg.files).toEqual(expect.arrayContaining(['fastforward.mjs', 'assets']))
    const action = pkg.agnes.application.workbench.actions.find((a: Any) => a.id === 'fast-forward')
    expect(action.agent).toBe('@agnes-showcase/devboard#coordinator')
    expect(action.prompt['zh-CN']).toContain('devboard_fastforward')
    // One tool call needs no playbook: reading it would cost a model round trip on the quick path.
    for (const lang of ['en', 'zh-CN']) expect(action.prompt[lang]).not.toContain('skill_read')
    const runApp = pkg.agnes.application.workbench.actions.find((a: Any) => a.id === 'run-app')
    expect(runApp.prompt['zh-CN']).toContain('devboard_app_register')
  })

  it('adds traceFrom to the change tool without a new tool name or capability', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const caps = pkg.agnes.plugins[0].capabilities
    expect(caps.tools.names).toHaveLength(21)
    expect(Object.keys(caps).sort()).toEqual(['filesystem', 'store', 'tools', 'ui'])
    const schema = JSON.parse(JSON.stringify(tool('devboard_change_upsert').parameters))
    expect(schema.properties.traceFrom).toMatchObject({ type: 'boolean' })
    expect(schema.required ?? []).not.toContain('traceFrom')
    const action = pkg.agnes.application.workbench.actions.find((a: Any) => a.id === 'customer-change')
    expect(action.agent).toBe('@agnes-showcase/devboard#coordinator')
    for (const lang of ['en', 'zh-CN']) {
      expect(action.prompt[lang]).toContain('traceFrom')
      expect(action.prompt[lang]).toContain('CUSTOMER')
      expect(action.prompt[lang]).toContain('devboard_approval_submit')
    }
  })

  it('takes only the gate enum as input and writes only below the new project directory', async () => {
    const def = tool('devboard_fastforward')
    const schema = JSON.parse(JSON.stringify(def.parameters))
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['gate'] })
    expect(Object.keys(schema.properties)).toEqual(['gate'])
    expect(schema.properties.gate.anyOf.map((v: Any) => v.const)).toEqual(GATES)
    const store = memoryStore()
    const writes: string[] = []
    const fs = {
      stat: async () => {
        throw new Error('ENOENT')
      },
      write: async (path: string, data: string) => {
        expect(data.length).toBeGreaterThan(0)
        writes.push(path)
      },
    }
    const ctx = { store, signal, fs } as Any
    for (const gate of ['../../etc', 'TR2', '', 7])
      expect((await def.execute({ gate }, ctx)).isError, String(gate)).toBe(true)
    expect(writes).toEqual([])
    const done = await def.execute({ gate: 'TR5' }, ctx)
    expect(done.isError).toBeFalsy()
    const { projectId, workspaceDir, gate, decision } = done.structured.data
    // the feed line names the new project, not its gate
    expect(read(store).activity.at(-1)).toMatchObject({
      tool: 'devboard_fastforward',
      entity: { kind: 'project', id: projectId },
      projectId,
      summary: `快进演示项目 ${projectId}`,
    })
    expect({ gate, decision, workspaceDir }).toEqual({
      gate: 'TR5',
      decision: 'PENDING',
      workspaceDir: `devboard-projects/${projectId}`,
    })
    expect(writes).toHaveLength(FILES.filter(([from]) => from <= 3).length)
    for (const path of writes)
      expect(path.startsWith(`${workspaceDir}/`) && !/\.\./.test(path), path).toBe(true)
    // a second call is another project in another directory
    const again = await def.execute({ gate: 'TR5' }, ctx)
    expect(again.structured.data.projectId).not.toBe(projectId)
    expect(writes.filter((p) => p.startsWith(`${workspaceDir}/`))).toHaveLength(
      FILES.filter(([from]) => from <= 3).length,
    )
  })

  it('ships a template directory that matches the manifest and the registered documents', async () => {
    const root = fileURLToPath(new URL('../assets/fastforward/', import.meta.url))
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name],
      )
    expect(walk(root).sort()).toEqual(FILES.map(([, rel]) => rel).sort())
    const store = memoryStore()
    const ctx = {
      store,
      signal,
      fs: {
        stat: async () => {
          throw new Error('ENOENT')
        },
        write: async () => undefined,
      },
    } as Any
    await tool('devboard_fastforward').execute({ gate: 'DONE' }, ctx)
    const reqs = read(store).reqs.filter((r: Any) => r.projectId === read(store).projects.at(-1).id)
    const text = (rel: string) => readFileSync(join(root, rel), 'utf8')
    for (const r of reqs) {
      expect(text('docs/RTM.md'), r.id).toContain(r.id)
      if (r.level !== 'TC' && r.level !== 'DES') expect(text('docs/SRS.md'), r.id).toContain(r.id)
      if (r.level === 'DES') expect(text('docs/SAD.md'), r.id).toContain(r.id)
    }
    expect(reqs.filter((r: Any) => r.level === 'TC')).toHaveLength(8)
  })

  it('is accepted by the package manager inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devboard-inspect-'))
    try {
      const profile = join(root, 'profiles', 'local-dev')
      mkdirSync(profile, { recursive: true })
      cpSync(fileURLToPath(new URL('..', import.meta.url)), join(root, 'devboard'), {
        recursive: true,
        filter: (src) => !/\/(node_modules|test)(\/|$)/.test(src),
      })
      writeLock(profile, {
        ...emptyLock('local-dev', '0.1.0'),
        resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
        seams: Object.fromEntries(
          ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((n) => [
            n,
            { provider: 'local' },
          ]),
        ),
        policySnapshot: {
          capabilityCeiling: ['ui', 'store', 'tools', 'services', 'filesystem'],
          workspacePackages: 'require-project-trust',
        },
      })
      const manager = createPackageManager({
        dataDir: root,
        cwd: root,
        agnesVersion: '0.1.0',
        now: () => '2026-10-21T00:00:00Z',
        references: async () => [],
      })
      const preview = await manager.inspect(profile, parseSource('file:./devboard'))
      const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      expect(preview).toMatchObject({ id: '@agnes-showcase/devboard', version })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['README.md', 'README.zh-CN.md', 'skills/devboard-playbook.md', 'workbench prompts'])(
    'keeps role references in %s delegable',
    (source) => {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      const text =
        source === 'workbench prompts'
          ? JSON.stringify(pkg.agnes.application.workbench.actions.map((action: Any) => action.prompt))
          : readFileSync(new URL(`../${source}`, import.meta.url), 'utf8')
      const roles = Object.keys(pkg.agnes.bundles).filter((id) => id !== 'coordinator')
      const references = new Set([
        ...Array.from(text.matchAll(/@agnes-showcase\/devboard#[a-z][a-z0-9-]*/g), (match) => match[0]),
        ...roles
          .filter((id) => new RegExp(`(?<![a-zA-Z0-9_-])${id}(?![a-zA-Z0-9_-])`).test(text))
          .map((id) => `${pkg.name}#${id}`),
      ])
      expect(references.size).toBeGreaterThan(0)
      expect([...references].filter((ref) => !pkg.agnes.application.delegableAgents.includes(ref))).toEqual(
        [],
      )
    },
  )

  it('resolves declared roles with narrow tools and keeps approved commands in the coordinator', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const { bundles, application } = pkg.agnes
    const contracts = parsePackageBundleContract(pkg.name, bundles)
    const coordinator = bundles.coordinator
    const policy = coordinator.presets.devboard.approval.command_policy
    expect(policy.length).toBeGreaterThan(0)
    expect(policy.every((r: { tool: string }) => r.tool === 'edit|write')).toBe(true)
    expect(coordinator.presets.devboard.subagent.isolation).toBe('shared')
    expect(coordinator.profile.toolPolicy.allow).toEqual(coordinator.profile.tools)
    expect(coordinator.presets.devboard.sandbox).toEqual({
      level: 'L1',
      on_unavailable: 'deny',
      network_allow: [],
      loopback_serve: true,
    })
    expect(coordinator.profile.tools).toEqual(
      expect.arrayContaining([
        ...tools.map((tool) => tool.name),
        'tool_search',
        'tool_describe',
        'subagent_spawn',
        'subagent_collect',
        'subagent_list',
        'shell',
        'job_output',
        'job_list',
        'job_kill',
      ]),
    )
    const READ_ONLY = ['reviewer', 'quality', 'config']
    const titles: Record<string, string> = {
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
    }
    expect(Object.keys(bundles).filter((id) => id !== 'coordinator')).toEqual(Object.keys(titles))
    expect(application.agents).toEqual(
      ['coordinator', ...Object.keys(titles)].map((role) => `${pkg.name}#${role}`),
    )
    expect(application.delegableAgents).toEqual(Object.keys(titles).map((role) => `${pkg.name}#${role}`))
    for (const ref of application.agents) {
      expect(contracts[ref]?.document.launch?.preset).toBe('devboard')
      const role = bundles[ref.split('#')[1]]
      expect(role.presets.devboard.model.system_prompt.personaPrefix).toContain('全过程')
    }
    for (const ref of application.agents.filter((r: string) => !r.endsWith('#coordinator'))) {
      expect(application.agents).toContain(ref)
      const role = bundles[ref.split('#')[1]]
      expect(role.profile.tools).toEqual(role.profile.toolPolicy.allow)
      expect(role.profile.skills).toEqual([])
      const id = ref.split('#')[1]
      const readOnly = READ_ONLY.includes(id)
      expect(role.launch.title['zh-CN']).toBe(titles[id])
      expect(role.presets.devboard.model.system_prompt.personaPrefix).toContain(`宁川装备的${titles[id]}`)
      expect(role.profile.toolPolicy.readOnly).toBe(readOnly ? true : undefined)
      expect(role.profile.tools.every((name: string) => coordinator.profile.tools.includes(name))).toBe(true)
      expect(role.profile.tools).toEqual(
        readOnly ? ['read', 'ls', 'find', 'grep'] : ['read', 'ls', 'find', 'grep', 'write', 'edit'],
      )
    }
  })
})
