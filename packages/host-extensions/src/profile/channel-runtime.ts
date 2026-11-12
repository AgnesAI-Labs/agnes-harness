import type {
  ChannelConfiguration,
  ChannelProvider,
  ChannelRuntime,
  Logger,
  OwnedStore,
  ProfileManagedInit,
} from '@agnes/extension-api'
import type {
  ApprovalDecideParams,
  ChannelCredential,
  DecisionCommandReceipt,
  JsonValue,
  UiActionParams,
  UiActionReceipt,
} from '@agnes/protocol'
import type { ChannelTargetsBridge } from './channel-targets.js'

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
    /** Host pairings of this channel row's chats to managed services. */
    targets?: ChannelTargetsBridge
    interactions?: ChannelInteractionPort
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

/** Trusted registered-channel ingress. Never exposed to a managed service or public RPC caller. */
export interface ChannelInteractionPort {
  surface(params: UiActionParams, credential: ChannelCredential): Promise<UiActionReceipt>
  approval(params: ApprovalDecideParams, credential: ChannelCredential): Promise<DecisionCommandReceipt>
}
export type ChannelInteractionsFactory = (caller: {
  owner: string
  packageId: string
  integrity: string
  provider: string
}) => ChannelInteractionPort
