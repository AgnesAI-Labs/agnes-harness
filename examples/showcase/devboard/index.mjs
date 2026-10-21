import { readFileSync } from 'node:fs'
import { defineAgnesPlugin, defineTool, readOnlyTool, toolError } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import {
  artifactBody,
  create,
  DomainError,
  decideGate,
  LABELS,
  projectPath,
  read,
  recordArtifact,
  recordTestRun,
  registerApp,
  reset,
  STAGES,
  snapshot,
  submitGate,
  transition,
  update,
  updateImpact,
  upsertReqs,
} from './domain.mjs'

const strict = { additionalProperties: false }
const id = Type.String({ minLength: 1, maxLength: 64 })
const note = Type.Optional(Type.String({ maxLength: 2000 }))
const short = (max = 200) => Type.String({ minLength: 1, maxLength: max })
const literals = (values) => Type.Union(values.map((v) => Type.Literal(v)))
const keys = (map) => literals(Object.keys(map))
const ids = Type.Array(id, { maxItems: 100 })
const json = (value) => JSON.parse(JSON.stringify(value))
const AGENT = '研发协调员'
const READ_LIMIT = 256 * 1024
const skill = readFileSync(new URL('./skills/devboard-playbook.md', import.meta.url), 'utf8')

const write = { ...readOnlyTool, isReadOnly: false, isConcurrencySafe: false, replay: 'never' }
const titles = {
  board: '读取研发看板',
  create_requirement: '录入研发需求',
  create_task: '创建研发任务',
  transition: '更新研发事项状态',
  request_human: '请求人工决策',
  project_create: '创建研发项目',
  stage_update: '更新项目阶段',
  artifact_record: '登记项目交付物',
  req_upsert: '登记需求追溯条目',
  gate_submit: '提交阶段评审',
  gate_status: '读取评审决议',
  test_record: '登记真实测试结果',
  defect_upsert: '登记或更新缺陷',
  change_upsert: '登记或更新变更',
  app_register: '登记本地应用地址',
}
const result = Type.Object({ revision: Type.Integer(), data: Type.Unknown() }, strict)

function tool(name, description, parameters, run, meta = write) {
  return defineTool({
    name,
    description,
    parameters,
    result,
    meta: { ...meta, presentation: { title: titles[name.slice('devboard_'.length)], description } },
    async execute(input, ctx) {
      ctx.signal.throwIfAborted()
      try {
        const output = json(await run(input, ctx))
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structured: output }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
const mutate = (store, work) => {
  const { revision, result } = update(store, work)
  return { revision, data: result }
}
const lean = (r) => ({
  id: r.id,
  level: r.level,
  title: r.title,
  parent: r.parent,
  verifiedBy: r.verifiedBy,
  status: r.status,
})
const gateView = (state, gate) => {
  const stage = state.stages.find((s) => s.id === gate.stageId)
  return { ...gate, stageState: stage?.state, stage: stage?.stage, projectId: stage?.projectId }
}

/** No argument: the portfolio. projectId: that project's lifecycle. id: one entity of any kind. */
function board(input, store) {
  const state = read(store)
  const view = snapshot(state, Date.now(), input.projectId)
  if (input.id) {
    const all = [
      'projects',
      'stages',
      'gates',
      'artifacts',
      'reqs',
      'changes',
      'defects',
      'testRuns',
      'requirements',
      'tasks',
      'interventions',
    ]
    const items = all.flatMap((c) => view[c].filter((x) => x.id === input.id))
    if (!items.length) throw new DomainError(`未找到 ${input.id}`)
    return { revision: view.revision, data: items.length === 1 ? items[0] : items }
  }
  const { machines, labels, roles, ...rest } = view
  if (input.projectId) return { revision: view.revision, data: { ...rest, reqs: rest.reqs.map(lean), roles } }
  return {
    revision: view.revision,
    data: {
      projects: view.projects.map(({ risks, ...p }) => ({
        ...p,
        metrics: { ...p.metrics, defectTrend: undefined },
      })),
      pendingGates: view.gates.filter((g) => g.decision === 'PENDING').map((g) => gateView(state, g)),
      requirements: view.requirements.map(({ history, ...r }) => r),
      tasks: view.tasks.map(({ history, ...t }) => t),
      interventions: view.interventions.map(({ history, ...i }) => i),
      counts: view.counts,
      hint: '传 projectId 查看单个项目的阶段、门、交付物、需求追溯、变更、缺陷与测试；传 id 查看单个实体。',
    },
  }
}

const impact = Type.Optional(
  Type.Object(
    {
      reqs: Type.Optional(ids),
      artifacts: Type.Optional(ids),
      tests: Type.Optional(ids),
      safety: Type.Optional(Type.Boolean()),
      effortDays: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
    },
    strict,
  ),
)

export const tools = [
  tool(
    'devboard_board',
    'Read the DevBoard (fictional demo data). No arguments: project portfolio with metrics, pending review gates and v1 items; projectId: one project lifecycle; id: one entity. 读取看板。',
    Type.Object({ projectId: Type.Optional(id), id: Type.Optional(id) }, strict),
    (input, ctx) => board(input, ctx.store),
    readOnlyTool,
  ),
  tool(
    'devboard_create_requirement',
    'Create a v1 board requirement in RAW. 录入新需求（RAW）。',
    Type.Object(
      {
        title: short(),
        description: Type.Optional(Type.String({ maxLength: 2000 })),
        priority: Type.Optional(keys(LABELS.priority)),
        owner: Type.Optional(Type.String({ maxLength: 64 })),
        projectId: Type.Optional(id),
      },
      strict,
    ),
    (input, ctx) => mutate(ctx.store, (s) => create(s, { ...input, kind: 'requirement', by: AGENT })),
  ),
  tool(
    'devboard_create_task',
    'Create a PENDING task under a v1 requirement. 为需求拆出任务（PENDING）。',
    Type.Object(
      {
        requirementId: id,
        title: short(),
        type: keys(LABELS.taskType),
        owner: Type.Optional(Type.String({ maxLength: 64 })),
        dependsOn: Type.Optional(Type.Array(id, { maxItems: 20 })),
      },
      strict,
    ),
    (input, ctx) => mutate(ctx.store, (s) => create(s, { ...input, kind: 'task', by: AGENT })),
  ),
  tool(
    'devboard_transition',
    'Move a requirement, task, change request or defect to another state; illegal moves are refused. Stages use devboard_stage_update / devboard_gate_submit. Do not claim or resolve human-intervention requests. 推进状态。',
    Type.Object(
      {
        kind: literals(['requirement', 'task', 'change', 'defect']),
        id,
        to: id,
        note,
        members: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 12 })),
      },
      strict,
    ),
    (input, ctx) => mutate(ctx.store, (s) => transition(s, { ...input, by: AGENT })),
  ),
  tool(
    'devboard_request_human',
    'Ask a human to decide; creates an OPEN human-intervention request with a deadline. 发起人工介入请求。',
    Type.Object(
      {
        type: keys(LABELS.interventionType),
        entityKind: literals(['requirement', 'task']),
        entityId: id,
        ask: short(2000),
        dueInHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 720 })),
      },
      strict,
    ),
    (input, ctx) =>
      mutate(ctx.store, (s) =>
        create(s, {
          kind: 'intervention',
          type: input.type,
          entity: { kind: input.entityKind, id: input.entityId },
          ask: input.ask,
          dueInHours: input.dueInHours,
          by: AGENT,
        }),
      ),
  ),
  tool(
    'devboard_project_create',
    'Create a live R&D project; returns its id and workspaceDir (devboard-projects/<id>), where every project file must be written. The initiation stage starts IN_PROGRESS. 新建现场项目。',
    Type.Object(
      {
        name: short(120),
        description: Type.Optional(Type.String({ maxLength: 2000 })),
        customer: Type.Optional(Type.String({ maxLength: 120 })),
        manager: Type.Optional(Type.String({ maxLength: 64 })),
        projectKind: Type.Optional(keys(LABELS.projectKind)),
        productLine: Type.Optional(keys(LABELS.productLine)),
      },
      strict,
    ),
    (input, ctx) => mutate(ctx.store, (s) => create(s, { ...input, kind: 'project', by: AGENT })),
  ),
  tool(
    'devboard_stage_update',
    'Start a stage (NOT_STARTED or REWORK → IN_PROGRESS); the previous stage must have PASSED. Optionally set its writing role. 开始阶段。',
    Type.Object({ projectId: id, stage: literals(STAGES), author: Type.Optional(short(32)), note }, strict),
    (input, ctx) =>
      mutate(ctx.store, (s) =>
        transition(s, {
          kind: 'stage',
          id: `${input.projectId}/${input.stage}`,
          to: 'IN_PROGRESS',
          by: AGENT,
          note: input.note,
          author: input.author,
        }),
      ),
  ),
  tool(
    'devboard_artifact_record',
    'Register or update a deliverable of a live project after writing its file. path is relative to the project directory (e.g. docs/SRS.md) and must stay inside it; the file is read so the board can preview it. 登记交付物。',
    Type.Object(
      {
        projectId: id,
        stage: literals(STAGES),
        kind: keys(LABELS.artifactKind),
        path: short(300),
        title: Type.Optional(short()),
        version: Type.Optional(short(16)),
        authorRole: Type.Optional(short(32)),
      },
      strict,
    ),
    async (input, ctx) => {
      const project = read(ctx.store).projects.find((p) => p.id === input.projectId)
      if (!project) throw new DomainError(`未找到 ${input.projectId}`)
      const path = projectPath(project, input.path)
      let markdown
      try {
        markdown = new TextDecoder().decode(await ctx.fs.read(path, { limit: READ_LIMIT }))
      } catch {
        throw new DomainError(`无法读取 ${path}：请先把文件写到项目目录内再登记`)
      }
      ctx.signal.throwIfAborted()
      return mutate(ctx.store, (s) => recordArtifact(s, { ...input, path, markdown }))
    },
  ),
  tool(
    'devboard_req_upsert',
    'Register or update CUS/SYS/SWR/DES/TC items of a project (ids like CUS-001, SWR-012, TC-020, unique within the project). parent names the items one level up: SYS→CUS, SWR→SYS, DES→SWR, TC→SWR. 登记需求、设计与用例并挂接追溯。',
    Type.Object(
      {
        projectId: id,
        items: Type.Array(
          Type.Object(
            {
              id: short(16),
              title: Type.Optional(short()),
              text: Type.Optional(short(2000)),
              parent: Type.Optional(Type.Array(short(16), { maxItems: 50 })),
              safety: Type.Optional(Type.Boolean()),
              status: Type.Optional(literals(['DRAFT', 'APPROVED', 'CHANGED', 'VERIFIED'])),
            },
            strict,
          ),
          { minItems: 1, maxItems: 100 },
        ),
      },
      strict,
    ),
    (input, ctx) => mutate(ctx.store, (s) => upsertReqs(s, { ...input, by: AGENT })),
  ),
  tool(
    'devboard_gate_submit',
    'Submit a stage for review (IN_PROGRESS → IN_REVIEW, new PENDING gate), or add/close findings on its pending gate. After submitting a human gate, end the turn and ask the user to approve it on the board. The implementation stage passes automatically once all findings are closed. 提交评审。',
    Type.Object(
      {
        projectId: id,
        stage: literals(STAGES),
        note,
        findings: Type.Optional(Type.Array(short(500), { maxItems: 30 })),
        closeFindings: Type.Optional(
          Type.Array(Type.Object({ id: short(8), note: short(500) }, strict), { maxItems: 30 }),
        ),
      },
      strict,
    ),
    (input, ctx) =>
      mutate(ctx.store, (s) =>
        submitGate(s, { ...input, stageId: `${input.projectId}/${input.stage}`, by: AGENT }),
      ),
  ),
  tool(
    'devboard_gate_status',
    'Read review gate decisions, approvers, comments and findings: one gate by gateId, or every gate of a project. 查询评审门。',
    Type.Object({ gateId: Type.Optional(id), projectId: Type.Optional(id) }, strict),
    (input, ctx) => {
      const state = read(ctx.store)
      const gates = state.gates
        .filter(
          (g) =>
            (!input.gateId || g.id === input.gateId) &&
            (!input.projectId || g.stageId.startsWith(`${input.projectId}/`)),
        )
        .map((g) => gateView(state, g))
      if (input.gateId && !gates.length) throw new DomainError(`未找到 ${input.gateId}`)
      return { revision: state.revision, data: input.gateId ? gates[0] : gates }
    },
    readOnlyTool,
  ),
  tool(
    'devboard_test_record',
    'Record a real test run of a project (source live): counts must add up; include a short log summary. Never record results you did not run. 登记测试运行。',
    Type.Object(
      {
        projectId: id,
        level: keys(LABELS.testLevel),
        total: Type.Integer({ minimum: 0, maximum: 100000 }),
        passed: Type.Integer({ minimum: 0, maximum: 100000 }),
        failed: Type.Integer({ minimum: 0, maximum: 100000 }),
        skipped: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
        log: Type.Optional(Type.String({ maxLength: 4000 })),
      },
      strict,
    ),
    (input, ctx) => mutate(ctx.store, (s) => recordTestRun(s, input)),
  ),
  tool(
    'devboard_defect_upsert',
    'Create a defect (omit id) or move one (id + to): NEW → CONFIRMED → FIXING → RETEST → CLOSED, DEFERRED. 登记或流转缺陷。',
    Type.Object(
      {
        id: Type.Optional(id),
        projectId: Type.Optional(id),
        title: Type.Optional(short()),
        severity: Type.Optional(keys(LABELS.severity)),
        foundIn: Type.Optional(literals(STAGES)),
        testCase: Type.Optional(short(16)),
        req: Type.Optional(short(16)),
        owner: Type.Optional(short(64)),
        description: Type.Optional(Type.String({ maxLength: 500 })),
        to: Type.Optional(id),
        note,
      },
      strict,
    ),
    (input, ctx) =>
      mutate(ctx.store, (s) =>
        input.id
          ? transition(s, { kind: 'defect', id: input.id, to: input.to, note: input.note, by: AGENT })
          : create(s, { ...input, kind: 'defect', by: AGENT }),
      ),
  ),
  tool(
    'devboard_change_upsert',
    'Create a change request (omit id), update its impact analysis, and/or move it: SUBMITTED → ANALYZED (needs impact) → CCB_REVIEW → APPROVED/REJECTED → IMPLEMENTED → CLOSED. Leave CCB decisions to people unless told otherwise. 登记或推进变更。',
    Type.Object(
      {
        id: Type.Optional(id),
        projectId: Type.Optional(id),
        title: Type.Optional(short()),
        reason: Type.Optional(short(2000)),
        impact,
        to: Type.Optional(id),
        note,
      },
      strict,
    ),
    (input, ctx) =>
      mutate(ctx.store, (s) => {
        const cr = input.id
          ? input.impact
            ? updateImpact(s, input)
            : s.changes.find((c) => c.id === input.id)
          : create(s, { ...input, kind: 'change', by: AGENT })
        if (!cr) throw new DomainError(`未找到 ${input.id}`)
        return input.to
          ? transition(s, { kind: 'change', id: cr.id, to: input.to, note: input.note, by: AGENT })
          : cr
      }),
  ),
  tool(
    'devboard_app_register',
    'Register the local address where a live project application runs (http://127.0.0.1:<port>/). 登记运行地址。',
    Type.Object({ projectId: id, url: short(200) }, strict),
    (input, ctx) => mutate(ctx.store, (s) => registerApp(s, input)),
  ),
]

const common = {
  scope: 'profile',
  timeoutMs: 5000,
  maxResultBytes: 1048576,
  outputSchema: { type: 'object' },
}
const effectPolicy = {
  isDestructive: false,
  isOpenWorld: false,
  replay: 'never',
  requiresApproval: 'never',
  approvalScopes: [],
}
const by = Type.String({ minLength: 1, maxLength: 64 })
const optionalText = (max) => Type.Optional(Type.String({ maxLength: max }))
const kinds = ['requirement', 'task', 'intervention', 'stage', 'change', 'defect']
const schemas = {
  'devboard.transition': Type.Object(
    {
      kind: literals(kinds),
      id,
      to: id,
      by,
      note,
      members: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 12 })),
    },
    strict,
  ),
  'devboard.create': Type.Object(
    {
      kind: literals(['requirement', 'task', 'intervention', 'project', 'change', 'defect']),
      by,
      projectId: Type.Optional(id),
      name: optionalText(120),
      title: optionalText(200),
      description: optionalText(2000),
      reason: optionalText(2000),
      customer: optionalText(120),
      manager: optionalText(64),
      priority: optionalText(8),
      owner: optionalText(64),
      requirementId: Type.Optional(id),
      type: optionalText(64),
      severity: optionalText(4),
      foundIn: optionalText(32),
      testCase: optionalText(16),
      req: optionalText(16),
      impact,
      dependsOn: Type.Optional(Type.Array(id, { maxItems: 20 })),
      entity: Type.Optional(Type.Object({ kind: Type.String({ maxLength: 16 }), id }, strict)),
      ask: optionalText(2000),
      dueInHours: Type.Optional(Type.Number()),
    },
    strict,
  ),
  'devboard.gate': Type.Object(
    {
      gateId: id,
      decision: literals(['APPROVED', 'REJECTED']),
      by,
      comment: optionalText(2000),
      closeFindings: Type.Optional(
        Type.Array(Type.Object({ id: short(8), note: short(500) }, strict), { maxItems: 30 }),
      ),
    },
    strict,
  ),
  'devboard.reset': Type.Object({}, strict),
}
const handlers = {
  'devboard.transition': (input, store) => update(store, (s) => transition(s, input)),
  'devboard.create': (input, store) => update(store, (s) => create(s, input)),
  'devboard.gate': (input, store) => update(store, (s) => decideGate(s, input)),
  'devboard.reset': (_input, store) => reset(store),
}
const queries = {
  'devboard.snapshot': [
    Type.Object({ projectId: Type.Optional(id) }, strict),
    (input, store) => snapshot(read(store), Date.now(), input.projectId),
  ],
  'devboard.artifact': [
    Type.Object({ artifactId: id }, strict),
    (input, store) => artifactBody(store, input.artifactId),
  ],
}

export const main = defineAgnesPlugin({
  apply(ctx) {
    for (const t of tools) ctx.tools.register(t)
    ctx.skills.register({
      name: 'devboard-playbook',
      description:
        'DevBoard 研发全流程：阶段、评审门、追溯、角色子智能体与文件约定 / DevBoard R&D lifecycle playbook',
      body: skill,
    })
    // Query services and effect preparation get a read-only store: they read, never save.
    for (const [name, [schema, run]] of Object.entries(queries))
      ctx.services.register({
        ...common,
        name,
        kind: 'query',
        inputSchema: json(schema),
        async handler(input, c) {
          try {
            return json(run(input, c.store))
          } catch (error) {
            if (error instanceof DomainError) return { ok: false, error: error.message }
            throw error
          }
        },
      })
    for (const [name, schema] of Object.entries(schemas))
      ctx.services.register({
        ...common,
        name,
        kind: 'effect',
        inputSchema: json(schema),
        effectPolicy,
        async prepare(input, c) {
          const revision = read(c.store).revision
          return {
            input,
            resourceRevision: String(revision),
            presentation: { input, warning: '虚构演示数据', revision },
          }
        },
        async handler(input, c) {
          c.signal.throwIfAborted()
          // A refused move is an expected answer, not a failed operation: the page shows the message.
          try {
            return json({ ok: true, ...handlers[name](input, c.store) })
          } catch (error) {
            if (error instanceof DomainError) return { ok: false, error: error.message }
            throw error
          }
        },
      })
  },
})
