import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileManagedInit } from '@agnes/extension-api'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHookStateHolder } from '../../src/runtime/hook-state.js'
import { startService } from '../../src/runtime/index.js'
import { type LifecycleDeps, sessionsOnly } from '../../src/runtime/lifecycle.js'
import {
  type FakeSession,
  fakeApp,
  fakeControl,
  fakeSessions,
  ORCHESTRATOR,
  workerKey,
} from './lifecycle-fakes.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sa-slot-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

/** Starts the service with a stand-in grant; `lifecycle` replaces dependencies of the lifecycle it composes. */
async function startWith(lifecycle: Partial<LifecycleDeps> = {}) {
  let shutdown: ((reason: 'disable' | 'upgrade' | 'exit') => Promise<unknown>) | undefined
  const client = {
    initialize() {},
    close() {},
    clientId() {},
    session: {},
    workspace: { add: async () => {} },
    config: { get: async () => ({ accounts: [] }) },
  }
  const init = {
    bundledApp: {
      stateDirectory: directory,
      client,
      channels: { subscribe: () => () => {} },
      assertCurrent() {},
    },
    ready() {},
    onShutdown: (handler: typeof shutdown) => {
      shutdown = handler
    },
  } as unknown as ProfileManagedInit
  const service = await startService(
    init,
    createHookStateHolder(),
    { warn: () => {} },
    {
      lifecycle: { platform: 'linux', ...lifecycle },
    },
  )
  return { service, shutdown: (reason: 'disable' | 'upgrade' | 'exit') => shutdown!(reason) }
}

/** Lifecycle dependencies whose agent environment passes and whose app is a fake that logs. */
const passing = (log: string[], sessionIds: () => string[] = () => []): Partial<LifecycleDeps> => ({
  environment: async () => ({
    stateDir: '/state',
    account: { login: 'agent-bot', email: 'a@x', blocked: [] },
  }),
  writeEnvironment: async () => {},
  verifyEnvironment: async () => {},
  archive: () => ({ archived: 0 }),
  createApp: () => fakeApp(log, sessionIds),
})

it.each([
  ['disable', 'disable'],
  ['upgrade', 'generation'],
  ['exit', 'shutdown'],
] as const)(
  'starts its lifecycle once start() returned and stops it on a %s shutdown as %s',
  async (reason, expected) => {
    const log: string[] = []
    const { shutdown } = await startWith(passing(log))
    expect(log, 'nothing started before start() returned').toEqual([])
    await vi.waitFor(() => expect(log).toEqual(['app.start']))
    await expect(shutdown(reason)).resolves.toEqual({ state: 'settled' })
    expect(log).toEqual(['app.start', `app.stopSignal ${expected}`, 'app.drain'])
  },
)

it('registers its lifecycle itself, so no second one can be registered', async () => {
  const { service, shutdown } = await startWith()
  expect(() => service.register('lifecycle', { start() {}, stop() {} })).toThrow(/already registered/)
  await shutdown('exit')
})

it('shuts down a service that waits for setup', async () => {
  const { shutdown } = await startWith()
  await new Promise((resolve) => setImmediate(resolve))
  await expect(shutdown('disable')).resolves.toEqual({ state: 'settled' })
})

/** The Host's shutdown deadline for this service (the manifest's `shutdownTimeoutMs`). */
const DEADLINE_MS = 5_000
const SESSIONS = 36

/** A real lifecycle on fakes, registered on a started service; the shutdown runs against a fake 5 s deadline. */
async function deadlineCase(options: {
  drain?: () => Promise<void>
  environment?: (signal: AbortSignal) => Promise<never>
  /** How long each session's cancel takes. */
  cancelMs?: number
}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const log: string[] = []
  const sessions = new Map<string, FakeSession>()
  // The main session and a few dozen workers: the registry keeps every worker until retention retires it.
  for (const id of [ORCHESTRATOR, ...Array.from({ length: SESSIONS - 1 }, (_, n) => workerKey(`T-${n}`))])
    sessions.set(id, { running: true, pending: [], jobs: 1 })
  const adapter = fakeSessions(log, sessions)
  const cancel = adapter.cancel
  if (options.cancelMs)
    adapter.cancel = async (id) => {
      await new Promise((resolve) => setTimeout(resolve, options.cancelMs))
      await cancel(id)
    }
  const { shutdown } = await startWith({
    sessions: adapter,
    control: fakeControl(log, sessions),
    hookState: sessionsOnly,
    environment:
      options.environment ??
      (async () => ({ stateDir: '/state', account: { login: 'agent-bot', email: 'a@x', blocked: [] } })),
    createApp: () => fakeApp(log, () => [...sessions.keys()], options.drain),
    writeEnvironment: async () => {},
    verifyEnvironment: async () => {},
    archive: () => ({ archived: 0 }),
    log: {
      warn: () => {},
    },
  })
  // Started once the reconcile has read every session; those all run, so it leaves them alone.
  const settled = () =>
    vi.waitFor(() => expect(log.filter((line) => line.startsWith('state ')).length).toBe(SESSIONS))
  if (options.environment) {
    // The start is under way and waits in the environment check.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } else await settled()
  log.length = 0
  let atDeadline: string[] | undefined
  setTimeout(() => {
    atDeadline = [...log]
  }, DEADLINE_MS)
  let finished = false
  const done = shutdown('upgrade').then(() => {
    finished = !atDeadline
  })
  await vi.advanceTimersByTimeAsync(DEADLINE_MS)
  await done
  return { log, sessions, atDeadline: atDeadline ?? [], finished }
}

it('cancels and kills every session first, within the shutdown deadline, even when the app drains slowly', async () => {
  const { atDeadline, sessions, finished } = await deadlineCase({
    drain: () => new Promise(() => {}),
  })
  expect(finished, 'the shutdown handler returned before the deadline').toBe(true)
  for (const id of sessions.keys()) {
    expect(atDeadline).toContain(`cancel ${id}`)
    expect(atDeadline).toContain(`kill ${id}`)
  }
  expect(atDeadline[0], 'polling and sending stop first, without waiting').toBe('app.stopSignal generation')
  const lastStop = Math.max(...atDeadline.map((line, at) => (/^(cancel|kill) /.test(line) ? at : -1)))
  expect(atDeadline.indexOf('app.drain'), 'the drain is awaited only after every session').toBeGreaterThan(
    lastStop,
  )
  expect([...sessions.values()].every((session) => !session.running && session.jobs === 0)).toBe(true)
})

it('aborts a start that is still checking the environment instead of waiting for it', async () => {
  let aborted = false
  const { finished, log } = await deadlineCase({
    environment: (signal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      }),
  })
  expect(aborted).toBe(true)
  expect(finished).toBe(true)
  expect(log, 'no app was created').toEqual([])
})

it('returns within the deadline from a start that ignores the abort, and that start opens nothing afterwards', async () => {
  let release: () => void = () => {}
  const { finished, log } = await deadlineCase({
    environment: () =>
      new Promise<never>((resolve) => {
        release = () => resolve(undefined as never)
      }),
  })
  expect(finished).toBe(true)
  release()
  await vi.advanceTimersByTimeAsync(10)
  expect(log).toEqual([])
})

it('stops the sessions in parallel: 36 whose cancel takes 1.5 s each all end before the 5 s deadline', async () => {
  const { atDeadline, sessions, finished } = await deadlineCase({ cancelMs: 1_500 })
  expect(finished).toBe(true)
  expect(sessions.size).toBe(SESSIONS)
  for (const id of sessions.keys()) expect(atDeadline).toContain(`kill ${id}`)
})
