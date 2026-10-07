import type { ExtensionAPI, ToolContext, ToolDef } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import extension from '../src/index.js'
import { workflowProjection } from '../src/state.js'

async function fixture(terminal: 'completed' | 'idle' = 'completed') {
  let persisted = workflowProjection.init()
  const tools = new Map<string, ToolDef>()
  const tasks: string[] = []
  const cancelled: string[] = []
  let held = false
  const api = {
    registerProjection: () => () => {},
    registerTool: (tool: ToolDef) => {
      tools.set(tool.name, tool)
      return () => {}
    },
    registerSlot: () => () => {},
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
      invoke: async (_name: string, args: { task: string }) => {
        tasks.push(args.task)
        return { content: [], details: { childKey: 'child-' + tasks.length } }
      },
    },
    subagent: {
      collect: async (childKey: string) => ({
        childKey,
        status: held ? 'running' : terminal,
        text: childKey + ' answer',
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
    expect(f.tasks[2]).toContain('child-1 answer')
    expect(f.tasks[2]).toContain('child-2 answer')
    const run = Object.values(f.persisted().runs)[0]!
    expect(run.status).toBe('completed')
    expect(run.stages[0]?.members.map((m) => m.childKey)).toEqual(['child-1', 'child-2'])
    const again = await f.tools.get('workflow')!.execute({ runId: run.id }, f.ctx)
    expect(again.structured).toEqual(run)
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
  f.ctx.subagent.collect = async (childKey) => {
    f.ac.abort()
    return { childKey, status: 'running' }
  }
  await f.tools.get('workflow')!.execute({ name: 'report', stages }, f.ctx)
  expect(f.cancelled.sort()).toEqual(['child-1', 'child-2'])
  expect(Object.values(f.persisted().runs)[0]?.status).toBe('cancelled')
})
