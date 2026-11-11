import type {
  ChannelConfiguration,
  ChannelProvider,
  ChannelRuntime,
  Logger,
  OwnedStore,
  ProfileManagedInit,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'

/** Backend composition only; never a plugin-supplied factory or transport address. */
export type ChannelRuntimeFactory = ((
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
) => Promise<ChannelRuntime>) & {
  /** Backend-only, read-only metadata recovery. Never starts or resumes a transport. */
  snapshot?(
    provider: ChannelProvider,
    config: ChannelConfiguration,
    store: OwnedStore,
    owner: string,
  ): JsonValue
}
