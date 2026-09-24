import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { approvalPolicy } from '../extensions/approval-policy/src/seam.js'
import { artifactsLocal } from '../extensions/artifacts-local/src/seam.js'
import { budgetLedger } from '../extensions/budget/src/seam.js'
import { fsCheckpoint } from '../extensions/fs-checkpoint/src/seam.js'
import { repairPolicy, verifierT0 } from '../extensions/loop-hygiene/src/seam.js'
import { principalsLocal } from '../extensions/principals-local/src/seam.js'
import { refineOperation } from '../extensions/refine/src/operation.js'
import { RefineQueue } from '../extensions/refine/src/queue.js'
import { refineHarness } from '../extensions/refine/src/seam.js'
import { sandboxSeam } from '../extensions/sandbox/src/seam.js'
import type { SeamInitContext } from './seam-init.js'

/** Replaced with the reviewed package asset by the CLI SEA build. */
declare const AGNES_BASE_PRESET_TEXT: string | undefined

/** One preset document: a mapping that names itself, and optionally names the one it extends. */
export type PresetDoc = Record<string, unknown> & { name: string; extends?: string }

/**
 * Parses one document and checks it declares the name it was filed under. A file saying something
 * else would be loadable under two names and win silently under the wrong one.
 */
export function parsePreset(text: string, name: string): PresetDoc {
  const doc: unknown = parse(text)
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    throw new Error(`preset ${name}.yaml is not a mapping`)
  const asDoc = doc as PresetDoc
  if (asDoc.name !== name) throw new Error(`preset ${name}.yaml declares name=${String(asDoc.name)}`)
  return asDoc
}

export const PACKAGE_NAME = '@agnes/base' as const

export {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactGcExecutionPrerequisite,
  type ArtifactGcFiveSourceSnapshot,
  type ArtifactGcHostCandidate,
  type ArtifactGcPlan,
  type ArtifactGcReachabilitySnapshotIdentity,
  type ArtifactGcRootOwner,
  type ArtifactGcRootOwnerSnapshot,
  type ArtifactGcScheduler,
  type ArtifactReachabilityInput,
  type ArtifactRetentionGcPlan,
  type ArtifactRoot,
  type ArtifactRootSnapshot,
  type ArtifactRootSource,
  artifactStorePath,
  createArtifactGcScheduler,
  planArtifactGc,
  planRetainedArtifactGc,
  type RetainedArtifactCandidate,
  type StoredArtifactCandidate,
} from '@agnes/core/artifacts'
export { prepareArtifactGcExecutionPrerequisite } from '../extensions/artifacts-local/src/gc-execution-prerequisite.js'
export {
  type ArtifactGcExecutionLease,
  type ArtifactGcExecutionPermit,
  type ArtifactGcExecutionResult,
  type ArtifactGcPhysicalDelete,
  authorizeLinuxArtifactGcExecution,
  authorizeMacOSArtifactGcExecution,
  authorizeWindowsArtifactGcExecution,
  executeArtifactGc,
} from '../extensions/artifacts-local/src/gc-executor.js'
export { collectArtifactGcFiveSourceSnapshot } from '../extensions/artifacts-local/src/gc-snapshot.js'
export {
  createRecentArtifactMetadataIndex,
  type RecentArtifactMetadataIndex,
  type RecentArtifactMetadataSnapshot,
} from '../extensions/artifacts-local/src/recent-metadata.js'
export { buildCompactionPlan } from '../extensions/compaction/src/plan.js'
export { toolDescribeTool, toolSearchTool } from '../extensions/mcp-search/src/search-tools.js'
export {
  type McpCatalogHub,
  type McpCatalogHubContext,
  mcpCatalogHubFor,
} from '../extensions/mcp-server/src/catalog-hub.js'
export { type McpServerExtensionDeps, mcpServerExtension } from '../extensions/mcp-server/src/extension.js'
export { type McpServerOpener, mcpServerConfigFromDefinition } from '../extensions/mcp-server/src/opener.js'
export {
  type ConnectionStatusEvent,
  RECONNECT_DEFAULTS as MCP_RECONNECT_DEFAULTS,
  type ReconnectPolicy as McpReconnectPolicy,
} from '../extensions/mcp-server/src/supervisor.js'
export {
  allowsContent,
  allowsUpload,
  CONSENT_LEVELS,
  type ConsentLevel,
  changeConsent,
  createPrivacyExtension,
  createSessionEgressGate,
  EgressCommitError,
  privacyExtension,
  recordEgress,
  sessionEgressAuthority,
  transitionConsent,
} from '../extensions/privacy/src/index.js'
export {
  type ProbedSandboxWorkspace,
  type SandboxWorkspaceProbeInput,
  sandboxWorkspaceProbe,
} from '../extensions/sandbox/src/workspace-probe.js'
// Skill discovery is a pure, bounded parser used by the worker resource bridge. Keeping this
// public Base seam prevents daemon composition from reimplementing file limits/frontmatter rules.
export {
  discoverPackageSkill,
  discoverSkillRoot,
  locateSkillEntry,
  type SkillCandidate as DiscoveredSkillCandidate,
  type SkillFile,
  type SkillFileKind,
  type SkillFs,
  type SkillRoot,
  type SkillRootDir,
  type SkillRootFailure,
  type SkippedSkillEntry,
  skillResourceIdAt,
  skillRoots,
  workspaceSkillKey,
} from '../extensions/skills/src/discover.js'
// The tools each bundled extension defines, for anything that needs the definitions themselves
// rather than the registry the extension host fills from them - the schema snapshot generator, a
// preset test that checks this package's full tool surface against what it actually ships, and the
// sandbox implementation that has to know what the shell tool's argv placeholder is. Which
// extensions this package ships is declared once, in the `agnes.extensions` field of its
// package.json, which is what the host reads off disk; it is deliberately not restated here.
export {
  subagentCollectTool,
  subagentForkTool,
  subagentSpawnTool,
} from '../extensions/subagent/src/index.js'
export { SHELL_SENTINEL, TOOLS_CORE } from '../extensions/tools-core/src/index.js'
export { TOOLS_SEARCH } from '../extensions/tools-search/src/index.js'
export { TOOLS_WEB } from '../extensions/tools-web/src/index.js'
export {
  type ActivationRecord as ComputerUseActivationRecord,
  activateLockedPackage,
  canonicalLockedPackagePayload,
  confirmLockedPackageLkg,
  type LockedPackageEnvironment,
  type LockedPackageManifest,
  type LockedPackageMutationKind,
  type LockedPackageOperation,
  type LockedPackageOperationHistory,
  type LockedPackageOperationReceipt,
  type LockedPackageOperationReceiptPort,
  type LockedPackageOperationReconciliation,
  type LockedPackageSignatureVerifier,
  parseLockedPackageManifest,
  reconcileLockedPackageOperation,
  rollbackLockedPackage,
  type SignatureEvidence as ComputerUseSignatureEvidence,
} from './computer-use/locked-package.js'
export {
  type ImmutableLockedPackageBytes,
  type ValidatedLockedPackageArchive,
  type ValidatedLockedPackageFile,
  validateLockedPackageArchive,
} from './computer-use/locked-package-archive.js'
export {
  approvalPlugin,
  artifactsPlugin,
  checkpointPlugin,
  harnessPlugin,
  ledgerPlugin,
  principalsPlugin,
  repairPlugin,
  verifierPlugin,
} from './cordis-seams.js'
export {
  createEcosystemExtensions,
  ecosystem,
  type HooksRunnerEcosystemDeps,
  readSubagentLimits,
} from './ecosystem.js'
export { isolatedEcosystem } from './hooks-isolation.js'
export { catalogInfoOf, type McpCatalogInfo } from './mcp/catalog-info.js'
export type { McpServerConfig } from './mcp/config.js'
export { connectMcp, type McpSdkDeps } from './mcp/connect.js'
export {
  SqliteToolIndex,
  type ToolIndex,
  type ToolIndexHit,
  type ToolIndexReader,
  type ToolIndexRow,
} from './mcp/index-table.js'
export { mcpLocalToolPrefix } from './mcp/naming.js'
export {
  inspectRemoteCatalog,
  type McpConnection,
  type McpRemoteTool,
  registerRemoteToolsStrict,
  validateRemoteCatalog,
} from './mcp/register.js'

export type {
  HostExec,
  HostExecResult,
  HostFs,
  Prompter,
  SandboxBackendReport,
  SandboxExecBinding,
  SandboxGateState,
  SandboxHostServices,
  SeamAdaptersView,
  SeamFactory,
  SeamInitContext,
  SeamProfileView,
  TableHandle,
} from './seam-init.js'

/**
 * The seam implementations this package delivers, by seam name. The host reads this named export at
 * assembly and fits each one; a name absent here is a name the profile cannot point at this package
 * for, which is a startup refusal rather than a seam that turns out to be missing later. The
 * remaining seven arrive with the pieces that implement them.
 */
export const seams = {
  approval: approvalPolicy,
  principals: principalsLocal,
  artifacts: artifactsLocal,
  checkpoint: fsCheckpoint,
  ledger: budgetLedger,
  verifier: verifierT0,
  repair: repairPolicy,
  harness: refineHarness,
  sandbox: sandboxSeam,
} as const

/** Host operation factories consume the same durable queue as the fitted harness and tool. */
export const operations = {
  refine: (deps: Pick<SeamInitContext, 'adapters' | 'profile'>) =>
    refineOperation({
      queue: new RefineQueue(deps.adapters.storage.table('refine_queue')),
      preset: deps.profile.preset,
    }),
} as const

/**
 * The preset documents this package delivers, by name. `base` is the root every shipped recipe
 * extends; a product package's recipe names it in `extends` and adds the product's own opinion.
 *
 * The file is read here rather than restated as an object literal, because the YAML is what an
 * operator reads and edits, and a second spelling in TypeScript would be the one that drifts. This
 * is an assembly-time read of a file inside the installed package - not a workspace file, which is
 * what a tool's ToolContext exists to fence.
 */
export const presets: Record<string, PresetDoc> = {
  base: parsePreset(
    typeof AGNES_BASE_PRESET_TEXT === 'undefined'
      ? readFileSync(new URL('../presets/base.yaml', import.meta.url), 'utf8')
      : AGNES_BASE_PRESET_TEXT,
    'base',
  ),
}
