import { describe, expect, it, vi } from 'vitest'
import { createRunnerSupervisor } from '../src/runner/supervisor.js'
import { createFakeClient } from '../testkit/index.js'

function instance(name: string, order: string[]) {
  const client = createFakeClient()
  const runner = {
    start: vi.fn(async () => {
      order.push(`${name}:start`)
    }),
    stopIntake: vi.fn(() => {
      order.push(`${name}:stopIntake`)
    }),
    stop: vi.fn(async () => {
      order.push(`${name}:stop`)
    }),
  }
  return { client, runner }
}

describe('Channel SDK terminal recovery', () => {
  it('stops the old runner before constructing a fresh client and never duplicates the active runner', async () => {
    const order: string[] = []
    const first = instance('first', order)
    const second = instance('second', order)
    const create = vi.fn(async () => {
      order.push('create')
      return create.mock.calls.length === 1 ? first : second
    })
    const supervisor = createRunnerSupervisor(create, { warn: vi.fn() }, { wait: async () => undefined })
    await supervisor.start()

    first.client.emit('closed', { reason: 'eof' })
    first.client.emit('closed', { reason: 'eof' })
    await vi.waitFor(() => expect(second.runner.start).toHaveBeenCalledOnce())
    expect(order).toEqual([
      'create',
      'first:start',
      'first:stopIntake',
      'first:stop',
      'create',
      'second:start',
    ])
    expect(first.runner.stop).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledTimes(2)

    await supervisor.stop({ drainMs: 50 })
    second.client.emit('closed', { reason: 'closed' })
    expect(create).toHaveBeenCalledTimes(2)
    expect(second.runner.stop).toHaveBeenCalledOnce()
  })

  it('retries a failed fresh construction and cancels recovery when shutdown starts', async () => {
    const order: string[] = []
    const first = instance('first', order)
    const second = instance('second', order)
    const warn = vi.fn()
    let attempt = 0
    const create = vi.fn(async () => {
      attempt++
      if (attempt === 2) throw new Error('temporary daemon failure')
      return attempt === 1 ? first : second
    })
    const supervisor = createRunnerSupervisor(create, { warn }, { wait: async () => undefined })
    await supervisor.start()
    first.client.emit('closed', { reason: 'eof' })
    await vi.waitFor(() => expect(second.runner.start).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledOnce()
    await supervisor.stop()
  })

  it('waits for in-flight construction before reporting shutdown complete', async () => {
    const order: string[] = []
    const late = instance('late', order)
    let finishConstruction: ((value: typeof late) => void) | undefined
    const create = vi.fn(() => new Promise<typeof late>((resolve) => (finishConstruction = resolve)))
    const supervisor = createRunnerSupervisor(create, { warn: vi.fn() })
    const start = supervisor.start()
    const stop = supervisor.stop()
    let stopped = false
    void stop.then(() => (stopped = true))
    await Promise.resolve()
    expect(stopped).toBe(false)

    finishConstruction?.(late)
    await Promise.all([start, stop])
    expect(stopped).toBe(true)
    expect(late.runner.start).not.toHaveBeenCalled()
    expect(late.runner.stop).toHaveBeenCalledOnce()
  })

  it('does not rebuild while a terminal runner is still starting', async () => {
    const order: string[] = []
    const first = instance('first', order)
    const second = instance('second', order)
    let finishStart: (() => void) | undefined
    first.runner.start.mockImplementationOnce(() => new Promise<void>((resolve) => (finishStart = resolve)))
    const create = vi.fn(async () => (create.mock.calls.length === 1 ? first : second))
    const supervisor = createRunnerSupervisor(create, { warn: vi.fn() }, { wait: async () => undefined })
    const start = supervisor.start()
    await vi.waitFor(() => expect(first.runner.start).toHaveBeenCalledOnce())
    first.client.emit('closed', { reason: 'eof' })
    await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)

    finishStart?.()
    await expect(start).rejects.toThrow('closed during startup')
    await vi.waitFor(() => expect(second.runner.start).toHaveBeenCalledOnce())
    expect(order.indexOf('first:stop')).toBeLessThan(order.indexOf('second:start'))
    await supervisor.stop()
  })
})
