import { defineTool, type ToolContext, type ToolDef, type ToolResult } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import type { WorktreeFinishResult, WorktreeManager } from './worktree.js'

export type SubagentLimits = {
  maxDepth: number
  maxFanOut: number
  isolation: 'worktree' | 'shared'
}

type ChildRecord = {
  running: boolean
  worktree?: string
  cleanup?: Promise<WorktreeFinishResult>
}

type SessionState = {
  pending: number
  children: Map<string, ChildRecord>
}

export type SubagentRuntime = {
  readonly sessions: Map<string, SessionState>
}

export type SubagentDeps = {
  limits: SubagentLimits
  worktrees: WorktreeManager
  /** Supply one explicitly when multiple tool instances must share lifecycle accounting. */
  runtime?: SubagentRuntime
}

const implicitRuntimes = new WeakMap<SubagentDeps, SubagentRuntime>()

export function createSubagentRuntime(): SubagentRuntime {
  return { sessions: new Map() }
}

function runtimeOf(deps: SubagentDeps): SubagentRuntime {
  let runtime = deps.runtime ?? implicitRuntimes.get(deps)
  if (!runtime) {
    runtime = createSubagentRuntime()
    implicitRuntimes.set(deps, runtime)
  }
  return runtime
}

export function resetSubagentRuntime(deps: SubagentDeps): void {
  runtimeOf(deps).sessions.clear()
  implicitRuntimes.delete(deps)
}

function stateOf(runtime: SubagentRuntime, sessionKey: string): SessionState {
  let state = runtime.sessions.get(sessionKey)
  if (!state) {
    state = { pending: 0, children: new Map() }
    runtime.sessions.set(sessionKey, state)
  }
  return state
}

function prune(runtime: SubagentRuntime, sessionKey: string, state: SessionState): void {
  if (state.pending === 0 && state.children.size === 0) runtime.sessions.delete(sessionKey)
}

function active(state: SessionState): number {
  let count = state.pending
  for (const child of state.children.values()) if (child.running) count += 1
  return count
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function assertDeps(deps: SubagentDeps): void {
  if (!validLimit(deps.limits.maxDepth)) throw new Error('subagent maxDepth must be a non-negative integer')
  if (!validLimit(deps.limits.maxFanOut)) throw new Error('subagent maxFanOut must be a non-negative integer')
  if (deps.limits.isolation !== 'worktree' && deps.limits.isolation !== 'shared')
    throw new Error('subagent isolation must be worktree or shared')
}

async function rollbackWorktree(
  deps: SubagentDeps,
  ctx: ToolContext,
  worktree: string | undefined,
): Promise<void> {
  if (!worktree) return
  try {
    await deps.worktrees.finish(ctx, 'spawn-failed', worktree)
  } catch {
    ctx.log.warn('subagent worktree rollback failed', { worktree })
  }
}

const forkParameters = Type.Object(
  {
    question: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

const forkDefinition: ToolDef<typeof forkParameters> = {
  name: 'subagent_fork',
  description: 'Synchronously run a child session with a full tool loop and return its final text.',
  parameters: forkParameters,
  meta: {
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: true,
    replay: 'never',
    costHint: undefined,
    deferLoading: false,
    requiresApproval: 'never',
  },
  async execute(args, ctx) {
    if (args.question.length === 0) return fail('question must not be empty')
    const options = args.model === undefined ? undefined : { model: args.model }
    const text = await ctx.subagent.fork(args.question, options)
    return { content: [{ type: 'text', text }] }
  },
}

export const subagentForkTool = defineTool(forkDefinition)

const spawnParameters = Type.Object(
  {
    task: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String({ minLength: 1 })),
    isolation: Type.Optional(Type.Union([Type.Literal('worktree'), Type.Literal('shared')])),
    budget: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)

export function subagentSpawnTool(deps: SubagentDeps): ToolDef<typeof spawnParameters> {
  assertDeps(deps)
  const definition: ToolDef<typeof spawnParameters> = {
    name: 'subagent_spawn',
    description: 'Start an independent child task and return a handle for subagent_collect.',
    parameters: spawnParameters,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: true,
      replay: 'never',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'never',
    },
    async execute(args, ctx) {
      if (args.task.length === 0) return fail('task must not be empty')
      if (args.budget !== undefined && (!Number.isSafeInteger(args.budget) || args.budget < 1))
        return fail('budget must be a positive integer')
      if (ctx.session.generationDepth + 1 > deps.limits.maxDepth)
        return fail(`depth limit ${deps.limits.maxDepth} reached`)

      const runtime = runtimeOf(deps)
      const sessionKey = ctx.session.key
      const state = stateOf(runtime, sessionKey)
      for (const [key, rec] of state.children) {
        if (!rec.running) continue
        try {
          const snap = await ctx.subagent.collect(key, { wait: false })
          if (snap.status !== 'running') {
            rec.running = false
            state.children.delete(key)
          }
        } catch {
          rec.running = false
          state.children.delete(key)
        }
      }
      if (active(state) >= deps.limits.maxFanOut) {
        prune(runtime, sessionKey, state)
        return fail(`fan-out limit ${deps.limits.maxFanOut} reached`)
      }

      // Persist identity first (design 10.1), then prepare a worktree, then start the child.
      state.pending += 1
      let worktree: string | undefined
      let skipped: string | undefined
      try {
        const requested = args.isolation ?? deps.limits.isolation
        const options = {
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.budget === undefined ? {} : { budget: args.budget }),
          isolation: requested,
          ...(requested === 'worktree' ? { start: false as const } : {}),
        }
        const spawned = await ctx.subagent.spawn(args.task, options)
        if (requested === 'worktree') {
          const created = await deps.worktrees.create(ctx)
          if ('skipped' in created) skipped = created.skipped
          else {
            worktree = created.path
            await deps.worktrees.bind?.(spawned.childKey, created.path)
          }
          await ctx.subagent.resume(spawned.childKey)
        }

        if (spawned.childKey.length === 0 || state.children.has(spawned.childKey)) {
          await rollbackWorktree(deps, ctx, worktree)
          return fail('subagent backend returned an invalid or duplicate child key')
        }
        state.children.set(spawned.childKey, { running: true, ...(worktree ? { worktree } : {}) })

        const details: Record<string, JsonValue> = {
          childKey: spawned.childKey,
          isolation: worktree ? 'worktree' : 'shared',
        }
        if (worktree) details.worktree = worktree
        if (skipped) details.worktreeSkipped = skipped
        const note = skipped ? ` (worktree skipped: ${skipped}; sharing cwd)` : ''
        return { content: [{ type: 'text', text: `spawned ${spawned.childKey}${note}` }], details }
      } finally {
        state.pending -= 1
        prune(runtime, sessionKey, state)
      }
    },
  }
  return defineTool(definition)
}

const collectParameters = Type.Object(
  {
    childKey: Type.String({ minLength: 1 }),
    wait: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export function subagentCollectTool(deps: SubagentDeps): ToolDef<typeof collectParameters> {
  assertDeps(deps)
  const definition: ToolDef<typeof collectParameters> = {
    name: 'subagent_collect',
    description: 'Collect the current or terminal result of a spawned child task.',
    parameters: collectParameters,
    meta: {
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'never',
    },
    async execute(args, ctx) {
      if (args.childKey.length === 0) return fail('childKey must not be empty')
      const result = await ctx.subagent.collect(args.childKey, { wait: args.wait ?? true })
      if (result.childKey !== args.childKey) return fail('subagent backend returned a mismatched child key')

      const runtime = runtimeOf(deps)
      const sessionKey = ctx.session.key
      const state = runtime.sessions.get(sessionKey)
      const record = state?.children.get(args.childKey)
      const details: Record<string, JsonValue> = {
        childKey: result.childKey,
        status: result.status,
        ...(result.credits === undefined ? {} : { credits: result.credits }),
      }

      if (result.status !== 'running' && record) {
        record.running = false
        state?.children.delete(args.childKey)
        if (state) prune(runtime, sessionKey, state)
      }

      return {
        content: [{ type: 'text', text: result.text ?? `child ${args.childKey}: ${result.status}` }],
        details,
      }
    },
  }
  return defineTool(definition)
}

const cancelParameters = Type.Object(
  { childKey: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
)

export function subagentCancelTool(deps: SubagentDeps): ToolDef<typeof cancelParameters> {
  assertDeps(deps)
  const definition: ToolDef<typeof cancelParameters> = {
    name: 'subagent_cancel',
    description: 'Cancel a spawned child and its subtree. Idempotent; collect confirms the terminal state.',
    parameters: cancelParameters,
    meta: {
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'never',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'never',
    },
    async execute(args, ctx) {
      if (args.childKey.length === 0) return fail('childKey must not be empty')
      const result = await ctx.subagent.cancel(args.childKey)
      return {
        content: [{ type: 'text', text: `cancelled ${result.childKey}: ${result.status}` }],
        details: { childKey: result.childKey, status: result.status },
      }
    },
  }
  return defineTool(definition)
}
