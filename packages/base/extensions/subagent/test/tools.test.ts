import { checkToolDef, type ToolContext, type ToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createSubagentExtension } from '../src/index.js'
import type { SubagentDeps } from '../src/tools.js'
import {
  createSubagentRuntime,
  subagentCancelTool,
  subagentCollectTool,
  subagentForkTool,
  subagentSpawnTool,
} from '../src/tools.js'
import type { WorktreeCreateResult, WorktreeFinishResult, WorktreeManager } from '../src/worktree.js'

type SubagentCalls = {
  fork: Array<[string, { model?: string } | undefined]>
  spawn: Array<
    [
      string,
      (
        | {
            model?: string
            isolation?: 'worktree' | 'shared'
            budget?: number
            cwd?: string
            start?: boolean
          }
        | undefined
      ),
    ]
  >
  collect: Array<[string, { wait?: boolean } | undefined]>
  resume: string[]
}

function context(
  handlers: {
    fork?: ToolContext['subagent']['fork']
    spawn?: ToolContext['subagent']['spawn']
    collect?: ToolContext['subagent']['collect']
    resume?: ToolContext['subagent']['resume']
  } = {},
) {
  const ctx = fakeToolContext()
  const calls: SubagentCalls = { fork: [], spawn: [], collect: [], resume: [] }
  const subagent: ToolContext['subagent'] = {
    async fork(question, options) {
      calls.fork.push([question, options])
      return handlers.fork ? handlers.fork(question, options) : `answer:${question}`
    },
    async spawn(task, options) {
      calls.spawn.push([task, options])
      return handlers.spawn ? handlers.spawn(task, options) : { childKey: `child-${calls.spawn.length}` }
    },
    async collect(childKey, options) {
      calls.collect.push([childKey, options])
      return handlers.collect
        ? handlers.collect(childKey, options)
        : { childKey, status: 'completed', text: 'done', credits: 3 }
    },
    async cancel(childKey) {
      return { childKey, status: 'cancelled' }
    },
    async resume(childKey) {
      calls.resume.push(childKey)
      return handlers.resume ? handlers.resume(childKey) : { childKey }
    },
  }
  ;(ctx as unknown as { subagent: ToolContext['subagent'] }).subagent = subagent
  return { calls, ctx }
}

function worktrees(
  handlers: {
    create?: (ctx: ToolContext) => Promise<WorktreeCreateResult>
    finish?: (ctx: ToolContext, childKey: string, path: string) => Promise<WorktreeFinishResult>
  } = {},
) {
  const calls = { create: [] as ToolContext[], finish: [] as Array<[string, string]> }
  const manager: WorktreeManager = {
    async create(ctx) {
      calls.create.push(ctx)
      return handlers.create
        ? handlers.create(ctx)
        : {
            id: '1234abcd',
            path: '/work/proj/.worktrees/agnes-1234abcd',
            branch: 'agnes/subagent-1234abcd',
          }
    },
    async finish(ctx, childKey, path) {
      calls.finish.push([childKey, path])
      return handlers.finish ? handlers.finish(ctx, childKey, path) : { action: 'removed' }
    },
    async bind() {
      return
    },
  }
  return { calls, manager }
}

function deps(
  options: {
    maxDepth?: number
    maxFanOut?: number
    isolation?: 'worktree' | 'shared'
    worktrees?: WorktreeManager
  } = {},
): SubagentDeps {
  return {
    limits: {
      maxDepth: options.maxDepth ?? 1,
      maxFanOut: options.maxFanOut ?? 2,
      isolation: options.isolation ?? 'worktree',
    },
    worktrees: options.worktrees ?? worktrees().manager,
    runtime: createSubagentRuntime(),
  }
}

describe('subagent tool definitions', () => {
  it('publishes three complete definitions with the intended replay metadata', () => {
    const d = deps()
    const tools = [subagentForkTool, subagentSpawnTool(d), subagentCollectTool(d), subagentCancelTool(d)]

    for (const tool of tools) expect(checkToolDef(tool, { prefix: 'subagent_' })).toEqual({ ok: true })
    expect(tools.map((tool) => [tool.name, tool.meta.replay, tool.meta.isConcurrencySafe])).toEqual([
      ['subagent_fork', 'never', true],
      ['subagent_spawn', 'never', true],
      ['subagent_collect', 'safe', true],
      ['subagent_cancel', 'never', true],
    ])
    expect(tools[0]?.meta).toMatchObject({ isReadOnly: false, isOpenWorld: true, replay: 'never' })
    expect(tools[2]?.meta).toMatchObject({ isReadOnly: false, isDestructive: true })
  })

  it('the explicit extension factory registers and disposes all three tools', () => {
    const names: string[] = []
    const disposed: string[] = []
    const factory = createSubagentExtension(deps())
    const dispose = factory({
      registerTool(tool: ToolDef) {
        names.push(tool.name)
        return () => disposed.push(tool.name)
      },
    } as never)

    expect(names).toEqual(['subagent_fork', 'subagent_spawn', 'subagent_collect', 'subagent_cancel'])
    expect(dispose).toBeTypeOf('function')
    ;(dispose as () => void)()
    expect(disposed).toEqual(['subagent_cancel', 'subagent_collect', 'subagent_spawn', 'subagent_fork'])
  })
})

describe('subagent_fork', () => {
  it('returns the answer and preserves an optional model choice', async () => {
    const { calls, ctx } = context()

    await expect(subagentForkTool.execute({ question: 'review this', model: 'fast' }, ctx)).resolves.toEqual({
      content: [{ type: 'text', text: 'answer:review this' }],
    })
    expect(calls.fork).toEqual([['review this', { model: 'fast' }]])
  })
})

describe('subagent_spawn', () => {
  it('creates worktree isolation and passes model, budget and cwd without asking core for a second worktree', async () => {
    const wt = worktrees()
    const d = deps({ worktrees: wt.manager })
    const { calls, ctx } = context()

    const result = await subagentSpawnTool(d).execute(
      { task: 'implement', model: 'm', isolation: 'worktree', budget: 7 },
      ctx,
    )

    expect(calls.spawn).toEqual([
      [
        'implement',
        {
          model: 'm',
          budget: 7,
          isolation: 'worktree',
          start: false,
        },
      ],
    ])
    expect(wt.calls.create).toEqual([ctx])
    expect(calls.resume).toEqual(['child-1'])
    expect(result.details).toEqual({
      childKey: 'child-1',
      isolation: 'worktree',
      worktree: '/work/proj/.worktrees/agnes-1234abcd',
    })
  })

  it('honours explicit shared isolation and a fail-closed worktree fallback', async () => {
    const wt = worktrees({ create: async () => ({ skipped: 'not-git' }) })
    const d = deps({ worktrees: wt.manager })
    const first = context({ spawn: async () => ({ childKey: 'shared-child' }) })

    await subagentSpawnTool(d).execute({ task: 'shared', isolation: 'shared' }, first.ctx)
    expect(wt.calls.create).toEqual([])
    expect(first.calls.spawn).toEqual([['shared', { isolation: 'shared' }]])

    const second = context({ spawn: async () => ({ childKey: 'fallback-child' }) })
    const result = await subagentSpawnTool(d).execute({ task: 'fallback' }, second.ctx)
    expect(second.calls.spawn).toEqual([['fallback', { isolation: 'worktree', start: false }]])
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('worktree skipped: not-git') })
    expect(result.details).toMatchObject({ isolation: 'shared', worktreeSkipped: 'not-git' })
  })

  it('enforces depth before worktree or child creation', async () => {
    const wt = worktrees()
    const d = deps({ maxDepth: 1, worktrees: wt.manager })
    const { calls, ctx } = context()
    ;(ctx.session as { generationDepth: number }).generationDepth = 1

    const result = await subagentSpawnTool(d).execute({ task: 'too deep' }, ctx)
    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('depth limit') })
    expect(wt.calls.create).toEqual([])
    expect(calls.spawn).toEqual([])
  })

  it('enforces fan-out across repeated tool instances and releases it after collection', async () => {
    let next = 0
    const d = deps({ maxFanOut: 2, isolation: 'shared' })
    const c = context({
      spawn: async () => ({ childKey: `c${++next}` }),
      collect: async (childKey, options) => ({
        childKey,
        status: options?.wait === false ? 'running' : 'completed',
      }),
    })

    await subagentSpawnTool(d).execute({ task: 'one' }, c.ctx)
    await subagentSpawnTool(d).execute({ task: 'two' }, c.ctx)
    const refused = await subagentSpawnTool(d).execute({ task: 'three' }, c.ctx)
    expect(refused).toMatchObject({ isError: true })
    expect(refused.content[0]).toMatchObject({ text: expect.stringContaining('fan-out limit') })
    expect(c.calls.spawn).toHaveLength(2)

    await subagentCollectTool(d).execute({ childKey: 'c1', wait: true }, c.ctx)
    await subagentSpawnTool(d).execute({ task: 'three' }, c.ctx)
    expect(c.calls.spawn).toHaveLength(3)
  })

  it('reserves fan-out before awaiting spawn so concurrent calls cannot exceed the limit', async () => {
    let release: ((value: { childKey: string }) => void) | undefined
    const pending = new Promise<{ childKey: string }>((resolve) => {
      release = resolve
    })
    const d = deps({ maxFanOut: 1, isolation: 'shared' })
    const c = context({ spawn: async () => pending })
    const tool = subagentSpawnTool(d)

    const first = tool.execute({ task: 'one' }, c.ctx)
    await Promise.resolve()
    const second = await tool.execute({ task: 'two' }, c.ctx)
    expect(second).toMatchObject({ isError: true })
    expect(c.calls.spawn).toHaveLength(1)

    release?.({ childKey: 'c1' })
    await first
  })

  it('persists identity before preparing a worktree, so a failed create never leaves a tree', async () => {
    const wt = worktrees()
    const d = deps({ worktrees: wt.manager })
    const c = context({
      spawn: async () => {
        throw new Error('child backend unavailable')
      },
    })

    await expect(subagentSpawnTool(d).execute({ task: 'one' }, c.ctx)).rejects.toThrow(
      'child backend unavailable',
    )
    expect(wt.calls.create).toEqual([])
    expect(wt.calls.finish).toEqual([])
  })

  it('rejects invalid direct-call budgets before reserving capacity', async () => {
    const d = deps({ isolation: 'shared' })
    const c = context()

    const result = await subagentSpawnTool(d).execute({ task: 'one', budget: 0 }, c.ctx)
    expect(result).toMatchObject({ isError: true })
    expect(c.calls.spawn).toEqual([])
  })
})

describe('subagent_collect', () => {
  it('preserves wait=false, keeps running children, then releases fan-out without finishing worktrees', async () => {
    let status: 'running' | 'completed' = 'running'
    const wt = worktrees()
    const d = deps({ maxFanOut: 1, worktrees: wt.manager })
    const c = context({
      spawn: async () => ({ childKey: 'c1' }),
      collect: async (childKey) => ({
        childKey,
        status,
        ...(status === 'completed' ? { text: 'done', credits: 3 } : {}),
      }),
    })

    await subagentSpawnTool(d).execute({ task: 'one' }, c.ctx)
    const running = await subagentCollectTool(d).execute({ childKey: 'c1', wait: false }, c.ctx)
    expect(c.calls.collect[0]).toEqual(['c1', { wait: false }])
    expect(running.details).toEqual({ childKey: 'c1', status: 'running' })
    expect(wt.calls.finish).toEqual([])
    expect((await subagentSpawnTool(d).execute({ task: 'blocked' }, c.ctx)).isError).toBe(true)

    status = 'completed'
    const done = await subagentCollectTool(d).execute({ childKey: 'c1' }, c.ctx)
    expect(c.calls.collect.at(-1)).toEqual(['c1', { wait: true }])
    expect(done.content).toEqual([{ type: 'text', text: 'done' }])
    expect(done.details).toEqual({
      childKey: 'c1',
      status: 'completed',
      credits: 3,
    })
    expect(wt.calls.finish).toEqual([])
    expect((await subagentSpawnTool(d).execute({ task: 'now allowed' }, c.ctx)).isError).toBeUndefined()
  })

  it('releases fan-out on collect without finishing the worktree', async () => {
    let children = 0
    const wt = worktrees()
    const d = deps({ maxFanOut: 1, worktrees: wt.manager })
    const c = context({
      spawn: async () => ({ childKey: `c${++children}` }),
      collect: async (childKey) => ({ childKey, status: 'completed' }),
    })

    await subagentSpawnTool(d).execute({ task: 'one' }, c.ctx)
    await subagentCollectTool(d).execute({ childKey: 'c1' }, c.ctx)
    expect(wt.calls.finish).toEqual([])
    expect((await subagentSpawnTool(d).execute({ task: 'two' }, c.ctx)).isError).toBeUndefined()
  })
})
