// Adapted from dsh-superagent (MIT)
/**
 * Starting and stopping one app: `start()` resolves the deployment, opens the main session, starts the GitHub Source and
 * the queues, and re-dispatches what a restart interrupted; `stopSignal()` stops polling, sending and dispatch at once,
 * and `drain()` waits for what was in flight. Sessions, turns and jobs are left to the lifecycle that owns cancelling
 * them.
 */
import { mkdir } from 'node:fs/promises'
import { resolveDeployment } from '../deployment.js'
import { SetupError } from '../setup.js'
import { startGithub } from '../sources/github.js'
import { health as sourceHealth } from '../sources/host.js'
import type { AppDeps } from './app.js'
import { type AppState, type Core, now } from './app-core.js'
import type { EngineParts } from './app-engine.js'
import type { Tools } from './app-tools.js'

export function appRun(deps: AppDeps, state: AppState, core: Core, parts: EngineParts, tools: Tools) {
  const { store, sessions } = deps
  const { machine, probe, runtimeHealth, closing } = core
  const { settings, executor, passes, assessor } = parts
  const stops: (() => Promise<void>)[] = []
  const draining: Promise<unknown>[] = []
  async function configure(): Promise<boolean> {
    try {
      state.deployment = await resolveDeployment(machine, store.settings().sources.github?.config, probe)
      state.problem = undefined
      return true
    } catch (error) {
      if (!(error instanceof SetupError)) throw error
      state.problem = error.problem
      state.deployment = undefined
      return false
    }
  }
  /** Opens the main session and starts the Sources and queues of a configured deployment. */
  async function begin(): Promise<void> {
    await sessions.ensureOrchestrator()
    tools.skills.write(core.prompts.current())
    for (const id of settings.syncable()) await settings.sync(id).catch(() => {})
    if (closing()) return
    stops.push(startGithub(parts.sourceHost), ...(deps.sources?.(parts.sourceHost) ?? []))
    await executor.resume(!deps.reconciled)
    passes.start()
    core.effects.start()
    state.phase = 'ready'
    runtimeHealth.set({ state: 'ready', detail: 'Superagent is ready', at: now() })
  }
  async function reconfigure(): Promise<void> {
    if (state.phase !== 'setup' && state.phase !== 'ready') return
    const was = state.deployment !== undefined
    if ((await configure()) && !was && state.phase === 'setup') await begin()
  }
  return {
    reconfigure,
    async start(): Promise<void> {
      if (state.phase !== 'idle') throw new Error('Superagent was started already')
      state.phase = 'starting'
      state.started = (async () => {
        await mkdir(machine.stateDir, { recursive: true, mode: 0o700 })
        if (!(await configure())) {
          state.phase = 'setup'
          runtimeHealth.set({ ...sourceHealth('paused', 'setupPending'), at: now() })
          return
        }
        await begin()
      })()
      await state.started
    },
    stopSignal(_reason: 'disable' | 'generation' | 'shutdown'): void {
      if (state.phase === 'stopping') return
      state.phase = 'stopping'
      // Each stop begins synchronously: polling ends, the effect queue (and with it the outbox) takes nothing more,
      // and the executor, which reads the phase, dispatches nothing new.
      draining.push(passes.stop(), ...stops.splice(0).map((stop) => stop()), core.effects.drain())
      core.stopped.abort()
      assessor.stop()
    },
    async drain(): Promise<void> {
      await Promise.allSettled(draining.splice(0))
      await executor.shutdown()
    },
  }
}
export type AppRun = ReturnType<typeof appRun>
