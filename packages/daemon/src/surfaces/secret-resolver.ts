import type { SurfaceSecretResolver } from './types.js'

/** Wraps the host layer's synchronous secret resolver in the Surface async contract. A plain string
 * is returned rather than a lease: neither the file nor the env backend owns revocable material, so
 * there is nothing for dispose() to reclaim. That is a deliberate decision, not an omission. */
export function createSurfaceSecretResolver(resolve: (ref: string) => string): SurfaceSecretResolver {
  return Object.freeze({
    // async so a synchronous throw -- from an already-aborted signal or from the wrapped resolver
    // itself -- becomes a rejected promise, matching the SurfaceSecretResolver contract, instead of
    // escaping as an uncaught exception before the caller's await ever runs.
    async resolve(ref: string, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted()
      return resolve(ref)
    },
  })
}
