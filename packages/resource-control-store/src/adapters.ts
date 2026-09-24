import type {
  DesiredState,
  McpServerDefinitionInput,
  McpStatus,
  McpToolCatalogPage,
  ResourceDescriptor,
  SafeError,
  SkillDescriptor,
  SkillRootStatus,
  TrustState,
} from '@agnes/protocol'

/** Host-private discovery data. The capability hash is intentionally absent from wire DTOs. */
export type SkillCatalogCandidate = Readonly<{ descriptor: SkillDescriptor; capabilityHash: string }>
export type SkillCatalogRefresh = Readonly<{
  candidates: readonly SkillCatalogCandidate[]
  failedRoots: readonly SkillDescriptor['sourceIdentity']['rootKey'][]
  /** Entries that looked like Skills but were skipped; their prior records are kept as stale. */
  skippedResourceIds?: readonly string[]
  roots?: readonly SkillRootStatus[]
}>
export type SkillActualObservation = Readonly<{
  resourceId: string
  actual: SkillDescriptor['actual']
  resolution?: SkillDescriptor['resolution']
  priority?: number
  lastSafeError?: SafeError
}>

/** Host supplied catalogue: Daemon never imports bridges/base to discover Skills. */
export type SkillCatalogAdapter = Readonly<{
  validateRemove?(input: { profile: string; descriptor: SkillDescriptor }): Promise<void>
  remove?(input: { profile: string; descriptor: SkillDescriptor; signal: AbortSignal }): Promise<void>
  refresh(input: {
    profile: string
    rootKey?: string
    workspaceId?: string
    signal: AbortSignal
  }): Promise<readonly SkillCatalogCandidate[] | SkillCatalogRefresh>
  reconcile(input: {
    profile: string
    resources: readonly ResourceDescriptor[]
    signal: AbortSignal
  }): Promise<readonly SkillActualObservation[]>
}>

/** Host owns process/network effects. `test` must never activate, register, or invoke an MCP tool. */
export type McpLifecycleAdapter = Readonly<{
  /** Host-only staging; daemon never resolves the SecretRef contained in definition. */
  stage?(input: {
    definition: McpServerDefinitionInput
    revision: string
    desired: DesiredState
    trust: TrustState
  }): void | Promise<void>
  unstage?(serverId: string): void | Promise<void>
  reconcile(input: {
    profile: string
    serverId: string
    definition: McpServerDefinitionInput
    enabled: boolean
    signal: AbortSignal
  }): Promise<{ status: McpStatus; tools?: McpToolCatalogPage; error?: SafeError }>
  test(input: {
    profile: string
    serverId: string
    definition: McpServerDefinitionInput
    signal: AbortSignal
  }): Promise<{ toolCount: number; catalogRevision: string; error?: SafeError }>
  reconnect(input: {
    profile: string
    serverId: string
    definition: McpServerDefinitionInput
    signal: AbortSignal
  }): Promise<{ status: McpStatus; tools?: McpToolCatalogPage; error?: SafeError }>
  /** Reads the Host's current catalog page only; it neither reconnects nor invokes a tool. */
  tools(input: {
    profile: string
    serverId: string
    cursor?: string
    signal: AbortSignal
  }): Promise<McpToolCatalogPage>
}>
