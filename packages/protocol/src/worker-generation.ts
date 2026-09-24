import type { WorkerGeneration as GeneratedWorkerGeneration } from '../gen/ts/worker.js'

/** Supervisor-assigned process epoch used to fence stale worker traffic. */
export type WorkerGeneration = GeneratedWorkerGeneration

/** Runtime validator for the JSON representation of `WorkerGeneration`. */
export function isWorkerGeneration(value: unknown): value is WorkerGeneration {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

/** Parse an untrusted worker generation at a process or wire boundary. */
export function workerGeneration(value: unknown): WorkerGeneration {
  if (!isWorkerGeneration(value)) throw new TypeError('worker generation must be a positive safe integer')
  return value
}
