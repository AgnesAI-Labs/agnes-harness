// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, inputOf, SERVICES, usePoll } from '../src/api.js'
import { apply, sessionPage } from '../src/index.js'
import { PANEL_SERVICES } from '../../superagent/src/runtime/services.js'
import { en, zh } from '../src/locales.js'
import { problems } from './helpers/schema.js'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  vi.useRealTimers()
})

it('registers one localized primary home entry that shows the panel, and withdraws it', async () => {
  const entries: { id: string; placement?: string; titleKey: string; component: () => unknown }[] = []
  const catalogs: Record<string, unknown> = {}
  const off = { entry: vi.fn(), locale: vi.fn() }
  const ctx = {
    locale: {
      locale: 'zh-CN',
      subscribe: () => () => {},
      register: (namespace: string, catalog: unknown) => {
        catalogs[namespace] = catalog
        return off.locale
      },
    },
    homeEntries: {
      register: (entry: (typeof entries)[number]) => {
        entries.push(entry)
        return off.entry
      },
    },
    profile: { services: { query: vi.fn(() => new Promise(() => {})), effect: vi.fn() } },
  }
  const dispose = apply(ctx as never)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ id: 'superagent', placement: 'primary', titleKey: 'superagent.nav' })
  expect(catalogs['@agnes/superagent']).toEqual({
    en: { 'superagent.nav': 'Superagent' },
    'zh-CN': { 'superagent.nav': 'Superagent' },
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const Entry = entries[0]!.component as () => never
  await act(async () => {
    root.render(<Entry />)
  })
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  // The panel is in the language the host selected, and it read its state through the profile services.
  expect(container.textContent).toContain(zh['tab.overview'])
  expect(container.textContent).not.toContain(en['tab.overview'])
  expect(ctx.profile.services.query).toHaveBeenCalledWith('superagent.state', {})
  act(() => {
    root.unmount()
  })
  container.remove()
  dispose()
  expect(off.entry).toHaveBeenCalledOnce()
  expect(off.locale).toHaveBeenCalledOnce()
})

it('opens a worker session on the host page by its id', () => {
  expect(sessionPage('01J/ab c')).toBe('/?session=01J%2Fab%20c')
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(
      () =>
        new Promise<string[]>((done) => {
          calls.push({ limit, done })
        }),
      [limit],
      1000,
    )
    shown = { ...(data ? { data } : {}), limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(calls).toHaveLength(1)
  await act(async () => {
    calls[0]!.done(['a'])
  })
  expect(shown.data).toEqual(['a'])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(calls).toHaveLength(2)
  await act(async () => {
    setLimit(2)
  })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => {
    calls[2]!.done(['a', 'b'])
  })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => {
    calls[1]!.done(['stale'])
  })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  await act(async () => {
    calls[3]!.done(['a', 'b'])
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(calls).toHaveLength(5)
  act(() => {
    root.unmount()
  })
})

const messages = {
  effectNotDone: (state: string) => `not done ${state}`,
  offline: 'offline',
  notRunning: 'not running',
  serverError: (status: number) => `server ${status}`,
  requestFailed: (status: number) => `request ${status}`,
  setup: () => 'setup',
  user: ({ code }: { code: string }) => `user ${code}`,
}

it('sends each route as its service, with the path, query and body as one input', async () => {
  const query = vi.fn(async (_name: string, _input: unknown) => ({})),
    effect = vi.fn(async (_name: string, _input: unknown, _options: { operationId: string }) => ({
      state: 'completed',
      output: {},
    }))
  const call = caller(() => messages, { query, effect } as never)
  await call('GET tickets', { query: { state: 'ended', limit: 20, offset: undefined } })
  await call('GET search', { query: { q: '' } })
  await call('GET threads/:key', { key: 'feishu:oc_1:om/root', query: { limit: 50, before: 'x' } })
  await call('POST tickets/:id/stop', { id: 't1' })
  await call('PUT settings/:block', {
    block: 'source:github',
    body: { value: { enabled: true }, revision: 2 },
  })
  await call('PUT prompts', { body: { config: { team: 1 } as never, baseRevision: 3 } })
  await call('POST prompts/preview', { body: { team: 1 } as never })
  await call('POST executor/pause', { body: { paused: true } })
  expect(query.mock.calls).toEqual([
    ['superagent.tickets.list', { state: 'ended', limit: 20 }],
    ['superagent.search', {}],
    ['superagent.threads.get', { key: 'feishu:oc_1:om/root', limit: 50, before: 'x' }],
  ])
  expect(effect.mock.calls.map(([name, input]) => [name, input])).toEqual([
    ['superagent.tickets.stop', { id: 't1' }],
    ['superagent.settings.save', { block: 'source:github', value: { enabled: true }, revision: 2 }],
    ['superagent.prompts.save', { config: { team: 1 }, baseRevision: 3 }],
    ['superagent.prompts.preview', { config: { team: 1 } }],
    ['superagent.executor.pause', { paused: true }],
  ])
  // Every click is its own operation, never a replay of an earlier one.
  const ids = effect.mock.calls.map(([, , options]) => (options as { operationId: string }).operationId)
  expect(new Set(ids).size).toBe(ids.length)
  expect(inputOf('GET state', undefined)).toEqual({})
})

it('names the service of every route once, as a query for a GET and an effect for the rest', () => {
  const names = Object.values(SERVICES).map(([name]) => name)
  expect(new Set(names).size).toBe(25)
  for (const [route, [, kind]] of Object.entries(SERVICES)) expect(kind, route).toBe(route.startsWith('GET ') ? 'query' : 'effect')
})

it('tells a Superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const failure = async (service: { query?: () => Promise<unknown>; effect?: () => Promise<unknown> }) => {
    const call = caller(() => messages, service as never)
    const error = await call('GET tickets/:id', { id: 't1' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(
    await failure({
      query: async () => {
        throw new TypeError('Failed to fetch')
      },
    }),
  ).toEqual({ message: 'offline', status: 0, missing: false, unreachable: true })
  // The Host refuses a service of a plugin that is not running.
  expect(
    await failure({
      query: async () => {
        throw new Error('CAPABILITY_DENIED')
      },
    }),
  ).toEqual({ message: 'not running', status: 404, missing: false, unreachable: true })
  // A refusal or a failure of the Host is no lost connection: the panel says what failed, not "offline".
  expect(await failure({ query: async () => { throw new Error('INVALID_PARAMS (-32602)') } })).toEqual({ message: 'request 400', status: 400, missing: false, unreachable: false })
  expect(await failure({ query: async () => { throw new Error('INTERNAL_ERROR (-32603)') } })).toEqual({ message: 'server 500', status: 500, missing: false, unreachable: false })
  expect(await failure({ query: async () => ({ failure: { status: 502 } }) })).toEqual({
    message: 'server 502',
    status: 502,
    missing: false,
    unreachable: false,
  })
  expect(await failure({ query: async () => ({ failure: { status: 400 } }) })).toEqual({
    message: 'request 400',
    status: 400,
    missing: false,
    unreachable: false,
  })
  expect(
    await failure({
      query: async () => ({ failure: { status: 404, error: 'Unknown ticket', code: 'unknownTicket' } }),
    }),
  ).toEqual({
    message: 'user unknownTicket',
    status: 404,
    missing: true,
    unreachable: false,
  })
  expect(await failure({ query: async () => ({ failure: { status: 404, error: 'Ticket not found' } }) })).toMatchObject({ message: 'Ticket not found', missing: true })
})

it('reports an effect that did not complete, and an effect refused as a failure', async () => {
  const run = (effect: () => Promise<unknown>) =>
    caller(() => messages, { effect } as never)('POST tickets/:id/retry', { id: 't1' }).then(
      () => 'done',
      (error: Error) => error.message,
    )
  expect(await run(async () => ({ state: 'unknown', code: 'OUTCOME_UNKNOWN' }))).toBe('not done unknown')
  expect(await run(async () => ({ state: 'approval-required' }))).toBe('not done approval-required')
  expect(
    await run(async () => ({
      state: 'completed',
      output: { failure: { status: 400, error: 'refused', code: 'notRetryable' } },
    })),
  ).toBe('user notRetryable')
  expect(await run(async () => ({ state: 'completed', output: { retried: true } }))).toBe('done')
})

it('asks for as many rows as "load more" has grown to: no limit is refused by the Host, the services clamp it', () => {
  // The Eval list grows its limit by one page per click without bound; the declared schemas must admit that.
  for (const [route, limit] of [['GET decisions', 5000], ['GET tickets', 5000], ['GET threads', 5000], ['GET threads/:key', 5000]] as const) {
    const [name] = SERVICES[route]
    const input = inputOf(route, { ...(route === 'GET threads/:key' ? { key: 'github:1' } : {}), query: { limit } })
    const service = PANEL_SERVICES.find((item) => item.name === name)
    expect(problems(service?.inputSchema as never, input), route).toEqual([])
  }
})
