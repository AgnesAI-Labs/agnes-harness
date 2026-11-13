import { HookEngine, type SessionImpl } from '@agnes/core'
import { expect, it } from 'vitest'
import { createSessionHookPort } from '../src/runtime/sessions/session-hooks.js'
import { withStoppingInputSignal } from '../src/runtime/sessions/stopping-input-scope.js'

const human = { itemId: 'new', kind: 'prompt', actor: { role: 'owner' }, content: [] }
function fixture(items: unknown[] = []) {
  const ac = new AbortController()
  const listeners = new Set<(events: any[]) => void>()
  let inbox = { items }
  const session = {
    ac,
    lane: 'main',
    latest: () => inbox,
    onAppended(fn: (events: any[]) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  } as unknown as SessionImpl
  const enqueue = (item: unknown) => {
    inbox = { items: [item] }
    for (const fn of listeners) fn([{ type: 'inbox', lane: 'main', data: inbox }])
  }
  return {
    session,
    ac,
    listeners,
    enqueue,
    setInbox(value: unknown[]) {
      inbox = { items: value }
    },
  }
}
it('abandons waiting hooks on genuine input without aborting the session and cleans subscriptions', async () => {
  const f = fixture()
  await withStoppingInputSignal(f.session, async (signal) => {
    expect(signal.aborted).toBe(false)
    f.enqueue(human)
    expect(signal.aborted).toBe(true)
    expect(f.ac.signal.aborted).toBe(false)
  })
  expect(f.listeners.size).toBe(0)
})
it('notices existing pending input and input during subscription setup', async () => {
  const f = fixture([human])
  await withStoppingInputSignal(f.session, async (signal) => expect(signal.aborted).toBe(true))
  const race = fixture()
  const subscribe = race.session.onAppended.bind(race.session)
  race.session.onAppended = (fn) => {
    const off = subscribe(fn)
    race.setInbox([human])
    return off
  }
  await withStoppingInputSignal(race.session, async (signal) => expect(signal.aborted).toBe(true))
  expect(race.listeners.size).toBe(0)
})
it('ignores plugin follow-ups and runtime context, while cancellation still propagates', async () => {
  const f = fixture()
  await withStoppingInputSignal(f.session, async (signal) => {
    f.enqueue({ ...human, kind: 'follow_up', actor: { role: 'extension' } })
    f.enqueue({ ...human, kind: 'runtime_context' })
    f.enqueue({ ...human, origin: 'system' })
    expect(signal.aborted).toBe(false)
    f.ac.abort()
    expect(signal.aborted).toBe(true)
  })
  await expect(
    withStoppingInputSignal(f.session, async () => {
      throw Error('failure')
    }),
  ).rejects.toThrow('failure')
  expect(f.listeners.size).toBe(0)
})
it('connects genuine input to the real session hook adapter and refuses a late continue', async () => {
  const f = fixture()
  Object.assign(f.session, {
    key: 's',
    workspaceRoot: '/work',
    turn: null,
    d: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finish!: (value: { action: 'continue'; note: string }) => void
  const pending = new Promise<{ action: 'continue'; note: string }>((resolve) => {
    finish = resolve
  })
  const engine = new HookEngine({
    diag() {},
    onFailure() {},
    leaseFor: () => ({ expiresAt: '2999-01-01T00:00:00Z', scope: {}, budget: { remaining: 1 } }),
    platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
  })
  engine.on(
    'turn_stopping',
    () => {
      entered()
      return pending
    },
    { source: 'plugin/test', trust: 'trusted' },
  )
  const port = createSessionHookPort(f.session, engine, () => [])
  const result = port.turnStopping({ turn: 1, step: 1, proposedReason: 'completed' })
  await started
  f.enqueue(human)
  finish({ action: 'continue', note: 'late' })
  expect(await result).toEqual({ action: 'stop' })
  expect(f.ac.signal.aborted).toBe(false)
  expect(f.listeners.size).toBe(0)
})
