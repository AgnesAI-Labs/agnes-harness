// Adapted from dsh-superagent (MIT)
/**
 * Starting and stopping one app: the GitHub Source kind registers when the app is built, so its settings can be saved
 * during setup; `start()` resolves the deployment, opens the main session, starts the GitHub Source's polling and the
 * queues, and re-dispatches what a restart interrupted; `stopSignal()` stops polling, sending and dispatch at once,
 * and `drain()` waits for what was in flight, a start included. A stop wins over a start that awaits: the start looks
 * at the phase after every step and starts nothing once the app stops. Sessions, turns and jobs are left to the
 * lifecycle that owns cancelling them.
 */
import { mkdir } from 'node:fs/promises'
import { resolveDeployment } from '../deployment.js'
import { resolveFeishuBot } from '../feishu-setup.js'
import { SetupError } from '../setup.js'
import { registerGithub } from '../sources/github.js'
import { health as sourceHealth } from '../sources/host.js'
import type { AppDeps } from './app.js'
import { type AppState, type Core, now } from './app-core.js'
import type { EngineParts } from './app-engine.js'
import type { Tools } from './app-tools.js'
import { SessionTaken } from './sessions.js'

export function appRun(deps: AppDeps, state: AppState, core: Core, parts: EngineParts, tools: Tools) {
  const { store, sessions } = deps
  const { machine, probe, runtimeHealth, closing } = core
  const { settings, executor, passes, assessor } = parts
  // The GitHub kind is there from the start, as the Feishu kind is, so the owner can set the repository during setup.
  const github = registerGithub(parts.sourceHost)
  const stops: (() => Promise<void>)[] = []
  const draining: Promise<unknown>[] = []
  /** Starts and reconfigurations that run, which `drain()` waits for. */
  const starting = new Set<Promise<void>>()
  const track = (work: Promise<void>): Promise<void> => {
    starting.add(work)
    void work.finally(() => starting.delete(work)).catch(() => {})
    return work
  }
  const waitForSetup = (): void => {
    state.phase = 'setup'
    runtimeHealth.set({ ...sourceHealth('paused', 'setupPending'), at: now() })
  }
  async function configure(): Promise<boolean> {
    try {
      const github = store.settings().sources.github?.config
      // A start right after the lifecycle's own check takes what that check resolved: the agent's CLI is probed once.
      const deployment = deps.resolved?.(github) ?? (await resolveDeployment(machine, github, probe))
      if (closing()) return false
      const feishu = store.settings().sources.feishu
      // Feishu setup failure pauses only this optional source; GitHub continues.
      state.feishuProblem = undefined
      delete deployment.feishu
      if (feishu?.enabled) {
        try {
          deployment.feishu = await resolveFeishuBot(machine, feishu.config, probe)
        } catch (error) {
          if (!(error instanceof SetupError)) throw error
          state.feishuProblem = error.problem
        }
      }
      if (closing()) return false
      state.deployment = deployment
      state.problem = undefined
      return true
    } catch (error) {
      if (!(error instanceof SetupError)) throw error
      state.problem = error.problem
      state.deployment = undefined
      return false
    }
  }
  /**
   * Opens the main session and starts the Sources and queues of a configured deployment, unless the app stops first. A
   * session Superagent did not open under the main session's key leaves it waiting for setup.
   */
  async function begin(): Promise<void> {
    try {
      await sessions.ensureOrchestrator()
    } catch (error) {
      if (!(error instanceof SessionTaken) || closing()) throw error
      state.problem = new SetupError('sessionTaken', { session: error.key }).problem
      state.deployment = undefined
      return waitForSetup()
    }
    if (closing()) return
    tools.skills.write(core.prompts.current())
    for (const id of settings.syncable()) {
      await settings.sync(id).catch(() => {})
      if (closing()) return
    }
    // One by one, so a start that fails at a later Source still stops the earlier ones.
    stops.push(github.run())
    stops.push(...(deps.sources?.(parts.sourceHost) ?? []))
    await executor.resume(!deps.reconciled)
    if (closing()) return
    passes.start()
    core.effects.start()
    state.phase = 'ready'
    runtimeHealth.set({ state: 'ready', detail: 'Superagent is ready', at: now() })
  }
  async function reconfigureOnce(): Promise<void> {
    if (state.phase !== 'setup' && state.phase !== 'ready') return
    const was = state.deployment !== undefined
    if ((await configure()) && !was && state.phase === 'setup') await track(begin())
  }
  /** The reconfiguration that runs; one asked for meanwhile runs once after it, so only one ever opens the app. */
  let reconfiguring: Promise<void> | undefined
  let again = false
  function reconfigure(): Promise<void> {
    if (reconfiguring) {
      again = true
      return reconfiguring
    }
    reconfiguring = (async () => {
      try {
        do {
          again = false
          await reconfigureOnce()
        } while (again)
      } finally {
        reconfiguring = undefined
      }
    })()
    return reconfiguring
  }
  return {
    reconfigure,
    async start(): Promise<void> {
      if (state.phase !== 'idle') throw new Error('Superagent was started already')
      state.phase = 'starting'
      state.started = track(
        (async () => {
          await mkdir(machine.stateDir, { recursive: true, mode: 0o700 })
          if (closing()) return
          const configured = await configure()
          if (closing()) return
          if (configured) await begin()
          else waitForSetup()
        })(),
      )
      try {
        await state.started
      } catch (error) {
        // A start that failed is rolled back, unless a stop took over: the Sources it began stop, so nothing polls, and
        // the app can be started again. The error stays the start's own.
        if (state.phase === 'starting') {
          await Promise.allSettled(stops.splice(0).map((stop) => stop()))
          // A stop that came while the Sources stopped keeps the app stopping.
          if (state.phase === 'starting') state.phase = 'idle'
        }
        throw error
      }
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
      await Promise.allSettled([...starting])
      await Promise.allSettled(draining.splice(0))
      await executor.shutdown()
    },
  }
}
export type AppRun = ReturnType<typeof appRun>
