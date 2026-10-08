import { describe, expect, it, vi } from 'vitest'
import { createLazyComputerUseRuntime } from '../../src/computer-use/lazy-runtime.js'

function candidate() {
  const backend = {
    acquire: vi.fn(async () => ({ marker: 'backend' }) as never),
    release: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    status: () => ({ activeSessions: 0, startAttempted: false }),
  }
  return {
    backend,
    dispose: vi.fn(async () => undefined),
    controls: {
      status: () => ({
        platform: 'win32' as const,
        version: '1',
        publisher: 'signed',
        activeSessions: 0,
        startAttempted: false,
      }),
      doctor: vi.fn(async () => undefined),
      permissionsStatus: async () => null,
      permissionsGrant: async () => null,
      setSessionYolo: async () => undefined,
      operationStart: vi.fn(() => {
        throw new Error('unused')
      }),
      operationStatus: () => undefined,
      operationCancel: () => undefined,
    },
  }
}

const session = { key: 's', lane: 'main' }

describe('Computer Use first-use preparation', () => {
  it('does not cancel explicitly requested preparation when a joining tool cancels', async () => {
    let finish!: (value: ReturnType<typeof candidate>) => void
    let signal: AbortSignal | undefined
    const lazy = createLazyComputerUseRuntime({
      initialize: (input) => {
        signal = input
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const operation = lazy.controls.operationStart('install')
    const abort = new AbortController()
    const request = lazy.backend.acquire(session, abort.signal)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(signal).toBeDefined())
    abort.abort()
    await rejected
    expect(signal?.aborted).toBe(false)
    finish(candidate())
    await vi.waitFor(() =>
      expect(lazy.controls.operationStatus(operation.operationId)?.state).toBe('succeeded'),
    )
    await lazy.dispose()
  })

  it('records automatic preparation and permits explicit cancellation', async () => {
    let started: AbortSignal | undefined
    const lazy = createLazyComputerUseRuntime({
      initialize: (signal) =>
        new Promise((_resolve, reject) => {
          started = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const request = lazy.backend.acquire(session, new AbortController().signal)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(started).toBeDefined())
    const operation = lazy.controls.operationStatus()
    if (!operation) throw new Error('missing preparation operation')
    expect(operation).toMatchObject({ kind: 'install', state: 'running' })
    lazy.controls.operationCancel(operation.operationId)
    await rejected
    expect(lazy.controls.operationStatus(operation.operationId)?.state).toBe('cancelled')
    await lazy.dispose()
  })

  it('waits for cancelled cleanup before an immediate retry starts a fresh initializer', async () => {
    let rejectFirst!: (error: unknown) => void
    const first = new Promise<ReturnType<typeof candidate>>((_resolve, reject) => {
      rejectFirst = reject
    })
    const initialize = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(candidate())
    const lazy = createLazyComputerUseRuntime({ initialize })
    const abort = new AbortController()
    const request = lazy.backend.acquire(session, abort.signal)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
    abort.abort()
    await rejected
    const retry = lazy.backend.acquire(session, new AbortController().signal)
    await Promise.resolve()
    expect(initialize).toHaveBeenCalledOnce()
    rejectFirst(new DOMException('cancelled', 'AbortError'))
    await retry
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(lazy.controls.operationStatus()?.state).toBe('succeeded')
    await lazy.dispose()
  })

  it('aborts and joins a post-initialization probe before completing close', async () => {
    let lifetime: AbortSignal | undefined
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const driver = candidate()
    driver.controls.doctor = vi.fn(async () => {
      await new Promise<void>((resolve) =>
        lifetime?.addEventListener('abort', () => resolve(), { once: true }),
      )
      await cleanup
    })
    const lazy = createLazyComputerUseRuntime({
      initialize: async (signal) => {
        lifetime = signal
        return driver
      },
    })
    await lazy.backend.acquire(session, new AbortController().signal)
    const probe = lazy.controls.doctor()
    await vi.waitFor(() => expect(driver.controls.doctor).toHaveBeenCalledOnce())
    let closed = false
    const closing = lazy.dispose().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(lifetime?.aborted).toBe(true)
    expect(closed).toBe(false)
    finishCleanup()
    await Promise.all([probe, closing])
    expect(driver.dispose).toHaveBeenCalledOnce()
  })

  it('does not install on construction, status, mode changes, release or close', async () => {
    const initialize = vi.fn(async () => candidate())
    const lazy = createLazyComputerUseRuntime({ initialize })
    expect(lazy.controls.status()).toEqual({ availability: 'driver-not-prepared' })
    await lazy.controls.setSessionYolo(session, true)
    await lazy.backend.release(session)
    await lazy.dispose()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('shares initialization, preserves pre-acquire permission mode and reuses the ready driver', async () => {
    const driver = candidate()
    const initialize = vi.fn(async () => driver)
    const lazy = createLazyComputerUseRuntime({ initialize })
    await lazy.controls.setSessionYolo(session, true)
    const signal = new AbortController().signal
    await Promise.all([
      lazy.backend.acquire(session, signal),
      lazy.backend.acquire({ ...session, key: 'other' }, signal),
    ])
    await lazy.backend.acquire(session, signal)
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(driver.backend.setPermissionMode).toHaveBeenCalledWith(session, 'unrestricted')
    expect(lazy.controls.status()).toMatchObject({ version: '1' })
    await lazy.dispose()
    expect(driver.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports failure without destroying the Host and retries on the next request', async () => {
    const initialize = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(candidate())
    const lazy = createLazyComputerUseRuntime({ initialize })
    const signal = new AbortController().signal
    await expect(lazy.backend.acquire(session, signal)).rejects.toThrow('offline')
    expect(lazy.controls.status()).toEqual({ availability: 'driver-prepare-failed' })
    await lazy.backend.acquire(session, signal)
    expect(initialize).toHaveBeenCalledTimes(2)
    await lazy.dispose()
  })

  it.each(['feature-disabled', 'platform-unsupported'] as const)(
    'never initializes when %s',
    async (unavailable) => {
      const initialize = vi.fn(async () => candidate())
      const lazy = createLazyComputerUseRuntime({ unavailable, initialize })
      await expect(lazy.backend.acquire(session, new AbortController().signal)).rejects.toThrow(unavailable)
      expect(() => lazy.controls.operationStart('install')).toThrow(unavailable)
      expect(initialize).not.toHaveBeenCalled()
      await lazy.dispose()
    },
  )

  it('cancels preparation when the last waiting request is cancelled', async () => {
    let started: AbortSignal | undefined
    const lazy = createLazyComputerUseRuntime({
      initialize: (signal) =>
        new Promise((_resolve, reject) => {
          started = signal
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
    })
    const abort = new AbortController()
    const request = lazy.backend.acquire(session, abort.signal)
    const rejected = expect(request).rejects.toBeDefined()
    await vi.waitFor(() => expect(started).toBeDefined())
    abort.abort()
    await rejected
    expect(started?.aborted).toBe(true)
    await lazy.dispose()
  })

  it('keeps shared preparation alive when only one caller cancels', async () => {
    let finish: (value: ReturnType<typeof candidate>) => void = () => undefined
    let started: AbortSignal | undefined
    const lazy = createLazyComputerUseRuntime({
      initialize: (signal) => {
        started = signal
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const abort = new AbortController()
    const first = lazy.backend.acquire(session, abort.signal)
    const rejection = expect(first).rejects.toBeDefined()
    const second = lazy.backend.acquire({ ...session, key: 'other' }, new AbortController().signal)
    await vi.waitFor(() => expect(started).toBeDefined())
    abort.abort()
    await rejection
    expect(started?.aborted).toBe(false)
    finish(candidate())
    await second
    await lazy.dispose()
  })

  it('exposes preparation progress through existing install operations', async () => {
    const lazy = createLazyComputerUseRuntime({
      initialize: async () => ({ ...candidate(), preparationOutcome: 'installed' as const }),
    })
    const operation = lazy.controls.operationStart('install')
    expect(operation.state).toBe('queued')
    await vi.waitFor(() =>
      expect(lazy.controls.operationStatus(operation.operationId)?.state).toBe('succeeded'),
    )
    expect(lazy.controls.status()).toMatchObject({ platform: 'win32' })
    expect(lazy.controls.operationStatus(operation.operationId)?.outcome).toBe('installed')
    await lazy.dispose()
  })

  it('joins repeated close calls until the pending initializer has cleaned up', async () => {
    let finish: (value: ReturnType<typeof candidate>) => void = () => undefined
    const driver = candidate()
    const initialize = vi.fn(
      () =>
        new Promise<ReturnType<typeof candidate>>((resolve) => {
          finish = resolve
        }),
    )
    const lazy = createLazyComputerUseRuntime({ initialize })
    const request = lazy.backend.acquire(session, new AbortController().signal)
    const rejected = expect(request).rejects.toBeDefined()
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
    const first = lazy.dispose()
    const second = lazy.dispose()
    expect(second).toBe(first)
    finish(driver)
    await Promise.all([first, second, rejected])
    expect(driver.dispose).toHaveBeenCalledOnce()
  })
})
