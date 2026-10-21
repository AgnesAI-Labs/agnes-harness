import { expect, it, vi } from 'vitest'
import { AssemblyLifetime, assemblyPort } from '../src/supervisor/assembly-lifetime.js'

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
  try {
    const closing = lifetime.close(10)
    await vi.advanceTimersByTimeAsync(11)
    await closing
    expect(effects).toEqual(['stop', 'kill', 'worker', 'lock'])
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
