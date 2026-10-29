import { describe, expect, it, vi } from 'vitest'
import {
  type ResourceGeneration,
  type ResourceGenerationCandidate,
  ResourceGenerationCell,
} from '../src/resource-generation-cell.js'

type Resources = Readonly<{ version: string; handler(): string }>

function resources(version: string): Resources {
  return Object.freeze({ version, handler: () => version })
}

async function prepared(
  cell: ResourceGenerationCell<Resources>,
  version: string,
  cleanups: readonly (() => void | Promise<void>)[] = [],
): Promise<ResourceGenerationCandidate<Resources>> {
  return cell.prepare((scope) => {
    for (const cleanup of cleanups) scope.defer(cleanup)
    return resources(version)
  })
}

describe('ResourceGenerationCell', () => {
  it('finishes reverse cleanup before rejecting a failed build or health check and leaves live state alone', async () => {
    let current: ResourceGeneration<Resources> | undefined
    const cell = new ResourceGenerationCell<Resources>(() => current)
    current = cell.consumeCandidate(await prepared(cell, 'v1'))
    const events: string[] = []

    await expect(
      cell.prepare(async (scope) => {
        scope.defer(async () => {
          await Promise.resolve()
          events.push('build:first')
        })
        scope.defer(() => {
          events.push('build:second')
        })
        throw new Error('build failed')
      }),
    ).rejects.toThrow('build failed')
    expect(events).toEqual(['build:second', 'build:first'])
    expect(current).toBeDefined()

    await expect(
      cell.prepare(
        (scope) => {
          scope.defer(() => {
            events.push('health:first')
          })
          scope.defer(async () => {
            await Promise.resolve()
            events.push('health:second')
          })
          return resources('v2')
        },
        async () => {
          throw new Error('health failed')
        },
      ),
    ).rejects.toThrow('health failed')
    expect(events).toEqual(['build:second', 'build:first', 'health:second', 'health:first'])
    const live = cell.createFacade((value) => value.version).acquire()
    expect(live.value).toBe('v1')
    live.release()
  })

  it('holds the old generation across an exchange until a long invocation releases its lease', async () => {
    let current: ResourceGeneration<Resources> | undefined
    const cell = new ResourceGenerationCell<Resources>(() => current)
    const cleaned: string[] = []
    current = cell.consumeCandidate(
      await prepared(cell, 'v1', [
        () => {
          cleaned.push('v1')
        },
      ]),
    )
    const facade = cell.createFacade((value) => value.handler)
    const oldInvocation = facade.acquire()

    const previous = current
    current = cell.consumeCandidate(
      await prepared(cell, 'v2', [
        () => {
          cleaned.push('v2')
        },
      ]),
    )
    const retirement = cell.retire(previous)

    expect(oldInvocation.value()).toBe('v1')
    const newInvocation = facade.acquire()
    expect(newInvocation.value()).toBe('v2')
    newInvocation.release()
    expect(cleaned).toEqual([])

    oldInvocation.release()
    await retirement
    expect(cleaned).toEqual(['v1'])
  })

  it('runs cleanup once in reverse order despite duplicate retire and release calls', async () => {
    let current: ResourceGeneration<Resources> | undefined
    const cell = new ResourceGenerationCell<Resources>(() => current)
    const events: string[] = []
    const cleanup = [
      vi.fn(() => {
        events.push('first')
      }),
      vi.fn(() => {
        events.push('second')
      }),
      vi.fn(() => {
        events.push('third')
      }),
    ]
    current = cell.consumeCandidate(await prepared(cell, 'v1', cleanup))
    const lease = cell.createFacade((value) => value.version).acquire()
    const previous = current
    current = cell.consumeCandidate(await prepared(cell, 'v2'))

    const first = cell.retire(previous)
    const second = cell.retire(previous)
    expect(second).toBe(first)
    lease.release()
    lease.release()
    await Promise.all([first, second])

    expect(cleanup[2]).toHaveBeenCalledOnce()
    expect(cleanup[1]).toHaveBeenCalledOnce()
    expect(cleanup[0]).toHaveBeenCalledOnce()
    expect(events).toEqual(['third', 'second', 'first'])
  })

  it('refuses to retire the current generation without starting cleanup', async () => {
    let current: ResourceGeneration<Resources> | undefined
    const cell = new ResourceGenerationCell<Resources>(() => current)
    const cleanup = vi.fn()
    current = cell.consumeCandidate(await prepared(cell, 'v1', [cleanup]))

    expect(() => cell.retire(current)).toThrow(/E_RESOURCE_GENERATION_CURRENT/)
    expect(cleanup).not.toHaveBeenCalled()
    const live = cell.createFacade((value) => value.version).acquire()
    expect(live.value).toBe('v1')
    live.release()
  })

  it('rejects wrong-owner and duplicate publication before the outer pointer exchange', async () => {
    let currentA: ResourceGeneration<Resources> | undefined
    let currentB: ResourceGeneration<Resources> | undefined
    const a = new ResourceGenerationCell<Resources>(() => currentA)
    const b = new ResourceGenerationCell<Resources>(() => currentB)
    const fromB = await prepared(b, 'b')
    const fromA = await prepared(a, 'a')
    let exchanges = 0
    const publishA = (candidate: ResourceGenerationCandidate<Resources>) => {
      const next = a.consumeCandidate(candidate)
      exchanges += 1
      currentA = next
    }

    expect(() => a.consumeCandidate(fromB)).toThrow(/E_RESOURCE_GENERATION_OWNER/)
    expect(exchanges).toBe(0)
    publishA(fromA)
    expect(exchanges).toBe(1)
    expect(() => publishA(fromA)).toThrow(/E_RESOURCE_GENERATION_CONSUMED/)
    expect(exchanges).toBe(1)
    const leaseA = a.createFacade((value) => value.version).acquire()
    expect(leaseA.value).toBe('a')
    leaseA.release()

    currentB = b.consumeCandidate(fromB)
    const leaseB = b.createFacade((value) => value.version).acquire()
    expect(leaseB.value).toBe('b')
    leaseB.release()
  })

  it('rechecks the outer current pointer after acquiring so an exchange has no unleased window', async () => {
    let current: ResourceGeneration<Resources> | undefined
    let exchangeDuringRead = false
    let replacement: ResourceGeneration<Resources> | undefined
    const cell = new ResourceGenerationCell<Resources>(() => {
      const observed = current
      if (exchangeDuringRead) {
        exchangeDuringRead = false
        current = replacement
      }
      return observed
    })
    current = cell.consumeCandidate(await prepared(cell, 'v1'))
    replacement = cell.consumeCandidate(await prepared(cell, 'v2'))
    exchangeDuringRead = true

    const lease = cell.createFacade((value) => value.version).acquire()
    expect(lease.value).toBe('v2')
    lease.release()
  })

  it('discards an unpublished candidate once and never exposes it through the stable facade', async () => {
    let current: ResourceGeneration<Resources> | undefined
    const cell = new ResourceGenerationCell<Resources>(() => current)
    const cleanup = vi.fn()
    const candidate = await prepared(cell, 'candidate', [cleanup])

    await cell.discardCandidate(candidate)
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(cell.discardCandidate(candidate)).rejects.toThrow(/E_RESOURCE_GENERATION_CONSUMED/)
    expect(() => cell.createFacade((value) => value.version).acquire()).toThrow(
      /E_RESOURCE_GENERATION_UNAVAILABLE/,
    )
  })

  it('releases a generation lease when resolution throws and reports active cleanup failures once at drain', async () => {
    let current: ResourceGeneration<Resources> | undefined
    const cell = new ResourceGenerationCell<Resources>(() => current)
    const cleanupFailure = new Error('cleanup failed')
    let rejectCleanup!: (error: unknown) => void
    const cleanup = new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject
    })
    current = cell.consumeCandidate(await prepared(cell, 'v1', [() => cleanup]))

    expect(() =>
      cell
        .createFacade(() => {
          throw new Error('resolve failed')
        })
        .acquire(),
    ).toThrow('resolve failed')
    const previous = current
    current = cell.consumeCandidate(await prepared(cell, 'v2'))
    const retirement = cell.retire(previous)
    const drain = cell.drainRetirements()
    rejectCleanup(cleanupFailure)

    await expect(retirement).rejects.toThrow('resource generation cleanup failed')
    const drainFailure = await drain.catch((error: unknown) => error)
    expect(drainFailure).toBeInstanceOf(AggregateError)
    const retirementFailure = (drainFailure as AggregateError).errors[0]
    expect(retirementFailure).toBeInstanceOf(AggregateError)
    expect((retirementFailure as AggregateError).errors).toContain(cleanupFailure)
    await expect(cell.drainRetirements()).resolves.toBeUndefined()
  })
})
