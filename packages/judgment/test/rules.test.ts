import type { HookContext, HookHandler, PluginContextFacets } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
import type { Judge } from '../src/judge.js'
import type { JudgmentRuntime } from '../src/runtime.js'
import { registerRuleChecks } from '../src/uses/rules.js'
import { createRulesProjection } from '../src/uses/rules-projection.js'

const owner = 'plugin/524280817e87343c'
const rule = { id: 'r', text: 'Never delete records', tools: ['exec'] }
function fixture(items = [rule]) {
  const projection = createRulesProjection(owner)
  const rows: any[] = [
    { seq: 1, type: 'session/start', data: { key: 's' }, origin: 'system', trust: 'trusted' },
  ]
  let state = rows.reduce(projection.apply, projection.init())
  let handler!: HookHandler<'tool_result'>
  const result = {
    content: [{ type: 'text' as const, text: 'deleted record' }],
    isError: false,
    details: { private: true },
    structured: { kept: true },
    terminate: false,
  }
  const payload = {
    toolUseId: 't',
    name: 'exec',
    args: { command: 'delete record' },
    result,
    enforcement: { level: 'full', scope: [] },
  } as any
  const judge: Judge = {
    judge: vi.fn<Judge['judge']>(async (_purpose, req) => ({
      status: 'ok',
      answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: 'noul', noul: 0.7 }])),
      cached: false,
      model: 'j',
      backend: 'native',
      probabilityAvailable: true,
      accounting: { calls: [] },
    })),
  }
  const runtime = {
    current: () => [{ route: 'jev', model: 'j', native: true }],
    judge: vi.fn(async () => judge),
  } as unknown as JudgmentRuntime
  const append = vi.fn(async (name: string, data: any) => {
    const row = {
      seq: rows.length + 1,
      type: `x/${owner}/${name}`,
      data,
      origin: `ext:${owner}`,
      trust: 'untrusted',
    }
    rows.push(row)
    state = projection.apply(state, row as any)
    return row.seq
  })
  const plugin = {
    hooks: {
      register: vi.fn((_name, fn) => {
        handler = fn
        return () => {}
      }),
    },
    projections: { register: () => () => {} },
    self: { extId: owner, signal: new AbortController().signal },
    eventLog: { append },
  } as unknown as PluginContextFacets
  const controller = new AbortController()
  const ctx = {
    signal: controller.signal,
    session: { key: 's' },
    sideCall: {},
    projections: { readOwn: vi.fn(async () => ({ status: 'available', value: state })) },
  } as unknown as HookContext
  const config = { uses: { rules: { enabled: true, items } } }
  const dispose = registerRuleChecks(plugin, runtime, config)
  return {
    plugin,
    runtime,
    judge,
    append,
    controller,
    ctx,
    payload,
    result,
    config,
    rows,
    projection,
    dispose,
    run: () => handler(payload, ctx),
    get state() {
      return state
    },
    set state(next) {
      state = next
    },
  }
}
it('combines rules in one native call, persists each version first and preserves the entire result', async () => {
  const f = fixture([rule, { ...rule, id: 'second', text: 'Keep backups' }])
  const output = await f.run()
  expect(output.result).toEqual({
    ...f.result,
    content: [...f.result.content, { type: 'text', text: expect.stringContaining('Never delete records') }],
  })
  expect(output.result?.content).toHaveLength(2)
  expect(f.append).toHaveBeenCalledTimes(2)
  expect(f.judge.judge).toHaveBeenCalledTimes(1)
  expect(vi.mocked(f.judge.judge).mock.calls[0]).toMatchObject([
    'judgment.rules',
    { state: { tool: 'exec' } },
    { retry: 'none', allowSplit: false, attemptMs: 1500 },
  ])
  expect(await f.run()).toEqual({})
  const restarted = fixture([rule])
  restarted.state = JSON.parse(JSON.stringify(f.rows)).reduce(
    restarted.projection.apply,
    restarted.projection.init(),
  )
  expect(await restarted.run()).toEqual({})
  const other = fixture()
  Object.assign(other.ctx, { session: { key: 'other' } })
  other.state = other.projection.apply(other.projection.init(), { ...other.rows[0], data: { key: 'other' } })
  expect((await other.run()).result?.content).toHaveLength(2)
})
it.each([
  'disabled',
  'similar-tool',
  'child',
  'identity',
  'projection',
  'text-primary',
  'low',
  'write-failure',
  'unconfirmed',
  'aborted',
  'disposed',
  'saturated',
] as const)('passes the original result unchanged for %s', async (kind) => {
  const f = fixture()
  if (kind === 'disabled') f.config.uses.rules.enabled = false
  if (kind === 'similar-tool') f.payload.name = 'exec_more'
  if (kind === 'child') f.state = { ...f.state, child: true }
  if (kind === 'identity') Object.assign(f.ctx, { session: { key: 'different' } })
  if (kind === 'projection')
    vi.mocked(f.ctx.projections.readOwn).mockResolvedValue({ status: 'unavailable' } as any)
  if (kind === 'text-primary') f.runtime.current = () => [{ route: 'chat', model: 'c', native: false }]
  if (kind === 'low')
    vi.mocked(f.judge.judge).mockResolvedValue({
      status: 'ok',
      answers: { r0: { type: 'noul', noul: 0.699 } },
      backend: 'native',
      probabilityAvailable: true,
    } as any)
  if (kind === 'write-failure') f.append.mockRejectedValue(new Error('failed'))
  if (kind === 'unconfirmed') f.append.mockResolvedValue(2)
  if (kind === 'aborted') f.controller.abort()
  if (kind === 'disposed') f.dispose()
  if (kind === 'saturated') f.state = { ...f.state, identities: Array(2048).fill('a'.repeat(64)) }
  expect(await f.run()).toEqual({})
  expect(f.result.content).toHaveLength(1)
})
it('reserves each identity across concurrency, releases on failure and permits changed rule versions', async () => {
  const f = fixture()
  let finish!: () => void
  const initial = vi.mocked(f.judge.judge).getMockImplementation()!
  vi.mocked(f.judge.judge).mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return initial(...args)
  })
  const first = f.run()
  for (let i = 0; i < 15; i++) await Promise.resolve()
  expect(await f.run()).toEqual({})
  finish()
  expect((await first).result?.content).toHaveLength(2)
  f.config.uses.rules.items[0] = { ...rule, text: 'Updated rule' }
  vi.mocked(f.judge.judge).mockImplementation(initial)
  expect((await f.run()).result?.content).toHaveLength(2)
  const failed = fixture()
  failed.append.mockRejectedValueOnce(new Error('write'))
  expect(await failed.run()).toEqual({})
  expect((await failed.run()).result?.content).toHaveLength(2)
})
it('redacts complete context before taking the original argument prefix and result suffix', async () => {
  const f = fixture()
  f.payload.args = { password: 's'.repeat(2500), sentinel: 'OUTSIDE_ARGUMENT_WINDOW' }
  f.payload.result.content = [
    { type: 'text', text: 'OUTSIDE_RESULT_WINDOW ' + 'A'.repeat(7900) + ' password=' + 's'.repeat(200) },
  ]
  await f.run()
  const state = vi.mocked(f.judge.judge).mock.calls[0]![1].state as any
  expect(state.args.length).toBeLessThanOrEqual(2000)
  expect(state.result.length).toBeLessThanOrEqual(8000)
  expect(JSON.stringify(state)).not.toContain('OUTSIDE_')
  expect(JSON.stringify(state)).not.toContain('s'.repeat(20))
})
it('includes lookup, judging and marker confirmation in the total 1500ms deadline', async () => {
  vi.useFakeTimers()
  try {
    for (const phase of ['projection', 'catalogue', 'judge', 'marker']) {
      const f = fixture()
      if (phase === 'projection')
        vi.mocked(f.ctx.projections.readOwn).mockImplementation(async () => new Promise(() => {}))
      if (phase === 'catalogue')
        vi.mocked(f.runtime.judge).mockImplementation(async () => new Promise(() => {}))
      if (phase === 'judge') vi.mocked(f.judge.judge).mockImplementation(async () => new Promise(() => {}))
      if (phase === 'marker') f.append.mockImplementation(async () => new Promise(() => {}))
      const pending = f.run()
      await vi.advanceTimersByTimeAsync(1500)
      expect(await pending).toEqual({})
      f.dispose()
    }
  } finally {
    vi.useRealTimers()
  }
})
it('never retries or reminds on budget refusal, invalid probability, or cancellation during persistence', async () => {
  const budget = fixture()
  vi.mocked(budget.judge.judge).mockResolvedValue({
    status: 'failed',
    reason: 'budget',
    accounting: { calls: [] },
  })
  expect(await budget.run()).toEqual({})
  expect(budget.append).not.toHaveBeenCalled()
  const cancelled = fixture()
  cancelled.append.mockImplementation(async () => {
    cancelled.controller.abort()
    return 2
  })
  expect(await cancelled.run()).toEqual({})
  for (const value of [NaN, Infinity, -1, 1.1]) {
    const invalid = fixture()
    vi.mocked(invalid.judge.judge).mockResolvedValue({
      status: 'ok',
      answers: { r0: { type: 'noul', noul: value } },
      backend: 'native',
      probabilityAvailable: true,
    } as any)
    expect(await invalid.run()).toEqual({})
    expect(invalid.append).not.toHaveBeenCalled()
  }
})
it('masks credentials in configured rule evidence and in the appended reminder', async () => {
  const f = fixture([{ ...rule, text: 'Never expose password=synthetic_rule_secret' }])
  const output = await f.run()
  expect(JSON.stringify(vi.mocked(f.judge.judge).mock.calls[0]?.[1].state)).not.toContain(
    'synthetic_rule_secret',
  )
  expect(JSON.stringify(output)).not.toContain('synthetic_rule_secret')
})
it.each(['too-many-rules', 'long-text', 'too-many-tools', 'duplicate-id', 'string-enabled'] as const)(
  'sends nothing for invalid rule config %s',
  async (kind) => {
    const f = fixture()
    if (kind === 'too-many-rules')
      f.config.uses.rules.items = Array.from({ length: 33 }, (_, i) => ({ ...rule, id: `r${i}` }))
    if (kind === 'long-text') f.config.uses.rules.items = [{ ...rule, text: 'r'.repeat(1001) }]
    if (kind === 'too-many-tools')
      f.config.uses.rules.items = [
        { ...rule, tools: ['exec', ...Array.from({ length: 16 }, (_, i) => `t${i}`)] },
      ]
    if (kind === 'duplicate-id') f.config.uses.rules.items = [rule, rule]
    if (kind === 'string-enabled') Object.assign(f.config.uses.rules, { enabled: 'true' })
    expect(await f.run()).toEqual({})
    expect(f.judge.judge).not.toHaveBeenCalled()
  },
)
it('matches leading-underscore names using the public Core tool-name contract', async () => {
  const f = fixture([{ ...rule, tools: ['_tool'] }])
  f.payload.name = '_tool'
  expect((await f.run()).result?.content).toHaveLength(2)
})
it.each(['1tool', 'bad.name', 'bad:tool', 'a'.repeat(65)])(
  'rejects a configured name outside the public Core contract: %s',
  async (name) => {
    const f = fixture([{ ...rule, tools: [name] }])
    f.payload.name = name
    expect(await f.run()).toEqual({})
    expect(f.judge.judge).not.toHaveBeenCalled()
  },
)
