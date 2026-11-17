// A start that fails for a reason other than its setup, such as a daemon client that does not yet reach a daemon that
// has just restarted: it is tried again after growing pauses, shown with the time of the next attempt and warned once
// while it repeats; a recheck tries at once, and a stop cancels the attempt that waits.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../../src/app/store.js'
import { createHookStateCell } from '../../src/runtime/hook-state.js'
import { DATABASE_FILE } from '../../src/runtime/index.js'
import { createLifecycle, type LifecycleDeps, sessionsOnly } from '../../src/runtime/lifecycle.js'
import { SetupError } from '../../src/setup.js'
import { AT, type FakeSession, fakeApp, fakeControl, fakeSessions } from './lifecycle-fakes.js'

let directory: string
let store: Store
let log: string[]
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sa-lifecycle-retry-'))
  store = openStore(join(directory, DATABASE_FILE))
  log = []
})
afterEach(() => {
  vi.useRealTimers()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const plan = {
  stateDir: '/state',
  account: { login: 'agent-bot', email: 'a@example.invalid', blocked: [] },
}
/** Timers and intervals faked; `setImmediate`, which a start awaits first, stays real. */
const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

/** A lifecycle over fakes whose environment check is `environment`; it records warnings and reported start problems. */
function setup(environment: () => Promise<typeof plan>, more: Partial<LifecycleDeps> = {}) {
  const sessions = new Map<string, FakeSession>()
  const app = fakeApp(log, () => [...sessions.keys()])
  const problems: ({ detail: string; retryAt: string } | undefined)[] = []
  const warnings: string[] = []
  const lifecycle = createLifecycle({
    store,
    sessions: fakeSessions(log, sessions),
    control: fakeControl(log, sessions),
    hooks: createHookStateCell(),
    hookState: sessionsOnly,
    environment: async () => {
      log.push('environment')
      return environment()
    },
    createApp: () => app,
    writeEnvironment: async () => {},
    verifyEnvironment: async () => {},
    archive: () => ({ archived: 0 }),
    now: () => Date.parse(AT),
    log: { warn: (text) => warnings.push(text) },
    startProblem: (problem) => problems.push(problem),
    ...more,
  })
  const attempts = () => log.filter((line) => line === 'environment').length
  return { lifecycle, app, problems, warnings, attempts }
}
const unreachable = () => Promise.reject(new Error('daemon discovery owner identity is unavailable'))
const retryAt = (ms: number) => new Date(Date.parse(AT) + ms).toISOString()

it('tries a start that failed for a reason other than its setup again after each pause, until it runs', async () => {
  let failing = 2
  const { lifecycle, attempts, problems } = setup(
    () => (failing-- > 0 ? unreachable() : Promise.resolve(plan)),
    { retryDelaysMs: [5, 10] },
  )
  await lifecycle.start()
  await lifecycle.settled()
  expect(lifecycle.status()).toEqual({
    state: 'failed',
    detail: expect.stringContaining('owner identity is unavailable'),
  })
  await vi.waitFor(() => expect(lifecycle.status()).toEqual({ state: 'running' }), { timeout: 2_000 })
  expect(attempts()).toBe(3)
  expect(log.filter((line) => line === 'app.start')).toHaveLength(1)
  // Each failure showed the next attempt; the start that ran took that back.
  expect(problems.map((problem) => problem?.retryAt)).toEqual([retryAt(5), retryAt(10), undefined])
})

it('starts the app again when its start failed, rather than taking it as begun', async () => {
  const { lifecycle, app } = setup(() => Promise.resolve(plan), { retryDelaysMs: [5] })
  const start = app.start.bind(app)
  let fails = 1
  app.start = async () => {
    if (fails-- > 0) {
      log.push('app.start failed')
      throw new Error('daemon discovery owner identity is unavailable')
    }
    await start()
  }
  await lifecycle.start()
  await vi.waitFor(() => expect(lifecycle.status()).toEqual({ state: 'running' }), { timeout: 2_000 })
  expect(log.filter((line) => line.startsWith('app.start'))).toEqual(['app.start failed', 'app.start'])
})

it('keeps the app paused while upgrade is refused and resumes only after preparation succeeds', async () => {
  let refused = true
  const { lifecycle } = setup(() => Promise.resolve(plan), {
    retryDelaysMs: [60_000],
    async prepareSessionUpgrade() {
      log.push('upgrade')
      if (refused) throw new Error('E_GENERATION_EXECUTION_UNSETTLED')
    },
  })
  await lifecycle.start()
  await lifecycle.settled()
  expect(lifecycle.status()).toEqual({ state: 'failed', detail: 'E_GENERATION_EXECUTION_UNSETTLED' })
  expect(log).toEqual(['environment', 'upgrade'])
  refused = false
  lifecycle.recheck()
  await lifecycle.settled()
  expect(lifecycle.status()).toEqual({ state: 'running' })
  expect(log).toEqual(['environment', 'upgrade', 'environment', 'upgrade', 'app.start'])
  await lifecycle.stop('shutdown')
})

it('backs off to a pause of 10 minutes, shows each next attempt, and warns once while the same failure repeats', async () => {
  fakeTimers()
  let error = 'daemon discovery owner identity is unavailable'
  const { lifecycle, attempts, problems, warnings } = setup(() => Promise.reject(new Error(error)))
  await lifecycle.start()
  await lifecycle.settled()
  const pauses: number[] = []
  for (let attempt = 1; attempt <= 10; attempt++) {
    const shown = problems.at(-1)!
    expect(shown.detail).toContain(error)
    pauses.push((Date.parse(shown.retryAt) - Date.parse(AT)) / 1000)
    await vi.advanceTimersByTimeAsync(Date.parse(shown.retryAt) - Date.parse(AT))
    await lifecycle.settled()
    expect(attempts()).toBe(attempt + 1)
  }
  expect(pauses).toEqual([1, 2, 5, 10, 30, 60, 120, 300, 600, 600])
  expect(warnings).toEqual([expect.stringContaining('owner identity is unavailable')])
  // Another failure is warned again.
  error = 'E_SANDBOX_WORKSPACE'
  await vi.advanceTimersByTimeAsync(600_000)
  await lifecycle.settled()
  expect(warnings).toHaveLength(2)
  expect(warnings[1]).toContain('E_SANDBOX_WORKSPACE')
  await lifecycle.stop('disable')
})

it('tries at once on a recheck and starts the pauses over, and a stop cancels the attempt that waits', async () => {
  fakeTimers()
  const { lifecycle, attempts, problems } = setup(unreachable, { retryDelaysMs: [1_000, 4_000] })
  await lifecycle.start()
  await lifecycle.settled()
  await vi.advanceTimersByTimeAsync(1_000)
  await lifecycle.settled()
  expect(attempts()).toBe(2)
  expect(problems.at(-1)?.retryAt).toBe(retryAt(4_000))
  // A person checks again: an attempt now, and the next one after the first pause again.
  lifecycle.recheck()
  await lifecycle.settled()
  expect(attempts()).toBe(3)
  expect(problems.at(-1)?.retryAt).toBe(retryAt(1_000))
  await lifecycle.stop('disable')
  expect(vi.getTimerCount(), 'no attempt waits after the stop').toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(attempts()).toBe(3)
  expect(lifecycle.status()).toEqual({ state: 'stopped' })
})

it('leaves a setup problem to a recheck, and takes back a failure shown before it', async () => {
  fakeTimers()
  let failure: Error = new Error('daemon discovery owner identity is unavailable')
  const { lifecycle, attempts, problems } = setup(() => Promise.reject(failure), { retryDelaysMs: [1_000] })
  await lifecycle.start()
  await lifecycle.settled()
  failure = new SetupError('repositoryUnset')
  await vi.advanceTimersByTimeAsync(1_000)
  await lifecycle.settled()
  expect(lifecycle.status().state).toBe('setupRequired')
  expect(problems.at(-1), 'the failure shown before is taken back').toBeUndefined()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(attempts(), 'a setup problem waits for a recheck').toBe(2)
  expect(vi.getTimerCount()).toBe(0)
  await lifecycle.stop('disable')
})
