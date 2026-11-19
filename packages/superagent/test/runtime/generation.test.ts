// One generation as the service composes it: the panel is wired with every part before anything starts, Superagent's
// sessions of earlier runs are refused with their live notes from the first moment, a setup problem of the agent
// environment reaches the panel, and "check again" runs the start again.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { fakeGhCommand } from '../fixtures/commands.js'
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
      prepareSessionUpgrade: async () => {},
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
  /**
   * Starts with the default environment check, with a fake agent CLI as worker shells run it (nothing is written or
   * verified), until the app is ready; `between` runs after the check, before the app starts. Returns the CLI's calls.
   */
  async function checkedStart(between: (stateDir: string) => void = () => {}) {
    const tools = mkdtempSync(join(tmpdir(), 'superagent-generation-cli-'))
    dirs.push(tools)
    const calls = join(tools, 'gh.log')
    const cli = fakeGhCommand(join(tools, 'gh'), {
      script: JSON.stringify({
        rules: [
          { pattern: '^api user$', stdout: '{"login":"agent-bot","id":42}' },
          { pattern: '^api repos/acme/app --jq', stdout: '{"name":"acme/app","push":true}' },
          { pattern: '^api repos/acme/app/notifications', stdout: '[]' },
        ],
      }),
      log: calls,
    })
    const github = (path: string) =>
      SettingsSchema.parse({
        sources: { github: { enabled: true, config: { repository: 'acme/app', cli: path } } },
      })
    const { call, shutdown } = await start(
      {
        lifecycle: {
          writeEnvironment: async (stateDir) => between(stateDir),
          verifyEnvironment: async () => {},
        },
      },
      createHookStateHolder(),
      (store) => store.saveSettings(github(cli)),
    )
    await vi.waitFor(
      async () =>
        expect(
          ((await call('superagent.state')).health as { runtime?: { state: string } }).runtime?.state,
        ).toBe('ready'),
      { timeout: 20_000, interval: 100 },
    )
    await shutdown('disable')
    const argv = readFileSync(calls, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(' '))
    return { cli, github, argv }
  }

  it("probes the agent's CLI once per start: the app takes the deployment the environment check just resolved", async () => {
    const { argv } = await checkedStart()
    // The account and the repository were checked once, by the environment check, not again by the app's start.
    expect(argv.filter((line) => line === 'api user')).toHaveLength(1)
    expect(argv.filter((line) => line.startsWith('api repos/acme/app --jq'))).toHaveLength(1)
  })

  it('probes again when the GitHub Source settings changed between the check and the start', async () => {
    let changed = false
    const { argv } = await checkedStart((stateDir) => {
      // The same CLI written with a space the settings trim: other settings, the same account.
      const store = openStore(join(stateDir, DATABASE_FILE))
      try {
        const cli = store.settings().sources.github?.config.cli as string
        store.saveSettings({
          ...store.settings(),
          sources: { github: { enabled: true, config: { repository: 'acme/app', cli: ` ${cli}` } } },
        })
        changed = true
      } finally {
        store.close()
      }
    })
    expect(changed).toBe(true)
    expect(argv.filter((line) => line === 'api user')).toHaveLength(2)
  })

  it('shows a start that failed on the runtime health, with when it is tried again, until an attempt starts it', async () => {
    let unreachable = true
    const { call, shutdown } = await start(
      {
        probe: async (argv) =>
          argv.includes('user') ? '{"login":"agent-bot","id":42}' : '{"name":"acme/app","push":true}',
        lifecycle: {
          retryDelaysMs: [300],
          environment: async () => {
            if (unreachable) throw new Error('daemon discovery owner identity is unavailable')
            return { stateDir: '/state', account: { login: 'agent-bot', email: 'a@x', blocked: [] } }
          },
          writeEnvironment: async () => {},
          verifyEnvironment: async () => {},
        },
      },
      createHookStateHolder(),
      (store) =>
        store.saveSettings(
          SettingsSchema.parse({
            sources: { github: { enabled: true, config: { repository: 'acme/app', cli: process.execPath } } },
          }),
        ),
    )
    const runtime = async () =>
      ((await call('superagent.state')).health as { runtime?: { state: string; detail: string } }).runtime
    await vi.waitFor(async () =>
      expect(await runtime()).toMatchObject({
        state: 'error',
        detail: expect.stringMatching(
          /^Superagent could not start: daemon discovery owner identity is unavailable\. It tries again at \d{4}-\d\d-\d\dT/,
        ),
      }),
    )
    unreachable = false
    await vi.waitFor(async () => expect((await runtime())?.state).toBe('ready'), { timeout: 10_000 })
    await shutdown('disable')
  })

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
          // Any executable file on every operating system stands for the agent's CLI: the probe answers for it.
          sources: { github: { enabled: true, config: { repository: 'acme/app', cli: process.execPath } } },
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
