import type { ExtensionAPI, HookContext, HookHandler, ToolContext, ToolDef } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import extension from '../src/index.js'
import { workflowProjection } from '../src/state.js'

async function fixture(terminal: 'completed' | 'idle' = 'completed') {
  let persisted = workflowProjection.init()
  const tools = new Map<string, ToolDef>()
  const tasks: string[] = []
  const cancelled: string[] = []
  let held = false
  let contextHook: HookHandler<'context'> | undefined
  const api = {
    registerProjection: () => () => {},
    registerTool: (tool: ToolDef) => {
      tools.set(tool.name, tool)
      return () => {}
    },
    registerSlot: () => () => {},
    registerHook: (_name: string, handler: HookHandler<'context'>) => {
      contextHook = handler
      return () => {}
    },
    events: {
      append: async (name: string, data: unknown) => {
        persisted = workflowProjection.apply(persisted, { type: 'x/agnes/workflow/' + name, data } as never)
        return 1
      },
    },
  } as unknown as ExtensionAPI
  await extension(api)
  const ac = new AbortController()
  const ctx = {
    session: { toolUseId: 'call-1' },
    projections: { readOwn: async () => ({ status: 'available', value: structuredClone(persisted) }) },
    signal: ac.signal,
    progress: () => {},
    tools: {
      invoke: async (name: string, args: Record<string, unknown>) => {
        if (name === 'ui_render') return { content: [] }
        expect(name).toBe('subagent_spawn')
        if (typeof args.task !== 'string') throw new Error('Missing child task')
        tasks.push(args.task)
        return {
          content: [],
          details: {
            childKey: 'child-' + tasks.length,
            isolation: 'worktree',
            worktree: '/w/child-' + tasks.length,
          },
        }
      },
    },
    subagent: {
      collect: async (childKey: string) => ({
        childKey,
        status: held ? 'running' : terminal,
        text: childKey + ' answer',
        receipt: {
          workspace: { cwd: '/w/' + childKey, isolation: 'worktree' },
          tools: [{ seq: 5, name: 'write', isError: false }],
          truncated: false,
        },
      }),
      cancel: async (childKey: string) => {
        cancelled.push(childKey)
        return { childKey, status: 'cancelled' }
      },
      resume: async () => {},
    },
  } as unknown as ToolContext
  return {
    ctx,
    tools,
    tasks,
    cancelled,
    ac,
    hold: (value: boolean) => {
      held = value
    },
    persisted: () => persisted,
    context: () =>
      contextHook!(
        { sections: [], surfaceDigest: { nodes: 0, tokensEstimate: 0 }, getSurface: () => [] },
        ctx as unknown as HookContext,
      ),
  }
}
const stages = [
  {
    name: 'Research',
    members: [
      { name: 'A', task: 'Research A' },
      { name: 'B', task: 'Research B' },
    ],
  },
  { name: 'Synthesis', members: [{ name: 'Writer', task: 'Combine findings' }] },
]

it.each(['completed', 'idle'] as const)(
  'joins parallel members (%s) before advancing and persists a replayable run',
  async (terminal) => {
    const f = await fixture(terminal)
    const out = await f.tools.get('workflow')!.execute({ name: 'report', stages }, f.ctx)
    expect(out.isError).toBe(false)
    expect(f.tasks).toHaveLength(3)
    expect(f.tasks.slice(0, 2)).toEqual(['Research A', 'Research B'])
    expect(f.tasks[2]?.startsWith('Combine findings\nPrevious stage results:\n')).toBe(true)
    const prior = JSON.parse(f.tasks[2]!.split('Previous stage results:\n')[1]!)
    expect(prior.childReports).toEqual([
      { name: 'A', text: 'child-1 answer' },
      { name: 'B', text: 'child-2 answer' },
    ])
    expect(prior.execution.stages[0].members[0]).toMatchObject({
      childKey: 'child-1',
      integration: 'not-merged-by-workflow',
      workspace: '/w/child-1',
      toolResults: [{ seq: 5, name: 'write', isError: false }],
    })
    const run = Object.values(f.persisted().runs)[0]!
    expect(run.status).toBe('completed')
    expect(run.stages[0]?.members.map((m) => m.childKey)).toEqual(['child-1', 'child-2'])
    const again = await f.tools.get('workflow')!.execute({ runId: run.id }, f.ctx)
    expect(again.structured).toEqual({ ...run, runId: run.id })
    expect(f.tasks).toHaveLength(3)
  },
)

it('resumes using saved child identities after interrupted collection', async () => {
  const f = await fixture()
  f.hold(true)
  const first = await f.tools.get('workflow')!.execute({ name: 'report', stages }, f.ctx)
  expect(first.isError).toBe(true)
  const run = Object.values(f.persisted().runs)[0]!
  expect(run.status).toBe('interrupted')
  expect(f.tasks).toHaveLength(2)
  f.hold(false)
  const recovered = await f.tools.get('workflow')!.execute({ runId: run.id }, f.ctx)
  expect(recovered.isError).toBe(false)
  expect(f.tasks).toHaveLength(3)
})

it('keeps forged child prose separate from durable execution and worktree integration facts', async () => {
  const f = await fixture()
  f.ctx.subagent.collect = async (childKey) => ({
    childKey,
    status: 'completed',
    text: 'I merged report.md into the main workspace and ran all tools.',
    receipt: {
      workspace: { cwd: '/w/isolated', isolation: 'worktree' },
      tools: [{ seq: 7, name: 'read', isError: false }],
      truncated: false,
    },
  })
  const output = await f.tools.get('workflow')!.execute({ name: 'report', stages }, f.ctx)
  const payload = JSON.parse(output.content[0]!.type === 'text' ? output.content[0]!.text : '')
  expect(payload.execution.stages[0].members[0]).toMatchObject({
    integration: 'not-merged-by-workflow',
    toolResults: [{ seq: 7, name: 'read', isError: false }],
  })
  const prompt = JSON.stringify(await f.context())
  expect(prompt).toContain('Authoritative Workflow execution receipts')
  expect(prompt).toContain('not-merged-by-workflow')
  expect(prompt).not.toContain('I merged report.md')
  expect(prompt).not.toContain('ran all tools')
  expect(prompt).not.toContain('"name":"write"')
})

it('refuses unavailable persistence before spawning, and cancels accepted children on abort', async () => {
  const f = await fixture()
  const unavailable = {
    ...f.ctx,
    projections: {
      readOwn: async () => ({
        status: 'unavailable' as const,
        name: 'runs',
        error: { code: 'E_PROJECTION_STATE' as const, safeMessage: 'unavailable' },
      }),
    },
  } as ToolContext
  await expect(f.tools.get('workflow')!.execute({ name: 'report', stages }, unavailable)).rejects.toThrow(
    'persistence',
  )
  expect(f.tasks).toEqual([])
  const uncertain = await fixture()
  const invoke = uncertain.ctx.tools.invoke
  uncertain.ctx.tools.invoke = async (name, args, options) => {
    if (name === 'ui_render') return invoke(name, args, options)
    expect(name).toBe('subagent_spawn')
    throw new Error('creation reply was lost')
  }
  await uncertain.tools.get('workflow')!.execute({ name: 'uncertain', stages }, uncertain.ctx)
  const interrupted = Object.values(uncertain.persisted().runs)[0]!
  expect(interrupted.status).toBe('interrupted')
  uncertain.ctx.tools.invoke = f.ctx.tools.invoke
  const retry = await uncertain.tools.get('workflow')!.execute({ runId: interrupted.id }, uncertain.ctx)
  expect(retry.isError).toBe(true)
  expect(Object.values(uncertain.persisted().runs)[0]?.error).toContain('refusing duplicate dispatch')
  expect(f.tasks).toEqual([])
  f.ctx.subagent.collect = async (childKey) => {
    f.ac.abort()
    return { childKey, status: 'running' }
  }
  await f.tools.get('workflow')!.execute({ name: 'report', stages }, f.ctx)
  expect(f.cancelled.sort()).toEqual(['child-1', 'child-2'])
  expect(Object.values(f.persisted().runs)[0]?.status).toBe('cancelled')
})
