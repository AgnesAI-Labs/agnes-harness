import type { HostOptions } from '@agnes/host'
import { backendClient } from '../worker/backend-client.js'

/**
 * The bundled application key the daemon gave this worker, taken out of the process environment when this module
 * loads, before any plugin code runs in the worker; only the grant's client below uses it.
 */
const bundledAppKey = process.env.AGNES_BUNDLED_APP_KEY
delete process.env.AGNES_BUNDLED_APP_KEY

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
    ...(bundledAppKey ? { bundledAppKey } : {}),
  })
  return { client, close: () => client.close() }
}
