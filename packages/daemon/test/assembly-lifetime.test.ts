import { expect, it, vi } from 'vitest'
import { AssemblyLifetime, assemblyPort, assemblyTasks } from '../src/supervisor/assembly-lifetime.js'

it('uses one reverse owner list for successful and partial initialization, and closes only once', async () => {
  for (const failAfter of [0, 1, 2, 3]) {
    const lifetime = new AssemblyLifetime()
    const released: number[] = []
    for (let phase = 0; phase < 4; phase++) {
      const scope = lifetime.phase()
      scope.own({
        dispose: () => {
          released.push(phase)
        },
      })
      if (phase === failAfter) break
    }
    await Promise.all([lifetime.close(50), lifetime.close(50)])
    expect(released).toEqual(Array.from({ length: failAfter + 1 }, (_, i) => failAfter - i))
    expect(() => lifetime.own({ dispose() {} })).toThrow('E_PACKAGE_STATE')
  }
})

it('continues cleanup after a resource fails and forces a drain that exceeds its grace', async () => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const lifetime = new AssemblyLifetime()
  const effects: string[] = []
  lifetime.own({
    dispose: () => {
      effects.push('lock')
    },
  })
  const scope = lifetime.phase()
  scope.own({
    stop: () => {
      effects.push('stop')
    },
    drain: () => new Promise<void>(() => {}),
    force: () => {
      effects.push('kill')
    },
    dispose: () => {
      effects.push('worker')
      throw new Error('release failed')
    },
  })
  scope.own({
    force: () => {
      throw new Error('termination failed')
    },
    dispose: () => {
      effects.push('sibling')
    },
  })
  try {
    const closing = lifetime.close(10)
    await vi.advanceTimersByTimeAsync(11)
    await closing
    expect(effects).toEqual(['stop', 'kill', 'sibling', 'worker', 'lock'])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    log.mockRestore()
    vi.useRealTimers()
  }
})

it('refuses every unready or closed bootstrap callback with the same closed error', () => {
  const port = assemblyPort<(n: number) => number>()
  expect(() => port.read()(1)).toThrow('E_PACKAGE_STATE: daemon port is not ready')
  port.initialize((n) => n + 1)
  expect(port.read()(1)).toBe(2)
  expect(() => port.initialize((n) => n)).toThrow('E_PACKAGE_STATE')
  port.close()
  expect(() => port.read()(1)).toThrow('E_PACKAGE_STATE: daemon port is not ready')
  expect(() => port.initialize((n) => n)).toThrow('E_PACKAGE_STATE')
})

it('waits for already-started runtime recovery before releasing the owner and refuses late work', async () => {
  const lifetime = new AssemblyLifetime()
  const events: string[] = []
  lifetime.own({
    dispose: () => {
      events.push('lock')
    },
  })
  const tasks = assemblyTasks()
  lifetime.own({ dispose: () => tasks.close() })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const running = tasks.run(async () => {
    await gate
    events.push('recovery')
  })
  const closing = lifetime.dispose()
  await Promise.resolve()
  expect(events).toEqual([])
  expect(() => tasks.run(async () => undefined)).toThrow('E_PACKAGE_STATE')
  finish()
  await Promise.all([running, closing])
  expect(events).toEqual(['recovery', 'lock'])
})

it('returns a complete phase disposer that can run before the parent without releasing twice', async () => {
  vi.useFakeTimers()
  try {
    const lifetime = new AssemblyLifetime(10)
    const events: string[] = []
    const { ready, dispose } = await lifetime.assemble((owner) => {
      const timer = setInterval(() => undefined, 100)
      owner.own({
        stop: () => {
          clearInterval(timer)
          events.push('stop')
        },
        drain: async () => {
          events.push('drain')
        },
        dispose: () => {
          events.push('dispose')
        },
      })
      return 'ready'
    })
    expect(ready).toBe('ready')
    await dispose()
    await lifetime.close(10)
    expect(events).toEqual(['stop', 'drain', 'dispose'])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
