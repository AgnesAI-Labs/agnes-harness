import { expect, it, vi } from 'vitest'
import {
  ActivationInProgressError,
  ActivationTimeoutError,
  createExtensionActivationBarrier,
} from '../../src/ext-host/activation-barrier.js'

const deferred = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('waits for turns and their Tool and Service children before issuing the permit', async () => {
  const barrier = createExtensionActivationBarrier()
  const turnDone = deferred(),
    toolDone = deferred(),
    serviceDone = deferred()
  const turn = barrier.admit('turn')
  const tool = turn.child('tool')
  const service = turn.child('service')
  const running = [
    turn.run(() => turnDone.promise),
    tool.run(() => toolDone.promise),
    service.run(() => serviceDone.promise),
  ]
  const switched: string[] = []
  const activation = barrier.quiesce('pkg.update', async () => {
    switched.push('committed')
  })

  expect(barrier.snapshot()).toMatchObject({
    state: 'quiescing',
    operationId: 'pkg.update',
    active: { turn: 1, tool: 1, service: 1 },
  })
  expect(() => barrier.admit('turn')).toThrow(
    expect.objectContaining({ code: 'OVERLOADED', reason: 'activation-in-progress', retryable: true }),
  )
  expect(() => barrier.admit('service')).toThrow(ActivationInProgressError)
  turnDone.resolve()
  serviceDone.resolve()
  await Promise.resolve()
  expect(switched).toEqual([])
  toolDone.resolve()
  await Promise.all([...running, activation])
  expect(switched).toEqual(['committed'])
  expect(barrier.snapshot()).toEqual({
    state: 'accepting',
    active: { turn: 0, tool: 0, service: 0 },
    queued: { turn: 0, tool: 0, service: 0 },
  })
})

it('holds a pre-existing queued invocation until after the switching commit point', async () => {
  const barrier = createExtensionActivationBarrier()
  const active = barrier.admit('turn'),
    queued = barrier.enqueue('turn'),
    release = deferred()
  const running = active.run(() => release.promise)
  const order: string[] = []
  const activation = barrier.quiesce('pkg.queue', async () => {
    order.push('commit-start')
    await Promise.resolve()
    order.push('commit-end')
  })
  const queuedStart = queued.start().then((invocation) => {
    order.push('queued-start')
    invocation.finish()
  })

  expect(barrier.snapshot().queued.turn).toBe(1)
  release.resolve()
  await Promise.all([running, activation, queuedStart])
  expect(order).toEqual(['commit-start', 'commit-end', 'queued-start'])
})

it('makes an open-gate queue start active before yielding to a same-tick activation', async () => {
  const barrier = createExtensionActivationBarrier()
  const queued = barrier.enqueue('service'),
    release = deferred()
  const started = queued.start()
  const activationOrder: string[] = []
  const activation = barrier.quiesce('pkg.same-tick', async () => {
    activationOrder.push('commit')
  })
  const invocation = await started
  expect(barrier.snapshot()).toMatchObject({ state: 'quiescing', active: { service: 1 } })
  const running = invocation.run(() => release.promise)
  await Promise.resolve()
  expect(activationOrder).toEqual([])
  release.resolve()
  await Promise.all([running, activation])
  expect(activationOrder).toEqual(['commit'])
})

it('times out only activation, reopens admission, and does not cancel active work', async () => {
  vi.useFakeTimers()
  try {
    const barrier = createExtensionActivationBarrier({ deadlineMs: 30 })
    const invocation = barrier.admit('service')
    let completed = false
    const work = invocation.run(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      completed = true
    })
    const activation = barrier.quiesce('pkg.timeout', async () => undefined)
    const assertion = expect(activation).rejects.toMatchObject({
      name: 'ActivationTimeoutError',
      code: 'ACTIVATION_TIMEOUT',
      operationId: 'pkg.timeout',
      deadlineMs: 30,
    })
    await vi.advanceTimersByTimeAsync(30)
    await assertion
    expect(completed).toBe(false)
    const next = barrier.admit('turn')
    next.finish()
    expect(barrier.snapshot()).toMatchObject({ state: 'accepting', active: { service: 1 } })
    await vi.advanceTimersByTimeAsync(70)
    await work
    expect(completed).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('issues a frozen permit and still opens the gate around a nested barrier', async () => {
  const first = createExtensionActivationBarrier(),
    second = createExtensionActivationBarrier()
  await first.quiesce('pkg.permit', async (permit) => {
    expect(Object.isFrozen(permit)).toBe(true)
    await second.quiesce('pkg.other', async (otherPermit) => {
      expect(Object.isFrozen(otherPermit)).toBe(true)
      expect(otherPermit).not.toBe(permit)
    })
    expect(second.snapshot()).toMatchObject({ state: 'accepting' })
  })
  expect(first.snapshot()).toMatchObject({ state: 'accepting' })
})

it('admits Tool and Service children started by an existing turn after the gate closes', async () => {
  const barrier = createExtensionActivationBarrier()
  const startChildren = deferred()
  const childrenDone = deferred()
  const turn = barrier.admit('turn')
  const running = turn.run(async () => {
    await startChildren.promise
    const tool = barrier.admit('tool')
    const service = barrier.admit('service')
    await Promise.all([tool.run(() => childrenDone.promise), service.run(() => childrenDone.promise)])
  })
  const switched: string[] = []
  const activation = barrier.quiesce('pkg.children', async () => void switched.push('commit'))

  startChildren.resolve()
  await Promise.resolve()
  expect(barrier.snapshot()).toMatchObject({
    state: 'quiescing',
    active: { turn: 1, tool: 1, service: 1 },
  })
  expect(() => barrier.admit('turn')).toThrow(ActivationInProgressError)
  childrenDone.resolve()
  await Promise.all([running, activation])
  expect(switched).toEqual(['commit'])
})

it('lets an admitted turn retain a durable turn hold after activation closes the gate', async () => {
  const barrier = createExtensionActivationBarrier()
  const retainNow = deferred()
  const retained = deferred()
  let durable: ReturnType<typeof barrier.admit> | undefined
  const outer = barrier.admit('turn')
  const running = outer.run(async () => {
    await retainNow.promise
    durable = barrier.admit('turn')
    retained.resolve()
  })
  const order: string[] = []
  const activation = barrier.quiesce('pkg.after-outer-admission', async () => void order.push('commit'))

  retainNow.resolve()
  await retained.promise
  await running
  expect(barrier.snapshot()).toMatchObject({
    state: 'quiescing',
    active: { turn: 1 },
  })
  expect(order).toEqual([])
  durable?.finish()
  await activation
  expect(order).toEqual(['commit'])
})

it('does not let detached work retain an expired turn across a closed gate', async () => {
  const barrier = createExtensionActivationBarrier()
  const invokeDetached = deferred()
  const finishSwitch = deferred()
  let detached: Promise<unknown> | undefined
  const outer = barrier.admit('turn')
  await outer.run(() => {
    detached = invokeDetached.promise.then(() => {
      try {
        return barrier.admit('turn')
      } catch (error) {
        return error
      }
    })
  })
  const activation = barrier.quiesce('pkg.detached-expired-turn', () => finishSwitch.promise)
  invokeDetached.resolve()
  await expect(detached).resolves.toBeInstanceOf(ActivationInProgressError)
  finishSwitch.resolve()
  await activation
})

it('reopens queued and immediate admission when switching fails', async () => {
  const barrier = createExtensionActivationBarrier()
  const queued = barrier.enqueue('service')
  await expect(
    barrier.quiesce('pkg.failure', async () => {
      throw new Error('candidate failed')
    }),
  ).rejects.toThrow('candidate failed')
  const service = await queued.start()
  service.finish()
  const turn = barrier.admit('turn')
  turn.finish()
})

it('validates the host-owned deadline and reports the timeout type', () => {
  expect(() => createExtensionActivationBarrier({ deadlineMs: 0 })).toThrow('deadlineMs must be positive')
  expect(new ActivationTimeoutError('op', 30_000)).toMatchObject({ code: 'ACTIVATION_TIMEOUT' })
})

it('uses the frozen v1 default quiescence deadline of 30 seconds', async () => {
  vi.useFakeTimers()
  try {
    const barrier = createExtensionActivationBarrier()
    const invocation = barrier.admit('tool')
    const activation = barrier.quiesce('pkg.default-deadline', async () => undefined)
    const assertion = expect(activation).rejects.toMatchObject({
      code: 'ACTIVATION_TIMEOUT',
      deadlineMs: 30_000,
    })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(barrier.snapshot().state).toBe('quiescing')
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    invocation.finish()
  } finally {
    vi.useRealTimers()
  }
})
