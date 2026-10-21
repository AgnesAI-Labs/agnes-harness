import { defineAgnesPlugin, defineTool, readOnlyTool, toolError } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { create, DomainError, LABELS, read, reset, snapshot, transition, update } from './domain.mjs'

const strict = { additionalProperties: false }
const id = Type.String({ minLength: 1, maxLength: 64 })
const note = Type.Optional(Type.String({ maxLength: 2000 }))
const kind = Type.Union(['requirement', 'task', 'intervention'].map((k) => Type.Literal(k)))
const literals = (values) => Type.Union(Object.keys(values).map((v) => Type.Literal(v)))
const json = (value) => JSON.parse(JSON.stringify(value))
const AGENT = '研发协调员'

const skill = `# DevBoard 工作方式

看板上的数据均为虚构演示数据。每一步先调用 devboard_board 读取最新看板，再决定下一步。

## 三套状态机（只能按表流转，其他一律被拒绝：「非法状态流转：A 不可流转至 B」）

- 需求：RAW → REFINED（细化）；REFINED → RAW（打回）/ ASSIGNED（分配）；ASSIGNED → REFINED（打回）/ IN_PROGRESS；IN_PROGRESS → BLOCKED / COMPLETED；BLOCKED → IN_PROGRESS。
- 任务：PENDING → IN_PROGRESS / BLOCKED / CANCELLED；IN_PROGRESS → COMPLETED / FAILED / BLOCKED；BLOCKED → IN_PROGRESS / CANCELLED；FAILED → PENDING（重试）/ CANCELLED。
- 人工介入：OPEN → CLAIMED（认领）；CLAIMED → OPEN（放弃认领）/ RESOLVED（处理完成）。OPEN 且超过 dueAt 时显示为 EXPIRED，仍可认领。

## 联动

- 需求处于 ASSIGNED 时，第一个关联任务开始，需求自动进入 IN_PROGRESS。
- 需求处于 IN_PROGRESS 时，全部关联任务完成或取消，需求自动 COMPLETED。

## 工作方式

1. 新需求用 devboard_create_requirement 录入（RAW），补全描述后用 devboard_transition 细化为 REFINED。
2. 细化后用 devboard_create_task 拆成任务：需求拆解、研发（DEVELOPMENT）、测试（TESTING）、安全校验（SECURITY_CHECK）、自动发布（AUTO_RELEASE），并写明依赖。拆完把需求流转到 ASSIGNED。
3. 按依赖推进任务；失败时说明原因再重试或取消。
4. 需要人拍板（需求取舍、架构方案、安全放行、发布、故障处理）时调用 devboard_request_human，写清问题和期限，然后停下等待；不要替人做决定，也不要自己认领或处理介入请求。
5. 人在「人工介入」页处理后，重新读看板，按处理结论继续。
`

const write = { ...readOnlyTool, isReadOnly: false, isConcurrencySafe: false, replay: 'never' }
const result = Type.Object({ revision: Type.Integer(), data: Type.Unknown() }, strict)

function tool(name, description, parameters, run, meta = write) {
  return defineTool({
    name,
    description,
    parameters,
    result,
    meta,
    async execute(input, ctx) {
      ctx.signal.throwIfAborted()
      try {
        const output = json(run(input, ctx.store))
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

export const tools = [
  tool(
    'devboard_board',
    'Read the DevBoard (fictional demo data): requirements, tasks, human-intervention requests and counts; pass id for one entity. 读取看板快照或单个实体。',
    Type.Object({ id: Type.Optional(id) }, strict),
    (input, store) => {
      const view = snapshot(read(store))
      const { machines, labels, ...board } = view
      if (!input.id) return { revision: view.revision, data: { ...board, machines } }
      const all = [...view.requirements, ...view.tasks, ...view.interventions]
      const item = all.find((entry) => entry.id === input.id)
      if (!item) throw new DomainError(`未找到 ${input.id}`)
      const tasks = view.tasks.filter((t) => t.requirementId === input.id)
      return { revision: view.revision, data: tasks.length ? { ...item, tasks } : item }
    },
    readOnlyTool,
  ),
  tool(
    'devboard_create_requirement',
    'Create a requirement in RAW. 录入新需求（RAW）。',
    Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Optional(Type.String({ maxLength: 2000 })),
        priority: Type.Optional(literals(LABELS.priority)),
        owner: Type.Optional(Type.String({ maxLength: 64 })),
      },
      strict,
    ),
    (input, store) => mutate(store, (s) => create(s, { ...input, kind: 'requirement', by: AGENT })),
  ),
  tool(
    'devboard_create_task',
    'Create a PENDING task under a requirement. 为需求拆出任务（PENDING）。',
    Type.Object(
      {
        requirementId: id,
        title: Type.String({ minLength: 1, maxLength: 200 }),
        type: literals(LABELS.taskType),
        owner: Type.Optional(Type.String({ maxLength: 64 })),
        dependsOn: Type.Optional(Type.Array(id, { maxItems: 20 })),
      },
      strict,
    ),
    (input, store) => mutate(store, (s) => create(s, { ...input, kind: 'task', by: AGENT })),
  ),
  tool(
    'devboard_transition',
    'Move a requirement or task to another state; illegal moves are refused. Do not claim or resolve human-intervention requests. 推进需求或任务状态。',
    Type.Object(
      { kind: Type.Union([Type.Literal('requirement'), Type.Literal('task')]), id, to: id, note },
      strict,
    ),
    (input, store) => mutate(store, (s) => transition(s, { ...input, by: AGENT })),
  ),
  tool(
    'devboard_request_human',
    'Ask a human to decide; creates an OPEN human-intervention request with a deadline. 发起人工介入请求。',
    Type.Object(
      {
        type: literals(LABELS.interventionType),
        entityKind: Type.Union([Type.Literal('requirement'), Type.Literal('task')]),
        entityId: id,
        ask: Type.String({ minLength: 1, maxLength: 2000 }),
        dueInHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 720 })),
      },
      strict,
    ),
    (input, store) =>
      mutate(store, (s) =>
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
]

const common = { scope: 'profile', timeoutMs: 5000, maxResultBytes: 524288, outputSchema: { type: 'object' } }
const effectPolicy = {
  isDestructive: false,
  isOpenWorld: false,
  replay: 'never',
  requiresApproval: 'never',
  approvalScopes: [],
}
const by = Type.String({ minLength: 1, maxLength: 64 })
const schemas = {
  'devboard.transition': Type.Object({ kind, id, to: id, by, note }, strict),
  'devboard.create': Type.Object(
    {
      kind,
      by,
      title: Type.Optional(Type.String({ maxLength: 200 })),
      description: Type.Optional(Type.String({ maxLength: 2000 })),
      priority: Type.Optional(Type.String({ maxLength: 8 })),
      owner: Type.Optional(Type.String({ maxLength: 64 })),
      requirementId: Type.Optional(id),
      type: Type.Optional(Type.String({ maxLength: 64 })),
      dependsOn: Type.Optional(Type.Array(id, { maxItems: 20 })),
      entity: Type.Optional(Type.Object({ kind: Type.String({ maxLength: 16 }), id }, strict)),
      ask: Type.Optional(Type.String({ maxLength: 2000 })),
      dueInHours: Type.Optional(Type.Number()),
    },
    strict,
  ),
  'devboard.reset': Type.Object({}, strict),
}
const handlers = {
  'devboard.transition': (input, store) => update(store, (s) => transition(s, input)),
  'devboard.create': (input, store) => update(store, (s) => create(s, input)),
  'devboard.reset': (_input, store) => reset(store),
}

export const main = defineAgnesPlugin({
  apply(ctx) {
    for (const t of tools) ctx.tools.register(t)
    ctx.skills.register({
      name: 'devboard-playbook',
      description: 'DevBoard 三套状态机与研发协调工作方式 / DevBoard state machines and coordination steps',
      body: skill,
    })
    ctx.services.register({
      ...common,
      name: 'devboard.snapshot',
      kind: 'query',
      inputSchema: json(Type.Object({}, strict)),
      async handler(_input, c) {
        return json(snapshot(read(c.store)))
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
