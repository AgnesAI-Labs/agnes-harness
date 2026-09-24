import type { Client } from '@agnes/sdk'
import type { Runner, RunnerLog } from './runner.js'

type Instance = Readonly<{
  client: Pick<Client, 'on'>
  runner: Pick<Runner, 'start' | 'stopIntake' | 'stop'>
}>

async function backoff(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Owns exactly one Channel Runner and replaces it only after its SDK Client went terminal. */
export function createRunnerSupervisor(
  create: () => Promise<Instance>,
  log: Pick<RunnerLog, 'warn'>,
  options: { baseMs?: number; maxMs?: number; wait?: typeof backoff } = {},
): Pick<Runner, 'start' | 'stopIntake' | 'stop'> {
  const abort = new AbortController()
  let active: (Instance & { unsubscribe: () => void; intakeStopped: boolean }) | undefined
  let starting: Promise<void> | undefined
  let recovery: Promise<void> | undefined
  let stopping = false
  let stopPromise: Promise<void> | undefined

  async function retire(drainMs = 5_000): Promise<void> {
    const old = active
    active = undefined
    if (!old) return
    old.unsubscribe()
    stopIntake(old)
    try {
      await old.runner.stop({ drainMs })
    } catch {
      log.warn('channel runner teardown failed before replacement')
    }
  }

  function stopIntake(instance: NonNullable<typeof active>): void {
    if (instance.intakeStopped) return
    instance.intakeStopped = true
    instance.runner.stopIntake()
  }

  async function startFresh(): Promise<void> {
    const instance = await create()
    if (stopping) {
      await instance.runner.stop({ drainMs: 0 })
      return
    }
    let closedDuringStart = false
    const unsubscribe = instance.client.on('closed', () => {
      if (stopping) return
      closedDuringStart = true
      scheduleRecovery()
    })
    active = { ...instance, unsubscribe, intakeStopped: false }
    try {
      await instance.runner.start()
      if (closedDuringStart) throw new Error('channel SDK closed during startup')
    } catch (error) {
      await retire()
      throw error
    }
  }

  function scheduleRecovery(): void {
    if (stopping || recovery) return
    recovery = (async () => {
      // A terminal event may arrive while runner.start is still subscribing. Let that startup
      // settle before teardown so a late subscription cannot outlive the retired runner.
      await starting?.catch(() => undefined)
      await retire()
      let delay = options.baseMs ?? 250
      const max = options.maxMs ?? 5_000
      while (!stopping) {
        await (options.wait ?? backoff)(delay, abort.signal)
        if (stopping) break
        try {
          await startFresh()
          return
        } catch {
          if (!stopping) log.warn('channel daemon client rebuild failed; retrying')
          delay = Math.min(max, delay * 2)
        }
      }
    })().finally(() => {
      recovery = undefined
    })
  }

  return {
    start() {
      if (stopping) return Promise.reject(new Error('channel runner supervisor is stopped'))
      if (active && !starting) return Promise.resolve()
      starting ??= startFresh().finally(() => {
        starting = undefined
      })
      return starting
    },
    stopIntake() {
      if (active) stopIntake(active)
    },
    stop(options) {
      stopPromise ??= (async () => {
        stopping = true
        abort.abort()
        await starting?.catch(() => undefined)
        await retire(options?.drainMs)
        await recovery
        await retire(options?.drainMs)
      })()
      return stopPromise
    },
  }
}
