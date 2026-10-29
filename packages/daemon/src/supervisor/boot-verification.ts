import { AsyncResource } from 'node:async_hooks'
import { withPackageVerification } from '@agnes/package-manager'

/** One read boundary for the pre-listen boot sequence. It is one operation, never a cache across
 * requests: writers still invalidate it, and write/publish/execute gates still hash on their own. */
export type BootVerification = Readonly<{
  /** Run a boot step inside the shared boundary. A failed step closes it. */
  bind<A extends unknown[], R>(step: (...args: A) => Promise<R>): (...args: A) => Promise<R>
  /** Create servers whose callbacks must never share boot observations (the workers socket). */
  outside<T>(action: () => T): T
  /** Close the boundary; resolves once it is inactive and its digests are cleared. Idempotent. */
  end(): Promise<void>
}>

/**
 * AsyncLocalStorage inheritance: timers, watchers and promises created by a step keep this
 * operation as their store. They rely on the existing close semantics (active=false plus cleared
 * digests), so anything that runs after end() re-hashes; boot-verification.test.ts proves it. The
 * workers socket is created through outside() instead, so worker requests during boot read exactly
 * as before. end() must resolve before the client socket listens.
 */
export function openBootVerification(): BootVerification {
  const outsideScope = new AsyncResource('agnes.boot-verification.outside')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let scope!: AsyncResource
  // The read callback runs synchronously up to `await gate`, so `scope` is set before return.
  const closed = withPackageVerification(async () => {
    scope = new AsyncResource('agnes.boot-verification')
    await gate
  })
  const end = async (): Promise<void> => {
    release()
    await closed
  }
  return {
    bind:
      (step) =>
      async (...args) => {
        try {
          return await scope.runInAsyncScope(step, undefined, ...args)
        } catch (error) {
          await end()
          throw error
        }
      },
    outside: (action) => outsideScope.runInAsyncScope(action),
    end,
  }
}
