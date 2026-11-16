// The app's start and stop: a stop that comes while the start awaits wins, so nothing polls, sends or dispatches after a
// disable; and a session the owner holds under the main session's key leaves Superagent waiting for setup.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Deployment, machineOf } from '../../src/deployment.js'
import { SettingsSchema } from '../../src/policy.js'
import { createRuntimeParts, createSuperagentApp, type SuperagentApp } from '../../src/runtime/app.js'
import { SessionRegistry } from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore, ticket } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

const GITHUB = { enabled: true, config: { repository: 'acme/app', cli: process.execPath } }
/**
 * A configured deployment whose GitHub checks pass, over a fake SDK client; `fresh` leaves the settings empty. `probes`
 * records each call of the agent's CLI; `resolved` is the deployment a check just resolved, if any.
 */
function setup(
  fresh = false,
  hold?: () => Promise<void> | undefined,
  more: { probes?: string[][]; resolved?: (github: unknown) => Deployment | undefined } = {},
) {
  if (!fresh) temp.store.saveSettings(SettingsSchema.parse({ sources: { github: GITHUB } }))
  const fake = fakeClient()
  const lifetime = new AbortController()
  const grant = { stateDirectory: join(temp.dir, 'state'), client: fake.client }
  const runtime = createRuntimeParts({ store: temp.store, grant, lifetime: lifetime.signal })
  const app = createSuperagentApp({
    store: temp.store,
    grant,
    ...runtime,
    log: { warn: () => {} },
    skillsRoot: join(temp.dir, 'skills'),
    probe: async (argv) => {
      more.probes?.push(argv)
      await hold?.()
      return argv.includes('user') ? '{"login":"agent-bot","id":42}' : '{"name":"acme/app","push":true}'
    },
    ...(more.resolved ? { resolved: more.resolved } : {}),
  })
  return { app, fake, lifetime, runtime }
}

/** A promise the test releases, standing for a step of the start that waits. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

function watchStarts(app: SuperagentApp) {
  return {
    passes: vi.spyOn(app.parts.passes, 'start'),
    effects: vi.spyOn(app.parts.effects, 'start'),
    // A Source's polling begins by taking its context; its kind registers when the app is built.
    sources: vi.spyOn(app.parts.sourceHost, 'context'),
  }
}

describe('the app', () => {
  it("starts on the deployment a check just resolved without probing the agent's CLI again, and probes without one", async () => {
    const deployment: Deployment = {
      ...machineOf({ stateDir: join(temp.dir, 'state') }),
      repository: 'acme/app',
      github: { cli: process.execPath, login: 'agent-bot', noreply: '42+agent-bot@users.noreply.github.com' },
    }
    const seen: unknown[] = []
    const probes: string[][] = []
    const checked = setup(false, undefined, {
      probes,
      resolved: (github) => {
        seen.push(github)
        return deployment
      },
    })
    await checked.app.start()
    expect(checked.app.unavailable()).toBeUndefined()
    expect(probes, 'no second probe').toEqual([])
    expect(seen, "asked with the GitHub Source's settings").toEqual([GITHUB.config])
    await checked.app.stop('disable')
    // Without a resolved deployment the start probes as before.
    const unchecked = setup(false, undefined, { probes, resolved: () => undefined })
    await unchecked.app.start()
    expect(unchecked.app.unavailable()).toBeUndefined()
    expect(probes.map((argv) => argv.slice(1, 3).join(' '))).toEqual([
      'api user',
      'api repos/acme/app',
      'api repos/acme/app/notifications?per_page=1',
    ])
    await unchecked.app.stop('disable')
  })

  it('starts and becomes ready on a configured deployment', async () => {
    const { app, fake } = setup()
    const starts = watchStarts(app)
    await app.start()
    expect(app.unavailable()).toBeUndefined()
    expect(starts.passes).toHaveBeenCalledOnce()
    expect(starts.effects).toHaveBeenCalledOnce()
    expect(starts.sources).toHaveBeenCalled()
    expect(fake.sessions.has('superagent:orchestrator')).toBe(true)
    await app.stop('disable')
  })

  it('starts again after a start that failed before its Sources started, and only then', async () => {
    const { app, fake } = setup()
    const starts = watchStarts(app)
    // Right after a daemon restart its client may not reach the daemon yet: the main session cannot be opened.
    const add = fake.client.workspace.add
    fake.client.workspace.add = vi.fn(async () => {
      throw new Error('daemon discovery owner identity is unavailable')
    })
    await expect(app.start()).rejects.toThrow('owner identity is unavailable')
    expect(starts.sources, 'no Source started').not.toHaveBeenCalled()
    fake.client.workspace.add = add
    await app.start()
    expect(app.unavailable()).toBeUndefined()
    expect(starts.passes).toHaveBeenCalledOnce()
    expect(fake.sessions.has('superagent:orchestrator')).toBe(true)
    // A started app is not started a second time.
    await expect(app.start()).rejects.toThrow('started already')
    await app.stop('disable')
  })

  it.each(['main session', 'resume'] as const)(
    'lets a stop during the start (at the %s) win: nothing starts after it, and drain waits for the start',
    async (step) => {
      const { app, runtime } = setup()
      const starts = watchStarts(app)
      const held = gate()
      const reached = gate()
      const hold = async () => {
        reached.open()
        await held.opened
      }
      if (step === 'resume') {
        const resume = app.executor.resume.bind(app.executor)
        app.executor.resume = async (interrupt) => {
          await hold()
          return resume(interrupt)
        }
      } else {
        const ensure = runtime.sessions.ensureOrchestrator.bind(runtime.sessions)
        runtime.sessions.ensureOrchestrator = async () => {
          await hold()
          return ensure()
        }
      }
      const started = app.start()
      await reached.opened
      app.stopSignal('disable')
      let drained = false
      const draining = app.drain().then(() => {
        drained = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(drained).toBe(false)
      held.open()
      await started
      await draining
      expect(starts.passes).not.toHaveBeenCalled()
      expect(starts.effects).not.toHaveBeenCalled()
      // Stopped before the Sources start, the GitHub Source never polls.
      if (step === 'main session') expect(starts.sources).not.toHaveBeenCalled()
      expect(app.unavailable()).toBe('Superagent is stopping')
    },
  )

  it('waits for setup, naming it, when a session it did not open holds the main session key', async () => {
    const { app, fake } = setup()
    fake.make('superagent:orchestrator')
    const starts = watchStarts(app)
    await app.start()
    expect(app.parts.setupProblem()).toMatchObject({ code: 'sessionTaken' })
    expect(app.unavailable()).toMatch(/waiting for setup: .*superagent:orchestrator/)
    expect(starts.passes).not.toHaveBeenCalled()
    await app.stop('disable')
  })

  it('lists the GitHub Source on a fresh start, saves its repository during setup and then starts it', async () => {
    const { app } = setup(true)
    const starts = watchStarts(app)
    await app.start()
    expect(app.parts.setupProblem()).toMatchObject({ code: 'repositoryUnset' })
    expect(app.parts.sources.instances().map((instance) => instance.id)).toContain('github')
    expect(starts.sources).not.toHaveBeenCalled()
    const saved = await app.parts.settings.save('source:github', GITHUB, 0, 'panel')
    expect(saved).toMatchObject({ saved: true, restarting: true })
    await vi.waitFor(() => expect(app.unavailable()).toBeUndefined())
    expect(app.parts.setupProblem()).toBeUndefined()
    expect(starts.sources).toHaveBeenCalledWith(expect.objectContaining({ kind: 'github' }))
    expect(starts.passes).toHaveBeenCalledOnce()
    await app.stop('disable')
  })
})

describe('the app in setup', () => {
  it('starts the GitHub Source once when two saves complete the setup at once', async () => {
    // Once both saves are in, the setup checks they schedule wait at the account check until the test opens it.
    let held: ReturnType<typeof gate> | undefined
    let waiting = 0
    const { app } = setup(true, () => {
      if (!held) return undefined
      waiting += 1
      return held.opened
    })
    const starts = watchStarts(app)
    await app.start()
    await app.parts.settings.save('source:github', GITHUB, 0, 'panel')
    await app.parts.settings.save(
      'source:github',
      { ...GITHUB, config: { ...GITHUB.config, pollSeconds: 120 } },
      1,
      'panel',
    )
    held = gate()
    await vi.waitFor(() => expect(waiting).toBeGreaterThan(0))
    // Both scheduled checks have run by now: without serializing, both wait at the account check.
    await new Promise((resolve) => setTimeout(resolve, 20))
    held.open()
    await vi.waitFor(() => expect(app.unavailable()).toBeUndefined())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(starts.sources.mock.calls.filter(([kind]) => kind.kind === 'github')).toHaveLength(1)
    expect(starts.passes).toHaveBeenCalledOnce()
    await app.stop('disable')
  })
})

describe("the app's hook state", () => {
  it('governs sessions registered after a reconcile read its sessions, and refuses earlier ones it did not list', async () => {
    // A worker of an earlier run, which the reconcile did not go through.
    new SessionRegistry(temp.store).record({ kind: 'worker', ticketId: 'old' }, 'superagent:worker:old')
    const { app, runtime } = setup()
    await app.start()
    const state = app.hookState(new Set(['superagent:orchestrator']))
    const call = (sessionId: string) => state.guardTool({ sessionId, toolName: 'read', input: {} })
    // A ticket accepted after the reconcile: its worker is registered afterwards and governed as any other.
    temp.store.tickets.save(ticket('t1'))
    runtime.registry.record({ kind: 'worker', ticketId: 't1' }, 'superagent:worker:t1')
    expect(state.isSuperagentSession('superagent:worker:t1')).toBe(true)
    expect(call('superagent:worker:t1')).toBeUndefined()
    temp.store.tickets.save(ticket('t1', { state: 'ended' }))
    expect(call('superagent:worker:t1')).toBe('Ticket ended; new work needs a new authorized ticket')
    expect(call('superagent:worker:t1/01CHILD')).toBe('Ticket ended; new work needs a new authorized ticket')
    expect(call('superagent:worker:old')).toMatch(/has not reconciled/)
    expect(call('superagent:worker:old/01CHILD')).toMatch(/has not reconciled/)
    expect(state.promptSections('superagent:orchestrator').stable).toHaveLength(1)
    expect(state.isSuperagentSession('01OWNER')).toBe(false)
    expect(call('01OWNER')).toBeUndefined()
    await app.stop('disable')
  })

  it("leaves a frozen refusal after a stop that keeps the sessions' live notes", async () => {
    const { app, runtime } = setup()
    await app.start()
    runtime.delivery.notify('superagent:orchestrator', { content: 'Settings saved' })
    await app.stop('disable')
    const stopped = app.stoppedState('Superagent is not running')
    temp.close()
    temp = tempStore()
    expect(stopped.guardTool({ sessionId: 'superagent:orchestrator', toolName: 'read', input: {} })).toBe(
      'Superagent is not running',
    )
    expect(stopped.promptSections('superagent:orchestrator')).toEqual({
      stable: [],
      liveNote: { id: 'superagent-notices', content: 'Settings saved' },
    })
    expect(stopped.guardTool({ sessionId: '01OWNER', toolName: 'read', input: {} })).toBeUndefined()
  })
})
