import { fileURLToPath } from 'node:url'
import {
  type RunAgnesdArgs,
  type RunAgnesdDeps,
  runAgnesd as run,
  type StartSupervisorOptions,
  startSupervisor as start,
  startProductionSupervisor as startProduction,
} from './supervisor/runtime.js'

function defaultWorkerEntry(): string {
  return fileURLToPath(new URL('./worker/main.js', import.meta.url))
}

export function startSupervisor(o: StartSupervisorOptions): ReturnType<typeof start> {
  return start({ ...o, workerEntry: o.workerEntry ?? defaultWorkerEntry() })
}

export function startProductionSupervisor(
  o: Parameters<typeof startProduction>[0],
  deps: Parameters<typeof startProduction>[1] = {},
): ReturnType<typeof startProduction> {
  return startProduction({ ...o, workerEntry: o.workerEntry ?? defaultWorkerEntry() }, deps)
}

export function runAgnesd(args: RunAgnesdArgs = {}, deps: RunAgnesdDeps = {}): Promise<void> {
  return run(args, { ...deps, workerEntry: deps.workerEntry || defaultWorkerEntry() })
}
