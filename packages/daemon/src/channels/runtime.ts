import { channelBindingSnapshot, startChannelBridge } from '@agnes/channels/bridge'
import type { HostOptions } from '@agnes/host'
import { backendClient } from '../worker/backend-client.js'

/** The backend selects its own authenticated endpoint; plugin configuration cannot replace it. */
const runChannelRuntime: NonNullable<HostOptions['channelRuntime']> = (provider, init, context) =>
  startChannelBridge(provider, init, {
    ...context,
    createClient(_config, stateDirectory) {
      return backendClient({
        scope: {
          home: context.home,
          profile: context.profile,
          dataDir: context.dataDir,
          workspace: context.workspace,
        },
        stateDirectory,
        signal: init.signal,
        assertCurrent: () => init.assertCurrent(),
        unavailable: 'Channel backend is unavailable',
      })
    },
  })

export const daemonChannelRuntime: NonNullable<HostOptions['channelRuntime']> = Object.assign(
  runChannelRuntime,
  {
    snapshot: channelBindingSnapshot,
  },
)
