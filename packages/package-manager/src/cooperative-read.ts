import { setImmediate } from 'node:timers/promises'
import { type ByteIdentity, byteDirectoryDigest, byteDirectoryDigestAsync } from './byte-verification.js'
import { verifiedDirectoryDigest, verifiedDirectoryDigestAsync } from './verification-operation.js'

type ReadAction = { sync(): string; async(): Promise<string> }
export type ReadSteps<T> = Generator<undefined | ReadAction, T, string>

/** Hash requests are lazy: transaction drivers never start asynchronous work. */
export function* directoryDigestSteps(
  ...args: Parameters<typeof verifiedDirectoryDigest>
): ReadSteps<string> {
  return yield {
    sync: () =>
      (!args[2] ? byteDirectoryDigest(args[0], args[1]) : undefined) ?? verifiedDirectoryDigest(...args),
    async: () =>
      (!args[2] ? byteDirectoryDigestAsync(args[0], args[1]) : undefined) ??
      verifiedDirectoryDigestAsync(...args),
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

/** Managed Host reads preserve operation-scoped full verification without a private owner. */
export function readRuntimePackageTreeDigest(directory: string, identity: ByteIdentity): Promise<string> {
  return byteDirectoryDigestAsync(directory, identity) ?? verifiedDirectoryDigestAsync(directory, identity)
}
