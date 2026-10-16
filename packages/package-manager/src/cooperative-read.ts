import { setImmediate } from 'node:timers/promises'

/** Drive the same verifier synchronously for transactions or cooperatively for async readers. */
export function collectRead<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}
export async function collectReadAsync<T>(steps: Generator<void, T, void>): Promise<T> {
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    await setImmediate()
  }
}
