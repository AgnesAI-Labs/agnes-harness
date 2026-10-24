import type { HookContext, HookHandler, ServiceContext, ServiceDef } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { expect, it, vi } from 'vitest'
import {
  createFollowUpHintExtension,
  FOLLOW_UP_HINT_SYSTEM,
  normalizeHint,
} from '../extensions/follow-up-hint/src/index.js'
import type { SessionTasks } from '../src/seam-init.js'

async function fixture() {
  const starts = new Map<string, HookHandler<'session_start'>>()
  let service!: ServiceDef
  let listener!: Parameters<SessionTasks['watch']>[1]
  const pending: Array<{ resolve(value: string): void; signal: AbortSignal }> = []
  const generate = vi.fn(
    (_ref, _input, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        pending.push({ resolve, signal })
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      }),
  )
  const off = vi.fn()
  const tasks: SessionTasks = {
    watch: (_ref, fn) => {
      listener = fn
      return off
    },
    generate,
    review: vi.fn(async () => undefined),
  }
  const api = {
    registerHook: (name: string, handler: HookHandler<'session_start'>) => {
      starts.set(name, handler)
      return () => starts.delete(name)
    },
    registerService: (def: ServiceDef) => {
      service = def
      return () => undefined
    },
  } as unknown as ExtensionAPI
  const dispose = await extensionFactoryOf(createFollowUpHintExtension(tasks))(api)
  const session = { key: 'synthetic', lane: 'main', workspaceRoot: '/synthetic' }
  const start = starts.get('session_start')
  if (!start) throw new Error('session hook missing')
  await start({} as never, { session } as HookContext)
  return {
    generate,
    pending,
    off,
    dispose,
    emit: (reason: string, turn = 1) =>
      listener({ turn, reason, messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }),
    read: (turn = 1) => service.handler({ turn }, { session } as ServiceContext),
  }
}

it('publishes one volatile turn-bound hint, drops late output and stops all work when disabled', async () => {
  const f = await fixture()
  for (const reason of ['running', 'pending', 'error', 'cancelled', 'parked', 'approval']) f.emit(reason)
  expect(f.generate).not.toHaveBeenCalled()
  f.emit('completed')
  f.emit('running', 2)
  expect(f.pending[0]?.signal.aborted).toBe(true)
  f.pending[0]?.resolve('旧的问题？')
  await Promise.resolve()
  expect(await f.read()).toEqual({})
  f.emit('completed', 2)
  f.pending[1]?.resolve('接下来如何验证？')
  await Promise.resolve()
  expect(await f.read(1)).toEqual({})
  expect(await f.read(2)).toEqual({ turn: 2, text: '接下来如何验证？' })
  f.generate.mockRejectedValueOnce(new Error('synthetic failure'))
  f.emit('completed', 3)
  await Promise.resolve()
  expect(await f.read(3)).toEqual({})
  await f.dispose?.()
  expect(f.off).toHaveBeenCalled()
  expect(await f.read(2)).toEqual({})
  expect(f.pending[1]?.signal.aborted).toBe(true)
})

it('silently times out and rejects multiline or oversized output', async () => {
  vi.useFakeTimers()
  try {
    const f = await fixture()
    f.emit('completed')
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.pending[0]?.signal.aborted).toBe(true)
    f.pending[0]?.resolve('too late?')
    await Promise.resolve()
    expect(await f.read()).toEqual({})
    await f.dispose?.()
  } finally {
    vi.useRealTimers()
  }
  for (const value of ['one\ntwo', '```question```', 'a'.repeat(81), '问'.repeat(41), '\u202eunsafe'])
    expect(normalizeHint(value)).toBeUndefined()
  expect(normalizeHint('「如何开始？」')).toBe('如何开始？')
})

it("asks for the user's own next message, never the assistant's voice", async () => {
  const f = await fixture()
  f.emit('completed')
  const input = f.generate.mock.calls[0]?.[1] as { system: string; label: string }
  expect(input.label).toBe('reply-suggestions')
  expect(input.system).toBe(FOLLOW_UP_HINT_SYSTEM)
  expect(input.system).toContain("user's point of view")
  expect(input.system).toContain('Never write as the assistant')
  await f.dispose?.()
})
