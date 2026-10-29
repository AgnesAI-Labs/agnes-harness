import { describe, expect, it, vi } from 'vitest'
import { createComputerUseDriverOperationRuntime } from '../../src/computer-use/driver-operation-runtime.js'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Computer Use driver operation runtime', () => {
  it('publishes bounded progress and a stable successful result', async () => {
    let now = 10
    const runtime = createComputerUseDriverOperationRuntime(
      {
        install: async (_kind, input) => {
          input.phase('installing')
          input.phase('restarting')
          return 'installed'
        },
        restart: async () => 'restarted',
      },
      { clock: () => now++, operationId: () => 'cu-one' },
    )
    expect(runtime.start('install')).toMatchObject({ state: 'queued', phase: 'queued' })
    await settle()
    expect(runtime.status('cu-one')).toEqual({
      operationId: 'cu-one',
      kind: 'install',
      state: 'succeeded',
      phase: 'complete',
      startedAtMs: 10,
      updatedAtMs: 13,
      outcome: 'installed',
    })
  })

  it('cancels the exact active operation and never exposes its error text', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = createComputerUseDriverOperationRuntime(
      {
        install: async (_kind, input) => {
          input.phase('installing')
          await waiting
          input.signal.throwIfAborted()
          return 'installed'
        },
        restart: async () => 'restarted',
      },
      { operationId: () => 'cu-cancel' },
    )
    runtime.start('update')
    await Promise.resolve()
    expect(runtime.cancel('cu-cancel')).toMatchObject({ state: 'cancelling' })
    release()
    await settle()
    expect(runtime.status('cu-cancel')).toMatchObject({ state: 'cancelled', phase: 'complete' })
    expect(runtime.status('cu-cancel')).not.toHaveProperty('failure')
  })

  it('refuses overlap, isolates unknown ids and converts task failures to a stable code', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const install = vi.fn(async () => {
      await waiting
      throw new Error('secret local path')
    })
    const runtime = createComputerUseDriverOperationRuntime(
      { install, restart: async () => 'restarted' },
      { operationId: () => 'cu-failure' },
    )
    runtime.start('install')
    expect(() => runtime.start('restart')).toThrow(/already running/)
    expect(runtime.cancel('cu-unknown')).toBeUndefined()
    release()
    await settle()
    expect(runtime.status()).toMatchObject({ state: 'failed', failure: 'operation-failed' })
    expect(JSON.stringify(runtime.status())).not.toContain('secret local path')
  })

  it('aborts and waits for the active task during close', async () => {
    const runtime = createComputerUseDriverOperationRuntime(
      {
        install: async (_kind, input) => {
          input.signal.throwIfAborted()
          await new Promise<void>((resolve) =>
            input.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          input.signal.throwIfAborted()
          return 'installed'
        },
        restart: async () => 'restarted',
      },
      { operationId: () => 'cu-close' },
    )
    runtime.start('install')
    await runtime.close()
    expect(runtime.status()).toMatchObject({ state: 'cancelled' })
    expect(() => runtime.start('install')).toThrow(/closed/)
  })

  it('reports success when cancellation arrives after an irreversible task has committed', async () => {
    let release!: () => void
    const committed = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = createComputerUseDriverOperationRuntime(
      {
        install: async (_kind, input) => {
          input.phase('restarting')
          await committed
          return 'installed'
        },
        restart: async () => 'restarted',
      },
      { operationId: () => 'cu-committed' },
    )
    runtime.start('install')
    await Promise.resolve()
    runtime.cancel('cu-committed')
    release()
    await settle()

    expect(runtime.status('cu-committed')).toMatchObject({
      state: 'succeeded',
      phase: 'complete',
      outcome: 'installed',
    })
  })

  it('reports a real task failure even when cancellation was requested first', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = createComputerUseDriverOperationRuntime(
      {
        install: async (_kind, input) => {
          input.phase('installing')
          await waiting
          throw new Error('archive verification failed after cancellation')
        },
        restart: async () => 'restarted',
      },
      { operationId: () => 'cu-cancel-then-fail' },
    )
    runtime.start('update')
    await Promise.resolve()
    runtime.cancel('cu-cancel-then-fail')
    release()
    await settle()

    expect(runtime.status('cu-cancel-then-fail')).toMatchObject({
      state: 'failed',
      phase: 'complete',
      failure: 'operation-failed',
    })
  })

  it('keeps published timestamps monotonic when the wall clock moves backward', async () => {
    const times = [100, 90, 80]
    const runtime = createComputerUseDriverOperationRuntime(
      {
        install: async (_kind, input) => {
          input.phase('installing')
          return 'installed'
        },
        restart: async () => 'restarted',
      },
      { clock: () => times.shift() ?? 70, operationId: () => 'cu-clock' },
    )

    runtime.start('install')
    await settle()

    expect(runtime.status('cu-clock')).toMatchObject({ startedAtMs: 100, updatedAtMs: 100 })
  })
})
