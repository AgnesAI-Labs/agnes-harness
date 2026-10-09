import { renderInteractionSurface, tableSurface } from '../../../src/interaction-surfaces.js'
import { randomUUID } from 'node:crypto'
import { defineExtension, defineTool, type ToolContext } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { WORKFLOW_RECEIPT_RULE, workflowReceipts } from './receipts.js'
import { type Run, type State, workflowProjection } from './state.js'

const member = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    task: Type.String({ minLength: 1, maxLength: 8192 }),
  },
  { additionalProperties: false },
)
const stages = Type.Array(
  Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 128 }),
      members: Type.Array(member, { minItems: 1, maxItems: 4 }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 16 },
)

const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: 'never' as const,
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never' as const,
}

async function state(ctx: ToolContext): Promise<State> {
  const read = await ctx.projections.readOwn<State>('runs')
  if (read.status !== 'available') throw new Error('Workflow persistence is unavailable')
  return read.value
}

const result = (run: Run) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({
        ...run,
        runId: run.id,
        execution: workflowReceipts(run),
        evidenceRule: WORKFLOW_RECEIPT_RULE,
      }),
    },
  ],
  structured: { ...run, runId: run.id },
  isError: run.status !== 'completed',
})

async function renderRun(ctx: ToolContext, run: Run) {
  await renderInteractionSurface(
    ctx,
    tableSurface(
      ctx.session.toolUseId,
      run.name,
      ['Stage', 'Member', 'Status', 'Child session', 'Run status', 'Run id', 'Integration'],
      run.stages.flatMap((s) =>
        s.members.map((m) => [
          s.name,
          m.name,
          m.status,
          m.childKey,
          run.status,
          run.id,
          (m.receipt?.workspace.isolation ?? m.isolation) === 'worktree'
            ? 'not-merged-by-workflow'
            : (m.receipt?.workspace.isolation ?? m.isolation) === 'shared'
              ? 'shared-workspace'
              : 'unverified',
        ]),
      ),
    ),
  )
}

export default defineExtension((agnes) => {
  const disposers = [agnes.registerProjection(workflowProjection)]
  disposers.push(
    agnes.registerHook('context', async (_payload, ctx) => {
      const read = await ctx.projections.readOwn<State>('runs')
      if (read.status !== 'available') return {}
      const runs = Object.values(read.value.runs).slice(-8)
      if (!runs.length) return {}
      return {
        refreshOnRequest: true,
        sections: [
          {
            id: 'workflow:receipts',
            order: 113,
            content: WORKFLOW_RECEIPT_RULE + '\n' + JSON.stringify(runs.map(workflowReceipts)),
          },
        ],
      }
    }),
  )
  disposers.push(
    agnes.registerTool(
      defineTool({
        name: 'workflow',
        description:
          'Run sequential stages of parallel child agents. Each stage receives previous stage results. Supply name and stages for a new run, or only runId to resume a durable run. A failed stage stops the workflow. Use workflow_status to inspect stages and child sessions.',
        parameters: Type.Object(
          {
            runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            stages: Type.Optional(stages),
          },
          { additionalProperties: false },
        ),
        meta,
        async execute(args, ctx) {
          const previous = await state(ctx)
          let run = args.runId ? previous.runs[args.runId] : undefined
          if (args.runId && !run) throw new Error('Unknown workflow run')
          if (run && (args.stages || args.name)) throw new Error('Resume uses the saved workflow definition')
          if (!run) {
            if (!args.stages || !args.name) throw new Error('A new workflow needs name and stages')
            if (new Set(args.stages.map((s) => s.name)).size !== args.stages.length)
              throw new Error('Stage names must be unique')
            if (args.stages.some((s) => new Set(s.members.map((m) => m.name)).size !== s.members.length))
              throw new Error('Member names must be unique within a stage')
            if (new TextEncoder().encode(JSON.stringify(args.stages)).byteLength > 32768)
              throw new Error('Workflow definition is too large')
            if (
              Object.keys(previous.runs).length >= 64 ||
              new TextEncoder().encode(JSON.stringify(previous)).byteLength > 120000
            )
              throw new Error('Workflow run budget exceeded')
            run = {
              id: randomUUID(),
              name: args.name,
              toolUseId: ctx.session.toolUseId,
              status: 'running',
              error: '',
              stages: args.stages.map((s) => ({
                name: s.name,
                members: s.members.map((m) => ({
                  ...m,
                  status: 'pending',
                  childKey: '',
                  text: '',
                })),
              })),
            }
          } else run = structuredClone(run)
          if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
            await renderRun(ctx, run)
            return result(run)
          }
          const current = run
          // Serialize immutable snapshots so parallel completions cannot reorder persisted state.
          let persistenceFailed = false
          let writes = Promise.resolve()
          const save = () => {
            const snapshot = structuredClone(current)
            writes = writes
              .then(async () => {
                await agnes.events.append('run', snapshot)
              })
              .catch((error) => {
                persistenceFailed = true
                throw error
              })
            return writes
          }
          current.toolUseId = ctx.session.toolUseId
          await save()
          try {
            let input = ''
            for (const stage of current.stages) {
              ctx.signal.throwIfAborted()
              ctx.progress('Workflow ' + current.name + ': ' + stage.name)
              const settled = await Promise.allSettled(
                stage.members.map(async (m) => {
                  if (m.status === 'completed') return
                  if (m.status === 'starting' && !m.childKey)
                    throw new Error(
                      'Interrupted child creation requires reconciliation; refusing duplicate dispatch',
                    )
                  if (m.status === 'failed' || m.status === 'cancelled')
                    throw new Error('A workflow member failed')
                  if (!m.childKey) {
                    m.status = 'starting'
                    await save()
                    // Use the official child tool: it enforces preset depth/fan-out and worktree policy.
                    const spawned = await ctx.tools.invoke(
                      'subagent_spawn',
                      { task: m.task + (input ? '\nPrevious stage results:\n' + input : '') },
                      { signal: ctx.signal },
                    )
                    if (
                      spawned.isError ||
                      !spawned.details ||
                      typeof spawned.details !== 'object' ||
                      Array.isArray(spawned.details) ||
                      typeof spawned.details.childKey !== 'string'
                    )
                      throw new Error('Child creation refused')
                    m.childKey = spawned.details.childKey
                    if (spawned.details.isolation === 'worktree' || spawned.details.isolation === 'shared')
                      m.isolation = spawned.details.isolation
                    if (typeof spawned.details.worktree === 'string') m.worktree = spawned.details.worktree
                    m.status = 'running'
                    await save()
                  }
                  let child = await ctx.subagent.collect(m.childKey, { wait: false })
                  if (child.status === 'interrupted') {
                    await ctx.subagent.resume(m.childKey)
                  }
                  if (child.status !== 'completed' && child.status !== 'idle')
                    child = await ctx.subagent.collect(m.childKey, { wait: true })
                  if (child.status === 'running' || child.waitTimedOut)
                    throw new Error('Child is still running; resume this workflow by runId')
                  m.status = child.status === 'completed' || child.status === 'idle' ? 'completed' : 'failed'
                  m.text = new TextDecoder().decode(
                    new TextEncoder().encode(child.text ?? '').subarray(0, 1024),
                  )
                  if (child.receipt) m.receipt = structuredClone(child.receipt)
                  await save()
                  if (m.status !== 'completed') throw new Error('Workflow child failed')
                }),
              )
              const failed = settled.find((s) => s.status === 'rejected')
              if (failed?.status === 'rejected') throw failed.reason
              input = JSON.stringify({
                execution: workflowReceipts(current),
                childReports: stage.members.map((m) => ({ name: m.name, text: m.text })),
                evidenceRule: WORKFLOW_RECEIPT_RULE,
              })
            }
            current.status = 'completed'
          } catch (error) {
            current.error = error instanceof Error ? error.message.slice(0, 512) : 'Workflow failed'
            const pending = current.stages
              .flatMap((s) => s.members)
              .filter((m) => m.status !== 'completed' && m.childKey)
            if (ctx.signal.aborted || persistenceFailed) {
              const cancelled = await Promise.allSettled(pending.map((m) => ctx.subagent.cancel(m.childKey)))
              cancelled.forEach((outcome, i) => {
                if (outcome.status === 'fulfilled') pending[i]!.status = 'cancelled'
              })
              current.status = cancelled.some((c) => c.status === 'rejected') ? 'interrupted' : 'cancelled'
            } else if (current.stages.some((s) => s.members.some((m) => m.status === 'failed'))) {
              const cancelled = await Promise.allSettled(pending.map((m) => ctx.subagent.cancel(m.childKey)))
              cancelled.forEach((outcome, i) => {
                const m = pending[i]
                if (outcome.status === 'fulfilled' && m && m.status !== 'failed') m.status = 'cancelled'
              })
              current.status = cancelled.some((c) => c.status === 'rejected') ? 'interrupted' : 'failed'
            } else current.status = 'interrupted'
          }
          await save()
          await renderRun(ctx, current)
          return result(current)
        },
      }),
    ),
  )
  disposers.push(
    agnes.registerTool(
      defineTool({
        name: 'workflow_status',
        description: 'Read a durable workflow run and its stage/member/child session state.',
        parameters: Type.Object(
          { runId: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
        meta: { ...meta, isReadOnly: true, isOpenWorld: false, replay: 'safe' },
        async execute(args, ctx) {
          const run = (await state(ctx)).runs[args.runId]
          if (!run) throw new Error('Unknown workflow run')
          await agnes.events.append('view', { runId: run.id, toolUseId: ctx.session.toolUseId })
          await renderRun(ctx, run)
          return { ...result(run), isError: false }
        },
      }),
    ),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
})
