import { expect, it, vi } from 'vitest'
import { createWindowsPipeListener, type PipeAccept } from '../src/windows-pipe-listener.js'
import type { OwnedPipe, WindowsPipeStream } from '../src/windows-pipe-stream.js'

it.each([0, 254, 255, 1.5, Number.NaN])('rejects business capacity %s before accepting', (capacity) => {
  const reservation = { accept: vi.fn(), close: vi.fn() }
  expect(() => createWindowsPipeListener(reservation, capacity, () => {})).toThrow('capacity')
  expect(reservation.accept).not.toHaveBeenCalled()
  expect(reservation.close).toHaveBeenCalledOnce()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function accepting(autoCancel = true) {
  const result = deferred<{ open(): OwnedPipe }>()
  const pending: PipeAccept = {
    ready: Promise.resolve(),
    result: result.promise,
    cancel: vi.fn(() => {
      if (autoCancel) result.reject(new Error('cancelled'))
    }),
  }
  return { pending, ...result }
}
function owner() {
  const read = deferred<Buffer | null>()
  return {
    read: vi.fn(() => read.promise),
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {
      read.resolve(null)
    }),
  }
}

it('drains a connected result racing stop before releasing the reservation without dispatching it', async () => {
  const waiting = accepting(false)
  const release = deferred<void>()
  const pipe = { ...owner(), close: vi.fn(() => release.promise) }
  const reservation = { accept: vi.fn(() => waiting.pending), close: vi.fn() }
  const dispatch = vi.fn()
  const listener = createWindowsPipeListener(reservation, 1, dispatch)
  const stopped = listener.stopAccepting()
  expect(listener.stopAccepting()).toBe(stopped)
  expect(waiting.pending.cancel).toHaveBeenCalledOnce()
  expect(reservation.close).not.toHaveBeenCalled()
  waiting.resolve({ open: () => pipe })
  await vi.waitFor(() => expect(pipe.close).toHaveBeenCalledOnce())
  expect(dispatch).not.toHaveBeenCalled()
  expect(reservation.close).not.toHaveBeenCalled()
  release.resolve()
  await stopped
  expect(reservation.close).toHaveBeenCalledOnce()
  await listener.close()
  expect(reservation.accept).toHaveBeenCalledOnce()
})

it('restores capacity only after an active stream closes and preserves active streams during stop', async () => {
  const requests: ReturnType<typeof accepting>[] = []
  const reservation = {
    accept: vi.fn(() => {
      const next = accepting()
      requests.push(next)
      return next.pending
    }),
    close: vi.fn(),
  }
  const streams: WindowsPipeStream[] = []
  const listener = createWindowsPipeListener(reservation, 1, (stream) => streams.push(stream))
  const first = owner()
  requests[0]?.resolve({ open: () => first })
  await vi.waitFor(() => expect(streams).toHaveLength(1))
  expect(reservation.accept).toHaveBeenCalledOnce()
  streams[0]?.destroy()
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  const second = owner()
  requests[1]?.resolve({ open: () => second })
  await vi.waitFor(() => expect(streams).toHaveLength(2))
  await listener.stopAccepting()
  expect(second.close).not.toHaveBeenCalled()
  expect(streams[1]?.destroyed).toBe(false)
  const closed = listener.close()
  expect(listener.close()).toBe(closed)
  await closed
  expect(second.close).toHaveBeenCalledOnce()
  expect(reservation.close).toHaveBeenCalledOnce()
})

it.each([5, 8, 87, 231])(
  'keeps infrastructure error %s fatal and closes dispatched connections',
  async (win32Code) => {
    const first = accepting(),
      second = accepting()
    const reservation = {
      accept: vi.fn().mockReturnValueOnce(first.pending).mockReturnValueOnce(second.pending),
      close: vi.fn(),
    }
    const dispatch = vi.fn()
    const listener = createWindowsPipeListener(reservation, 2, dispatch)
    const pipe = owner()
    first.resolve({ open: () => pipe })
    await vi.waitFor(() => expect(reservation.accept).toHaveBeenCalledTimes(2))
    const failure = Object.assign(new Error('accept failed'), { code: 'E_PIPE_ACCEPT', win32Code })
    second.reject(failure)
    expect(await listener.failed).toBe(failure)
    await listener.close()
    expect(pipe.close).toHaveBeenCalledOnce()
    expect(reservation.close).toHaveBeenCalledOnce()
  },
)

it('drops a rejected peer, preserves active connections, and accepts the next peer', async () => {
  const requests: ReturnType<typeof accepting>[] = []
  const reservation = {
    accept: vi.fn(() => {
      const next = accepting()
      requests.push(next)
      return next.pending
    }),
    close: vi.fn(),
  }
  const dispatch = vi.fn()
  const listener = createWindowsPipeListener(reservation, 3, dispatch)
  const failed = vi.fn()
  void listener.failed.then(failed)
  const first = owner()
  try {
    requests[0]?.resolve({ open: () => first })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    requests[1]?.reject(Object.assign(new Error('peer disappeared'), { code: 'E_PIPE_PEER_REJECTED' }))
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(first.close).not.toHaveBeenCalled()
    requests[2]?.resolve({ open: () => owner() })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(failed).not.toHaveBeenCalled()
    expect(reservation.close).not.toHaveBeenCalled()
  } finally {
    await listener.close()
  }
})

it('releases the reservation when initial accept setup throws', () => {
  const failure = new Error('setup failed')
  const reservation = {
    accept: vi.fn(() => {
      throw failure
    }),
    close: vi.fn(),
  }
  expect(() => createWindowsPipeListener(reservation, 1, () => {})).toThrow(failure)
  expect(reservation.close).toHaveBeenCalledOnce()
})

it('backs off repeated peer rejection and stops during the delay without accepting again', async () => {
  vi.useFakeTimers()
  const rejected = Object.assign(new Error('denied'), { code: 'E_PIPE_PEER_REJECTED', win32Code: 5 })
  const reservation = {
    accept: vi.fn(() => ({ ready: Promise.resolve(), result: Promise.reject(rejected), cancel: vi.fn() })),
    close: vi.fn(),
  }
  const dispatch = vi.fn()
  const listener = createWindowsPipeListener(reservation, 1, dispatch)
  try {
    await listener.ready
    await vi.advanceTimersByTimeAsync(9)
    expect(reservation.accept).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(reservation.accept).toHaveBeenCalledTimes(2)
    const stopped = listener.close()
    await vi.advanceTimersByTimeAsync(10)
    await stopped
    expect(reservation.accept).toHaveBeenCalledTimes(2)
    expect(reservation.close).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('isolates a throwing connection handler and continues accepting', async () => {
  const first = accepting(),
    second = accepting()
  const reservation = {
    accept: vi.fn().mockReturnValueOnce(first.pending).mockReturnValueOnce(second.pending),
    close: vi.fn(),
  }
  const dispatch = vi.fn(() => {
    throw new Error('handler failed')
  })
  const listener = createWindowsPipeListener(reservation, 1, dispatch)
  const failed = vi.fn()
  void listener.failed.then(failed)
  const pipe = owner()
  first.resolve({ open: () => pipe })
  await vi.waitFor(() => expect(reservation.accept).toHaveBeenCalledTimes(2))
  expect(pipe.close).toHaveBeenCalledOnce()
  await listener.close()
  expect(failed).not.toHaveBeenCalled()
})

it('waits for native setup before publishing readiness', async () => {
  const setup = deferred<void>()
  const pending = accepting()
  pending.pending.ready = setup.promise
  const reservation = { accept: vi.fn(() => pending.pending), close: vi.fn() }
  const listener = createWindowsPipeListener(reservation, 1, () => {})
  const ready = vi.fn()
  void listener.ready.then(ready)
  await Promise.resolve()
  expect(ready).not.toHaveBeenCalled()
  setup.resolve()
  await listener.ready
  expect(ready).toHaveBeenCalledOnce()
  await listener.close()
})

it('rejects readiness when stopped during preparation even if native later reports ready', async () => {
  const setup = deferred<void>()
  const pending = accepting()
  pending.pending.ready = setup.promise
  const reservation = { accept: vi.fn(() => pending.pending), close: vi.fn() }
  const listener = createWindowsPipeListener(reservation, 1, () => {})
  const rejected = expect(listener.ready).rejects.toThrow('stopped before ready')
  await listener.stopAccepting()
  setup.resolve()
  await rejected
  expect(reservation.close).toHaveBeenCalledOnce()
})

it('reports native preparation failure and waits for accept cleanup before releasing the name', async () => {
  const setup = deferred<void>()
  const pending = accepting(false)
  pending.pending.ready = setup.promise
  const reservation = { accept: vi.fn(() => pending.pending), close: vi.fn() }
  const listener = createWindowsPipeListener(reservation, 1, () => {})
  const failure = new Error('native preparation failed')
  const rejected = expect(listener.ready).rejects.toBe(failure)
  setup.reject(failure)
  await rejected
  expect(await listener.failed).toBe(failure)
  expect(reservation.close).not.toHaveBeenCalled()
  pending.reject(failure)
  await listener.close()
  expect(reservation.close).toHaveBeenCalledOnce()
})
