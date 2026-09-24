import { describe, expect, it, vi } from 'vitest'
import { closeWithAudit, installSignals, shutdownLadder } from '../src/supervisor/lifecycle.js'

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('flushes after close, preserving failures (%s, %s)', async (closeFails, flushFails) => {
  const order: string[] = []
  const closeError = new Error('close failure')
  const flushError = new Error('flush failure')
  const result = closeWithAudit(
    async () => {
      order.push('close')
      if (closeFails) throw closeError
    },
    async () => {
      order.push('flush')
      if (flushFails) throw flushError
    },
  )
  if (closeFails && flushFails)
    await expect(result).rejects.toMatchObject({ errors: [closeError, flushError] })
  else if (closeFails || flushFails) await expect(result).rejects.toBe(closeFails ? closeError : flushError)
  else await result
  expect(order).toEqual(['close', 'flush'])
})

describe('shutdown ladder', () => {
  it('runs every phase in order without force-killing workers that drain', async () => {
    const order: string[] = []
    await shutdownLadder({
      stopAccepting: async () => void order.push('stop'),
      notify: () => void order.push('notify'),
      closeWorkers: async () => void order.push('close'),
      killWorkers: () => void order.push('kill'),
      closeSockets: async () => void order.push('sockets'),
      releaseLock: async () => void order.push('lock'),
      graceMs: 100,
    })
    expect(order).toEqual(['stop', 'notify', 'close', 'sockets', 'lock'])
  })

  it('force-kills after grace and still closes sockets and releases the lock', async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      const closing = shutdownLadder({
        stopAccepting: async () => void order.push('stop'),
        notify: () => void order.push('notify'),
        closeWorkers: async () => {
          order.push('close')
          await new Promise(() => {})
        },
        killWorkers: () => void order.push('kill'),
        closeSockets: async () => void order.push('sockets'),
        releaseLock: async () => void order.push('lock'),
        graceMs: 50,
      })
      await vi.advanceTimersByTimeAsync(50)
      await closing
      expect(order).toEqual(['stop', 'notify', 'close', 'kill', 'sockets', 'lock'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the timed-out drain so its late continuation cannot cross lock release', async () => {
    vi.useFakeTimers()
    try {
      let releaseDrain!: () => void
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve
      })
      const order: string[] = []
      const closing = shutdownLadder({
        stopAccepting: async () => {},
        notify: () => {},
        closeWorkers: async (_graceMs, signal) => {
          await drainGate
          if (!signal.aborted) order.push('late-worker-action')
        },
        killWorkers: () => void order.push('kill'),
        closeSockets: async () => void order.push('sockets'),
        releaseLock: async () => void order.push('lock'),
        graceMs: 50,
      })

      await vi.advanceTimersByTimeAsync(50)
      await closing
      expect(order).toEqual(['kill', 'sockets', 'lock'])
      releaseDrain()
      await Promise.resolve()
      expect(order).toEqual(['kill', 'sockets', 'lock'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs each failed phase and never skips later resource release', async () => {
    const order: string[] = []
    const logs: string[] = []
    await shutdownLadder({
      stopAccepting: async () => {
        order.push('stop')
        throw new Error('intake')
      },
      notify: () => {
        order.push('notify')
        throw new Error('notice')
      },
      closeWorkers: async () => {
        order.push('close')
        throw new Error('worker')
      },
      killWorkers: () => {
        order.push('kill')
        throw new Error('kill')
      },
      closeSockets: async () => {
        order.push('sockets')
        throw new Error('socket')
      },
      releaseLock: async () => void order.push('lock'),
      graceMs: 100,
      log: (message) => logs.push(message),
    })
    expect(order).toEqual(['stop', 'notify', 'close', 'kill', 'sockets', 'lock'])
    expect(logs).toEqual([
      expect.stringContaining('stopAccepting'),
      expect.stringContaining('notify'),
      expect.stringContaining('closeWorkers'),
      expect.stringContaining('killWorkers'),
      expect.stringContaining('closeSockets'),
    ])
  })
})

describe('daemon signals', () => {
  const signalTarget = () => {
    const listeners = new Map<NodeJS.Signals, Set<() => void>>()
    return {
      target: {
        on(signal: NodeJS.Signals, listener: () => void) {
          const set = listeners.get(signal) ?? new Set()
          set.add(listener)
          listeners.set(signal, set)
        },
        removeListener(signal: NodeJS.Signals, listener: () => void) {
          listeners.get(signal)?.delete(listener)
        },
      },
      emit(signal: NodeJS.Signals) {
        for (const listener of [...(listeners.get(signal) ?? [])]) listener()
      },
    }
  }

  it('drains on the first signal and exits zero', async () => {
    const signals = signalTarget()
    const exits: number[] = []
    let drained = false
    installSignals(
      async () => {
        drained = true
      },
      (code) => exits.push(code),
      signals.target,
    )
    signals.emit('SIGTERM')
    await vi.waitFor(() => expect(exits).toEqual([0]))
    expect(drained).toBe(true)
  })

  it('forces 130 on either second signal without waiting for the drain', async () => {
    const signals = signalTarget()
    const exits: number[] = []
    let finish!: () => void
    const draining = new Promise<void>((resolve) => {
      finish = resolve
    })
    installSignals(
      () => draining,
      (code) => exits.push(code),
      signals.target,
    )
    signals.emit('SIGINT')
    signals.emit('SIGTERM')
    expect(exits).toEqual([130])
    finish()
    await Promise.resolve()
    expect(exits).toEqual([130])
  })

  it('uses exit one when graceful shutdown rejects', async () => {
    const signals = signalTarget()
    const exits: number[] = []
    installSignals(
      async () => Promise.reject(new Error('failed')),
      (code) => exits.push(code),
      signals.target,
    )
    signals.emit('SIGTERM')
    await vi.waitFor(() => expect(exits).toEqual([1]))
  })

  it('uses exit one and removes listeners when shutdown throws synchronously', async () => {
    const signals = signalTarget()
    const exits: number[] = []
    installSignals(
      () => {
        throw new Error('synchronous failure')
      },
      (code) => exits.push(code),
      signals.target,
    )
    signals.emit('SIGTERM')
    await vi.waitFor(() => expect(exits).toEqual([1]))
    signals.emit('SIGINT')
    expect(exits).toEqual([1])
  })
})
