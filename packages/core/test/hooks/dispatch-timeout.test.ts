import { afterEach, expect, it, vi } from 'vitest'
import { HookDispatch } from '../../src/hooks/dispatch.js'
import { HookEngine } from '../../src/hooks/engine.js'

afterEach(() => vi.useRealTimers())
it('uses the entry timeout when set', async () => {
  vi.useFakeTimers()
  const dispatcher = new HookDispatch({ diag() {}, onFailure() {} })
  const pending = dispatcher.run(
    'turn_stopping',
    [
      {
        source: 'plugin/test',
        timeoutMs: 15000,
        invoke: () => new Promise((resolve) => setTimeout(() => resolve({ action: 'continue' }), 14000)),
      },
    ],
    new AbortController().signal,
  )
  await vi.advanceTimersByTimeAsync(14000)
  expect(await pending).toEqual({
    kind: 'ok',
    results: [{ source: 'plugin/test', value: { action: 'continue' } }],
  })
})
it('falls back to the table timeout', async () => {
  vi.useFakeTimers()
  const dispatcher = new HookDispatch({ diag() {}, onFailure() {} })
  const pending = dispatcher.run(
    'turn_stopping',
    [{ source: 'plugin/test', invoke: () => new Promise(() => {}) }],
    new AbortController().signal,
  )
  await vi.advanceTimersByTimeAsync(1001)
  expect(await pending).toEqual({ kind: 'ok', results: [] })
})
it('carries the host registration timeout through the engine', async () => {
  vi.useFakeTimers()
  const engine = new HookEngine({
    diag() {},
    onFailure() {},
    platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
  })
  engine.on(
    'turn_stopping',
    () => new Promise((resolve) => setTimeout(() => resolve({ action: 'continue', note: 'resume' }), 12000)),
    { source: 'plugin/test', trust: 'trusted', hookTimeoutMs: 15000 },
  )
  const pending = engine.dispatch(
    'turn_stopping',
    () => ({ turn: 1, step: 1, proposedReason: 'completed' }),
    {
      session: { key: 's', lane: 'main', workspaceRoot: '/work' },
      lease: { expiresAt: '2999-01-01T00:00:00Z', scope: {}, budget: { remaining: 1 } },
      signal: new AbortController().signal,
      replayed: false,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    },
  )
  await vi.advanceTimersByTimeAsync(12000)
  expect(await pending).toMatchObject({
    kind: 'ok',
    results: [{ value: { action: 'continue', note: 'resume' } }],
  })
})
