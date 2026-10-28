import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostOptions } from '../lifecycle/host.js'

type Read = NonNullable<HostOptions['runtimePluginSources']>

/**
 * One agent resolution asks for the installed plugin sources from admission, from opening its
 * composition and from the Host it builds. Inside `scoped` they all share the first read, so the
 * resolution sees one consistent catalogue and pays for one read. The scope ends with the call:
 * nothing is kept across resolutions, sessions or a configuration change.
 */
export function createResolutionSources(read: Read | undefined) {
  const scopes = new AsyncLocalStorage<{ closed: boolean; sources?: ReturnType<Read> }>()
  return {
    read: read
      ? (): ReturnType<Read> => {
          const scope = scopes.getStore()
          // A Host built inside the scope can outlive it; its later reads must not see this snapshot.
          if (!scope || scope.closed) return read()
          scope.sources ??= read()
          return scope.sources
        }
      : undefined,
    scoped:
      <A extends unknown[], T>(run: (...args: A) => Promise<T>) =>
      (...args: A): Promise<T> => {
        const scope: { closed: boolean; sources?: ReturnType<Read> } = { closed: false }
        return scopes.run(scope, async () => {
          try {
            return await run(...args)
          } finally {
            scope.closed = true
          }
        })
      },
  }
}
