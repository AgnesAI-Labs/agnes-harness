// jcs is the shared strict RFC 8785 serializer for SDK/daemon signature bytes; it does not replace core request hashing.
export { type ValidatedRequestMedia, validateRequestMedia } from './request-media.js'
export { readSessionTitle, SESSION_TITLE_EVENT, SessionTitleRecord } from './session-title.js'
// ── What belongs on the root export surface ──────────────────────────────────────────────────
// This surface used to have no discernible rule. Only 8 of the 11 event data types were exported
// (missing exactly the three that core needs when writing step/start, step/end and request/header);
// `JsonValue` (the declared type of EventEnvelope['data']), SurfaceOp and ToolCallState were absent;
// and on the agnes-v1 side only 4 helper types made it out while all 9 method params/result types a
// JSON-RPC handler in daemon / sdk / cli has to name were off the surface entirely.
//
// The rule below replaces that, is machine-checkable, and is applied exhaustively.
// test/boundary.test.ts pins it in both directions:
//
//   1. Every runtime export of `src/` (values and functions) is on the root surface. The only
//      exceptions are the test back door `resetMigrations` (see below) and `DATA_DEFS`; assertions
//      pin both as absent from the surface.
//   2. **Every** type generated from our own schema documents (`schema/session-v1.json` /
//      `schema/agnes-v1.json` / `schema/model.json`) is on the root surface — those are the protocol
//      data shapes this package promises to the outside. Adding a `$def` means adding it here too, or
//      boundary.test.ts fails.
//   3. Vendored **ACP types stay off the root surface**: they are an upstream asset and this package
//      does not vouch for their stability. Packages that need them import from the
//      `@agnes/protocol/gen/acp` subpath (`./gen/*` is a public subpath in `package.json`).
//
// De-duplications under rule 2: `JsonValue`, `ContentBlock`, `Actor`, `SurfaceOp` and `EventEnvelope`
// in agnes-v1.json, and `JsonValue` / `ContentBlock` / `ToolCall` in model.json, are cross-file
// aliases pointing at session-v1 (the same definitions), so each is exported once, from session-v1.

export type {
  Ack,
  ApisListParams,
  ApisListResult,
  ApprovalDecideParams,
  ApprovalGrantListParams,
  ApprovalGrantListResult,
  ApprovalGrantRecord,
  ApprovalGrantRevokeParams,
  ArtifactReadParams,
  ArtifactReadResult,
  AttachFilter,
  Auth,
  AuthClaimParams,
  AuthClaimResult,
  CommandAckParams,
  CompactOutcome,
  ComputerUseDoctorParams,
  ComputerUseDoctorResult,
  ComputerUseLockedPackageMutationStatus,
  ComputerUseOperationIdParams,
  ComputerUseOperationResult,
  ComputerUseOperationStartParams,
  ComputerUseOperationStatusParams,
  ComputerUsePermissionsStatusResult,
  ComputerUseStatusResult,
  ConfigAccount,
  ConfigAccountInput,
  ConfigEmptyParams,
  ConfigModel,
  ConfigOAuthInput,
  ConfigOAuthNotice,
  ConfigOAuthPrompt,
  ConfigOAuthResult,
  ConfigProvider,
  ConfigProvidersResult,
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigTestInput,
  ConfigTestResult,
  Cursor,
  DaemonNotice,
  DiagnosticsCollectParams,
  DiagnosticsCollectResult,
  DiagnosticsEventsParams,
  DiagnosticsEventsResult,
  DirectoryUpsertParams,
  DirectoryUpsertResult,
  EffectiveFromResult,
  Empty,
  ErrorData,
  ExtensionAckParams,
  ExtensionCallError,
  ExtensionCallParams,
  ExtensionCallResult,
  ExtUiResponseParams,
  HarnessMeta,
  InitializeMeta,
  JobIdParams,
  JobIdResult,
  NewSessionMeta,
  PageSessionMeta,
  ParticipantListResult,
  ParticipantParams,
  SeqResult,
  SessionArchiveParams,
  SessionAttachParams,
  SessionAttachResult,
  SessionBudgetResult,
  SessionCompactParams,
  SessionEventParams,
  SessionForkParams,
  SessionIdParams,
  SessionListParams,
  SessionMeta,
  SessionPreferences,
  SessionPreviewParams,
  SessionProjectUIHistoryParams,
  SessionProjectUIOpeningParams,
  SessionProjectUIParams,
  SessionProjectUIPatchParams,
  SessionRenameParams,
  SessionSetModelParams,
  SessionSetPresetParams,
  SessionSetYoloParams,
  SessionSteerParams,
  SessionSteerResult,
  SlotFillView,
  SubmitParams,
  SurfacesMountsParams,
  SurfacesMountsResult,
  UIHistoryCursor,
  UIHistoryInfo,
  UIHistoryPage,
  UINode,
  UIOpeningResult,
  UIOperationState,
  UIProjectionNodeChange,
  UIProjectionTurnChange,
  UIProjectionUpdate,
  UISpan,
  UITimeline,
  UITimelinePatch,
  UITurn,
  UITurnCall,
  UITurnUsage,
  UsageView,
  WorkspaceAddParams,
  WorkspaceAddResult,
  WorkspaceEntry,
  WorkspaceListParams,
  WorkspaceListResult,
} from '../gen/ts/agnes-v1.js'
export type { Action, Decision, RowScope, Target } from '../gen/ts/authz.js'
export type { BridgeMethod, BridgeRequest, BridgeResponse, ToolsInvokeParams } from '../gen/ts/bridge.js'
export type {
  ApprovalAction,
  ChannelCapabilities,
  ChannelCredential,
  ChannelManifest,
  Credential,
  DirectoryEntry,
  JwtCredential,
  LocalCredential,
  PortalIdentityCredential,
  SourceAuthCredential,
  SurfaceAuthCredential,
} from '../gen/ts/channel.js'
export type { DeployManifest } from '../gen/ts/deploy-manifest.js'
export type {
  Capabilities,
  ClientContribution,
  ExtensionManifest,
  SkinContribution,
  SkinTokenValue,
} from '../gen/ts/extension-manifest.js'
export type { ServiceCapability } from '../gen/ts/extension-service.js'
export type { JobSpec, JobStatus, Schedule } from '../gen/ts/jobs.js'
export type { Lockfile, PackageLock } from '../gen/ts/lockfile.js'
export type {
  AiErrorCode,
  ContractManifest,
  ContractStamp,
  CountResult,
  DecodeRule,
  InferenceEvent,
  ModelCost,
  ModelRecord,
  ProbeReport,
  RequestBody,
  RequestMessage,
  RouteDecl,
  RouteTable,
  RouteTarget,
  Sha256,
  SlotName,
  ThinkingLevel,
  Timing,
  TokenCounts,
  ToolSchema,
} from '../gen/ts/model.js'
export type {
  ClientModuleEffectCallParams,
  ClientModuleListResult,
  ClientModuleReadParams,
  ClientModuleReadResult,
  ClientModuleRosterRow,
  ClientModuleServiceCallParams,
  PackageActivationRequest,
  PackageActivationTrust,
  PackageAdminContext,
  PackageAdminError,
  PackageAdminPermission,
  PackageBlocker,
  PackageCapabilityDiff,
  PackageCatalogDescriptor,
  PackageCatalogGetParams,
  PackageCatalogListParams,
  PackageCatalogPage,
  PackageContributionSummary,
  PackageDisableParams,
  PackageEnableParams,
  PackageInspectParams,
  PackageInstalledDescriptor,
  PackageInstallParams,
  PackageListParams,
  PackageListResult,
  PackageOperation,
  PackageOperationCancelParams,
  PackageOperationGetParams,
  PackageOperationReceipt,
  PackagePinsInspectParams,
  PackagePinsInspectResult,
  PackagePinsReleaseParams,
  PackagePinsReleaseResult,
  PackagePreview,
  PackageProvenance,
  PackageRemoveParams,
  PackageRollbackParams,
  PackageRollbackTarget,
  PackageSource,
  PackageTrustDecision,
  PackageTrustParams,
  PackageTrustWorkspaceParams,
  PackageTrustWorkspaceResult,
  PackageUntrustParams,
  PackageUpdateParams,
  PackageWarning,
  PluginTreeApplyParams,
  PluginTreeApplyResult,
  PluginTreeArtifact,
  PluginTreeRollbackParams,
  PluginTreeRollbackResult,
  PluginTreeView,
  RuntimePinDescriptor,
  RuntimePinReleaseResult,
  SkinListResult,
  SkinReadParams,
  SkinReadResult,
} from '../gen/ts/package-admin.js'
export type { PresetDoc } from '../gen/ts/preset.js'
export type {
  ApprovalMode,
  ApprovalProfile,
  Capability,
  CommandHookGrant,
  CommandHooksPolicy,
  ComputerUseAppIdentity,
  ComputerUseCapturePolicy,
  ComputerUseProfile,
  ComputerUseRestriction,
  ComputerUseRetentionPolicy,
  ExtensionIsolationPolicy,
  ExtensionIsolationRequest,
  ManagedPolicy,
  PackageRef,
  Policy,
  ProfileFragment,
  ReconcilePoint,
  ReconcilePolicy,
  ResolvedComputerUseProfile,
  ResolvedProfile,
  RuntimeProfileManifest,
  SeamName,
  SecretRef,
  Transport,
} from '../gen/ts/profile.js'
export type { ProjectionCapability, ProjectionReadResult } from '../gen/ts/projection.js'
export type {
  ActualState,
  ClientId,
  CommandId,
  DesiredState,
  McpEnvName,
  McpHttpSecretBinding,
  McpHttpTransport,
  McpInputSchema,
  McpOAuthSecretBinding,
  McpOAuthStatusResult,
  McpOAuthStatusSetParams,
  McpSecretBinding,
  McpServerCreateParams,
  McpServerDefinitionInput,
  McpServerDescriptor,
  McpServerDisableParams,
  McpServerEnableParams,
  McpServerGetParams,
  McpServerListParams,
  McpServerListResult,
  McpServerReconnectParams,
  McpServerRemoveParams,
  McpServerTestParams,
  McpServerUpdateParams,
  McpSseTransport,
  McpStatus,
  McpStdioSecretBinding,
  McpStdioTransport,
  McpTool,
  McpToolCatalogPage,
  McpToolPolicy,
  McpToolsListParams,
  McpTrustSetParams,
  ProfileId,
  ResourceDescriptor,
  ResourceDesiredSetParams,
  ResourceGetParams,
  ResourceId,
  ResourceListParams,
  ResourceListResult,
  ResourceOperation,
  ResourceOperationCancelParams,
  ResourceOperationGetParams,
  ResourceOperationReceipt,
  ResourcePermission,
  Revision,
  SafeError,
  ServerId,
  SkillDescriptor,
  SkillPrioritySetParams,
  SkillRefreshParams,
  SkillRemoveParams,
  SkillResolution,
  SkillRootDiagnostic,
  SkillRootKey,
  SkillRootStatus,
  SkillSourceIdentity,
  SkillTrustSetParams,
  SourceScope,
  TrustState,
  WorkspaceId,
} from '../gen/ts/resource-control.js'
export type {
  Actor,
  ApprovalAsked,
  ApprovalDecided,
  ApprovalGrant,
  ApprovalGuardianDecision,
  ArtifactJob,
  ArtifactRef,
  AssistantMessage,
  AssistantOutput,
  Billing,
  BudgetState,
  ContentBlock,
  CostLedger,
  DispatchPhase,
  EffectIntent,
  EffectSettled,
  EventEnvelope,
  ExecutionDomain,
  FeedbackImplicit,
  FeedbackRating,
  FormatDeviation,
  HarnessEntry,
  HarnessEntryValue,
  HarnessRefine,
  Inbox,
  InboxItem,
  JsonValue,
  OpState,
  Participant,
  PlanItems,
  RepairDecision,
  RequestHeader,
  RequestMediaHeader,
  RequestMediaManifest,
  RequestMediaManifestEntry,
  RequestSent,
  ResolvedToolCallPolicy,
  SessionStart,
  StepEnd,
  StepStart,
  SubagentCost,
  SurfaceOp,
  ToolCall,
  ToolCallState,
  ToolResult,
  TurnEnd,
  TurnStart,
  UserMessage,
  Verdict,
  VerifierSignal,
} from '../gen/ts/session-v1.js'
export type {
  SurfaceArtifact,
  SurfaceConfigValue,
  SurfaceDescriptor,
  SurfaceInstance,
  SurfacePackageMetadata,
  SurfaceServiceGrant,
} from '../gen/ts/surface.js'
// Same for validate.js: `DATA_DEFS` (11 generated TypeBox schemas) is validateEvent's internal
// lookup table, not part of the protocol surface this package promises to the outside.
export type { ParametersSchema, ToolDef, ToolMeta } from '../gen/ts/tooldef.js'
export type {
  RuntimeApplyFailedFrame,
  RuntimeBootReadyFrame,
  RuntimeConvergedFrame,
  RuntimeConvergenceReport,
  RuntimeConvergenceRow,
  RuntimeStaleFrame,
  RuntimeTargetArtifact,
  RuntimeTargetIdentity,
  WorkerGeneration,
} from '../gen/ts/worker.js'
export * from './codec/permission.js'
export * from './codec/stop-reason.js'
export * from './configs.js'
export * from './constants.js'
export * from './errors.js'
export * from './hooks.js'
export { jcs } from './jcs.js'
export { DEFAULT_JSON_DATA_MAX_BYTES, inspectJsonData } from './json-data.js'
export * from './meta.js'
export * from './methods.js'
// migrate.js is re-exported by name:
//   - `register` / `supported` are extremely generic names and read ambiguously from core / host:
//     extension-api's API surface is four `register*` functions, so a bare `register` imported from
//     another package gets read as "register an extension". They were renamed to
//     `registerMigration` / `supportedVersions` — the functions themselves were renamed rather than
//     aliased here, so two names for the same thing never coexist.
//   - `resetMigrations()` clears a module-level global Map and is a test back door. Leaving it on the
//     root surface would mean **any package could wipe the process-wide migration registry with one
//     runtime call** — considerably riskier than the read-only lookup table `DATA_DEFS` that was
//     taken off the surface. Same treatment: not on the root export; tests that need it import
//     './migrate.js' directly.
export { CURRENT_V, listMigrations, normalize, registerMigration, supportedVersions } from './migrate.js'
export * from './model.js'
export * from './package-admin.js'
export { validateProjectionCapability, validateProjectionReadResult } from './projections.js'
export * from './provider.js'
export * from './resource-control.js'
export * from './runtime-target-artifact.js'
export * from './sequence.js'
export { validateExtensionCall, validateExtensionCallError, validateServiceCapability } from './services.js'
export * from './slots.js'
export * from './surfaces.js'
export type { ValidationError, ValidationResult } from './validate.js'
export {
  isDateTime,
  toRpcError,
  validateAgainst,
  validateEvent,
  validateOpState,
  validateToolDef,
} from './validate.js'
export * from './worker-generation.js'
