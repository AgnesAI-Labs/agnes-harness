import { join } from 'node:path'
import { channelBindingSnapshot, startChannelBridge } from '@agnes/channels/bridge'
import type { HostOptions } from '@agnes/host'
import { createClient, fileJournal, unixTransport } from '@agnes/sdk'
import { readDaemonDiscovery } from '../supervisor/discovery.js'
import { resolveDaemonScope } from '../supervisor/scope.js'

/** The backend selects its own authenticated endpoint; plugin configuration cannot replace it. */
const runChannelRuntime: NonNullable<HostOptions['channelRuntime']> = (provider, init, context) =>
  startChannelBridge(provider, init, {
    ...context,
    createClient(_config, stateDirectory) {
      return createClient({
        transport: { kind: 'unix', path: 'host-discovery' },
        auth: { kind: 'local' },
        journal: fileJournal(join(stateDirectory, 'sdk')),
        transportFactories: {
          unix: () => async (handlers) => {
            init.signal.throwIfAborted()
            init.assertCurrent()
            // Use the worker's backend scope, not the instance's destination workspace.
            const scope = await resolveDaemonScope({
              home: context.home,
              profile: context.profile,
              dataDir: context.dataDir,
              workspace: context.workspace,
              env: process.env,
            })
            const discovery = await readDaemonDiscovery(scope)
            init.signal.throwIfAborted()
            init.assertCurrent()
            if (!discovery) throw new Error('Channel backend is unavailable')
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
              init.signal.throwIfAborted()
              init.assertCurrent()
              return transport
            } catch (error) {
              await transport.close()
              throw error
            }
          },
        },
      })
    },
  })

export const daemonChannelRuntime = Object.assign(runChannelRuntime, { snapshot: channelBindingSnapshot })
