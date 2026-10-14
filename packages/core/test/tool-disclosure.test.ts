import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { expect, it } from 'vitest'
import { AUTO_DEFER_MAX_TOOLS, ToolRegistry } from '../src/registry/tools.js'
import { deferredToolsSection } from '../src/request/deferred-tools.js'
import { discloseTools } from '../src/step/inference.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

it.each(['allowed-once', 'rejected'] as const)(
  'loads a deferred schema durably while preserving argument validation and %s approval',
  async (verdict) => {
    const registry = new ToolRegistry()
    const executed: unknown[] = []
    const checked: ToolDef = {
      ...(readTool(async (args) => {
        executed.push(args)
        return { content: [{ type: 'text', text: 'executed' }] }
      }) as ToolDef),
      name: 'later',
      parameters: Type.Object({ amount: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
      meta: { ...(readTool() as ToolDef).meta, deferLoading: true, requiresApproval: 'always' },
    }
    const describe: ToolDef = {
      ...(readTool() as ToolDef),
      name: 'describe',
      parameters: Type.Object({ name: Type.String() }),
      async execute({ name }, ctx) {
        await ctx.tools.disclose!(name)
        return { content: [{ type: 'text', text: name }] }
      },
    }
    for (const tool of [describe, checked]) registry.add(tool, { source: 'test', trust: 'builtin' })
    const approvals: string[] = []
    const provider = fakeProvider([
      toolTurn('later', { amount: 1 }), // Merely knowing its name cannot bypass discovery.
      toolTurn('describe', { name: 'later' }),
      toolTurn('later', { amount: 0 }),
      toolTurn('later', { amount: 1 }),
      textTurn('done'),
    ])
    const seams = fakeSeams({
      approval: {
        ask: async (request) => {
          approvals.push(request.tool?.name ?? '')
          return { verdict, answeredBy: actor }
        },
      },
    })
    const { session, storage } = await openSession({ provider, registry, seams })
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'discover' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const catalogText = provider.requests[0]?.system.match(
      /<available_deferred_tools>[\s\S]*?<\/available_deferred_tools>/,
    )?.[0]
    expect(catalogText).toContain('later —')
    expect(provider.requests[2]?.system).toContain(catalogText!)
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(['describe'])
    expect(provider.requests[2]?.tools.find((tool) => tool.name === 'later')?.parameters).toEqual(
      JSON.parse(JSON.stringify(checked.parameters)),
    )
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(results[0]?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
    expect(results[2]?.data).toMatchObject({ code: 'TOOL_ARGS_INVALID', isError: true })
    expect(executed).toEqual(verdict === 'allowed-once' ? [{ amount: 1 }] : [])
    expect(approvals).toHaveLength(1)
    await session.close()
    registry.add(
      { ...checked, name: 'new_later', description: 'New live capability.' },
      { source: 'test', trust: 'builtin' },
    )
    const reopened = await openSession({
      storage,
      registry,
      seams,
      provider: fakeProvider([textTurn('ready')]),
      writerRunId: 'r2',
    })
    try {
      await reopened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'continue' }] })
      await reopened.session.acceptInput()
      await reopened.session.runInference()
      expect(discloseTools(reopened.session)).toContain('later')
      expect((reopened.session.d.provider as ReturnType<typeof fakeProvider>).requests[0]?.system).toContain(
        'later —',
      )
      expect((reopened.session.d.provider as ReturnType<typeof fakeProvider>).requests[0]?.system).toContain(
        'new_later — New live capability.',
      )
      const rows = await reopened.session.scan({
        type: 'x/core/tool-disclosed',
        toSeq: reopened.session.lastSeq,
      })
      expect(rows.map((row) => row.data)).toEqual([{ name: 'later' }])
    } finally {
      await reopened.session.close()
    }
  },
)

it('renders a deterministic live deferred catalog and bounds long descriptions and catalogs', () => {
  const eager = readTool() as ToolDef
  const row = (name: string, description = 'Search records. More details.') => ({
    ...eager,
    name,
    description,
    meta: { ...eager.meta, deferLoading: true },
  })
  const rows = [
    row('zeta'),
    row('alpha'),
    eager,
    { ...row('ui_submit'), meta: { ...row('ui_submit').meta, modelVisible: false } },
  ]
  const section = deferredToolsSection(rows)
  expect(section).toEqual(deferredToolsSection([...rows].reverse()))
  expect(section?.text).toContain('alpha — Search records.\nzeta — Search records.')
  expect(section?.text).not.toContain('ui_submit')
  expect(section?.text).not.toContain('More details')
  expect(deferredToolsSection([eager])).toBeUndefined()
  const long = deferredToolsSection([row('long', '界😀'.repeat(200))])!.text
  expect(long).toContain('…')
  expect(long).not.toContain('\ufffd')
  const huge = deferredToolsSection(
    Array.from({ length: 1000 }, (_, i) => row(`tool_${i}`, '界😀'.repeat(200))),
  )!
  expect(new TextEncoder().encode(huge.text).byteLength).toBeLessThanOrEqual(8192)
  expect(huge.text).toMatch(/omitted \d+ deferred tools; use tool_search/)
  expect(huge.text).toContain('</available_deferred_tools>')
})

it('keeps internal UI collection out of model requests, discovery and disclosure', async () => {
  const registry = new ToolRegistry()
  const eager = readTool() as ToolDef
  const seen: string[][] = []
  registry.add(
    { ...eager, name: 'hidden_collect', meta: { ...eager.meta, deferLoading: true, modelVisible: false } },
    { source: 'test', trust: 'builtin' },
  )
  registry.add(
    {
      ...eager,
      name: 'describe',
      async execute(_args, ctx) {
        seen.push(ctx.tools.list().map((tool) => tool.name))
        await expect(ctx.tools.disclose!('hidden_collect')).rejects.toMatchObject({ code: 'E_ENVELOPE' })
        return { content: [{ type: 'text', text: 'internal target unavailable' }] }
      },
    },
    { source: 'test', trust: 'builtin' },
  )
  const provider = fakeProvider([toolTurn('hidden_collect', {}), toolTurn('describe', {}), textTurn('done')])
  const { session } = await openSession({ provider, registry })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'discover' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(
      provider.requests.every((request) => request.tools.every((tool) => tool.name !== 'hidden_collect')),
    ).toBe(true)
    expect(provider.requests[0]?.system).not.toContain('hidden_collect')
    expect(seen).toEqual([['describe']])
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(results[0]?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
  } finally {
    await session.close()
  }
})

it('defers auto tools together once they pass the count or size limit, and leaves fixed modes alone', () => {
  const eager = readTool() as ToolDef
  const auto = (name: string, note?: string) => ({
    ...eager,
    name,
    ...(note ? { parameters: Type.Object({ query: Type.String({ description: note }) }) } : {}),
    meta: { ...eager.meta, deferLoading: 'auto' as const },
  })
  const fixed = [
    { ...eager, name: 'always_shown', meta: { ...eager.meta, deferLoading: false } },
    { ...eager, name: 'on_demand', meta: { ...eager.meta, deferLoading: true } },
  ]
  const deferredNames = (count: number, note?: string) => {
    const registry = new ToolRegistry()
    for (const tool of [...fixed, ...Array.from({ length: count }, (_, i) => auto(`auto_${i}`, note))])
      registry.add(tool, { source: 'test', trust: 'builtin' })
    return registry
      .snapshot(0)
      .defs.filter((def) => def.meta.deferLoading === true)
      .map((def) => def.name)
  }
  expect(deferredNames(AUTO_DEFER_MAX_TOOLS)).toEqual(['on_demand'])
  expect(deferredNames(AUTO_DEFER_MAX_TOOLS + 1)).toHaveLength(AUTO_DEFER_MAX_TOOLS + 2)
  // A few tools with very large schemas cost as much as many small ones.
  expect(deferredNames(3, 'x'.repeat(6000))).toEqual(['auto_0', 'auto_1', 'auto_2', 'on_demand'])
  const registry = new ToolRegistry()
  registry.add(auto('only'), { source: 'test', trust: 'builtin' })
  expect(registry.snapshot(0).defs[0]?.meta.deferLoading).toBe(false)
  expect(registry.resolve('only')?.meta.deferLoading).toBe('auto')
})

it('lists a discovery group as one line with its count instead of one line per tool', () => {
  const eager = readTool() as ToolDef
  const grouped = Array.from({ length: 8 }, (_, i) => ({
    ...eager,
    name: `mcp__github__tool_${i}`,
    meta: { ...eager.meta, deferLoading: true, discoveryGroup: 'GitHub (MCP server)' },
  }))
  const lone = { ...eager, name: 'lone', meta: { ...eager.meta, deferLoading: true } }
  const text = deferredToolsSection([...grouped, lone])!.text
  expect(text).toContain(
    'GitHub (MCP server) — 8 tools (mcp__github__tool_0, mcp__github__tool_1, mcp__github__tool_2, mcp__github__tool_3, mcp__github__tool_4, mcp__github__tool_5, … 2 more); search by task or by "GitHub (MCP server)"',
  )
  expect(text).toContain('lone —')
  expect(text).not.toContain('mcp__github__tool_7')
})

it('loads an auto-deferred tool by describe and runs it through the same approval as any call', async () => {
  const registry = new ToolRegistry()
  const executed: unknown[] = []
  const approvals: string[] = []
  const base = readTool(async (args) => {
    executed.push(args)
    return { content: [{ type: 'text', text: 'executed' }] }
  }) as ToolDef
  for (let i = 0; i <= AUTO_DEFER_MAX_TOOLS; i++)
    registry.add(
      {
        ...base,
        name: `remote_${i}`,
        meta: { ...base.meta, deferLoading: 'auto', requiresApproval: 'always', discoveryGroup: 'Remote' },
      },
      { source: 'test', trust: 'builtin' },
    )
  registry.add(
    {
      ...(readTool() as ToolDef),
      name: 'describe',
      parameters: Type.Object({ name: Type.String() }),
      async execute({ name }, ctx) {
        await ctx.tools.disclose!(name)
        return { content: [{ type: 'text', text: name }] }
      },
    },
    { source: 'test', trust: 'builtin' },
  )
  const provider = fakeProvider([
    toolTurn('remote_3', {}),
    toolTurn('describe', { name: 'remote_3' }),
    toolTurn('remote_3', {}),
    textTurn('done'),
  ])
  const seams = fakeSeams({
    approval: {
      ask: async (request) => {
        approvals.push(request.tool?.name ?? '')
        return { verdict: 'allowed-once', answeredBy: actor }
      },
    },
  })
  const { session } = await openSession({ provider, registry, seams })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'use remote' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(['describe'])
    expect(provider.requests[0]?.system).toContain(`Remote — ${AUTO_DEFER_MAX_TOOLS + 1} tools`)
    expect(provider.requests[2]?.tools.map((tool) => tool.name)).toEqual(['describe', 'remote_3'])
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(results[0]?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
    expect(JSON.stringify(results[0]?.data)).toContain('call tool_describe')
    expect(executed).toEqual([{}])
    expect(approvals).toEqual(['remote_3'])
  } finally {
    await session.close()
  }
})
