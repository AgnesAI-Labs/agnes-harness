import type { ComputerUseStatusResult } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ComputerUseOperationPolling,
  type ComputerUseState,
  type ComputerUseStatusClient,
  createComputerUseState,
} from '../src/computer-use-state.js'

const rpc = '_agnes/v1/computerUse.'
const ready = {
  schemaVersion: 1,
  status: 'ready',
  admission: { state: 'ready', reason: 'macos-verified-driver' },
  runtime: { state: 'idle', startAttempted: false, activeSessions: 0 },
  blockers: [],
  driver: { platform: 'darwin', version: '0.28.1', publisher: 'synthetic' },
} as const satisfies ComputerUseStatusResult
const granted = {
  schemaVersion: 1,
  status: 'granted',
  admission: ready.admission,
  probe: {
    state: 'passed',
    reason: 'macos-tcc-permissions-granted',
    accessibility: true,
    screenRecording: true,
  },
} as const
const blocked = (reason = 'driver-not-prepared') => ({
  schemaVersion: 1,
  status: 'blocked',
  admission: { state: 'blocked', reason: 'runtime-unavailable' },
  runtime: { state: 'not-started', startAttempted: false },
  blockers: [reason],
})
const operation = (state = 'running', id = 'cu-test') => ({
  schemaVersion: 1,
  status: 'found',
  operationId: id,
  kind: 'update',
  state,
  phase:
    state === 'queued' ? 'queued' : ['running', 'cancelling'].includes(state) ? 'installing' : 'complete',
  startedAtMs: 1,
  updatedAtMs: 2,
  ...(state === 'succeeded' ? { outcome: 'already-current' } : {}),
  ...(state === 'failed' ? { failure: 'operation-failed' } : {}),
})
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (value: unknown) => void
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const models: ComputerUseState[] = []
function create(call: ComputerUseStatusClient['call'], polling?: ComputerUseOperationPolling) {
  const model = createComputerUseState({ call }, polling)
  models.push(model)
  return model
}
afterEach(() => {
  for (const model of models.splice(0)) model.dispose()
  vi.useRealTimers()
})

describe('Computer Use DOM-free state', () => {
  it('publishes stable immutable snapshots and releases subscriptions', async () => {
    const call = vi.fn().mockResolvedValue(blocked('feature-disabled'))
    const model = create(call)
    const initial = model.getSnapshot()
    expect(model.getSnapshot()).toBe(initial)
    const listener = vi.fn()
    const unsubscribe = model.subscribe(listener)
    await model.refresh()
    const result = model.getSnapshot()
    expect(result.status.label).toBe('Turned off')
    expect(result.controls.installDisabled).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.controls)).toBe(true)
    expect(Object.isFrozen(result.status.blockers)).toBe(true)
    expect(initial.status.label).toBe('Waiting for a check')
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    unsubscribe()
    listener.mockClear()
    await model.refresh()
    expect(listener).not.toHaveBeenCalled()
    model.dispose()
    const retired = model.getSnapshot()
    model.subscribe(listener)
    await Promise.all([
      model.refresh(),
      model.grantPermissions(),
      model.doctor(),
      model.install(),
      model.update(),
      model.restart(),
      model.refreshOperation(),
      model.cancelOperation(),
    ])
    expect(model.getSnapshot()).toBe(retired)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('keeps only the latest status and its controls when responses arrive out of order', async () => {
    const old = deferred()
    const recent = deferred()
    const call = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise)
    const model = create(call)
    const first = model.refresh()
    const second = model.refresh()
    old.resolve(ready)
    await first
    expect(model.getSnapshot().controls.refreshDisabled).toBe(true)
    recent.resolve(blocked('platform-unsupported'))
    await second
    expect(model.getSnapshot().status.label).toBe('Not supported on this system')
    expect(model.getSnapshot().controls.refreshDisabled).toBe(false)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('clears old details on failed status and retains ready when only permission reading fails', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error('/private/permissions'))
      .mockRejectedValueOnce(new Error('credential'))
    const model = create(call)
    await model.refresh()
    expect(model.getSnapshot().status.summary).toContain('macOS driver 0.28.1')
    expect(model.getSnapshot().permissions.label).toBe('Could not read permissions')
    await model.refresh()
    const result = model.getSnapshot()
    expect(result.status.label).toBe('Could not read status')
    expect(result.status.runtime).toBe('')
    expect(result.status.blockers).toEqual([])
    expect(result.controls.installDisabled).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/credential|\/private\/permissions|publisher/)
  })

  it.each([
    ['required', 'Authorization required', false],
    ['unknown', 'Could not confirm', true],
    ['unavailable', 'Unavailable', true],
    ['not-required', 'No system authorization required', true],
    ['granted', 'Authorized', true],
  ] as const)(
    'does not turn a successful grant RPC with %s into a granted status',
    async (status, label, hidden) => {
      const call = vi.fn().mockResolvedValue({ ...granted, status })
      const model = create(call)
      await model.grantPermissions()
      expect(model.getSnapshot().permissions.label).toBe(label)
      expect(model.getSnapshot().permissions.grantHidden).toBe(hidden)
      expect(call).toHaveBeenCalledExactlyOnceWith(`${rpc}permissions.grant`, {})
    },
  )

  it('retains a pending grant through blocked refresh and prevents duplicate grant and doctor requests', async () => {
    const grant = deferred()
    const doctor = deferred()
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.grant')) return grant.promise
      if (method.endsWith('doctor')) return doctor.promise
      return blocked('feature-disabled')
    })
    const model = create(call as ComputerUseStatusClient['call'])
    const granting = model.grantPermissions()
    const checking = model.doctor()
    await Promise.all([model.grantPermissions(), model.doctor(), model.refresh()])
    expect(model.getSnapshot().permissions.label).toBe('Waiting for system authorization')
    expect(model.getSnapshot().controls.refreshDisabled).toBe(true)
    expect(model.getSnapshot().controls.doctorDisabled).toBe(true)
    grant.resolve(granted)
    doctor.resolve({ status: 'unavailable' })
    await Promise.all([granting, checking])
    expect(model.getSnapshot().permissions.label).toBe('Authorized')
    expect(model.getSnapshot().doctor.label).toBe('Not run')
    expect(model.getSnapshot().controls.doctorDisabled).toBe(true)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['ready', 'Check passed'],
    ['failed', 'Check failed'],
    ['unreachable', 'Could not connect'],
    ['unavailable', 'Not run'],
  ] as const)('projects doctor %s without exposing service internals', async (status, label) => {
    const call = vi.fn().mockResolvedValue({
      status,
      admission: { state: 'ready', reason: 'linux-verified-driver' },
      privatePath: '/private/test',
    })
    const model = create(call)
    await model.doctor()
    expect(model.getSnapshot().doctor.label).toBe(label)
    expect(JSON.stringify(model.getSnapshot())).not.toContain('/private/test')
    expect(call).toHaveBeenCalledExactlyOnceWith(`${rpc}doctor`, {})
  })

  it.each(['grantPermissions', 'doctor', 'refresh', 'refreshOperation'] as const)(
    'retires an in-flight %s and its finally without notifying subscribers',
    async (action) => {
      const reply = deferred()
      const call = vi.fn().mockReturnValue(reply.promise)
      const model = create(call)
      const listener = vi.fn()
      model.subscribe(listener)
      const pending = model[action]()
      model.dispose()
      model.dispose()
      const retired = model.getSnapshot()
      listener.mockClear()
      reply.resolve(action === 'refresh' ? ready : action === 'refreshOperation' ? operation() : granted)
      await pending
      expect(model.getSnapshot()).toBe(retired)
      expect(listener).not.toHaveBeenCalled()
      expect(call).toHaveBeenCalledTimes(1)
    },
  )
})

describe('Computer Use operation coordination', () => {
  it.each(['driver-not-prepared', 'driver-prepare-failed'])(
    'permits only install when %s, and refreshes status after immediate terminal start',
    async (reason) => {
      const call = vi.fn(async (method: string) =>
        method.endsWith('operation.start') ? operation('succeeded') : blocked(reason),
      )
      const model = create(call as ComputerUseStatusClient['call'])
      await model.refresh()
      await Promise.all([model.update(), model.restart()])
      expect(call).toHaveBeenCalledTimes(1)
      await model.install()
      expect(call).toHaveBeenNthCalledWith(2, `${rpc}operation.start`, { kind: 'install' })
      expect(call).toHaveBeenNthCalledWith(3, `${rpc}status`, {})
      expect(model.getSnapshot().operation.label).toBe('Operation finished')
      expect(model.getSnapshot().controls.installDisabled).toBe(false)
    },
  )

  it('follows queued, running, cancelling and confirmed cancelled with one operation ID', async () => {
    vi.useFakeTimers()
    let poll = 0
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      if (method.endsWith('operation.start')) return operation('queued')
      if (method.endsWith('operation.status'))
        return operation(['running', 'cancelling', 'cancelled'][poll++])
      return ready
    })
    const model = create(call as ComputerUseStatusClient['call'], { intervalMs: 20, maxAttempts: 3 })
    await model.refresh()
    const starting = model.update()
    await vi.advanceTimersByTimeAsync(0)
    expect(model.getSnapshot().operation.record?.state).toBe('queued')
    expect(model.getSnapshot().controls.cancelDisabled).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(model.getSnapshot().operation.label).toBe('Installing')
    await vi.advanceTimersByTimeAsync(20)
    expect(model.getSnapshot().operation.label).toBe('Cancelling')
    expect(model.getSnapshot().controls.installDisabled).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    await starting
    expect(model.getSnapshot().operation.record?.state).toBe('cancelled')
    expect(model.getSnapshot().operation.label).toBe('Cancelled')
    expect(model.getSnapshot().controls.cancelHidden).toBe(true)
    expect(call.mock.calls.filter(([method]) => method.endsWith('operation.status'))).toEqual(
      Array(3).fill([`${rpc}operation.status`, { operationId: 'cu-test' }]),
    )
    expect(call.mock.calls.filter(([method]) => method.endsWith('operation.cancel'))).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('exhausts polling without inventing a terminal result, then recovers and permits another operation', async () => {
    let completed = false
    const wait = vi.fn(async () => undefined)
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      if (method.endsWith('operation.start')) return operation()
      if (method.endsWith('operation.status')) return operation(completed ? 'succeeded' : 'running')
      return ready
    })
    const model = create(call as ComputerUseStatusClient['call'], { maxAttempts: 2, intervalMs: 7, wait })
    await model.refresh()
    await model.update()
    const exhausted = model.getSnapshot()
    expect(exhausted.operation.label).toBe('Still running')
    expect(exhausted.operation.record?.state).toBe('running')
    expect(exhausted.controls.updateDisabled).toBe(true)
    expect(exhausted.controls.operationRefreshDisabled).toBe(false)
    expect(wait).toHaveBeenCalledTimes(2)
    completed = true
    await model.refreshOperation()
    expect(model.getSnapshot().operation.label).toBe('Operation finished')
    expect(model.getSnapshot().controls.restartDisabled).toBe(false)
    await model.restart()
    expect(call.mock.calls.filter(([method]) => method.endsWith('operation.start'))).toEqual([
      [`${rpc}operation.start`, { kind: 'update' }],
      [`${rpc}operation.start`, { kind: 'restart' }],
    ])
  })

  it('retains the active operation on a failed poll, cancel failure and failed refresh, and recovers', async () => {
    let recovered = false
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      if (method.endsWith('operation.start')) return operation()
      if (method.endsWith('operation.status') || method.endsWith('operation.cancel')) {
        if (!recovered) throw new Error('credential')
        return operation('failed')
      }
      return ready
    })
    const model = create(call as ComputerUseStatusClient['call'], { wait: async () => undefined })
    await model.refresh()
    await model.update()
    expect(model.getSnapshot().operation.label).toBe('Could not read progress')
    await model.cancelOperation()
    expect(model.getSnapshot().operation.label).toBe('Cancel failed')
    expect(model.getSnapshot().operation.record?.state).toBe('running')
    expect(model.getSnapshot().controls.cancelDisabled).toBe(false)
    await model.refreshOperation()
    expect(model.getSnapshot().operation.summary).toContain('still be running in the background')
    expect(model.getSnapshot().controls.updateDisabled).toBe(true)
    expect(JSON.stringify(model.getSnapshot())).not.toContain('credential')
    recovered = true
    await model.refreshOperation()
    expect(model.getSnapshot().operation.label).toBe('Operation failed')
    expect(model.getSnapshot().controls.updateDisabled).toBe(false)
    expect(call).toHaveBeenCalledWith(`${rpc}operation.cancel`, { operationId: 'cu-test' })
  })

  it('does not let old polls, reads or finally clear a pending cancellation and does not duplicate cancel', async () => {
    const oldPoll = deferred()
    const oldRead = deferred()
    const cancel = deferred()
    let reads = 0
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      if (method.endsWith('operation.start')) return operation()
      if (method.endsWith('operation.status')) return reads++ === 0 ? oldPoll.promise : oldRead.promise
      if (method.endsWith('operation.cancel')) return cancel.promise
      return ready
    })
    const model = create(call as ComputerUseStatusClient['call'], { wait: async () => undefined })
    await model.refresh()
    const starting = model.update()
    await vi.waitFor(() => expect(reads).toBe(1))
    const refreshing = model.refreshOperation()
    const cancelling = model.cancelOperation()
    await Promise.all([model.cancelOperation(), model.refreshOperation(), model.update()])
    oldPoll.resolve(operation('succeeded'))
    oldRead.resolve(operation('running'))
    await Promise.all([starting, refreshing])
    expect(model.getSnapshot().operation.label).toBe('Cancelling')
    expect(model.getSnapshot().controls.operationRefreshDisabled).toBe(true)
    expect(model.getSnapshot().controls.cancelDisabled).toBe(true)
    cancel.resolve(operation('cancelled'))
    await cancelling
    expect(model.getSnapshot().operation.label).toBe('Cancelled')
    expect(model.getSnapshot().controls.operationRefreshDisabled).toBe(false)
    expect(call.mock.calls.filter(([method]) => method.endsWith('operation.cancel'))).toHaveLength(1)
  })

  it.each(['start', 'cancel', 'status'] as const)(
    'does not turn operation.%s not-found into completion or cancellation',
    async (method) => {
      const call = vi.fn(async (name: string) => {
        if (name.endsWith('permissions.status')) return granted
        if (name === `${rpc}operation.${method}`) return { schemaVersion: 1, status: 'not-found' }
        if (name.endsWith('operation.start') || name.endsWith('operation.status')) return operation()
        return ready
      })
      const model = create(call as ComputerUseStatusClient['call'], {
        maxAttempts: 1,
        wait: async () => undefined,
      })
      await model.refresh()
      if (method === 'status') await model.refreshOperation()
      else {
        const starting = model.update()
        if (method === 'cancel') {
          await vi.waitFor(() => expect(model.getSnapshot().controls.cancelDisabled).toBe(false))
          await model.cancelOperation()
        }
        await starting
      }
      expect(model.getSnapshot().operation.label).toBe('No record')
      expect(model.getSnapshot().operation.record).toBeUndefined()
    },
  )

  it('cancels its default wait immediately on disposal without cancelling backend work', async () => {
    vi.useFakeTimers()
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      return method.endsWith('operation.start') ? operation() : ready
    })
    const model = create(call as ComputerUseStatusClient['call'])
    await model.refresh()
    const starting = model.update()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    model.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await starting
    expect(call).toHaveBeenCalledTimes(3)
    expect(call.mock.calls.some(([method]) => method.endsWith('operation.cancel'))).toBe(false)
  })

  it('aborts an injected wait and retires even when that wait never resolves', async () => {
    let signal: AbortSignal | undefined
    const wait = vi.fn((_delay: number, next?: AbortSignal) => {
      signal = next
      return new Promise<void>(() => undefined)
    })
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      return method.endsWith('operation.start') ? operation() : ready
    })
    const model = create(call as ComputerUseStatusClient['call'], { wait })
    await model.refresh()
    const starting = model.update()
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
    model.dispose()
    await starting
    expect(signal?.aborted).toBe(true)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it.each(['operation.start', 'operation.cancel', 'operation.status'] as const)(
    'rejects an in-flight %s reply after disposal',
    async (route) => {
      const reply = deferred()
      const call = vi.fn(async (method: string) => {
        if (method.endsWith(route)) return reply.promise
        if (method.endsWith('permissions.status')) return granted
        return method.endsWith('operation.start') || method.endsWith('operation.status') ? operation() : ready
      })
      const model = create(call as ComputerUseStatusClient['call'], { wait: async () => undefined })
      await model.refresh()
      const starting = model.update()
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith(`${rpc}operation.start`, { kind: 'update' }))
      const cancelling = route === 'operation.cancel' ? model.cancelOperation() : Promise.resolve()
      if (route !== 'operation.start')
        await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method.endsWith(route))).toBe(true))
      model.dispose()
      const retired = model.getSnapshot()
      reply.resolve(operation('succeeded'))
      await Promise.all([starting, cancelling])
      expect(model.getSnapshot()).toBe(retired)
      expect(call.mock.calls.filter(([method]) => method === `${rpc}status`)).toHaveLength(1)
    },
  )
})

describe('Computer Use subscription retirement', () => {
  it('does not issue a request when a subscriber retires the owner on its pending snapshot', async () => {
    const call = vi.fn().mockResolvedValue(ready)
    const model = create(call)
    model.subscribe(() => model.dispose())
    await model.refresh()
    expect(call).not.toHaveBeenCalled()
  })

  it('does not create a wait after a subscriber cancels an operation from its start response', async () => {
    vi.useFakeTimers()
    const cancellation = deferred()
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      if (method.endsWith('operation.start')) return operation()
      if (method.endsWith('operation.cancel')) return cancellation.promise
      return ready
    })
    const model = create(call as ComputerUseStatusClient['call'])
    await model.refresh()
    let cancelling: Promise<void> | undefined
    model.subscribe(() => {
      if (
        model.getSnapshot().operation.record?.state === 'running' &&
        !model.getSnapshot().controls.cancelDisabled
      )
        cancelling = model.cancelOperation()
    })
    const starting = model.update()
    await vi.advanceTimersByTimeAsync(0)
    const timerCount = vi.getTimerCount()
    cancellation.resolve(operation('cancelled'))
    await cancelling
    await vi.advanceTimersByTimeAsync(500)
    await starting
    expect(timerCount).toBe(0)
    expect(model.getSnapshot().operation.label).toBe('Cancelled')
    expect(call.mock.calls.some(([method]) => method.endsWith('operation.status'))).toBe(false)
  })
})

describe('Computer Use terminal recovery', () => {
  it('discovers a new preparation after an old terminal result within the same bounded monitor', async () => {
    let reads = 0
    let statusReads = 0
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('operation.status')) {
        const sequence = [
          operation('running', 'cu-old'),
          operation('failed', 'cu-old'),
          operation('running', 'cu-new'),
          operation('succeeded', 'cu-new'),
        ]
        return sequence[reads++]
      }
      if (method.endsWith('permissions.status')) return granted
      return statusReads++ === 0 ? blocked('driver-preparing') : ready
    })
    const wait = vi.fn(async () => undefined)
    const model = create(call as ComputerUseStatusClient['call'], { maxAttempts: 3, wait })
    await model.refreshOperation()
    expect(call.mock.calls.filter(([method]) => method.endsWith('operation.status'))).toEqual([
      [`${rpc}operation.status`, {}],
      [`${rpc}operation.status`, { operationId: 'cu-old' }],
      [`${rpc}operation.status`, {}],
      [`${rpc}operation.status`, { operationId: 'cu-new' }],
    ])
    expect(wait).toHaveBeenCalledTimes(3)
    expect(call.mock.calls.some(([method]) => method.endsWith('operation.start'))).toBe(false)
    expect(model.getSnapshot().operation.record).toEqual({
      operationId: 'cu-new',
      kind: 'update',
      state: 'succeeded',
      phase: 'complete',
    })
    expect(model.getSnapshot().status.label).toBe('Available')
    expect(model.getSnapshot().controls.updateDisabled).toBe(false)
  })

  it('keeps a cancelling response nonterminal until the backend confirms cancelled', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      if (method.endsWith('operation.start')) return operation()
      if (method.endsWith('operation.cancel')) return operation('cancelling')
      if (method.endsWith('operation.status')) return operation(cancelled ? 'cancelled' : 'running')
      return ready
    })
    const model = create(call as ComputerUseStatusClient['call'], { intervalMs: 20 })
    await model.refresh()
    const starting = model.update()
    await vi.advanceTimersByTimeAsync(0)
    const cancelling = model.cancelOperation()
    await vi.advanceTimersByTimeAsync(0)
    await starting
    expect(model.getSnapshot().operation.label).toBe('Cancelling')
    expect(model.getSnapshot().operation.record?.state).toBe('cancelling')
    expect(model.getSnapshot().controls.updateDisabled).toBe(true)
    cancelled = true
    await vi.advanceTimersByTimeAsync(20)
    await cancelling
    expect(model.getSnapshot().operation.label).toBe('Cancelled')
    expect(model.getSnapshot().controls.updateDisabled).toBe(false)
    expect(call.mock.calls.filter(([method]) => method.endsWith('operation.cancel'))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requires recovery after an uncertain start, finds the backend ID, then permits another submission', async () => {
    let submissions = 0
    const call = vi.fn(async (method: string) => {
      if (method.endsWith('permissions.status')) return granted
      if (method.endsWith('operation.start')) {
        if (submissions++ === 0) throw new Error('credential')
        return operation('succeeded', 'cu-second')
      }
      if (method.endsWith('operation.status')) return operation('succeeded', 'cu-first')
      return ready
    })
    const model = create(call as ComputerUseStatusClient['call'])
    await model.refresh()
    await model.update()
    await model.restart()
    expect(submissions).toBe(1)
    expect(model.getSnapshot().operation.label).toBe('Could not confirm the start')
    expect(model.getSnapshot().operation.record).toBeUndefined()
    expect(model.getSnapshot().controls.cancelDisabled).toBe(true)
    await model.refreshOperation()
    expect(call).toHaveBeenCalledWith(`${rpc}operation.status`, {})
    expect(model.getSnapshot().operation.record?.operationId).toBe('cu-first')
    expect(model.getSnapshot().controls.updateDisabled).toBe(false)
    await model.update()
    expect(submissions).toBe(2)
    expect(model.getSnapshot().operation.record?.operationId).toBe('cu-second')
    expect(JSON.stringify(model.getSnapshot())).not.toContain('credential')
  })
})
