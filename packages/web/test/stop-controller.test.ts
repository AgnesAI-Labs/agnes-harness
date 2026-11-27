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
  // Recap prompt explicitly specifies childKey for single-child recap scope and forwards a stable commandId.
  await f.controller.handleChildControl('child-1', 'recap')
  expect(followUp).toHaveBeenCalledWith(expect.stringContaining('childKey "child-1"'), {
    commandId: expect.any(String),
  })
  // Disconnected or switching rejects explicitly instead of silently resolving.
  f.context.connected = false
  await expect(f.controller.handleChildControl('child-1', 'pause')).rejects.toThrow()
})

it('reuses the exact same commandId when retrying a child write after a lost receipt and resets on edit, success or session switch', async () => {
  const f = setup(async () => undefined)
  const accepted = new Map<string, number>()
  let failOnce = true
  const control = vi.fn(async (_action: string, opts?: { commandId?: string }) => {
    const id = opts?.commandId ?? ''
    accepted.set(id, (accepted.get(id) ?? 0) + 1)
    if (failOnce) {
      failOnce = false
      throw new Error('receipt lost after server accept')
    }
    return 1
  })
  const makeSession = (id: string) => ({
    id,
    cancel: async () => undefined,
    control,
    followUp: vi.fn(async (_text: string, _opts?: { commandId?: string }) => 1),
    controls: vi.fn(async () => ({ facts: [], factsThrough: 1, children: [] })),
    pendingCommands: async () => [],
  })
  const sessionA = makeSession('session-a')
  Object.assign(f.context, { connected: true, current: sessionA })
  f.context.sessionBinding.attach(f.context.sessionBinding.capture(), {
    session: sessionA as unknown as Session,
  })

  // First attempt fails after port receives it; retrying the identical draft reuses the exact commandId.
  await expect(f.controller.handleChildControl('child-1', 'continue', 'same draft')).rejects.toThrow(
    'receipt lost',
  )
  await f.controller.handleChildControl('child-1', 'continue', 'same draft')
  const firstId = (control.mock.calls[0]?.[1] as { commandId?: string } | undefined)?.commandId
  const retryId = (control.mock.calls[1]?.[1] as { commandId?: string } | undefined)?.commandId
  expect(firstId).toBeTruthy()
  expect(retryId).toBe(firstId)
  expect(accepted.size).toBe(1)

  // After write confirmation, submitting the same text again starts a fresh intent with a new commandId.
  await f.controller.handleChildControl('child-1', 'continue', 'same draft')
  const freshAfterSuccess = (control.mock.calls[2]?.[1] as { commandId?: string } | undefined)?.commandId
  expect(freshAfterSuccess).toBeTruthy()
  expect(freshAfterSuccess).not.toBe(firstId)

  // Editing the draft after a failed write creates a new commandId instead of reusing the old one.
  failOnce = true
  await expect(f.controller.handleChildControl('child-1', 'continue', 'draft v1')).rejects.toThrow()
  const failedDraftId = (control.mock.calls[3]?.[1] as { commandId?: string } | undefined)?.commandId
  await f.controller.handleChildControl('child-1', 'continue', 'draft v2')
  const editedDraftId = (control.mock.calls[4]?.[1] as { commandId?: string } | undefined)?.commandId
  expect(editedDraftId).not.toBe(failedDraftId)

  // Switching sessions invalidates any pending commandId from the previous session.
  failOnce = true
  await expect(f.controller.handleChildControl('child-1', 'continue', 'switch draft')).rejects.toThrow()
  const beforeSwitchId = (control.mock.calls[5]?.[1] as { commandId?: string } | undefined)?.commandId
  const sessionB = makeSession('session-b')
  const { binding: bindingB } = f.context.sessionBinding.begin('session-b')
  f.context.current = sessionB as unknown as typeof f.context.current
  f.context.sessionBinding.attach(bindingB, { session: sessionB as unknown as Session })
  await f.controller.handleChildControl('child-1', 'continue', 'switch draft')
  const afterSwitchId = (control.mock.calls[6]?.[1] as { commandId?: string } | undefined)?.commandId
  expect(afterSwitchId).not.toBe(beforeSwitchId)

  // Even when a remounted UI passes a fresh commandId for the same unconfirmed intent, the session-bound
  // controller reuses the original pending commandId for both recap and continue until confirmed.
  let failFollowUpOnce = true
  sessionB.followUp.mockImplementation(async () => {
    if (failFollowUpOnce) {
      failFollowUpOnce = false
      throw new Error('recap receipt lost')
    }
    return 1
  })
  await expect(
    f.controller.handleChildControl('child-1', 'recap', undefined, { commandId: 'ui-recap-1' }),
  ).rejects.toThrow('recap receipt lost')
  await f.controller.handleChildControl('child-1', 'recap', undefined, { commandId: 'ui-recap-remounted-2' })
  expect((sessionB.followUp.mock.calls[0]?.[1] as { commandId?: string } | undefined)?.commandId).toBe(
    'ui-recap-1',
  )
  expect((sessionB.followUp.mock.calls[1]?.[1] as { commandId?: string } | undefined)?.commandId).toBe(
    'ui-recap-1',
  )
  await f.controller.handleChildControl('child-1', 'recap', undefined, { commandId: 'ui-recap-3' })
  expect((sessionB.followUp.mock.calls[2]?.[1] as { commandId?: string } | undefined)?.commandId).toBe(
    'ui-recap-3',
  )

  failOnce = true
  await expect(
    f.controller.handleChildControl('child-1', 'continue', 'remount draft', { commandId: 'ui-cont-1' }),
  ).rejects.toThrow('receipt lost')
  await f.controller.handleChildControl('child-1', 'continue', 'remount draft', {
    commandId: 'ui-cont-remounted-2',
  })
  const remountFirst = (control.mock.calls[7]?.[1] as { commandId?: string } | undefined)?.commandId
  const remountRetry = (control.mock.calls[8]?.[1] as { commandId?: string } | undefined)?.commandId
  expect(remountFirst).toBe('ui-cont-1')
  expect(remountRetry).toBe('ui-cont-1')
})

it('settles stale trailing refreshes on session switch and isolates per-session refresh state and polling', async () => {
  vi.useFakeTimers()
  const f = setup(async () => undefined)
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }
  const aReads: Array<ReturnType<typeof deferred<unknown>>> = []
  const bReads: Array<ReturnType<typeof deferred<unknown>>> = []
  const sessionA = {
    id: 'session-a',
    cancel: async () => undefined,
    controls: vi.fn(() => {
      const d = deferred<unknown>()
      aReads.push(d)
      return d.promise
    }),
    pendingCommands: async () => [],
  }
  const sessionB = {
    id: 'session-b',
    cancel: async () => undefined,
    controls: vi.fn(() => {
      const d = deferred<unknown>()
      bReads.push(d)
      return d.promise
    }),
    pendingCommands: async () => [],
  }
  Object.assign(f.context, {
    connected: true,
    current: sessionA,
    sessionControls: {
      sessionId: 'session-a',
      value: { facts: [], children: [{ id: 'a-1', status: 'running' }] },
    },
  })
  f.context.sessionBinding.attach(f.context.sessionBinding.capture(), {
    session: sessionA as unknown as Session,
  })
  const stopPoller = f.controller.startChildControlPolling({
    intervalMs: 1500,
    isVisible: () => true,
    onVisible: () => () => {},
    onFocus: () => () => {},
  })
  try {
    // Scenario 1: A has an in-flight + trailing refresh, switch to B, B also queues a trailing refresh.
    const aFirst = f.controller.refreshSessionControls(sessionA as unknown as Session)
    const aTrailing = f.controller.refreshSessionControls(sessionA as unknown as Session)
    expect(sessionA.controls).toHaveBeenCalledTimes(1)

    const { binding: bindingB } = f.context.sessionBinding.begin('session-b')
    f.context.current = sessionB as unknown as typeof f.context.current
    f.context.sessionControls = undefined
    f.context.sessionBinding.attach(bindingB, { session: sessionB as unknown as Session })

    const bFirst = f.controller.refreshSessionControls(sessionB as unknown as Session)
    const bTrailing = f.controller.refreshSessionControls(sessionB as unknown as Session)
    expect(sessionB.controls).toHaveBeenCalledTimes(1)

    // A's stale trailing promise settles immediately without hanging even before A's old read returns.
    let aTrailingSettled = false
    void aTrailing.then(() => {
      aTrailingSettled = true
    })
    await Promise.resolve()
    expect(aTrailingSettled).toBe(true)

    // Scenario 2: A's old read resolves while B's read is in flight; A must neither start a stale read
    // nor increment B's counter nor drop B's successful state.
    aReads[0]?.resolve({ facts: [], factsThrough: 1, children: [{ id: 'a-1', status: 'completed' }] })
    await aFirst
    expect(sessionA.controls).toHaveBeenCalledTimes(1)
    expect(f.context.sessionControls).toBeUndefined()

    bReads[0]?.resolve({ facts: [], factsThrough: 2, children: [{ id: 'b-1', status: 'running' }] })
    await bFirst
    expect(f.context.sessionControls).toMatchObject({
      sessionId: 'session-b',
      value: { children: [{ id: 'b-1', status: 'running' }] },
    })
    // B's trailing read starts and settles cleanly.
    expect(sessionB.controls).toHaveBeenCalledTimes(2)
    bReads[1]?.resolve({ facts: [], factsThrough: 3, children: [{ id: 'b-1', status: 'running' }] })
    await bTrailing
    // B's child poller remains armed and continues polling B on the interval.
    await vi.advanceTimersByTimeAsync(1500)
    expect(sessionB.controls).toHaveBeenCalledTimes(3)
    bReads[2]?.resolve({ facts: [], factsThrough: 4, children: [{ id: 'b-1', status: 'completed' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.context.sessionControls).toMatchObject({
      sessionId: 'session-b',
      value: { children: [{ id: 'b-1', status: 'completed' }] },
    })

    // Scenario 2b: A starts its trailing read right before switching to B; when A's stale trailing read
    // returns while B's read is in flight, B's response is still applied and B's poller keeps running.
    const { binding: bindingA2 } = f.context.sessionBinding.begin('session-a')
    f.context.current = sessionA as unknown as typeof f.context.current
    f.context.sessionControls = {
      sessionId: 'session-a',
      value: { facts: [], children: [{ id: 'a-1', status: 'running' }] },
    }
    f.context.sessionBinding.attach(bindingA2, { session: sessionA as unknown as Session })
    const aPoll = f.controller.refreshSessionControls(sessionA as unknown as Session)
    const aSecondTrailing = f.controller.refreshSessionControls(sessionA as unknown as Session)
    aReads[1]?.resolve({ facts: [], factsThrough: 5, children: [{ id: 'a-1', status: 'running' }] })
    await aPoll
    // A's trailing read (aReads[2]) has now started and is in flight.
    expect(sessionA.controls).toHaveBeenCalledTimes(3)

    const { binding: bindingB2 } = f.context.sessionBinding.begin('session-b')
    f.context.current = sessionB as unknown as typeof f.context.current
    f.context.sessionControls = undefined
    f.context.sessionBinding.attach(bindingB2, { session: sessionB as unknown as Session })
    const bRefresh = f.controller.refreshSessionControls(sessionB as unknown as Session)
    expect(sessionB.controls).toHaveBeenCalledTimes(4)

    // A's in-flight trailing read resolves before B's read; must not invalidate B's sequence or state.
    aReads[2]?.resolve({ facts: [], factsThrough: 6, children: [{ id: 'a-1', status: 'completed' }] })
    await aSecondTrailing
    expect(f.context.sessionControls).toBeUndefined()

    bReads[3]?.resolve({ facts: [], factsThrough: 7, children: [{ id: 'b-1', status: 'running' }] })
    await bRefresh
    expect(f.context.sessionControls).toMatchObject({
      sessionId: 'session-b',
      value: { children: [{ id: 'b-1', status: 'running' }] },
    })
    await vi.advanceTimersByTimeAsync(1500)
    expect(sessionB.controls).toHaveBeenCalledTimes(5)
    bReads[4]?.resolve({ facts: [], factsThrough: 8, children: [{ id: 'b-1', status: 'completed' }] })
    await vi.advanceTimersByTimeAsync(0)
  } finally {
    stopPoller()
  }
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
