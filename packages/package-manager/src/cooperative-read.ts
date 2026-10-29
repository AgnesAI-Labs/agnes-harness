import { setImmediate } from 'node:timers/promises'
import { verifiedDirectoryDigest, verifiedDirectoryDigestAsync } from './verification-operation.js'

type ReadAction = { sync(): string; async(): Promise<string> }
export type ReadSteps<T> = Generator<undefined | ReadAction, T, string>

/** Hash requests are lazy: transaction drivers never start asynchronous work. */
export function* directoryDigestSteps(
  ...args: Parameters<typeof verifiedDirectoryDigest>
): ReadSteps<string> {
  return yield {
    sync: () => verifiedDirectoryDigest(...args),
    async: () => verifiedDirectoryDigestAsync(...args),
  }
}

/** Drive identical validation/refusals synchronously for transactions or asynchronously for reads. */
export function collectRead<T>(steps: ReadSteps<T>): T {
  let step = steps.next('')
  for (;;) {
    if (step.done) return step.value
    try {
      const value = step.value?.sync() ?? ''
      step = steps.next(value)
    } catch (error) {
      step = steps.throw(error)
    }
  }
}
export async function collectReadAsync<T>(steps: ReadSteps<T>, asyncHashes = true): Promise<T> {
  let step = steps.next('')
  for (;;) {
    if (step.done) return step.value
    try {
      let value = ''
      if (step.value) value = asyncHashes ? await step.value.async() : step.value.sync()
      else await setImmediate()
      step = steps.next(value)
    } catch (error) {
      step = steps.throw(error)
    }
  }
}
