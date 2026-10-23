import type { HookContext, ServiceContext, ServiceDef } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createHeadsUpExtension,
  type HeadsUpOptions,
  NOTE_PREFIX,
  normalizeNote,
} from '../extensions/heads-up/src/index.js'
import type { SessionTasks } from '../src/seam-init.js'

afterEach(() => vi.useRealTimers())

type Any = (payload: unknown, ctx: HookContext) => unknown
async function fixture(options: HeadsUpOptions = { minIntervalMs: 0 }, withTasks = true) {
  const hooks = new Map<string, Any>()
  const services = new Map<string, ServiceDef>()
  let listener!: Parameters<SessionTasks['watch']>[1]
  const reviews: Array<{ data: string; signal: AbortSignal }> = []
  const answers: Array<(value: string | undefined) => void> = []
  const review = vi.fn(
    (_ref, input: { data: string }, signal: AbortSignal) =>
      new Promise<string | undefined>((resolve, reject) => {
        reviews.push({ data: input.data, signal })
        answers.push(resolve)
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      }),
  )
  const tasks = {
    watch: (_ref: unknown, fn: typeof listener) => {
      listener = fn
      return () => undefined
    },
    generate: vi.fn(),
    review,
  } as unknown as SessionTasks
  const api = {
    registerHook: (name: string, handler: Any) => {
      hooks.set(name, handler)
      return () => hooks.delete(name)
    },
    registerService: (def: ServiceDef) => {
      services.set(def.name, def)
      return () => undefined
    },
  } as unknown as ExtensionAPI
  const dispose = await extensionFactoryOf(createHeadsUpExtension(withTasks ? tasks : undefined, options))(
    api,
  )
  const session = { key: 'synthetic', lane: 'main', workspaceRoot: '/synthetic' }
  const hctx = { session } as HookContext
  await hooks.get('session_start')?.({}, hctx)
  const call = (name: string, input: unknown) =>
    services.get(name)?.handler(input as never, { session } as ServiceContext) as Promise<
      Record<string, unknown>
    >
  const tool = async (id: string, readOnly: boolean, isError = false) => {
    await hooks.get('tool_call')?.(
      { toolUseId: id, name: 'bash', args: { command: 'x' }, meta: { isReadOnly: readOnly } },
      hctx,
    )
    await hooks.get('tool_result')?.({ toolUseId: id, name: 'bash', args: {}, result: { isError } }, hctx)
  }
  return {
    reviews,
    answers,
    review,
    dispose,
    start: (turn: number) => listener({ turn, reason: 'running', messages: [] }),
    end: (turn: number, text = 'done') =>
      listener({
        turn,
        reason: 'completed',
        messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
      }),
    tool,
    on: (enabled = true) => call('headsup.set', { enabled }),
    read: (turn = 1) => call('headsup.read', { turn }),
    context: () =>
      hooks.get('context')?.({}, hctx) as Promise<{ additionalContext?: string; refreshOnRequest?: boolean }>,
  }
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

it('sanitizes and caps notes and treats NONE as nothing to say', () => {
  expect(normalizeNote('NONE')).toBeUndefined()
  expect(normalizeNote(' none. ')).toBeUndefined()
  expect(normalizeNote(undefined)).toBeUndefined()
  expect(normalizeNote('a\u0007b‮c\n\nd')).toBe('a b c d')
  expect(Array.from(normalizeNote('x'.repeat(900)) ?? '')).toHaveLength(300)
})

it('is off by default, reviews only after side-effecting tools and hands over each note once', async () => {
  const f = await fixture()
  await f.tool('t0', false)
  expect(f.review).not.toHaveBeenCalled()
  expect(await f.context()).toEqual({ refreshOnRequest: true })
  await f.on()
  f.start(1)
  await f.tool('t1', true)
  expect(f.review).not.toHaveBeenCalled()
  await f.tool('t2', false)
  await settle()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(f.reviews[0]?.data).toContain('bash {"command":"x"} -> ok')
  f.answers[0]?.('Deleted a build dir the user did not mention.')
  await settle()
  expect(await f.read()).toMatchObject({
    enabled: true,
    busy: false,
    turn: 1,
    text: 'Deleted a build dir the user did not mention.',
  })
  const first = await f.context()
  expect(first.refreshOnRequest).toBe(true)
  expect(first.additionalContext).toBe(`${NOTE_PREFIX}Deleted a build dir the user did not mention.`)
  expect(await f.context()).toEqual({ refreshOnRequest: true })
  f.start(2)
  expect(await f.read(1)).toMatchObject({ deliveredTurn: 1 })
})

it('treats NONE and failures as silent, dedupes repeats and caps notes per hour', async () => {
  const f = await fixture({ minIntervalMs: 0, maxPerHour: 2 })
  await f.on()
  f.start(1)
  await f.tool('a', false)
  await settle()
  f.answers[0]?.('NONE')
  await settle()
  expect(await f.read()).toMatchObject({ busy: false })
  expect((await f.read()).text).toBeUndefined()
  await f.tool('b', false)
  await settle()
  f.answers[1]?.('Check the path.')
  await settle()
  await f.tool('c', false)
  await settle()
  f.answers[2]?.('check the PATH.')
  await settle()
  expect((await f.context()).additionalContext).toContain('Check the path.')
  await f.tool('d', false)
  await settle()
  f.answers[3]?.('Second distinct note.')
  await settle()
  await f.tool('e', false)
  await settle()
  expect(f.review).toHaveBeenCalledTimes(4)
  const rejected = await fixture()
  await rejected.on()
  rejected.review.mockRejectedValueOnce(new Error('egress denied'))
  rejected.start(1)
  await rejected.tool('a', false)
  await settle()
  expect(await rejected.context()).toEqual({ refreshOnRequest: true })
})

it('runs one review at a time, coalesces triggers, spaces them and reviews the finished turn', async () => {
  vi.useFakeTimers()
  const f = await fixture({ minIntervalMs: 20_000 })
  await f.on()
  f.start(1)
  await f.tool('a', false)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.review).toHaveBeenCalledTimes(1)
  await f.tool('b', false)
  await f.tool('c', false)
  expect(f.review).toHaveBeenCalledTimes(1)
  f.answers[0]?.('NONE')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.review).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.review).toHaveBeenCalledTimes(2)
  expect(f.reviews[1]?.data).toContain('-> ok')
  f.end(1, 'All finished')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.reviews[1]?.signal.aborted).toBe(false)
  f.answers[1]?.('NONE')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.review).toHaveBeenCalledTimes(3)
  expect(f.reviews[2]?.data).toContain('All finished')
})

it('cancels the old review on a new turn and stops reviewing and handing over when turned off', async () => {
  const f = await fixture()
  await f.on()
  f.start(1)
  await f.tool('a', false)
  await settle()
  f.start(2)
  expect(f.reviews[0]?.signal.aborted).toBe(true)
  await settle()
  await f.tool('b', false)
  await settle()
  f.answers[1]?.('Unsent note.')
  await settle()
  await f.on(false)
  expect(await f.context()).toEqual({ refreshOnRequest: true })
  f.end(2)
  await f.tool('c', false)
  await settle()
  expect(f.review).toHaveBeenCalledTimes(2)
  expect(await f.read(2)).toMatchObject({ enabled: false })
})

it('does nothing without session tasks', async () => {
  const f = await fixture({ minIntervalMs: 0 }, false)
  await expect(f.on()).rejects.toThrow('unavailable')
  expect(await f.context()).toEqual({})
  await f.dispose?.()
})
