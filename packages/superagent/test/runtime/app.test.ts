// The app's start and stop: a stop that comes while the start awaits wins, so nothing polls, sends or dispatches after a
// disable; and a session the owner holds under the main session's key leaves Superagent waiting for setup.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSchema } from '../../src/policy.js'
import { createRuntimeParts, createSuperagentApp, type SuperagentApp } from '../../src/runtime/app.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

/** A configured deployment whose GitHub checks pass, over a fake SDK client. */
function setup() {
  temp.store.saveSettings(
    SettingsSchema.parse({
      sources: { github: { enabled: true, config: { repository: 'acme/app', cli: process.execPath } } },
    }),
  )
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
    probe: async (argv) =>
      argv.includes('user') ? '{"login":"agent-bot","id":42}' : '{"name":"acme/app","push":true}',
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
    sources: vi.spyOn(app.parts.sources, 'register'),
  }
}

describe('the app', () => {
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
})
