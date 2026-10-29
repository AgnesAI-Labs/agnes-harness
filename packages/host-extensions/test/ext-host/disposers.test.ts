import { describe, expect, it } from 'vitest'
import { DisposerBag } from '../../src/ext-host/disposers.js'

describe('DisposerBag', () => {
  it('releases in reverse order, once, including manually disposed entries', () => {
    const bag = new DisposerBag(),
      seen: number[] = []
    const one = bag.add(() => {
      seen.push(1)
    })
    bag.add(() => {
      seen.push(2)
    })
    one()
    one()
    expect(bag.disposeAll()).toEqual({ ran: 1, failed: 0 })
    expect(bag.disposeAll()).toEqual({ ran: 0, failed: 0 })
    expect(seen).toEqual([1, 2])
    expect(bag.size).toBe(0)
  })

  it('does not strand earlier disposers and retains failures for retry', () => {
    const bag = new DisposerBag(),
      seen: number[] = []
    let failing = true
    bag.add(() => {
      seen.push(1)
    })
    bag.add(() => {
      if (failing) throw new Error('failed')
      seen.push(2)
    })
    bag.add(() => {
      seen.push(3)
    })
    expect(bag.disposeAll()).toEqual({ ran: 2, failed: 1 })
    expect(seen).toEqual([3, 1])
    expect(bag.size).toBe(1)
    failing = false
    expect(bag.disposeAll()).toEqual({ ran: 1, failed: 0 })
    expect(seen).toEqual([3, 1, 2])
    expect(bag.size).toBe(0)
  })

  it('contains recursive release without double invocation', () => {
    const bag = new DisposerBag()
    let calls = 0
    let release: () => void = () => undefined
    release = bag.add(() => {
      calls++
      release()
      bag.disposeAll()
    })
    expect(bag.disposeAll()).toEqual({ ran: 1, failed: 0 })
    expect(calls).toBe(1)
  })

  it('cleans up late additions immediately and retains failed late additions', () => {
    const bag = new DisposerBag()
    bag.disposeAll()
    let calls = 0
    const release = bag.add(() => {
      calls++
    })
    release()
    expect(calls).toBe(1)
    expect(bag.size).toBe(0)
    expect(() =>
      bag.add(() => {
        throw new Error('late failed')
      }),
    ).toThrow('late failed')
    expect(bag.size).toBe(1)
    expect(bag.disposeAll()).toEqual({ ran: 0, failed: 1 })
  })
  it('does not claim an asynchronous cleanup succeeded or leak its rejection', async () => {
    const bag = new DisposerBag()
    bag.add(async () => {
      throw new Error('asynchronous failure')
    })
    expect(bag.disposeAll()).toEqual({ ran: 0, failed: 1 })
    expect(bag.size).toBe(1)
    await Promise.resolve()
  })
  it('awaits asynchronous cleanup and shares a pending manual release without invoking it twice', async () => {
    const bag = new DisposerBag()
    let finish: () => void = () => undefined
    let calls = 0
    const release = bag.add(() => {
      calls++
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    release()
    const done = bag.disposeAllAsync()
    let completed = false
    void done.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(bag.size).toBe(1)
    expect(calls).toBe(1)
    finish()
    await expect(done).resolves.toEqual({ ran: 1, failed: 0 })
    expect(bag.size).toBe(0)
  })
  it('does not report concurrent pending cleanup as zero outstanding work', async () => {
    const bag = new DisposerBag()
    let finish: () => void = () => undefined
    bag.add(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const first = bag.disposeAllAsync()
    await expect(bag.disposeAllAsync()).resolves.toEqual({ ran: 0, failed: 1 })
    finish()
    await expect(first).resolves.toEqual({ ran: 1, failed: 0 })
    expect(bag.size).toBe(0)
  })
})
