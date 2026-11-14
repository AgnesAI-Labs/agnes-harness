import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileManagedDefinition, ProfileManagedInit } from '@agnes/extension-api'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { createHookStateCell } from '../../src/runtime/hook-state.js'
import { type SuperagentService, superagentPlugin } from '../../src/runtime/index.js'
import {
  createLifecycle,
  type Lifecycle,
  type StopReason,
  sessionsOnly,
} from '../../src/runtime/lifecycle.js'
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

/** Applies the plugin with stand-in facets and starts its service with a stand-in grant. */
async function startService() {
  let definition: ProfileManagedDefinition<SuperagentService> | undefined
  superagentPlugin.apply({
    hooks: { register: () => () => {} },
    profileRuntime: {
      register: (value: ProfileManagedDefinition<SuperagentService>) => {
        definition = value
        return { get: async () => undefined as never }
      },
    },
  } as never)
  let shutdown: ((reason: 'disable' | 'upgrade' | 'exit') => Promise<unknown>) | undefined
  const client = { initialize() {}, close() {}, clientId() {}, session: {} }
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
  const service = await definition!.start(init)
  return { service, shutdown: (reason: 'disable' | 'upgrade' | 'exit') => shutdown!(reason) }
}

function fakeLifecycle(log: string[]): Lifecycle {
  return {
    async start() {
      log.push('start')
    },
    async stop(reason: StopReason) {
      log.push(`stop ${reason}`)
    },
    settled: async () => {},
    status: () => ({ state: 'running' }),
    ticketEnded: async () => {},
  }
}

it.each([
  ['disable', 'disable'],
  ['upgrade', 'generation'],
  ['exit', 'shutdown'],
] as const)(
  'starts a registered lifecycle at once and stops it on a %s shutdown as %s',
  async (reason, expected) => {
    const { service, shutdown } = await startService()
    const log: string[] = []
    service.register('lifecycle', fakeLifecycle(log))
    expect(log).toEqual(['start'])
    await expect(shutdown(reason)).resolves.toEqual({ state: 'settled' })
    expect(log).toEqual(['start', `stop ${expected}`])
  },
)

it('refuses a lifecycle part without start and stop', async () => {
  const { service, shutdown } = await startService()
  expect(() => service.register('lifecycle', {})).toThrow(TypeError)
  await shutdown('exit')
})

it('shuts down without a registered lifecycle', async () => {
  const { shutdown } = await startService()
  await expect(shutdown('disable')).resolves.toEqual({ state: 'settled' })
})

/** The Host's shutdown deadline for this service (the manifest's `shutdownTimeoutMs`). */
const DEADLINE_MS = 5_000

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
  for (const id of [ORCHESTRATOR, workerKey('A'), workerKey('B'), workerKey('C')])
    sessions.set(id, { running: true, pending: [], jobs: 1 })
  const store = openStore(join(directory, 'lifecycle.sqlite'))
  const adapter = fakeSessions(log, sessions)
  const cancel = adapter.cancel
  if (options.cancelMs)
    adapter.cancel = async (id) => {
      await new Promise((resolve) => setTimeout(resolve, options.cancelMs))
      await cancel(id)
    }
  const lifecycle = createLifecycle({
    store,
    sessions: adapter,
    control: fakeControl(log, sessions),
    hooks: createHookStateCell(),
    hookState: sessionsOnly,
    environment:
      options.environment ??
      (async () => ({ stateDir: '/state', account: { login: 'agent-bot', email: 'a@x', blocked: [] } })),
    createApp: () => fakeApp(log, () => [...sessions.keys()], options.drain),
    writeEnvironment: async () => {},
    verifyEnvironment: async () => {},
    archive: () => ({ archived: 0 }),
  })
  const { service, shutdown } = await startService()
  service.register('lifecycle', lifecycle)
  if (options.environment) {
    // The start is under way and waits in the environment check.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } else await lifecycle.settled()
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
  store.close()
  return { log, sessions, atDeadline: atDeadline ?? [], finished, lifecycle }
}

it('cancels and kills every session first, within the shutdown deadline, even when the app drains slowly', async () => {
  const { atDeadline, sessions, finished, lifecycle } = await deadlineCase({
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
  expect(lifecycle.status()).toEqual({ state: 'stopped' })
})

it('aborts a start that is still checking the environment instead of waiting for it', async () => {
  let aborted = false
  const { finished, log, lifecycle } = await deadlineCase({
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
  expect(lifecycle.status()).toEqual({ state: 'stopped' })
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

it('stops the sessions in parallel: four whose cancel takes 1.5 s each all end before the deadline', async () => {
  const { atDeadline, sessions, finished } = await deadlineCase({ cancelMs: 1_500 })
  expect(finished).toBe(true)
  for (const id of sessions.keys()) expect(atDeadline).toContain(`kill ${id}`)
})
