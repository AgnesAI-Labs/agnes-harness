import type { ChannelProvider, ChannelRuntime, Logger, ProfileManagedInit } from '@agnes/extension-api'

/** Backend composition only; never a plugin-supplied factory or transport address. */
export type ChannelRuntimeFactory = (
  provider: ChannelProvider,
  init: ProfileManagedInit,
  context: {
    owner: string
    stateDirectory: string
    home: string
    profile: string
    dataDir: string
    workspace: string
    resolveSecret(ref: string): string
    log: Logger
  },
) => Promise<ChannelRuntime>
