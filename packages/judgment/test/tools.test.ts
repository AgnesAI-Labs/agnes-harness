import { createHash } from 'node:crypto'
import type { PluginContextFacets, ToolContext, ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createJudgmentRuntime, type JudgmentRuntime } from '../src/runtime.js'
import { registerJudgmentTools } from '../src/uses/tools.js'

function fixture(config: unknown, native = true) {
  const definitions = new Map<string, ToolDef>()
  let targets: ReturnType<JudgmentRuntime['current']> = null
  let changed = () => {}
  const judge = {
    judge: vi.fn(async () => ({
      status: 'ok',
      answers: { q: { type: 'noul', noul: 0.8 } },
      probabilityAvailable: native,
      accounting: { calls: [] },
    })),
  }
  const runtime = {
    current: () => targets,
    subscribe: (fn: () => void) => {
      changed = fn
      return () => {}
    },
    judge: vi.fn(async () => judge),
  } as unknown as JudgmentRuntime
  const plugin = {
    tools: {
      register: (def: ToolDef) => {
        definitions.set(def.name, def)
        return () => {
          definitions.delete(def.name)
        }
      },
    },
    projections: { register: () => () => {} },
    self: { signal: new AbortController().signal },
  } as unknown as PluginContextFacets
  const dispose = registerJudgmentTools(plugin, runtime, config)
  const ctx = {
    signal: new AbortController().signal,
    session: { key: 's', toolUseId: 't', depth: 0, generationDepth: 0, workspaceRoot: '/repo' },
    sideCall: {},
    projections: {
      readOwn: async () => ({
        status: 'available',
        value: { sessionHash: createHash('sha256').update('s').digest('hex'), child: false },
      }),
    },
  } as unknown as ToolContext
  return {
    plugin,
    definitions,
    runtime,
    judge,
    dispose,
    ctx,
    ready(value: boolean) {
      targets = value ? [{ route: 'r', model: 'm', native }] : null
      changed()
    },
  }
}
const tool = (definitions: Map<string, ToolDef>, name: string) => {
  const definition = definitions.get(name)
  if (!definition) throw new Error(`Tool ${name} absent`)
  return definition
}
const enabled = { uses: { find: { enabled: true }, batch: { enabled: true } } }
const valid = {
  items: [{ id: 'one', state: { text: 'synthetic' } }],
  questions: { q: { type: 'noul', instructions: 'Relevant?' } },
}
it('binds concurrent find calls to native captured catalogues while keeping text batch dispatch', async () => {
  const f = fixture(enabled)
  f.dispose()
  let reads = 0,
    textOnly = false
  Object.assign(f.plugin.self, {
    log: { warn() {} },
    sideModels: {
      async list() {
        reads++
        return [
          {
            route: 'selected',
            model: 'j',
            api: textOnly || reads === 2 ? 'openai-completions' : 'typesafe-systemone',
          },
        ]
      },
    },
  })
  const config = { ...enabled, judge: { route: 'selected', model: 'j' } }
  const runtime = createJudgmentRuntime(f.plugin, config)
  const prepared: Array<{ output: string }> = []
  const invoked: Array<{ output: string }> = []
  Object.assign(f.ctx, {
    fs: {
      stat: async (path: string) => ({ kind: path === '/repo' ? 'dir' : 'file', size: 15, mtimeMs: 1 }),
      list: async () => [{ name: 'sample.ts', kind: 'file' }],
      read: async () => Buffer.from('semantic match\n'),
    },
    sideCall: {
      status: async (invocationId: string) => ({ status: 'absent', invocationId }),
      prepare: async (input: { output: string }) => {
        prepared.push(input)
        return input
      },
      invoke: async (input: { output: string }) => {
        invoked.push(input)
        return { status: 'refused', reason: 'budget' }
      },
    },
  })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const dispose = registerJudgmentTools(f.plugin, runtime, config)
  try {
    const find = tool(f.definitions, 'find_relevant')
    await Promise.all([
      find.execute({ query: 'semantic' }, f.ctx),
      find.execute({ query: 'semantic' }, { ...f.ctx, session: { ...f.ctx.session, toolUseId: 'second' } }),
    ])
    expect(reads).toBe(3)
    expect(runtime.current()).toEqual([{ route: 'selected', model: 'j', native: true }])
    expect(prepared.map((input) => input.output)).toEqual(['json'])
    expect(invoked.map((input) => input.output)).toEqual(['json'])
    textOnly = true
    await tool(f.definitions, 'judge_batch').execute(valid, f.ctx)
    expect(prepared.map((input) => input.output)).toEqual(['json', 'text'])
    expect(invoked.map((input) => input.output)).toEqual(['json', 'text'])
  } finally {
    dispose()
    runtime.dispose()
  }
})
it('registers only opted-in available tools, refreshes and revokes them', () => {
  const off = fixture({})
  off.ready(true)
  expect([...off.definitions.keys()]).toEqual([])
  off.dispose()
  const f = fixture(enabled)
  expect(f.definitions.size).toBe(0)
  f.ready(true)
  expect([...f.definitions.keys()].sort()).toEqual(['find_relevant', 'judge_batch'])
  f.ready(false)
  expect(f.definitions.size).toBe(0)
  f.ready(true)
  f.dispose()
  expect(f.definitions.size).toBe(0)
  const text = fixture(enabled, false)
  text.ready(true)
  expect([...text.definitions.keys()]).toEqual(['judge_batch'])
  text.dispose()
})
it('refuses inherited, isolated and unavailable-projection execution without judgment', async () => {
  const f = fixture(enabled)
  f.ready(true)
  for (const ctx of [
    { ...f.ctx, sideCall: undefined },
    { ...f.ctx, session: { ...f.ctx.session, depth: 1 } },
    { ...f.ctx, projections: { readOwn: async () => ({ status: 'unavailable' }) } },
    { ...f.ctx, session: { ...f.ctx.session, key: 'different' } },
  ]) {
    const result = await tool(f.definitions, 'judge_batch').execute(valid, ctx as ToolContext)
    expect(result.isError).toBe(true)
  }
  expect(f.runtime.judge).not.toHaveBeenCalled()
  f.dispose()
})
it('rejects complete invalid batches before resolving any judgment port', async () => {
  const f = fixture(enabled)
  f.ready(true)
  for (const args of [
    { ...valid, items: [] },
    { ...valid, items: Array.from({ length: 501 }, (_, n) => ({ id: String(n), state: null })) },
    { ...valid, items: [valid.items[0], valid.items[0]] },
    { ...valid, items: [{ id: 'raw', state: { password: 'x'.repeat(1048576) } }] },
    { ...valid, questions: { q: { type: 'noul', instructions: `password="${'x'.repeat(1048576)}"` } } },
    { ...valid, questions: { q: { type: 'choice', instructions: '?', criteria: { yes: 'yes', no: 'no' } } } },
    { ...valid, questions: { q: { type: 'bad' } } },
    { ...valid, questions: { q: { type: 'noul', instructions: '\u200B' } } },
    {
      ...valid,
      items: [
        { id: 'good', state: null },
        { id: 'bad', state: undefined },
      ],
    },
    { ...valid, questions: { [`ghp_${'a'.repeat(36)}`]: { type: 'noul', instructions: 'Synthetic?' } } },
    {
      ...valid,
      questions: {
        q: {
          type: 'choice',
          instructions: 'Synthetic?',
          criteria: { other: 'none', mixed: 'multiple', 'password=fixture-pass': 'synthetic' },
        },
      },
    },
  ]) {
    expect((await tool(f.definitions, 'judge_batch').execute(args, f.ctx)).isError).toBe(true)
  }
  for (const args of [{ query: '' }, { query: 'x'.repeat(2001) }, { query: 'ok', path: 'x'.repeat(2049) }])
    expect((await tool(f.definitions, 'find_relevant').execute(args, f.ctx)).isError).toBe(true)
  expect(f.runtime.judge).not.toHaveBeenCalled()
  f.dispose()
})

it('covers preparation and local traversal inside the use deadline', async () => {
  vi.useFakeTimers()
  const f = fixture(enabled)
  f.ready(true)
  try {
    const batch = f.definitions.get('judge_batch')
    const find = f.definitions.get('find_relevant')
    if (!batch || !find) throw new Error('tools absent')
    vi.mocked(f.runtime.judge).mockImplementationOnce(() => new Promise(() => {}))
    const preparing = batch.execute(valid, f.ctx)
    await vi.advanceTimersByTimeAsync(60000)
    expect(await preparing).toMatchObject({ structured: { completed: [], pending: ['one'], partial: true } })
    const traversing = find.execute({ query: 'synthetic' }, {
      ...f.ctx,
      fs: { stat: async () => new Promise(() => {}) },
    } as unknown as ToolContext)
    await vi.advanceTimersByTimeAsync(20000)
    expect(await traversing).toMatchObject({ structured: { partial: true, reasons: ['cancelled'] } })
    expect(f.judge.judge).not.toHaveBeenCalled()
  } finally {
    f.dispose()
    vi.useRealTimers()
  }
})

it('rechecks readiness after resolving the invocation judge', async () => {
  const f = fixture(enabled)
  f.ready(true)
  const definition = f.definitions.get('find_relevant')
  if (!definition) throw new Error('find absent')
  vi.mocked(f.runtime.judge).mockImplementationOnce(async () => {
    f.ready(false)
    return f.judge as never
  })
  expect((await definition.execute({ query: 'synthetic' }, f.ctx)).isError).toBe(true)
  expect(f.judge.judge).not.toHaveBeenCalled()
  f.dispose()
})

it('advertises the full question union in its executable schema', () => {
  const f = fixture(enabled)
  f.ready(true)
  const schema = tool(f.definitions, 'judge_batch').parameters
  expect(validateAgainst(schema, valid).ok).toBe(true)
  expect(validateAgainst(schema, { ...valid, questions: { q: { type: 'noul' } } }).ok).toBe(false)
  expect(
    validateAgainst(schema, { ...valid, questions: { q: { type: 'unknown', instructions: '?' } } }).ok,
  ).toBe(false)
  expect(
    validateAgainst(schema, {
      ...valid,
      questions: { q: { type: 'score', instructions: '?', criteria: ['one', 'two'] } },
    }).ok,
  ).toBe(true)
  f.dispose()
})

it('returns actual item answers in model-facing text alongside structured output', async () => {
  const f = fixture(enabled)
  f.ready(true)
  try {
    const result = await tool(f.definitions, 'judge_batch').execute(valid, f.ctx)
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    expect(text).toContain('"id":"one"')
    expect(text).toContain('"noul":0.8')
  } finally {
    f.dispose()
  }
})

it('skips cancelled batch preparation and preserves ids without reading states', async () => {
  const f = fixture(enabled)
  f.ready(true)
  let touched = 0
  const items = Array.from({ length: 20 }, (_, n) => ({
    id: String(n),
    get state() {
      touched++
      return { text: 'synthetic' }
    },
  }))
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await tool(f.definitions, 'judge_batch').execute(
      { ...valid, items },
      { ...f.ctx, signal: controller.signal },
    )
    expect(touched).toBe(0)
    expect(result).toMatchObject({
      structured: { completed: [], pending: items.map((item) => item.id), partial: true },
    })
    expect(f.runtime.judge).not.toHaveBeenCalled()
  } finally {
    f.dispose()
  }
})

it('stops actual whole-batch preparation at the absolute deadline before obtaining a judge', async () => {
  const f = fixture(enabled)
  f.ready(true)
  let elapsed = 0,
    touched = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed)
  const items = Array.from({ length: 20 }, (_, n) => ({
    id: String(n),
    get state() {
      touched++
      elapsed = 60001
      return { text: 'synthetic' }
    },
  }))
  try {
    const result = await tool(f.definitions, 'judge_batch').execute({ ...valid, items }, f.ctx)
    expect(touched).toBeLessThan(items.length)
    expect(result).toMatchObject({
      structured: { completed: [], pending: items.map((item) => item.id), partial: true },
    })
    expect(f.runtime.judge).not.toHaveBeenCalled()
  } finally {
    clock.mockRestore()
    f.dispose()
  }
})

it('yields actual question preparation so cancellation runs before any batch dispatch', async () => {
  const f = fixture(enabled)
  f.ready(true)
  const controller = new AbortController()
  const questions = Object.fromEntries(
    Array.from({ length: 200 }, (_, n) => [`q${n}`, { type: 'noul', instructions: 'Is this synthetic?' }]),
  )
  const cancel = setImmediate(() => controller.abort())
  try {
    const result = await tool(f.definitions, 'judge_batch').execute(
      { ...valid, questions },
      { ...f.ctx, signal: controller.signal },
    )
    expect(result).toMatchObject({ structured: { completed: [], pending: ['one'], partial: true } })
    expect(f.runtime.judge).not.toHaveBeenCalled()
    expect(f.judge.judge).not.toHaveBeenCalled()
  } finally {
    clearImmediate(cancel)
    f.dispose()
  }
})
