import type { Event, SessionImpl } from '@agnes/core'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createSessionTasks } from '../src/runtime/sessions/session-tasks.js'

function fixture(configured = true) {
  const ref = { key: 'synthetic', lane: 'main', workspaceRoot: '/synthetic' }
  const rows: Event[] = []
  const listeners = new Set<(events: Event[]) => void>()
  const calls: RequestBody[] = []
  const append = (type: string, data: unknown) => {
    const event = { seq: rows.length + 1, lane: 'main', type, data } as Event
    rows.push(event)
    for (const listener of listeners) listener([event])
  }
  const infer = vi.fn(async function* (request: RequestBody): AsyncGenerator<InferenceEvent> {
    calls.push(request)
    yield { type: 'text_delta', delta: 'What should I try next?' }
    yield {
      type: 'usage',
      tokens: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0 },
      credits: 0.1,
      creditSource: 'gateway',
    }
    yield { type: 'done', reason: 'stop' }
  })
  const billingRecord = vi.fn(async () => true)
  const session = {
    key: ref.key,
    lane: ref.lane,
    closingOrClosed: false,
    op: () => null,
    preset: {
      model: {
        route: { fast: configured ? 'fake' : undefined },
        id: { fast: configured ? 'fast' : undefined },
      },
      budget: { perRequestCap: null },
      treeBudgetCredits: null,
    },
    scan: async (q: { type: string | string[]; limit: number }) =>
      rows
        .filter((r) => [q.type].flat().includes(r.type))
        .slice()
        .reverse()
        .slice(0, q.limit),
    onAppended: (fn: (events: Event[]) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    locked: async (fn: () => Promise<unknown>) => fn(),
    ev: (type: string, data: unknown) => ({ type, data }),
    append: async (events: Array<{ type: string; data: unknown }>) => {
      for (const row of events) append(row.type, row.data)
    },
    d: {
      contract: { contract_id: null, parser_version: '1' },
      provider: {
        models: () => [
          {
            route: 'fake',
            id: 'fast',
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        infer,
      },
      runtime: { billingProjected: async () => ({ credits: 0 }), billingRecord },
    },
  } as unknown as SessionImpl
  const tasks = createSessionTasks(() => session)
  return { tasks, ref, append, rows, calls, infer, billingRecord }
}

it('observes only live successful completions, bounds context and drops superseded results', async () => {
  const f = fixture()
  f.append('turn/start', { turn: 1 })
  f.append('turn/end', { reason: 'completed', lastAssistantSeq: 1 })
  const observed: Array<{ turn: number; reason: string; messages: unknown[] }> = []
  const off = f.tasks.watch(f.ref, (event) => observed.push(event))
  expect(observed).toEqual([])
  f.append('user/message', {
    content: [
      { type: 'text', text: '好'.repeat(4000) },
      { type: 'image', data: 'never-context' },
    ],
  })
  f.append('turn/start', { turn: 2 })
  f.append('turn/end', { reason: 'completed', lastAssistantSeq: 2 })
  f.append('turn/start', { turn: 3 })
  await new Promise<void>((r) => queueMicrotask(r))
  expect(observed.some((e) => e.reason === 'completed')).toBe(false)
  for (const reason of ['error', 'cancelled', 'parked'])
    f.append('turn/end', { reason, lastAssistantSeq: null })
  f.append('turn/start', { turn: 4 })
  f.append('turn/end', { reason: 'completed', lastAssistantSeq: 4 })
  await vi.waitFor(() => expect(observed.at(-1)?.reason).toBe('completed'))
  expect(JSON.stringify(observed.at(-1)?.messages).length).toBeLessThan(1000)
  off()
  const count = observed.length
  f.append('turn/start', { turn: 5 })
  expect(observed).toHaveLength(count)
})

it('uses the fake fast model and ordinary auxiliary accounting without transcript/context writes', async () => {
  const f = fixture()
  f.append('turn/start', { turn: 1 })
  f.append('turn/end', { reason: 'completed', lastAssistantSeq: 1 })
  const input = {
    turn: 1,
    label: 'test',
    system: 'one question',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
  }
  await expect(f.tasks.generate(f.ref, input, new AbortController().signal)).resolves.toBe(
    'What should I try next?',
  )
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]?.model).toBe('fast')
  expect(f.calls[0]?.sampling?.maxTokens).toBe(128)
  expect(f.rows.map((r) => r.type)).toEqual(['turn/start', 'turn/end', 'cost/ledger'])
  expect(f.billingRecord).toHaveBeenCalledWith(
    expect.objectContaining({ purpose: 'side-call', sourceTurn: 1, model: 'fast', credits: 0.1 }),
  )
  const missing = fixture(false)
  missing.append('turn/start', { turn: 1 })
  missing.append('turn/end', { reason: 'completed', lastAssistantSeq: 1 })
  await expect(
    missing.tasks.generate(missing.ref, input, new AbortController().signal),
  ).resolves.toBeUndefined()
  expect(missing.infer).not.toHaveBeenCalled()
  f.append('turn/start', { turn: 2 })
  await expect(f.tasks.generate(f.ref, input, new AbortController().signal)).resolves.toBeUndefined()
  expect(f.calls).toHaveLength(1)
})

it('drops a late fast-model answer and accounts for failed or cancelled inference silently at the plugin boundary', async () => {
  const f = fixture()
  f.append('turn/start', { turn: 1 })
  f.append('turn/end', { reason: 'completed', lastAssistantSeq: 1 })
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  f.infer.mockImplementationOnce(async function* (): AsyncGenerator<InferenceEvent> {
    await wait
    yield { type: 'text_delta', delta: 'late?' }
    yield { type: 'done', reason: 'stop' }
  })
  const input = { turn: 1, label: 'test', system: 'one question', messages: [] }
  const late = f.tasks.generate(f.ref, input, new AbortController().signal)
  await vi.waitFor(() => expect(f.infer).toHaveBeenCalled())
  f.append('turn/start', { turn: 2 })
  release()
  await expect(late).resolves.toBeUndefined()
  f.append('turn/end', { reason: 'completed', lastAssistantSeq: 1 })
  f.infer.mockImplementationOnce(async function* (): AsyncGenerator<InferenceEvent> {
    yield { type: 'text_delta', delta: '' }
    throw new Error('synthetic provider failure')
  })
  await expect(f.tasks.generate(f.ref, { ...input, turn: 2 }, new AbortController().signal)).rejects.toThrow(
    'synthetic provider failure',
  )
  expect(f.rows.filter((r) => r.type === 'cost/ledger')).toHaveLength(2)
  f.infer.mockImplementationOnce(async function* (): AsyncGenerator<InferenceEvent> {
    await new Promise<void>(() => undefined)
    yield { type: 'text_delta', delta: 'never' }
  })
  const hungAbort = new AbortController()
  const hung = f.tasks.generate(f.ref, { ...input, turn: 2 }, hungAbort.signal)
  await vi.waitFor(() => expect(f.infer).toHaveBeenCalledTimes(3))
  hungAbort.abort()
  await expect(hung).rejects.toThrow('auxiliary cancelled')
  expect(f.rows.filter((r) => r.type === 'cost/ledger')).toHaveLength(3)
  const aborted = new AbortController()
  aborted.abort()
  const count = f.infer.mock.calls.length
  await expect(f.tasks.generate(f.ref, { ...input, turn: 2 }, aborted.signal)).resolves.toBeUndefined()
  expect(f.infer.mock.calls).toHaveLength(count)
})
