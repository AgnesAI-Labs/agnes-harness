import type { HookContext, HookHandler, PluginContextFacets } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import type { Judge } from '../src/judge.js'
import { createConversationProjection } from '../src/uses/conversation-projection.js'
import { registerStopDetection } from '../src/uses/stop.js'

afterEach(() => vi.useRealTimers())
const actor = { id: 'alice', org: 'test', role: 'user', deptPath: [], attrs: {} }
const row = (seq: number, type: string, data: unknown, origin = 'principal') =>
  ({ seq, type, data, origin, trust: 'trusted', actor }) as any
function fixture(value = 0.9, cached = false) {
  const projection = createConversationProjection('plugin/test')
  let state = projection.apply(
    projection.init(),
    row(1, 'user/message', { kind: 'prompt', content: [{ type: 'text', text: 'fix it' }] }),
  )
  state = projection.apply(
    state,
    row(2, 'assistant/message', {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'I will fix it now' }],
    }),
  )
  let handler: HookHandler<'turn_stopping'>
  const judge: Judge = {
    judge: vi.fn<Judge['judge']>(async () => ({
      status: 'ok',
      answers: { unexpected_stop: { type: 'noul', noul: value } },
      cached,
      model: 'j',
    })),
  }
  const append = vi.fn(async (name: string, data: unknown) => {
    state = projection.apply(state, row(3, `x/plugin/test/${name}`, data, 'ext:plugin/test'))
    return 3
  })
  const hooks = {
    register: vi.fn((_name, fn) => {
      handler = fn
      return vi.fn()
    }),
  }
  const plugin = {
    hooks,
    projections: { register: vi.fn(() => vi.fn()) },
    eventLog: { append },
    self: { extId: 'plugin/test', signal: new AbortController().signal },
  } as unknown as PluginContextFacets
  const controller = new AbortController()
  const ctx = {
    signal: controller.signal,
    session: { key: 's' },
    sideCall: {},
    projections: { readOwn: vi.fn(async () => ({ status: 'available', value: state })) },
  } as unknown as HookContext
  const deps = { judge: vi.fn(async () => judge), config: () => ({ enabled: true }) }
  const dispose = registerStopDetection(plugin, deps)
  return {
    plugin,
    ctx,
    controller,
    deps,
    judge,
    append,
    dispose,
    get state() {
      return state
    },
    set state(s) {
      state = s
    },
    run: () => handler!({ turn: 1, step: 1, proposedReason: 'completed' }, ctx),
  }
}
it('continues when yes-probability >= 0.5', async () => {
  const f = fixture(0.5)
  expect(await f.run()).toEqual({
    action: 'continue',
    note: expect.stringMatching(/^检测到回复说了要做却结束了/),
  })
  expect(f.append).toHaveBeenCalledWith('stop.continued', { requestSeq: 1 })
})
it('marks cached reminders', async () =>
  expect(await fixture(1, true).run()).toMatchObject({ note: expect.stringContaining('（缓存）') }))
it('stops below 0.5', async () => expect(await fixture(0.499).run()).toEqual({ action: 'stop' }))
it.each(['tools', 'child', 'goal', 'unattended', 'missing'] as const)(
  'stops for excluded %s without a judge request',
  async (kind) => {
    const f = fixture()
    if (kind === 'tools') f.state = { ...f.state, reply: { ...f.state.reply!, hasTools: true } }
    if (kind === 'child') f.state = { ...f.state, child: true }
    if (kind === 'goal') f.state = { ...f.state, goalSources: ['alice'] }
    if (kind === 'unattended') Object.assign(f.ctx, { unattended: true })
    if (kind === 'missing') f.state = { ...f.state, request: null }
    expect(await f.run()).toEqual({ action: 'stop' })
    expect(f.deps.judge).not.toHaveBeenCalled()
  },
)
it('continues at most once per user request', async () => {
  const f = fixture()
  await f.run()
  expect(await f.run()).toEqual({ action: 'stop' })
  expect(f.append).toHaveBeenCalledTimes(1)
})
it('does not continue twice for one request across restart', async () => {
  const before = fixture()
  await before.run()
  const after = fixture()
  const [name, data] = before.append.mock.calls[0]!
  after.state = createConversationProjection('plugin/test').apply(
    after.state,
    row(3, `x/plugin/test/${name}`, JSON.parse(JSON.stringify(data)), 'ext:plugin/test'),
  )
  expect(await after.run()).toEqual({ action: 'stop' })
  expect(after.deps.judge).not.toHaveBeenCalled()
})
it('stops when its projection is unavailable or the plugin is disposed', async () => {
  const unavailable = fixture()
  vi.mocked(unavailable.ctx.projections.readOwn).mockResolvedValue({
    status: 'unavailable',
    name: 'stop.conversation',
    error: { code: 'E_PROJECTION_STATE', safeMessage: 'unavailable' },
  })
  expect(await unavailable.run()).toEqual({ action: 'stop' })
  expect(unavailable.deps.judge).not.toHaveBeenCalled()
  const disposed = fixture()
  disposed.dispose()
  expect(await disposed.run()).toEqual({ action: 'stop' })
  expect(disposed.deps.judge).not.toHaveBeenCalled()
})
it('cannot continue after cancellation during catalogue lookup or marker persistence', async () => {
  const lookup = fixture()
  lookup.deps.judge.mockImplementation(async () => {
    lookup.controller.abort()
    return lookup.judge
  })
  expect(await lookup.run()).toEqual({ action: 'stop' })
  expect(lookup.judge.judge).not.toHaveBeenCalled()
  const marker = fixture()
  marker.append.mockImplementation(async () => {
    marker.controller.abort()
    return 3
  })
  expect(await marker.run()).toEqual({ action: 'stop' })
})
it('abandons when the turn signal aborts', async () => {
  const f = fixture()
  let finish!: (v: unknown) => void
  vi.mocked(f.judge.judge).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve as any
      }),
  )
  const result = f.run()
  await vi.waitFor(() => expect(f.judge.judge).toHaveBeenCalled())
  f.controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        result,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('still-running'), 100)
        }),
      ]),
    ).toEqual({ action: 'stop' })
  } finally {
    clearTimeout(timer)
  }
  finish({ status: 'ok', answers: { unexpected_stop: { type: 'noul', noul: 1 } } })
  expect(f.append).not.toHaveBeenCalled()
})
it('includes catalogue wait and marker append in the total deadline', async () => {
  vi.useFakeTimers()
  for (const phase of ['catalogue', 'marker']) {
    const f = fixture()
    if (phase === 'catalogue') f.deps.judge.mockImplementation(async () => new Promise(() => {}))
    else f.append.mockImplementation(async () => new Promise(() => {}))
    const result = f.run()
    await vi.advanceTimersByTimeAsync(14500)
    expect(await result).toEqual({ action: 'stop' })
  }
})
it('truncates request and reply and redacts credentials', async () => {
  const f = fixture()
  f.state = {
    ...f.state,
    request: { seq: 1, text: 'Q'.repeat(2100) },
    reply: {
      seq: 2,
      text: 'DROP'.repeat(1000) + 'R'.repeat(8100) + ' api_key=synthetic_secret',
      hasTools: false,
    },
  }
  await f.run()
  const state = vi.mocked(f.judge.judge).mock.calls[0]![1].state as Record<string, string>
  expect(state.request).toBe('Q'.repeat(2000))
  expect(state.reply).not.toContain('DROP')
  expect(state.reply).not.toContain('synthetic_secret')
  expect(state.reply).toContain('[REDACTED]')
  expect(vi.mocked(f.judge.judge).mock.calls[0]![2]).toMatchObject({ attemptMs: 5000, idPrefix: 'stop:1:1' })
})

const boundarySecret = 'boundary_secret_123'
const tailFiller = 'R'.repeat(8000 - boundarySecret.length - 1)
const privacyCases = [
  {
    name: 'ordinary password label immediately before the reply window',
    request: 'fix it',
    reply: [`password=${boundarySecret} ${tailFiller}`],
    forbidden: boundarySecret,
  },
  {
    name: 'quoted password crossing the reply window',
    request: 'fix it',
    reply: [`password="${boundarySecret} ${tailFiller.slice(1)}"`],
    forbidden: boundarySecret,
  },
  {
    name: 'unterminated quoted password crossing the reply window',
    request: 'fix it',
    reply: [`password="${boundarySecret} ${tailFiller}`],
    forbidden: boundarySecret,
  },
  {
    name: 'credential label and value in different text blocks',
    request: 'fix it',
    reply: ['password=', `${boundarySecret} ${tailFiller}`],
    forbidden: boundarySecret,
  },
  {
    name: 'token recognition extending beyond the request window',
    request: `${'Q'.repeat(1988)} sk-abcdefghijklmnop`,
    reply: ['I will act now'],
    forbidden: 'sk-abcdef',
  },
  {
    name: 'short quoted value at the request boundary stays bounded after defensive masking',
    request: `${'Q'.repeat(1988)} password="x"`,
    reply: ['I will act now'],
    forbidden: 'x',
  },
  {
    name: 'reply redaction cannot pull an earlier sentinel into the original tail',
    request: 'fix it',
    reply: [`OUTSIDE_REPLY_WINDOW ${'R'.repeat(7800)} password=${'s'.repeat(300)}`],
    forbidden: 'OUTSIDE_REPLY_WINDOW',
  },
  {
    name: 'request redaction cannot pull a later sentinel into the original prefix',
    request: `password=${'s'.repeat(2100)} OUTSIDE_REQUEST_WINDOW`,
    reply: ['I will act now'],
    forbidden: 'OUTSIDE_REQUEST_WINDOW',
  },
]
it.each(privacyCases)('masks full credential context before clipping: $name', async (input) => {
  const f = fixture()
  const p = createConversationProjection('plugin/test')
  const rows = [
    row(1, 'user/message', { kind: 'prompt', content: [{ type: 'text', text: input.request }] }),
    row(2, 'assistant/message', {
      stopReason: 'end_turn',
      content: input.reply.map((text) => ({ type: 'text', text })),
    }),
  ]
  f.state = rows.reduce(p.apply, p.init())
  const projected = f.state
  expect(JSON.parse(JSON.stringify(rows)).reduce(p.apply, p.init())).toEqual(projected)
  const repeated = rows[1]
  if (!repeated) throw new Error('missing assistant message')
  expect(p.apply(projected, repeated)).toBe(projected)
  await f.run()
  const call = vi.mocked(f.judge.judge).mock.calls[0]
  if (!call) throw new Error('expected a judgment request from the real conversation projection')
  const sent = call[1].state as { request: string; reply: string }
  expect(sent.request.length).toBeLessThanOrEqual(2000)
  expect(sent.reply.length).toBeLessThanOrEqual(8000)
  expect(sent.request).not.toContain(input.forbidden)
  expect(sent.reply).not.toContain(input.forbidden)
  expect(projected.request?.text.length).toBeLessThanOrEqual(2000)
  expect(projected.reply?.text.length).toBeLessThanOrEqual(8000)
  expect(projected.request?.text).not.toContain(input.forbidden)
  expect(projected.reply?.text).not.toContain(input.forbidden)
})
it('stops and sends nothing when idle', async () => {
  const f = fixture()
  f.deps.judge.mockResolvedValue(null as any)
  expect(await f.run()).toEqual({ action: 'stop' })
  expect(f.judge.judge).not.toHaveBeenCalled()
})
it('returns stop on any thrown error', async () => {
  const f = fixture()
  vi.mocked(f.judge.judge).mockRejectedValue(new Error('synthetic failure'))
  expect(await f.run()).toEqual({ action: 'stop' })
  expect(f.append).not.toHaveBeenCalled()
})
it('stops when marker persistence fails or request changes while judging', async () => {
  const f = fixture()
  f.append.mockRejectedValue(new Error('write failed'))
  expect(await f.run()).toEqual({ action: 'stop' })
  const changed = fixture()
  vi.mocked(changed.judge.judge).mockImplementation(async () => {
    changed.state = { ...changed.state, request: { seq: 9, text: 'new' } }
    return {
      status: 'ok',
      answers: { unexpected_stop: { type: 'noul', noul: 1 } },
      cached: false,
      model: 'j',
    }
  })
  expect(await changed.run()).toEqual({ action: 'stop' })
  expect(changed.append).not.toHaveBeenCalled()
})
it('registers only turn_stopping and disposes registration', () => {
  const f = fixture()
  expect(vi.mocked(f.plugin.hooks.register).mock.calls.map((call) => call[0])).toEqual(['turn_stopping'])
  expect(vi.mocked(f.plugin.hooks.register).mock.calls[0]![2]).toEqual({ timeoutMs: 15000 })
  f.dispose()
  expect(vi.mocked(f.plugin.hooks.register).mock.results[0]!.value).toHaveBeenCalled()
})
it.each(['reference clear', 'distinct command'] as const)(
  'sends no judgment while genuine goal suppression survives %s',
  async (kind) => {
    const f = fixture()
    const p = createConversationProjection('plugin/test')
    const content = (text: string) => [{ type: 'text', text }]
    let s = p.apply(
      f.state,
      row(
        3,
        'inbox',
        {
          items: [
            {
              itemId: 'old',
              commandId: 'old-create',
              actor,
              kind: 'prompt',
              content: content('/goal create task'),
            },
          ],
        },
        'system',
      ),
    )
    if (kind === 'reference clear') {
      s = p.apply(
        s,
        row(
          4,
          'inbox',
          {
            items: [
              {
                itemId: 'mixed',
                commandId: 'mixed',
                actor,
                kind: 'prompt',
                content: [
                  ...content('/goal'),
                  {
                    type: 'text',
                    text: 'clear',
                    reference: {
                      source: 'session',
                      id: 'quoted',
                      label: 'Quoted',
                      hash: 'a'.repeat(64),
                      truncated: false,
                    },
                  },
                ],
              },
            ],
          },
          'system',
        ),
      )
    } else {
      s = p.apply(
        s,
        row(4, 'user/message', { kind: 'prompt', commandId: 'clear', content: content('/goal clear') }),
      )
      s = p.apply(
        s,
        row(5, 'user/message', {
          kind: 'prompt',
          commandId: 'new-create',
          content: content('/goal create task'),
        }),
      )
    }
    f.state = p.apply(
      s,
      row(6, 'assistant/message', { stopReason: 'end_turn', content: content('I will act now') }),
    )
    expect(await f.run()).toEqual({ action: 'stop' })
    expect(f.deps.judge).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
  },
)
