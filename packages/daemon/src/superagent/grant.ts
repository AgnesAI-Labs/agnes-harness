import type { HostOptions } from '@agnes/host'
import { backendClient } from '../worker/backend-client.js'

/**
 * Owner-level local client for a release-granted bundled application. The Host chooses the state
 * directory and fixed client id; the journal lives under `<state directory>/sdk`. Connections are
 * refused once the grant is retired, and closing the lease ends the current connection.
 */
export const bundledAppClient: NonNullable<HostOptions['bundledAppClient']> = (context) => {
  const client = backendClient({
    scope: context.scope,
    stateDirectory: context.stateDirectory,
    clientId: context.clientId,
    signal: context.signal,
    assertCurrent: context.assertCurrent,
    unavailable: 'Bundled application backend is unavailable',
  })
  return { client, close: () => client.close() }
}
