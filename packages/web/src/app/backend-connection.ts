import { createClient, localStorageJournal } from '@agnes/sdk/browser'
import { bootstrapProbe } from '../reconnect.js'
import { frontendBackendIdentity, readRemoteFrontendInfo, selectedRemoteOrigin } from '../remote-frontend.js'

/** One page owns one immutable backend context; switching creates a fresh context before replay. */
export function createBackendConnection(wsUrl: string | undefined) {
  const remote = selectedRemoteOrigin()
  const namespace = `agnes-web-commands:${wsUrl ?? location.origin}${remote ? `:${frontendBackendIdentity()}` : ''}`
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
      ? async (signal: AbortSignal, manual: boolean) => {
          const info = await readRemoteFrontendInfo(remote, signal)
          return manual || JSON.stringify([remote, info.instanceId]) === frontendBackendIdentity()
        }
      : bootstrapProbe((input, init) => fetch(input, init), wsUrl ?? ''),
  }
}
