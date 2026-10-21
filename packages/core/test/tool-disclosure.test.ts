import { canonicalJson } from '@agnes/core-common/request/hash'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { type LoopFactory, loopCheckpointCodec, type ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { toolAvailability } from '../src/execution/turn/tool-availability.js'
import { createLoopContext } from '../src/loop/ports.js'
import { onlyTools } from '../src/registry/tool-allow.js'
import { AUTO_DEFER_MAX_TOOLS, ToolRegistry } from '../src/registry/tools.js'
import { deferredToolsSection } from '../src/request/deferred-tools.js'
import type { RequestHeaderData } from '../src/request/derive.js'
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
    expect(results[0]?.data).toMatchObject({
      code: 'TOOL_NOT_DISCLOSED',
      isError: true,
      content: [{ text: expect.stringContaining('request_selection') }],
    })
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
    { ...eager, name: 'tool_search', meta: { ...eager.meta, deferLoading: false } },
    { ...eager, name: 'tool_describe', meta: { ...eager.meta, deferLoading: false } },
    { ...eager, name: 'always_shown', meta: { ...eager.meta, deferLoading: false } },
    { ...eager, name: 'on_demand', meta: { ...eager.meta, deferLoading: true } },
  ]
  const deferredNames = (count: number, note?: string, discovery = true) => {
    const registry = new ToolRegistry()
    for (const tool of [
      ...fixed.filter((tool) => discovery || !['tool_search', 'tool_describe'].includes(tool.name)),
      ...Array.from({ length: count }, (_, i) => auto(`auto_${i}`, note)),
    ])
      registry.add(tool, { source: 'test', trust: 'builtin' })
    return registry
      .snapshot(0)
      .defs.filter((def) => def.meta.deferLoading === true)
      .map((def) => def.name)
  }
  expect(deferredNames(AUTO_DEFER_MAX_TOOLS)).toEqual(['on_demand'])
  expect(deferredNames(AUTO_DEFER_MAX_TOOLS + 1)).toHaveLength(AUTO_DEFER_MAX_TOOLS + 2)
  expect(deferredNames(AUTO_DEFER_MAX_TOOLS + 1, undefined, false)).toEqual(['on_demand'])
  // A few tools with very large schemas cost as much as many small ones.
  expect(deferredNames(3, 'x'.repeat(6000))).toEqual(['auto_0', 'auto_1', 'auto_2', 'on_demand'])
  for (const meta of [
    { modelVisible: false },
    { deferLoading: true },
    { deferLoading: 'auto' as const },
    { requiresImageInput: true },
  ]) {
    const registry = new ToolRegistry()
    for (const tool of [
      ...fixed.map((tool) =>
        tool.name === 'tool_describe' ? { ...tool, meta: { ...tool.meta, ...meta } } : tool,
      ),
      ...Array.from({ length: 20 }, (_, i) => auto(`auto_${i}`)),
    ])
      registry.add(tool, { source: 'test', trust: 'builtin' })
    expect(
      registry
        .snapshot(0)
        .defs.filter((tool) => tool.name.startsWith('auto_'))
        .every((tool) => tool.meta.deferLoading === false),
    ).toBe(true)
  }
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

it.each(['allowed-once', 'rejected'] as const)(
  'loads an auto-deferred tool by describe and preserves %s approval',
  async (verdict) => {
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
        name: 'tool_describe',
        parameters: Type.Object({ name: Type.String() }),
        async execute({ name }, ctx) {
          if (!ctx.tools.disclose) throw new Error('expected tool disclosure port')
          await ctx.tools.disclose(name)
          return { content: [{ type: 'text', text: name }] }
        },
      },
      { source: 'test', trust: 'builtin' },
    )
    registry.add({ ...(readTool() as ToolDef), name: 'tool_search' }, { source: 'test', trust: 'builtin' })
    const provider = fakeProvider([
      toolTurn('remote_3', {}),
      toolTurn('tool_describe', { name: 'remote_3' }),
      toolTurn('remote_3', {}),
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
    const { session } = await openSession({ provider, registry, seams })
    try {
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'use remote' }] })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(['tool_describe', 'tool_search'])
      expect(provider.requests[0]?.system).toContain(`Remote — ${AUTO_DEFER_MAX_TOOLS + 1} tools`)
      expect(provider.requests[2]?.tools.map((tool) => tool.name)).toEqual([
        'remote_3',
        'tool_describe',
        'tool_search',
      ])
      const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
      expect(results[0]?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
      expect(JSON.stringify(results[0]?.data)).toContain('call tool_describe')
      expect(executed).toEqual(verdict === 'allowed-once' ? [{}] : [])
      expect(approvals).toEqual(['remote_3'])
    } finally {
      await session.close()
    }
  },
)

describe('the tool catalog of a loop that names its tools', () => {
  const REMOTE_TOOLS = AUTO_DEFER_MAX_TOOLS + 1
  /** A deferred tool that nothing in the turn discloses, and the two discovery tools. */
  const NAMES = ['remote_3', 'tool_describe', 'tool_search']
  const codec = loopCheckpointCodec(1, () => null)
  const idle = () => ({
    checkpoint: () => codec.encode(null),
    cancel() {},
    dispose() {},
    step: async () => ({ outcome: 'idle' as const, phase: 'idle' }),
  })
  /** The session's pinned loop. The cases drive a loop context of their own, so its driver stays idle. */
  const loopFactory: LoopFactory = {
    id: 'test.stable-catalog',
    version: '1.0.0',
    capabilities: ['model', 'tools'],
    codec,
    create: idle,
    resume: idle,
  }
  const signal = () => new AbortController().signal
  const toolNames = (request: { tools: readonly { name: string }[] }) =>
    request.tools.map((tool) => tool.name)

  /**
   * The two discovery tools are registered first and stay visible; then sixteen tools that defer
   * together. Registered without the pair, or with fifteen tools, the group would stay visible and
   * a catalog that never changes would prove nothing.
   */
  function catalogRegistry() {
    const registry = new ToolRegistry()
    const base = readTool() as ToolDef
    const add = (tool: ToolDef) => registry.add(tool, { source: 'test', trust: 'builtin' })
    add({ ...base, name: 'tool_search' })
    add({ ...base, name: 'run_code' })
    add({
      ...base,
      name: 'tool_describe',
      parameters: Type.Object({ name: Type.String() }),
      async execute({ name }, ctx) {
        if (!ctx.tools.disclose) throw new Error('expected tool disclosure port')
        await ctx.tools.disclose(name)
        return { content: [{ type: 'text', text: name }] }
      },
    })
    for (let i = 0; i < REMOTE_TOOLS; i++)
      add({
        ...base,
        name: `remote_${i}`,
        meta: { ...base.meta, deferLoading: 'auto', discoveryGroup: 'Remote' },
      })
    return registry
  }

  type Harness = Awaited<ReturnType<typeof openLoop>>

  async function openLoop() {
    const provider = fakeProvider(Array.from({ length: 4 }, (_, i) => textTurn(`reply ${i + 1}`)))
    const { session } = await openSession({ provider, registry: catalogRegistry(), loopFactory })
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'decide' }] })
    expect(await session.acceptInput()).toBe(true)
    return { session, provider, ctx: await createLoopContext(session) }
  }

  async function withLoop(body: (t: Harness) => Promise<void>) {
    const t = await openLoop()
    try {
      await body(t)
    } finally {
      await t.session.close()
    }
  }

  /** One model request of the loop. */
  async function send(t: Harness, tools?: readonly string[]) {
    const request = await t.ctx.prepareRequest(tools ? { tools } : {})
    await t.ctx.model.complete(request, signal())
    return request
  }

  it('projects the exact custom Loop selection, preserves deferred status within a request and refreshes after loading', async () => {
    await withLoop(async (t) => {
      expect(toolAvailability(t.session, 'remote_3')).toMatchObject({
        status: 'unavailable',
        reason: 'unknown',
      })
      await send(t, ['tool_search'])
      expect(toolAvailability(t.session, 'tool_search').status).toBe('offered')
      expect(toolAvailability(t.session, 'run_code')).toMatchObject({
        status: 'unavailable',
        reason: 'request_selection',
      })
      expect(toolAvailability(t.session, 'tool_describe')).toMatchObject({
        status: 'unavailable',
        reason: 'request_selection',
      })
      expect(toolAvailability(t.session, 'remote_3')).toMatchObject({
        status: 'unavailable',
        reason: 'request_selection',
      })
      await send(t, ['tool_search', 'tool_describe'])
      expect(toolAvailability(t.session, 'remote_3').status).toBe('deferred')
      await disclose(t, 'remote_3')
      expect(toolAvailability(t.session, 'remote_3').status).toBe('deferred')
      await send(t)
      expect(toolAvailability(t.session, 'remote_3').status).toBe('offered')
      expect(toolAvailability(t.session, 'run_code')).toMatchObject({ status: 'unavailable', reason: 'mode' })
      expect(toolAvailability(t.session, 'absent')).toMatchObject({
        status: 'unavailable',
        reason: 'catalog',
      })
      const op = t.session.op()
      if (!op) throw new Error('missing operation')
      await t.session.rehydrateTurn(op)
      expect(toolAvailability(t.session, 'remote_3')).toMatchObject({
        status: 'unavailable',
        reason: 'unknown',
      })
    })
  })

  /** The loop calls the discovery tool, which loads a deferred schema for the rest of the turn. */
  async function disclose(t: Harness, name: string) {
    await t.ctx.tools.execute(
      { invocationId: `disclose-${name}`, name: 'tool_describe', args: { name } },
      signal(),
      { announce: true },
    )
  }

  /** The names `tool_describe` has loaded in this session, in the order they were loaded. */
  async function loadedNames(t: Harness) {
    const rows = await t.session.scan({ type: 'x/core/tool-disclosed', toSeq: t.session.lastSeq })
    return rows.map((row) => (row.data as { name: string }).name)
  }

  /** The `tool_schema_hash` of every request the loop sent, in order. */
  async function schemaHashes(t: Harness) {
    const headers = await t.session.scan({ type: 'request/header', toSeq: t.session.lastSeq })
    return headers.map((row) => (row.data as RequestHeaderData).tool_schema_hash)
  }

  it('keeps the tool bytes and the tool_schema_hash of every request in a turn when the loop passes the same names', async () => {
    await withLoop(async (t) => {
      const first = await send(t, NAMES)
      // The turn catalog is already settled: the sixteen tools are deferred as a group.
      expect(first.system).toContain(`Remote — ${REMOTE_TOOLS} tools`)
      expect(toolNames(first)).toEqual(NAMES)
      await disclose(t, 'remote_5')
      await send(t, NAMES)
      await disclose(t, 'remote_9')
      await send(t, NAMES)
      // Both loads happened, so a loop that followed the disclosure would have seen two new tools.
      expect(await loadedNames(t)).toEqual(['remote_5', 'remote_9'])
      expect(t.provider.requests).toHaveLength(3)
      expect(new Set(t.provider.requests.map((request) => canonicalJson(request.tools))).size).toBe(1)
      expect(new Set(t.provider.requests.map((request) => request.system)).size).toBe(1)
      const hashes = await schemaHashes(t)
      expect(hashes).toHaveLength(3)
      expect(new Set(hashes).size).toBe(1)
    })
  })

  it('does not depend on the order in which the names are listed', async () => {
    await withLoop(async (t) => {
      await send(t, NAMES)
      await disclose(t, 'remote_5')
      await send(t, [...NAMES].reverse())
      // The load happened between the two requests, so the equality below is not for lack of one.
      expect(await loadedNames(t)).toEqual(['remote_5'])
      const [first, second] = t.provider.requests
      expect(canonicalJson(second?.tools)).toBe(canonicalJson(first?.tools))
      const [a, b] = await schemaHashes(t)
      expect(b).toBe(a)
    })
  })

  it('changes between requests when the loop passes no names and a tool is loaded in between', async () => {
    await withLoop(async (t) => {
      const before = await send(t)
      await disclose(t, 'remote_5')
      const after = await send(t)
      expect(toolNames(before)).toEqual(['tool_describe', 'tool_search'])
      expect(toolNames(after)).toEqual(['remote_5', 'tool_describe', 'tool_search'])
      const [a, b] = await schemaHashes(t)
      expect(b).not.toBe(a)
    })
  })

  it('keeps a tool loaded in an earlier turn listed when the loop passes no names, and not when it passes the same names', async () => {
    await withLoop(async (t) => {
      const first = await send(t, NAMES)
      await disclose(t, 'remote_5')
      expect((await t.ctx.events.finish('completed')).outcome).toBe('turn-ended')
      await t.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'again' }] })
      expect(await t.session.acceptInput()).toBe(true)
      // The load belongs to the session, not to the turn that made it.
      expect(await loadedNames(t)).toEqual(['remote_5'])
      const named = await send(t, NAMES)
      const followed = await send(t)
      expect(canonicalJson(named.tools)).toBe(canonicalJson(first.tools))
      expect(toolNames(followed)).toEqual(['remote_5', 'tool_describe', 'tool_search'])
    })
  })
})

it('offers explicit session names without adding discovery authority or changing shared definitions', async () => {
  const base = readTool() as ToolDef
  const registry = new ToolRegistry()
  for (const name of ['tool_search', 'tool_describe', 'explicit', 'outside'])
    registry.add(
      {
        ...base,
        name,
        meta: {
          ...base.meta,
          deferLoading: name === 'explicit' || name === 'outside',
          requiresApproval: 'always',
        },
      },
      { source: 'test', trust: 'builtin' },
    )
  const view = onlyTools(registry, ['explicit'])
  expect(view.snapshot(1).defs.map((d) => [d.name, d.meta.deferLoading])).toEqual([['explicit', false]])
  expect(view.snapshot(1).byName.get('outside')).toBeUndefined()
  expect(view.resolve('tool_describe')).toBeUndefined()
  expect(registry.resolve('explicit')?.meta.deferLoading).toBe(true)
  const asks: string[] = []
  const provider = fakeProvider([toolTurn('explicit', {}), toolTurn('outside', {}), textTurn('done')])
  const { session, storage } = await openSession({
    registry,
    provider,
    preset: { ...presetDefaults(), tools: { ...presetDefaults().tools, allow: ['explicit'] } },
    seams: fakeSeams({
      approval: {
        ask: async (req) => {
          asks.push(req.tool?.name ?? '')
          return { verdict: 'rejected', answeredBy: actor }
        },
      },
    }),
  })
  try {
    await session.enqueue('explicit', { actor, content: [{ type: 'text', text: 'act' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(asks).toEqual(['explicit'])
    expect(JSON.stringify(await storage.scan(session.key, { type: 'tool/result' }))).toContain(
      'TOOL_NOT_FOUND',
    )
  } finally {
    await session.close()
  }
})
