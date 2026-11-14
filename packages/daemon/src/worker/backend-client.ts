import { join } from 'node:path'
import { createClient, fileJournal, unixTransport } from '@agnes/sdk'
import { readDaemonDiscovery } from '../supervisor/discovery.js'
import { resolveDaemonScope } from '../supervisor/scope.js'

/**
 * An owner-level local client of this worker's own daemon. The backend selects the endpoint from
 * trusted discovery on every connect; plugin configuration cannot replace it. Each connection
 * attempt re-checks the caller's fence so a retired grant can never reconnect.
 */
export function backendClient(options: {
  scope: { home: string; profile: string; dataDir: string; workspace: string }
  stateDirectory: string
  clientId?: string
  signal: AbortSignal
  assertCurrent(): void
  unavailable: string
}) {
  const fence = () => {
    options.signal.throwIfAborted()
    options.assertCurrent()
  }
  return createClient({
    transport: { kind: 'unix', path: 'host-discovery' },
    auth: { kind: 'local' },
    journal: fileJournal(join(options.stateDirectory, 'sdk'), options.clientId),
    transportFactories: {
      unix: () => async (handlers) => {
        fence()
        // Use the worker's backend scope, not the instance's destination workspace.
        const scope = await resolveDaemonScope({ ...options.scope, env: process.env })
        const discovery = await readDaemonDiscovery(scope)
        fence()
        if (!discovery) throw new Error(options.unavailable)
        const transport = await unixTransport({
          path: discovery.socketPath,
          ...(discovery.socketPath.startsWith('\\\\.\\pipe\\')
            ? {
                serverIdentity: {
                  pid: discovery.owner.pid,
                  processStartId: discovery.owner.processStartId,
                },
              }
            : {}),
          connectTimeoutMs: 3000,
        })(handlers)
        try {
          fence()
          return transport
        } catch (error) {
          await transport.close()
          throw error
        }
      },
    },
  })
}
