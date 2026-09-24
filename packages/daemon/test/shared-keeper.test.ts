import { afterEach, expect, it, vi } from 'vitest'
import { keepSharedWorker } from '../src/supervisor/shared-keeper.js'
import type { WorkerLink } from '../src/supervisor/worker-link.js'

afterEach(() => {
  vi.useRealTimers()
})

function fakeLink() {
  const handlers: Array<() => void> = []
  return {
    link: { onExit: (handler: () => void) => handlers.push(handler) } as unknown as WorkerLink,
    exit: () => {
      for (const handler of handlers.splice(0)) handler()
    },
  }
}

it('starts the shared worker at once and restarts it after it exits', async () => {
  vi.useFakeTimers()
  const links: ReturnType<typeof fakeLink>[] = []
  const acquire = vi.fn(async () => {
    const next = fakeLink()
    links.push(next)
    return next.link
  })
  const keeper = keepSharedWorker({ acquire, clock: () => Date.now() })
  await vi.advanceTimersByTimeAsync(0)
  expect(acquire).toHaveBeenCalledTimes(1)
  links[0]?.exit()
  await vi.advanceTimersByTimeAsync(999)
  expect(acquire).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(acquire).toHaveBeenCalledTimes(2)
  keeper.close()
})

it('backs off 1 s, 2 s, 4 s ... capped at 30 s while starting keeps failing, and never spins', async () => {
  vi.useFakeTimers()
  const calls: number[] = []
  const acquire = vi.fn(async () => {
    calls.push(Date.now())
    throw new Error('boot failed')
  })
  const keeper = keepSharedWorker({ acquire, clock: () => Date.now(), log: { warn: () => undefined } })
  await vi.advanceTimersByTimeAsync(120_000)
  const gaps = calls.slice(1).map((at, i) => at - (calls[i] as number))
  expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000])
  expect(gaps.every((gap) => gap <= 30_000)).toBe(true)
  keeper.close()
})

it('resets the delay once a worker stayed up for the cap', async () => {
  vi.useFakeTimers()
  const links: ReturnType<typeof fakeLink>[] = []
  let fail = 3
  const acquire = vi.fn(async () => {
    if (fail-- > 0) throw new Error('boot failed')
    const next = fakeLink()
    links.push(next)
    return next.link
  })
  const keeper = keepSharedWorker({ acquire, clock: () => Date.now(), log: { warn: () => undefined } })
  await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000)
  expect(links).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(30_000)
  links[0]?.exit()
  await vi.advanceTimersByTimeAsync(1000)
  expect(links).toHaveLength(2)
  keeper.close()
})

it('stops retrying once closed', async () => {
  vi.useFakeTimers()
  const acquire = vi.fn(async () => {
    throw new Error('boot failed')
  })
  const keeper = keepSharedWorker({ acquire, log: { warn: () => undefined } })
  await vi.advanceTimersByTimeAsync(0)
  keeper.close()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(acquire).toHaveBeenCalledTimes(1)
})
