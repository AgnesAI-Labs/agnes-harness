import { describe, expect, it } from 'vitest'
import { NestedToolScheduler, scheduleBatch } from '../src/effects/scheduler.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('scheduleBatch', () => {
  it('runs safe runs in parallel, treats an unsafe call as a barrier, and returns results in model order', async () => {
    const started: number[] = []
    const finished: number[] = []
    const call = (ordinal: number, safe: boolean, ms: number) => ({
      ordinal,
      concurrencySafe: safe,
      run: async () => {
        started.push(ordinal)
        await sleep(ms)
        finished.push(ordinal)
        return ordinal
      },
    })
    const results = await scheduleBatch(
      [call(0, true, 30), call(1, true, 5), call(2, false, 5), call(3, true, 5)],
      {
        maxParallel: 4,
        signal: new AbortController().signal,
        onSkipped: (c) => -c.ordinal,
      },
    )
    expect(results).toEqual([0, 1, 2, 3])
    expect(started.slice(0, 2).sort()).toEqual([0, 1])
    // The barrier waits for the whole safe run, not merely for the last one to have been started:
    // 1 finishes long before 0, so a scheduler that only awaited the newest call would let 2 in early.
    expect(started.indexOf(2)).toBeGreaterThan(finished.indexOf(0))
    expect(started.indexOf(3)).toBeGreaterThan(finished.indexOf(2))
  })

  it('never runs more than maxParallel at once', async () => {
    let active = 0
    let peak = 0
    const call = (o: number) => ({
      ordinal: o,
      concurrencySafe: true,
      run: async () => {
        active++
        peak = Math.max(peak, active)
        await sleep(5)
        active--
        return o
      },
    })
    const results = await scheduleBatch([call(0), call(1), call(2), call(3), call(4)], {
      maxParallel: 2,
      signal: new AbortController().signal,
      onSkipped: (c) => c.ordinal,
    })
    expect(peak).toBe(2)
    expect(results).toEqual([0, 1, 2, 3, 4])
  })

  it('skips calls that have not started once the signal aborts and synthesizes their results', async () => {
    const ran: number[] = []
    const ac = new AbortController()
    const call = (o: number) => ({
      ordinal: o,
      concurrencySafe: false,
      run: async () => {
        ran.push(o)
        if (o === 0) ac.abort()
        await sleep(1)
        return o
      },
    })
    const results = await scheduleBatch([call(0), call(1), call(2)], {
      maxParallel: 2,
      signal: ac.signal,
      onSkipped: (c) => 100 + c.ordinal,
    })
    expect(results).toEqual([0, 101, 102])
    expect(ran).toEqual([0])
  })

  it('aborting mid-run stops the rest of a parallel segment from starting', async () => {
    const ran: number[] = []
    const ac = new AbortController()
    const call = (o: number) => ({
      ordinal: o,
      concurrencySafe: true,
      run: async () => {
        ran.push(o)
        if (o === 0) ac.abort()
        await sleep(1)
        return o
      },
    })
    const results = await scheduleBatch([call(0), call(1), call(2), call(3)], {
      maxParallel: 1,
      signal: ac.signal,
      onSkipped: (c) => 100 + c.ordinal,
    })
    expect(ran).toEqual([0])
    expect(results).toEqual([0, 101, 102, 103])
  })

  it('orders by ordinal rather than by array position', async () => {
    const call = (o: number) => ({ ordinal: o, concurrencySafe: false, run: async () => o })
    const results = await scheduleBatch([call(2), call(0), call(1)], {
      maxParallel: 1,
      signal: new AbortController().signal,
      onSkipped: (c) => -1 - c.ordinal,
    })
    expect(results).toEqual([0, 1, 2])
  })
})

describe('NestedToolScheduler', () => {
  it('runs safe calls together and makes an unsafe call a fair barrier', async () => {
    const scheduler = new NestedToolScheduler()
    let active = 0
    let peak = 0
    const order: string[] = []
    let releaseSafe!: () => void
    const safeGate = new Promise<void>((resolve) => {
      releaseSafe = resolve
    })
    const safe = (name: string) =>
      scheduler.run(true, async () => {
        active++
        peak = Math.max(peak, active)
        order.push(`${name}:start`)
        await safeGate
        order.push(`${name}:end`)
        active--
      })
    const first = safe('a')
    const second = safe('b')
    const unsafe = scheduler.run(false, async () => {
      expect(active).toBe(0)
      order.push('unsafe')
    })
    const lateSafe = scheduler.run(true, async () => {
      order.push('late-safe')
    })
    await Promise.resolve()
    expect(peak).toBe(2)
    releaseSafe()
    await Promise.all([first, second, unsafe, lateSafe])
    expect(order.indexOf('unsafe')).toBeGreaterThan(order.indexOf('a:end'))
    expect(order.indexOf('unsafe')).toBeGreaterThan(order.indexOf('b:end'))
    expect(order.indexOf('late-safe')).toBeGreaterThan(order.indexOf('unsafe'))
  })

  it('keeps an unsafe parent exclusive while its nested child runs without self-deadlocking', async () => {
    const scheduler = new NestedToolScheduler()
    let active = 0
    let peak = 0
    const order: string[] = []
    await Promise.all([
      scheduler.run(false, async (parent) => {
        order.push('parent:start')
        active++
        peak = Math.max(peak, active)
        active--
        await scheduler.run(
          false,
          async () => {
            order.push('child:start')
            active++
            peak = Math.max(peak, active)
            await sleep(2)
            active--
            order.push('child:end')
          },
          parent,
        )
        order.push('parent:end')
      }),
      scheduler.run(false, async () => {
        order.push('other')
        active++
        peak = Math.max(peak, active)
        await sleep(1)
        active--
      }),
    ])
    expect(peak).toBe(1)
    expect(order).toEqual(['parent:start', 'child:start', 'child:end', 'parent:end', 'other'])
  })

  it('keeps an unsafe sibling between the safe runs that surround it', async () => {
    const scheduler = new NestedToolScheduler()
    const order: string[] = []
    await scheduler.run(true, async (parent) => {
      await Promise.all([
        scheduler.run(
          true,
          async () => {
            order.push('first:start')
            await sleep(2)
            order.push('first:end')
          },
          parent,
        ),
        scheduler.run(
          false,
          async () => {
            order.push('unsafe')
          },
          parent,
        ),
        scheduler.run(
          true,
          async () => {
            order.push('last')
          },
          parent,
        ),
      ])
    })
    expect(order).toEqual(['first:start', 'first:end', 'unsafe', 'last'])
  })

  it('serializes concurrent unsafe upgrades that suspend the same safe ancestor', async () => {
    const scheduler = new NestedToolScheduler()
    let activeUnsafe = 0
    let peakUnsafe = 0
    let branchesEntered = 0
    let releaseBranches!: () => void
    const bothBranchesEntered = new Promise<void>((resolve) => {
      releaseBranches = resolve
    })
    await scheduler.run(true, async (root) => {
      await Promise.all(
        [0, 1].map(() =>
          scheduler.run(
            true,
            async (branch) => {
              branchesEntered++
              if (branchesEntered === 2) releaseBranches()
              await bothBranchesEntered
              await scheduler.run(
                false,
                async () => {
                  activeUnsafe++
                  peakUnsafe = Math.max(peakUnsafe, activeUnsafe)
                  await sleep(1)
                  activeUnsafe--
                },
                branch,
              )
            },
            root,
          ),
        ),
      )
    })
    expect(peakUnsafe).toBe(1)
  })

  it('drains unawaited children and rejects a parent lease after its callback closes', async () => {
    const scheduler = new NestedToolScheduler()
    let staleParent: Parameters<typeof scheduler.run>[2]
    let childFinished = false
    await scheduler.run(false, async (parent) => {
      staleParent = parent
      void scheduler.run(
        true,
        async () => {
          await sleep(2)
          childFinished = true
        },
        parent,
      )
    })
    expect(childFinished).toBe(true)
    if (!staleParent) throw new Error('missing stale parent lease')
    await expect(scheduler.run(true, async () => undefined, staleParent)).rejects.toThrow(
      'parent lease is closed',
    )
  })

  it('removes an aborted unsafe waiter and leaves the scheduler reusable', async () => {
    const scheduler = new NestedToolScheduler()
    let releaseSafe!: () => void
    const safeGate = new Promise<void>((resolve) => {
      releaseSafe = resolve
    })
    const safe = scheduler.run(true, async () => safeGate)
    const ac = new AbortController()
    const cancelled = scheduler.run(false, async () => 'should-not-run', undefined, ac.signal)
    ac.abort()
    await expect(cancelled).rejects.toThrow('aborted: nested tool scheduling')
    releaseSafe()
    await safe
    await expect(scheduler.run(false, async () => 'next')).resolves.toBe('next')
  })

  it('starts safe work behind an aborted unsafe head before the active safe call releases', async () => {
    const scheduler = new NestedToolScheduler()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let lateSafeStarted = false
    const first = scheduler.run(true, async () => firstGate)
    const ac = new AbortController()
    const cancelled = scheduler.run(false, async () => undefined, undefined, ac.signal)
    const lateSafe = scheduler.run(true, async () => {
      lateSafeStarted = true
    })
    ac.abort()
    await expect(cancelled).rejects.toThrow('aborted: nested tool scheduling')
    await lateSafe
    expect(lateSafeStarted).toBe(true)
    releaseFirst()
    await first
  })
})
