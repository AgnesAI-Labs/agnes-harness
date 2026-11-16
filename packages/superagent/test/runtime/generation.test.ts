// One generation as the service composes it: the panel is wired with every part before anything starts, Superagent's
// sessions of earlier runs are refused with their live notes from the first moment, a setup problem of the agent
// environment reaches the panel, and "check again" runs the start again.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileManagedInit } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../../src/app/store.js'
import { SettingsSchema } from '../../src/policy.js'
import { SessionDelivery } from '../../src/runtime/delivery.js'
import { createHookStateHolder, type HookStateHolder } from '../../src/runtime/hook-state.js'
import { DATABASE_FILE, type ServiceOptions, startService } from '../../src/runtime/index.js'
import { SessionRegistry } from '../../src/runtime/sessions.js'
import { SetupError } from '../../src/setup.js'
import { fakeClient } from './fake-sdk.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const WORKER = 'superagent:worker:T-1'
const log = { warn: () => {} }

/** Starts a service over a fake client, its store holding a worker session of an earlier run with its live note. */
async function start(
  options: ServiceOptions = {},
  holder: HookStateHolder = createHookStateHolder(),
  seed: (store: Store) => void = () => {},
) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'superagent-generation-'))
  dirs.push(stateDirectory)
  const store = openStore(join(stateDirectory, DATABASE_FILE))
  new SessionRegistry(store).record({ kind: 'worker', ticketId: 'T-1' }, WORKER)
  new SessionDelivery({ sessions: { handle: () => Promise.reject(new Error('unused')) }, store }).notify(
    WORKER,
    { content: 'Ticket T-1 waits for a reply' },
  )
  seed(store)
  store.close()
  let shutdown: ((reason: 'disable' | 'upgrade' | 'exit') => Promise<unknown>) | undefined
  const init = {
    bundledApp: {
      stateDirectory,
      client: {
        ...fakeClient().client,
        initialize: async () => {},
        close: async () => {},
        clientId: async () => 'superagent',
      },
      channels: { subscribe: () => () => {} },
      assertCurrent: () => {},
    },
    onShutdown: (handler: typeof shutdown) => {
      shutdown = handler
    },
    ready: () => {},
  } as unknown as ProfileManagedInit
  // The setup's platform check is pinned, so these cases read the same on every operating system.
  const service = await startService(init, holder, log, {
    ...options,
    lifecycle: { platform: 'linux', ...options.lifecycle },
  })
  const call = (name: string, input: JsonValue = {}) =>
    service.callService(name, input, new AbortController().signal) as Promise<Record<string, unknown>>
  return { service, holder, call, shutdown: (reason: 'disable' | 'upgrade' | 'exit') => shutdown!(reason) }
}
const failure = (answer: Record<string, unknown>) => answer.failure as { status: number } | undefined
const setupOf = async (call: Awaited<ReturnType<typeof start>>['call']) =>
  ((await call('superagent.state')).setup as { problem: { code: string } | null }).problem

describe('a generation', () => {
  it('refuses the sessions of earlier runs, with their live notes, from the moment the service has started', async () => {
    const { holder, shutdown } = await start()
    // Nothing of the lifecycle ran yet: it begins after start() returned.
    const state = holder.get()
    expect(state.isSuperagentSession(WORKER)).toBe(true)
    expect(state.guardTool({ sessionId: WORKER, toolName: 'shell', input: {} })).toMatch(/starting/)
    expect(state.guardTool({ sessionId: `${WORKER}/01CHILD`, toolName: 'shell', input: {} })).toMatch(
      /starting/,
    )
    expect(state.promptSections(WORKER).liveNote).toEqual({
      id: 'superagent-notices',
      content: 'Ticket T-1 waits for a reply',
    })
    expect(state.guardTool({ sessionId: '01OWNER', toolName: 'shell', input: {} })).toBeUndefined()
    await shutdown('disable')
    const left = holder.get()
    expect(left.guardTool({ sessionId: WORKER, toolName: 'shell', input: {} })).toMatch(/not running/)
    expect(left.promptSections(WORKER).liveNote?.content).toBe('Ticket T-1 waits for a reply')
  })

  it("wires the panel with every part before the lifecycle starts, and shows the agent environment's setup problem", async () => {
    const { call, holder, shutdown } = await start({
      lifecycle: {
        environment: async () => {
          throw new SetupError('agentCredentialMixed', { helpers: 'osxkeychain' })
        },
      },
    })
    // Wired at once: an action answers rather than saying that Superagent is not ready.
    expect(failure(await call('superagent.executor.pause', { paused: false }))).toBeUndefined()
    await vi.waitFor(async () => expect(await setupOf(call)).toMatchObject({ code: 'agentCredentialMixed' }))
    // Its sessions stay refused for that reason, each keeping its live note.
    const state = holder.get()
    expect(state.guardTool({ sessionId: WORKER, toolName: 'shell', input: {} })).toMatch(
      /Superagent cannot start: git would ask other credential helpers/,
    )
    expect(state.promptSections(WORKER).liveNote?.content).toBe('Ticket T-1 waits for a reply')
    await shutdown('disable')
  })

  it('runs the start again when the setup is checked again, and refuses the check once everything is set up', async () => {
    let attempts = 0
    let problem: SetupError | undefined = new SetupError('repositoryUnset')
    const { call, shutdown } = await start({
      lifecycle: {
        environment: async () => {
          attempts++
          if (problem) throw problem
          throw new SetupError('agentCliUnset')
        },
      },
    })
    await vi.waitFor(async () => expect(await setupOf(call)).toMatchObject({ code: 'repositoryUnset' }))
    problem = undefined
    expect(await call('superagent.setup.check')).toEqual({ restarting: true })
    await vi.waitFor(async () => expect(await setupOf(call)).toMatchObject({ code: 'agentCliUnset' }))
    expect(attempts).toBe(2)
    await shutdown('disable')
  })
})

it('keeps the sessions of earlier runs refused after the app is ready, until the reconcile has read them', async () => {
  let release: () => void = () => {}
  const reading = new Promise<void>((resolve) => {
    release = resolve
  })
  const read: string[] = []
  let seen: ((id: string) => string | undefined) | undefined
  const { holder, shutdown } = await start(
    {
      // A configured deployment: the app gets ready and opens the main session.
      probe: async (argv) =>
        argv.includes('user') ? '{"login":"agent-bot","id":42}' : '{"name":"acme/app","push":true}',
      lifecycle: {
        environment: async () => ({
          stateDir: '/state',
          account: { login: 'agent-bot', email: 'a@x', blocked: [] },
        }),
        writeEnvironment: async () => {},
        verifyEnvironment: async () => {},
        sessions: {
          ensureOrchestrator: async () => 'unused',
          ensureWorker: async () => 'unused',
          cancel: async () => {},
          dropPending: async () => {},
          async state(id) {
            read.push(id)
            seen ??= (sessionId) => holder.get().guardTool({ sessionId, toolName: 'read', input: {} })
            await reading
            return { running: false, pending: [], jobs: 0 }
          },
        },
      },
    },
    createHookStateHolder(),
    (store) =>
      store.saveSettings(
        SettingsSchema.parse({
          sources: { github: { enabled: true, config: { repository: 'acme/app', cli: '/bin/sh' } } },
        }),
      ),
  )
  await vi.waitFor(() => expect(read.length).toBeGreaterThan(0))
  // The app is ready and the reconcile is reading: the worker of an earlier run is still refused.
  expect(seen?.(WORKER)).toMatch(/has not reconciled/)
  // The main session this app opened is Superagent's and runs under the guard.
  expect(seen?.('superagent:orchestrator')).toBeUndefined()
  release()
  await vi.waitFor(() =>
    expect(holder.get().guardTool({ sessionId: WORKER, toolName: 'read', input: {} })).toMatch(
      /Ticket ended/,
    ),
  )
  await shutdown('disable')
})
