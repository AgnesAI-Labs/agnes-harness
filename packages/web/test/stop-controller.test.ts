import type { Session } from '@agnes/sdk/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { createCommandController } from '../src/app/command-controller.js'
import { SessionBindingOwner } from '../src/app/session-owner.js'
import { SubmissionOwner } from '../src/app/submission-owner.js'
import { enT } from './helpers/locale.js'

afterEach(() => vi.useRealTimers())

function setup(cancel: () => Promise<void>) {
  let work = Promise.resolve()
  const sessionBinding = new SessionBindingOwner()
  const context = {
    current: { id: 'session', cancel, controls: async () => ({ facts: [], factsThrough: 1166 }) },
    sessionBinding,
    submissions: new SubmissionOwner(sessionBinding),
    stopping: false,
    sessionPending: false,
    projection: { upto: 1162, opState: { phase: 'tools' } },
    stopAfterSeq: 0,
    client: {
      notify: vi.fn(async () => undefined),
      call: vi.fn(async () => ({ facts: [{ action: 'cancel', outcome: 'applied', seq: 1166 }] })),
    },
    live: { refresh: vi.fn() },
    notice: {
      setText: vi.fn(),
      setKind: vi.fn(),
      offerMany: vi.fn<(actions: { label: string; run(): void }[]) => void>(),
    },
    t: enT,
    render: vi.fn(),
    run: (fn: () => Promise<void>) => {
      work = fn()
    },
    showError: vi.fn(),
    controlsHistory: new Map(),
  }
  context.sessionBinding.attach(context.sessionBinding.capture(), {
    session: context.current as unknown as Session,
  })
  const controller = createCommandController(
    context as unknown as Parameters<typeof createCommandController>[0],
  )
  return { context, controller, settled: () => work }
}

it('unlocks on the durable stop receipt when a parked turn owes no newer turn/end', async () => {
  const f = setup(async () => undefined)
  f.controller.handleComposerCancel()
  expect(f.context.stopping).toBe(true)
  await f.settled()
  expect(f.context.stopping).toBe(false)
  expect(f.context.live.refresh).toHaveBeenCalled()
  expect(f.context.notice.offerMany).not.toHaveBeenCalled()
})

it.each(['timeout', 'failure'] as const)(
  'unlocks after %s and offers bounded retry and direct cancellation',
  async (mode) => {
    vi.useFakeTimers()
    const f = setup(() => (mode === 'timeout' ? new Promise(() => {}) : Promise.reject(new Error('offline'))))
    f.controller.handleComposerCancel()
    await vi.advanceTimersByTimeAsync(10_000)
    await f.settled()
    expect(f.context.stopping).toBe(false)
    expect(f.context.notice.setText).toHaveBeenLastCalledWith(enT('app.stop.unconfirmed'))
    const actions = f.context.notice.offerMany.mock.calls.at(-1)![0]
    expect(actions.map((a: { label: string }) => a.label)).toEqual(['Retry stop', 'Force end'])
    actions[0]!.run()
    expect(f.context.stopping).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    await f.settled()
    f.context.client.call.mockResolvedValueOnce({ facts: [] })
    f.context.notice.offerMany.mock.calls.at(-1)![0][1]!.run()
    expect(f.context.stopping).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    await f.settled()
    expect(f.context.client.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'session' })
    expect(f.context.stopping).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  },
)

it('does not let an old stop result or recovery action alter another selected session', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const f = setup(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  f.controller.handleComposerCancel()
  await vi.advanceTimersByTimeAsync(10_000)
  await f.settled()
  const actions = f.context.notice.offerMany.mock.calls.at(-1)![0]
  f.context.sessionBinding.begin()
  f.context.stopping = true
  f.context.notice.setText.mockClear()
  finish()
  await Promise.resolve()
  actions[1]!.run()
  expect(f.context.client.call).not.toHaveBeenCalled()
  expect(f.context.notice.setText).not.toHaveBeenCalled()
  expect(f.context.stopping).toBe(true)
})
