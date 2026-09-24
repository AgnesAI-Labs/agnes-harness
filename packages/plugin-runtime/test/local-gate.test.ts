import { describe, expect, it, vi } from 'vitest'
import { E_LOCAL_GATE_FATAL, LocalGate } from '../src/local-gate.js'

const nextMicrotask = () => Promise.resolve()

describe('LocalGate', () => {
  it('drains active reads before running a closed transaction', async () => {
    const gate = new LocalGate()
    const release = await gate.enterRead()
    const body = vi.fn()
    const closed = gate.withClosed(body)

    await nextMicrotask()
    expect(gate.isOpen).toBe(false)
    expect(body).not.toHaveBeenCalled()

    release()
    await closed
    expect(body).toHaveBeenCalledOnce()
    expect(gate.isOpen).toBe(true)
  })

  it('queues new reads once closing begins and releases them after reopening', async () => {
    const gate = new LocalGate()
    const releaseFirst = await gate.enterRead()
    let secondEntered = false
    const closed = gate.withClosed(async () => undefined)
    const second = gate.enterRead().then((release) => {
      secondEntered = true
      return release
    })

    await nextMicrotask()
    expect(secondEntered).toBe(false)
    releaseFirst()
    await closed
    const releaseSecond = await second
    expect(secondEntered).toBe(true)
    releaseSecond()
  })

  it('reopens after an ordinary closed transaction failure', async () => {
    const gate = new LocalGate()
    await expect(
      gate.withClosed(async () => {
        throw new Error('ordinary failure')
      }),
    ).rejects.toThrow('ordinary failure')

    expect(gate.isOpen).toBe(true)
    const release = await gate.enterRead()
    release()
  })

  it('keeps the gate closed only when a fatal-on-error transaction fails', async () => {
    const gate = new LocalGate()
    await expect(
      gate.withClosed(
        async () => {
          throw new Error('fatal failure')
        },
        { fatal: true },
      ),
    ).rejects.toThrow('fatal failure')

    expect(gate.isOpen).toBe(false)
    await expect(gate.enterRead()).rejects.toThrow(E_LOCAL_GATE_FATAL)
  })

  it('reopens after a successful fatal-on-error transaction', async () => {
    const gate = new LocalGate()
    await expect(gate.withClosed(async () => 42, { fatal: true })).resolves.toBe(42)
    expect(gate.isOpen).toBe(true)
  })

  it('does not implicitly upgrade an active read into a write', async () => {
    const gate = new LocalGate()
    const release = await gate.enterRead()
    let wrote = false
    const closed = gate.withClosed(async () => {
      wrote = true
    })

    await nextMicrotask()
    expect(wrote).toBe(false)
    release()
    await closed
    expect(wrote).toBe(true)
  })

  it('makes read release idempotent', async () => {
    const gate = new LocalGate()
    const release = await gate.enterRead()
    release()
    release()
    await expect(gate.withClosed(async () => undefined)).resolves.toBeUndefined()
  })
})
