import { createClient, localStorageJournal } from '@agnes/sdk/browser'
import { bootstrapProbe } from '../reconnect.js'
import { frontendBackendIdentity, readRemoteFrontendInfo, selectedRemoteOrigin } from '../remote-frontend.js'

/** One page owns one immutable backend context; switching creates a fresh context before replay. */
export function createBackendConnection(wsUrl: string | undefined) {
  const remote = selectedRemoteOrigin()
  const namespace = `agnes-web-commands:${remote ? frontendBackendIdentity() : (wsUrl ?? location.origin)}`
  return {
    wsUrl,
    client: createClient({
      sessionRestoreHistory: 'none',
      transport: { kind: 'ws', url: wsUrl ?? '', protocols: ['agnes-v1'] },
      // Public-owner publication explicitly delegates B's workbench authority. Authenticated remote
      // WSS is a separate transport and cannot be selected through this publication handshake.
      auth: { kind: 'local' },
      journal: localStorageJournal(sessionStorage, namespace),
    }),
    probe: remote
      ? async (signal: AbortSignal) => {
          await readRemoteFrontendInfo(remote, signal)
          // A reload renews the authenticated transport and its backend-scoped journal.
          return true
        }
      : bootstrapProbe((input, init) => fetch(input, init), wsUrl ?? ''),
  }
}
