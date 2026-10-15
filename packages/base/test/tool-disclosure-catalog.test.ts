import { ToolRegistry } from '@agnes/core'
import { actor, fakeProvider, openSession, readTool, textTurn, toolTurn } from '@agnes/core/testkit'
import type { ToolDef } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { expect, it } from 'vitest'
import deliverables from '../extensions/deliverables/src/index.js'
import goal from '../extensions/goal/src/index.js'
import { createJobTools } from '../extensions/jobs/src/index.js'
import { createPtyTools } from '../extensions/jobs/src/pty-tools.js'
import { ShellJobs } from '../extensions/jobs/src/registry.js'
import { toolDescribeTool, toolSearchTool } from '../extensions/mcp-search/src/search-tools.js'
import { createScheduleTools } from '../extensions/schedule/src/tools.js'
import { createSubagentExtension } from '../extensions/subagent/src/index.js'
import workflow from '../extensions/workflow/src/index.js'
import { MemFts } from '../testkit/mem-fts.js'

it('reduces the official first-call payload and discovers, discloses and executes a real management tool', async () => {
  const jobs = new ShellJobs()
  const index = new MemFts()
  const defs: ToolDef[] = [
    readTool() as ToolDef,
    toolSearchTool(index),
    toolDescribeTool(index),
    ...createJobTools(jobs),
    ...createPtyTools(jobs),
    ...createScheduleTools(undefined),
  ]
  const api = {
    ctx: { signal: new AbortController().signal },
    registerTool(tool: ToolDef) {
      defs.push(tool)
      return () => undefined
    },
    registerProjection: () => () => undefined,
    registerHook: () => () => undefined,
    registerSlot: () => () => undefined,
    events: { append: async () => 1 },
  } as unknown as ExtensionAPI
  for (const plugin of [
    goal,
    workflow,
    deliverables,
    createSubagentExtension({
      limits: { maxDepth: 1, maxFanOut: 4, isolation: 'shared' },
      worktrees: {
        create: async () => {
          throw new Error('unused')
        },
        finish: async () => {
          throw new Error('unused')
        },
      },
    }),
  ])
    await extensionFactoryOf(plugin)(api)
  const registry = new ToolRegistry()
  const eagerRegistry = new ToolRegistry()
  for (const def of defs) {
    registry.add(def, { source: 'catalog-test', trust: 'builtin' })
    eagerRegistry.add(
      { ...def, meta: { ...def.meta, deferLoading: false } },
      { source: 'catalog-test', trust: 'builtin' },
    )
  }
  const provider = fakeProvider([
    toolTurn('job_list', {}),
    toolTurn('tool_search', { query: 'job_list' }),
    toolTurn('tool_describe', { name: 'job_list' }),
    toolTurn('job_list', {}),
    textTurn('done'),
  ])
  const eagerProvider = fakeProvider([textTurn('done')])
  const { session } = await openSession({ provider, registry })
  const { session: eager } = await openSession({ provider: eagerProvider, registry: eagerRegistry })
  try {
    for (const current of [session, eager]) {
      await current.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'inspect jobs' }] })
      await current.run({ until: 'turn-end', signal: new AbortController().signal })
    }
    const first = provider.requests[0]
    const original = eagerProvider.requests[0]
    if (!first || !original) throw new Error('expected first model requests')
    const jobList = defs.find((tool) => tool.name === 'job_list')
    if (!jobList) throw new Error('expected job_list definition')
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    const payload = (request: typeof first) => bytes({ system: request.system, tools: request.tools })
    console.info('official tool catalog payload', {
      totalTools: defs.length,
      initialTools: first.tools.length,
      eagerBytes: payload(original),
      deferredBytes: payload(first),
      eagerSchemaBytes: bytes(original.tools),
      deferredSchemaBytes: bytes(first.tools),
    })
    expect(payload(first)).toBeLessThan(payload(original) * 0.8)
    expect(first.tools.map((tool) => tool.name)).toEqual(['present', 'read', 'tool_describe', 'tool_search'])
    expect(defs.length).toBeGreaterThan(20)
    expect(first.tools.find((tool) => tool.name === 'present')).toBeDefined()
    for (const def of defs.filter((tool) => tool.meta.deferLoading === 'auto'))
      expect(first.tools.some((tool) => tool.name === def.name)).toBe(false)
    expect(first.system).toContain('job_list')
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(results[0]?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
    expect(JSON.stringify(results[1]?.data)).toContain('job_list')
    expect(results[3]).toBeDefined()
    expect(results[3]?.data).not.toHaveProperty('isError', true)
    expect(provider.requests[3]?.tools.find((tool) => tool.name === 'job_list')?.parameters).toEqual(
      JSON.parse(JSON.stringify(jobList.parameters)),
    )
  } finally {
    await session.close()
    await eager.close()
    await jobs.dispose()
  }
})
