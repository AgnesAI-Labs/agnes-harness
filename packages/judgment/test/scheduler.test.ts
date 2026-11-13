import { expect, it } from 'vitest'
import { createJudgmentScheduler } from '../src/scheduler.js'

it('limits actual work to sixteen and cancels queued work without dispatch', async () => {
  const scheduler = createJudgmentScheduler(16)
  const releases: (() => void)[] = []
  const active = Array.from({ length: 16 }, () =>
    scheduler.run(new AbortController().signal, () => new Promise<void>((resolve) => releases.push(resolve))),
  )
  const queued = new AbortController()
  let sent = false
  const waiting = scheduler.run(queued.signal, async () => {
    sent = true
  })
  const refused = expect(waiting).rejects.toBeDefined()
  queued.abort()
  await refused
  expect(releases).toHaveLength(16)
  expect(sent).toBe(false)
  releases.forEach((release) => {
    release()
  })
  await Promise.all(active)
  scheduler.dispose()
})
it('releases one waiter per settled work and closes queued and new work', async () => {
  const scheduler = createJudgmentScheduler(1)
  let release!: () => void
  const first = scheduler.run(
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  let sent = false
  const second = scheduler.run(new AbortController().signal, async () => {
    sent = true
  })
  expect(sent).toBe(false)
  await Promise.resolve()
  release()
  await Promise.all([first, second])
  expect(sent).toBe(true)
  scheduler.dispose()
  await expect(scheduler.run(new AbortController().signal, async () => {})).rejects.toBeDefined()
})
