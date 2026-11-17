import { receiveBundledAppKey } from '@agnes/daemon-foundation/local/bundled-app'
import type { HostOptions } from '@agnes/host'
import { backendClient } from '../worker/backend-client.js'

/**
 * The bundled application key, which the daemon sends the shared session worker over IPC once its hello is verified.
 * Listened for from the moment this module loads, before the worker says hello; other worker kinds get none.
 */
const bundledAppKey: Promise<string | undefined> =
  process.env.AGNES_WORKER_KIND === 'session' && process.env.AGNES_WORKER_KEY === '@shared'
    ? receiveBundledAppKey()
    : Promise.resolve(undefined)

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
    bundledAppKey,
  })
  return {
    client,
    close: () => client.close(),
    ...(context.clientId === 'bundled-app:@agnes/superagent/superagent' &&
    context.integrity &&
    context.incarnation
      ? {
          async prepareSessionUpgrade() {
            context.assertCurrent()
            await client.call(
              '_agnes/v1/superagent.sessions.upgrade',
              {
                integrity: context.integrity,
                incarnation: context.incarnation,
              },
              {
                // The daemon keeps its fence until the worker finishes; a caller timeout is not a rollback.
                timeoutMs: null,
                signal: context.signal,
              },
            )
            context.assertCurrent()
          },
        }
      : {}),
  }
}
