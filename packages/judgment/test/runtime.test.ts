import type { PluginContextFacets, SideModelEntry } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { createJudgmentRuntime } from '../src/runtime.js'

it('subscribes before reading, follows readiness, revalidates and disposes', async () => {
  let models: readonly SideModelEntry[] = []
  let listener: (() => void) | undefined
  let reads = 0
  const owner = new AbortController()
  const plugin = {
    self: {
      signal: owner.signal,
      log: { warn() {}, info() {} },
      sideModels: {
        subscribe(fn: () => void) {
          listener = fn
          return () => {
            listener = undefined
          }
        },
        async list() {
          expect(listener).toBeDefined()
          reads++
          return models
        },
      },
    },
  } as unknown as PluginContextFacets
  const runtime = createJudgmentRuntime(plugin, {})
  await Promise.resolve()
  await Promise.resolve()
  expect(runtime.current()).toBeNull()
  let notices = 0
  runtime.subscribe(() => {
    notices++
  })
  models = [{ route: 'jev', model: 'j', api: 'typesafe-systemone' }]
  listener!()
  listener!()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(runtime.current()).toEqual([{ route: 'jev', model: 'j', native: true }])
  expect(notices).toBe(1)
  models = []
  expect(
    await runtime.judge({ sideCall: {} as any, signal: owner.signal, session: { key: 's' } as any }),
  ).toBeNull()
  expect(runtime.current()).toBeNull()
  expect(reads).toBeGreaterThan(1)
  runtime.dispose()
  expect(listener).toBeUndefined()
  expect(await runtime.judge({ signal: owner.signal, session: { key: 's' } as any })).toBeNull()
})

it('shares sixteen actual requests across judge factories and cancels a queued call', async () => {
  const plugin = {
    self: {
      signal: new AbortController().signal,
      log: { warn() {}, info() {} },
      sideModels: {
        async list() {
          return [{ route: 'jev', model: 'j', api: 'typesafe-systemone' }]
        },
      },
    },
  } as unknown as PluginContextFacets
  const runtime = createJudgmentRuntime(plugin, {})
  const releases: (() => void)[] = []
  const port = {
    prepare: async (options: any) => options,
    status: async (invocationId: string) => ({ status: 'absent', invocationId }),
    invoke: async () =>
      new Promise((resolve) =>
        releases.push(() => resolve({ status: 'ok', text: '', json: { q: { type: 'noul', noul: 0.5 } } })),
      ),
  } as any
  const controller = new AbortController()
  const context = { signal: new AbortController().signal, sideCall: port, session: { key: 's' } as any }
  const one = await runtime.judge(context),
    two = await runtime.judge(context)
  expect(one && two).toBeTruthy()
  const req = { state: 'same', questions: { q: { type: 'noul' as const, instructions: 'yes?' } } }
  const run = (i: number, signal = context.signal) =>
    (i % 2 ? one! : two!).judge('judgment.batch', req, {
      attemptMs: 1000,
      totalMs: 5000,
      signal,
      idPrefix: `batch:${i}`,
      retry: 'none',
    })
  const active = Array.from({ length: 16 }, (_, i) => run(i))
  const queued = run(16, controller.signal)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(releases).toHaveLength(16)
  controller.abort()
  expect(await queued).toMatchObject({ status: 'failed', accounting: { calls: [] } })
  releases.forEach((release) => {
    release()
  })
  expect((await Promise.all(active)).every((result) => result.status === 'ok')).toBe(true)
  expect(releases).toHaveLength(16)
  runtime.dispose()
})

it('disposes captured lifetime ports after the row facade has retired', async () => {
  const owner = new AbortController()
  let retired = false
  const plugin = {
    get self() {
      if (retired) throw new Error('row retired')
      return {
        signal: owner.signal,
        log: { warn() {} },
        sideModels: {
          async list() {
            return []
          },
        },
      }
    },
  } as unknown as PluginContextFacets
  const runtime = createJudgmentRuntime(plugin, {})
  await Promise.resolve()
  retired = true
  expect(() => runtime.dispose()).not.toThrow()
  expect(runtime.current()).toBeNull()
})

it('requires the captured primary to be native without changing default text dispatch or retry policy', async () => {
  let native = false
  const plugin = {
    self: {
      signal: new AbortController().signal,
      log: { warn() {} },
      sideModels: {
        async list() {
          return [
            { route: 'selected', model: 'j', api: native ? 'typesafe-systemone' : 'openai-completions' },
            { route: 'fallback', model: 'j', api: 'typesafe-systemone' },
          ]
        },
      },
    },
  } as unknown as PluginContextFacets
  const runtime = createJudgmentRuntime(plugin, {
    judge: { route: 'selected', model: 'j', fallback: { route: 'fallback', model: 'j' } },
  })
  const prepared: Array<{ output: string; target: { route: string } }> = []
  const invoked: Array<{ output: string; target: { route: string } }> = []
  const context = {
    signal: new AbortController().signal,
    session: { key: 's' } as any,
    sideCall: {
      status: async (invocationId: string) => ({ status: 'absent', invocationId }),
      prepare: async (input: any) => {
        prepared.push(input)
        return input
      },
      invoke: async (input: any) => {
        invoked.push(input)
        return { status: 'failed', reason: 'adapter-error', retryable: true }
      },
    } as any,
  }
  const request = { state: 'synthetic', questions: { q: { type: 'noul' as const, instructions: 'yes?' } } }
  const options = {
    attemptMs: 1000,
    totalMs: 1500,
    signal: context.signal,
    idPrefix: 'test',
    retry: 'none' as const,
  }
  try {
    expect(await runtime.judge(context, { nativeOnly: true })).toBeNull()
    expect(prepared).toEqual([])
    expect(invoked).toEqual([])
    const text = await runtime.judge(context)
    expect(text).not.toBeNull()
    await text!.judge('judgment.batch', request, options)
    expect(prepared.map((input) => input.output)).toEqual(['text'])
    expect(invoked.map((input) => input.output)).toEqual(['text'])
    native = true
    const primary = await runtime.judge(context, { nativeOnly: true })
    expect(primary).not.toBeNull()
    await primary!.judge('judgment.rules', request, { ...options, idPrefix: 'native', allowSplit: false })
    expect(prepared.map((input) => [input.output, input.target.route])).toEqual([
      ['text', 'selected'],
      ['json', 'selected'],
    ])
    expect(invoked.map((input) => [input.output, input.target.route])).toEqual([
      ['text', 'selected'],
      ['json', 'selected'],
    ])
  } finally {
    runtime.dispose()
  }
})
