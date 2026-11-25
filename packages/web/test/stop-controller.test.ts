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
    current: {
      id: 'session',
      cancel,
      controls: async () => ({ facts: [], factsThrough: 1166 }),
      pendingCommands: async () => [],
    },
    sessionBinding,
    submissions: new SubmissionOwner(sessionBinding),
    stopping: false,
    connected: true,
    sessionPending: false,
    sessionControls: undefined as unknown,
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
      offer: vi.fn<(action: { label: string; run(): void }) => void>(),
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

it('separates child control write receipts from controls refresh failures and rejects when disconnected', async () => {
  const f = setup(async () => undefined)
  const control = vi.fn(async () => ({ ok: true }))
  const followUp = vi.fn(async () => ({ ok: true }))
  const controls = vi
    .fn()
    .mockRejectedValueOnce(new Error('controls read timeout'))
    .mockResolvedValueOnce({ facts: [], factsThrough: 1, children: [] })
  Object.assign(f.context, {
    connected: true,
    current: {
      id: 'session',
      cancel: async () => undefined,
      control,
      followUp,
      controls,
      pendingCommands: async () => [],
    },
  })
  f.context.sessionBinding.attach(f.context.sessionBinding.capture(), {
    session: f.context.current as unknown as Session,
  })
  const outcome = await f.controller.handleChildControl('child-1', 'continue', 'proceed')
  expect(control).toHaveBeenCalledTimes(1)
  expect(outcome?.refreshFailed).toContain('controls read timeout')
  expect(f.context.live.refresh).toHaveBeenCalledTimes(1)
  await outcome?.retryRefresh?.()
  // Retrying refresh only re-reads controls and never sends a duplicate write.
  expect(control).toHaveBeenCalledTimes(1)
  expect(controls).toHaveBeenCalledTimes(2)
  // Recap prompt explicitly specifies childKey for single-child recap scope.
  await f.controller.handleChildControl('child-1', 'recap')
  expect(followUp).toHaveBeenCalledWith(expect.stringContaining('childKey "child-1"'))
  // Disconnected or switching rejects explicitly instead of silently resolving.
  f.context.connected = false
  await expect(f.controller.handleChildControl('child-1', 'pause')).rejects.toThrow()
})

it('polls child controls serially without starving slow reads, pauses when hidden and ignores interrupted', async () => {
  vi.useFakeTimers()
  const f = setup(async () => undefined)
  let visible = true
  let onVisibleCb: (() => void) | undefined
  let resolveSlow: ((value: unknown) => void) | undefined
  const controls = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveSlow = resolve
      }),
  )
  const session = {
    id: 'session',
    cancel: async () => undefined,
    controls,
    pendingCommands: async () => [],
  }
  Object.assign(f.context, {
    connected: true,
    current: session,
    sessionControls: {
      sessionId: 'session',
      value: { facts: [], children: [{ id: 'c1', status: 'running' }] },
    },
  })
  f.context.sessionBinding.attach(f.context.sessionBinding.capture(), {
    session: session as unknown as Session,
  })
  const stop = f.controller.startChildControlPolling({
    intervalMs: 1500,
    isVisible: () => visible,
    onVisible: (fn) => {
      onVisibleCb = fn
      return () => {}
    },
    onFocus: () => () => {},
  })
  try {
    // Advance 5 seconds while the first read is still pending: never starts an overlapping read.
    await vi.advanceTimersByTimeAsync(5000)
    expect(controls).toHaveBeenCalledTimes(1)
    // A user-triggered refresh while the slow read is in flight queues one trailing read.
    const trailing = f.controller.refreshSessionControls(session as unknown as Session)
    expect(controls).toHaveBeenCalledTimes(1)
    resolveSlow?.({ facts: [], factsThrough: 2, children: [{ id: 'c1', status: 'running' }] })
    await vi.advanceTimersByTimeAsync(0)
    // The trailing read starts right after the first read commits.
    expect(controls).toHaveBeenCalledTimes(2)
    resolveSlow?.({ facts: [], factsThrough: 3, children: [{ id: 'c1', status: 'interrupted' }] })
    await trailing
    // Interrupted is settled; polling stops instead of spinning forever.
    await vi.advanceTimersByTimeAsync(5000)
    expect(controls).toHaveBeenCalledTimes(2)
    // Back to running while hidden: does not poll until tab returns to visible.
    f.context.sessionControls = {
      sessionId: 'session',
      value: { facts: [], children: [{ id: 'c1', status: 'running' }] },
    }
    visible = false
    await vi.advanceTimersByTimeAsync(3000)
    expect(controls).toHaveBeenCalledTimes(2)
    visible = true
    onVisibleCb?.()
    expect(controls).toHaveBeenCalledTimes(3)
    resolveSlow?.({ facts: [], factsThrough: 4, children: [{ id: 'c1', status: 'completed' }] })
    await Promise.resolve()
  } finally {
    stop()
  }
})
