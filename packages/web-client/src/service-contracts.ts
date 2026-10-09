import type { ArtifactRef } from '@agnes/protocol'

export type HostAgnesClient = import('@agnes/sdk/browser').Client

/** The only backend-service entry point available to a browser module. */
export type ClientServiceApi = Readonly<{
  call(name: string, input: Record<string, unknown>): Promise<unknown>
}>

export type AgnesClient = HostAgnesClient & Readonly<{ services: ClientServiceApi }>

export type ClientImageArtifact = Readonly<Pick<ArtifactRef, 'sha256' | 'size' | 'mime'>>
export type ClientDocumentArtifact = ClientImageArtifact

export type ClientDocumentKind = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'code'

export type ClientImageResource = Readonly<{
  artifact: ClientImageArtifact
  url: string
  release(): void
}>

export type ClientImageLoader = Readonly<{
  load(input: Readonly<{ laneId: string; artifact: ClientImageArtifact }>): Promise<ClientImageResource>
}>

export type ClientDocumentResource = Readonly<{
  artifact: ClientImageArtifact
  kind: ClientDocumentKind
  content?: string
  url?: string
  release(): void
}>

export type ClientDocumentLoader = Readonly<{
  load(
    input: Readonly<{
      laneId: string
      kind: ClientDocumentKind
      artifact: ClientImageArtifact
    }>,
  ): Promise<ClientDocumentResource>
}>

export type ClientServiceCaller = (
  module: ModuleIdentity,
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>

export type ClientEffectCaller = (
  module: ModuleIdentity,
  sessionId: string,
  name: string,
  commandId: string,
  input: Record<string, unknown>,
) => Promise<unknown>

/** Host-owned service that supplies the already-authenticated SDK client to browser modules. */
export type SessionClientHandle = {
  readonly id: string
  readonly listeners: Set<(...args: never[]) => void>
  projectUI(): Promise<unknown>
  prompt(input: unknown): Promise<unknown>
  steer(input: unknown): Promise<unknown>
  followUp(input: unknown): Promise<unknown>
  compact(instructions?: string): Promise<unknown>
  cancel(): Promise<void>
}

export type SessionProjection = {
  read(name?: string): Promise<unknown>
  subscribe(listener: () => void): () => void
}

export type SessionCommands = {
  prompt(input: unknown): Promise<unknown>
  steer(input: unknown): Promise<unknown>
  followUp(input: unknown): Promise<unknown>
  compact(instructions?: string): Promise<unknown>
  cancel(): Promise<void>
}

/**
 * Browser-side command contribution.  Registering a command is deliberately
 * separate from executing it: package code never gets to decide whether the
 * currently signed-in person may run a command.
 */
export type ClientCommand = Readonly<{
  id: string
  title?: string
  /** Set only by the host adapter for an effect-backed command; useful to an approval UI. */
  effectService?: string
  execute(input: unknown): unknown | Promise<unknown>
}>

export type ClientEffectCommand = Readonly<{
  id: string
  title?: string
  service: string
}>

export type CommandAuthorizer = (
  request: Readonly<{
    owner: string
    command: ClientCommand
    input: unknown
  }>,
) => boolean | Promise<boolean>

/**
 * Host-owned command table for client modules.  The host supplies the policy
 * bridge; absent such a bridge execution is fail-closed.  Registration is
 * still useful because the host can render or audit the current command set.
 */
export interface ModuleIdentity {
  /** Browser lifecycle/slot owner identity. Distinct rows of one package must not tear down each other. */
  rowId?: string
  packageId: string
  revision: string
  /** Informational manifest declaration enforced by the host registry as a UX/diagnostic guard. */
  allowedSlots?: readonly string[]
  /** Exact DSH-aligned component catalog used by this contribution. */
  slotCatalogVersion?: string
  /** Digest of the daemon-verified immutable client snapshot. */
  contentDigest?: string
  /** Explicit immutable manifest metadata, projected through the browser roster allow-list. */
  publicConfig?: Readonly<Record<string, unknown>>
  /** Immutable manifest allow-list for own-extension query services. */
  services?: readonly string[]
}
