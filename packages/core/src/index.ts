// The model seam is declared in protocol, the one package both sides of it may depend on, and is
// re-exported here so a caller assembling a session against core does not have to reach past core
// for the single interface its step machine calls every step.

export {
  applyChildAgentConfig,
  assertChildAgentAllowed,
  childAgentAllowlist,
  childAgentRefusal,
  normalizeChildAgentAllowlist,
  resetChildAgentAllowlists,
  setChildAgentAllowlist,
} from '@agnes/core-child-control/child/allowlist'
export {
  capToMicrocredits,
  chargeToMicrocredits,
  conservativeModelCredits,
} from '@agnes/core-child-control/child/credits'
export type { ExternalChildControls } from '@agnes/core-child-control/child/directory'
export {
  externalChild,
  externalChildren,
  trackExternalChild,
  updateExternalChild,
} from '@agnes/core-child-control/child/directory'
export { createChildEventQueue } from '@agnes/core-child-control/child/events'
export type { ChildControlStore } from '@agnes/core-child-control/child/store'
export { hasChildControl, recoverCreatingChildAttempts } from '@agnes/core-child-control/child/store'
export type {
  BeginChildAttemptInput,
  CancelCreatingChildInput,
  CancelledChildFact,
  ChildCreationCasInput,
  ChildCreationPhase,
  ChildTaskRecord,
  CreateDelegatedChildInput,
  CreateDelegatedChildResult,
  DeferCreatingChildInput,
  DeferredChildFact,
  PlannedWorkspace,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  TreeUsage,
} from '@agnes/core-child-control/child/types'
export { canTransitionChildState, isTerminalChildState } from '@agnes/core-child-control/child/types'
export { defaultIds } from '@agnes/core-common/ids'
export {
  type LoopPluginContext,
  LoopRegistry,
  loopKey,
  registerLoopPlugin,
} from '@agnes/core-common/loop/registry'
export { canonicalJson, sha256Hex, utf8 } from '@agnes/core-common/request/hash'
export type {
  CheckpointPhase,
  OpStateMeta,
  OpStateObj,
  OpStatePhase,
  ToolCallState,
  ToolsPhase,
} from '@agnes/core-common/step/op-state'
export { newOpState, withPhase } from '@agnes/core-common/step/op-state'
export type { PresetView } from '@agnes/core-common/step/preset'
export { presetDefaults, readPreset } from '@agnes/core-common/step/preset'
export * from '@agnes/core-common/types'
export {
  assertFsEnforces,
  assertNotDenied,
  decideFsPath,
  enforcementProbes,
  FS_DENIED,
  type FsPathDecision,
  type FsPolicy,
  type FsRule,
  type FsRuleSource,
  isDenial,
  validateFsPolicy,
} from '@agnes/core-effects/effects/fs-guard'
export { platformFacts, platformView } from '@agnes/core-effects/effects/platform-facts'
export { type RemoteTransport, RemoteTransportClosed } from '@agnes/core-effects/effects/remote-transport'
export { argvHash } from '@agnes/core-effects/effects/runtime'
// The model seam itself is re-exported from protocol at the top of this file rather than restated
// here: protocol publishes the interface, and a second declaration would be the one both sides
// disagree with.
export type { BatchCall } from '@agnes/core-effects/effects/scheduler'
export { scheduleBatch } from '@agnes/core-effects/effects/scheduler'
export * from '@agnes/core-effects/effects/seams'
export type {
  ChildHandle,
  ChildrenFactory,
  ChildStatus,
  FsOps,
  ToolContextDeps,
} from '@agnes/core-effects/effects/tool-context'
export { buildToolContext } from '@agnes/core-effects/effects/tool-context'
export type {
  HostDispatchObservation,
  HostToolDispatchInput,
  HostToolDispatchPort,
} from '@agnes/core-effects/effects/tool-dispatch'
export {
  defaultToolPolicy,
  ToolPolicyRegistry,
  ToolRuntimeRegistry,
} from '@agnes/core-effects/effects/tool-providers'
export { defaultToolRuntimeProvider } from '@agnes/core-effects/effects/tool-runtime'
export type { SeamFailure } from '@agnes/core-effects/effects/wrap'
export { SeamRuntime, withTimeout } from '@agnes/core-effects/effects/wrap'
export type {
  ApprovalWorkspaceContext,
  CanonicalWorkspaceId,
  CheckpointWorkspaceContext,
  ChildWorkspaceLifecycle,
  ChildWorkspaceRuntimePort,
  OpaqueSandboxConfine,
  RevocableFsOps,
  SessionWorkspaceLifecycle,
  SessionWorkspaceRuntime,
  WorkspaceHookSandbox,
  WorkspaceInvocationLease,
  WorkspaceInvocationPort,
  WorkspaceInvocationSource,
  WorkspaceInvocationToken,
  WorkspaceInvocationView,
  WorkspacePublicationDispatch,
} from '@agnes/core-effects/workspace/runtime'
export { createWorkspaceInvocationPort } from '@agnes/core-effects/workspace/runtime'
export { CORE_CHECKS } from '@agnes/core-ledger/invariants/core-checks'
export type { InvariantCheck, Violation } from '@agnes/core-ledger/invariants/registry'
export { InvariantRegistry } from '@agnes/core-ledger/invariants/registry'
export type { IntegrityState } from '@agnes/core-ledger/log/integrity'
export {
  INTEGRITY_PAGE_SIZE,
  LEDGER_INTEGRITY_ALGORITHM,
  LedgerIntegrityFailure,
  prepareIntegrity,
  verifyIntegrityRows,
  verifyLedger,
} from '@agnes/core-ledger/log/integrity'
export { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
export { checkRelations, makeRelationCheck } from '@agnes/core-ledger/log/relations'
export { type ScanRead, scanAll, scanPages } from '@agnes/core-ledger/log/scan-pages'
export type { AppendOptions, OpenLogOptions, Timers } from '@agnes/core-ledger/log/session-log'
export { SessionLogImpl } from '@agnes/core-ledger/log/session-log'
// Named rather than `export *`: a star export puts `cacheKey` and `RegisterMap` on the package's
// root surface, and `cacheKey` alone is enough for a consumer to assemble a second register map
// keyed by its own spelling of the composite key. That is the defect RegisterMap was introduced to
// rule out, so the one function that spells a key stays inside the package.
export type {
  CommitTx,
  IntegrityCommit,
  IntegrityMetadata,
  IntegrityMode,
  IntegrityRow,
  IntegrityScanQuery,
  LeaseClaim,
  OpenResult,
  RegisterRow,
  ScanQuery,
  StorageAdapter,
} from '@agnes/core-ledger/log/storage'
export { registerKey, SCAN_PAGE_MAX, scanTruncated } from '@agnes/core-ledger/log/storage'
export type { ProjectionCacheLine, ProjectionDef, ProjectionSnapshot } from '@agnes/core-ledger/project/named'
export { ProjectionRegistry } from '@agnes/core-ledger/project/named'
export type { RlafDump, RlafRange } from '@agnes/core-ledger/project/rlaf'
export { exportRlaf } from '@agnes/core-ledger/project/rlaf'
export type { SurfaceNode } from '@agnes/core-ledger/project/surface'
export { computeSurface, SurfaceCache, validateReplace } from '@agnes/core-ledger/project/surface'
export type {
  CoreUIProjectionUpdate,
  CoreUITimeline,
  CoreUITimelinePatch,
  SlotFill,
  SlotFillRunner,
  SlotTrigger,
  UIOptions,
  UIProjectionUsageOptions,
} from '@agnes/core-ledger/project/ui'
export { projectUI } from '@agnes/core-ledger/project/ui'
export type { UsageProjectionInput } from '@agnes/core-ledger/project/usage'
export { contextTokensAtCut, projectUsage } from '@agnes/core-ledger/project/usage'
export { foldEvents, initialState, reduce } from '@agnes/core-ledger/reduce/reducer'
export type * from '@agnes/core-ledger/reduce/shapes'
export type { EffectNode, EffectTree, LedgerState, RegisterCell } from '@agnes/core-ledger/reduce/state'
export { effectTree } from '@agnes/core-ledger/reduce/state'
export type { OpenTrackedOptions } from '@agnes/core-ledger/reduce/tracker'
export { openTracked, pendingEffects, StateTracker, verifyRegisters } from '@agnes/core-ledger/reduce/tracker'
export {
  OwnedRegistryTable,
  type PreparedOwnerReplacement,
  prepareOwnerReplacement,
} from '@agnes/core-ledger/registry/owner-batch'
export { DEFAULT_LOOP } from '@agnes/extension-api'
export type { Provider } from '@agnes/protocol'
export { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
export { bindChildAgentSession, runLoopChild } from './child/loop-port.js'
export type { InProcessChildBackend, ResidentStart, ResidentTurn } from './child/provider.js'
export {
  IN_PROCESS_CHILD_CAPABILITIES,
  IN_PROCESS_CHILD_PROVIDER_ID,
  inProcessChildAgentProvider,
} from './child/provider.js'
export { bindChildFactory, childBackend, unbindChildFactory } from './child/sessions.js'
export { HookBlockedError } from './hooks/block.js'
export { type DispatchContext, HOOK_UNHANDLED, HookEngine, WORKSPACE_HOOK_SANDBOX } from './hooks/engine.js'
export { type SessionHookInputs, SessionHookPort } from './hooks/port.js'
export type { CoreDiagName, KernelOptions, SessionOptions } from './kernel.js'
export { CORE_DIAG_NAMES, Kernel, KernelChildren } from './kernel.js'
export { LoopEventRegistry } from './loop/events.js'
export {
  AUXILIARY_VISION_MAX_EDGE,
  AUXILIARY_VISION_PURPOSE,
  type AuxiliaryVisionImageLimits,
  type AuxiliaryVisionImageTransform,
  type AuxiliaryVisionOutcome,
  type AuxiliaryVisionPlan,
  AuxiliaryVisionPlanError,
  type AuxiliaryVisionSettlement,
  type AuxiliaryVisionTarget,
  auxiliaryVisionOutcome,
  isPreparedAuxiliaryVisionPlan,
  prepareAuxiliaryVisionPlan,
} from './orchestrator/auxiliary-vision.js'
export { createAuxiliaryVisionEffectPort } from './orchestrator/auxiliary-vision-effect-port.js'
export {
  type AuxiliaryVisionDriver,
  type AuxiliaryVisionDriverResult,
  type AuxiliaryVisionEffectBinding,
  type AuxiliaryVisionEffectPort,
  type AuxiliaryVisionEffectReceipt,
  type AuxiliaryVisionEffectTerminal,
  type AuxiliaryVisionExecutionAuthority,
  AuxiliaryVisionExecutionError,
  type AuxiliaryVisionFinishedEffect,
  type AuxiliaryVisionUsage,
  authorizeAuxiliaryVisionExecution,
  executeAuxiliaryVision,
} from './orchestrator/auxiliary-vision-executor.js'
export { REQUEST_MEDIA_ARTIFACT_RECLAIMED } from './orchestrator/request-media-surface.js'
export type { RefineLimits } from './refine/apply.js'
export { applyRefine, rollbackRefine } from './refine/apply.js'
export { HookRegistry, type HookSnapshot } from './registry/hooks.js'
export { type RegisteredResource, ResourceRegistry } from './registry/resources.js'
export { type RuntimeSlotFill, SlotRegistry } from './registry/slots.js'
export type { ResolvedToolPolicyEnvelope } from './registry/tool-policy.js'
export { resolveValidatedToolCallPolicy } from './registry/tool-policy.js'
export type {
  ExecutionDomain,
  RegisteredTool,
  RegistrySnapshot,
  ToolSource,
  TrustTier,
} from './registry/tools.js'
export { ToolRegistry } from './registry/tools.js'
export type { Conflict, Contribution, Merged, PromptSection } from './request/contribute.js'
export { harnessSections, mergeContributions } from './request/contribute.js'
export type { ContractRef, DeriveInput, DeriveOutput, RequestHeaderData } from './request/derive.js'
export { deriveRequest, headerEquals, sanitize, wrapUntrusted } from './request/derive.js'
export type { EnvelopeCache } from './request/envelope-cache.js'
export { createEnvelopeCache } from './request/envelope-cache.js'
// Only the branded type and its predicate. The minting function and the unbranded body type stay
// inside the package on purpose: exporting the body type would hand every consumer the ingredient
// brand exists to withhold, which is the ability to present a request that was never derived.
export type { LedgerRequest } from './request/mint.js'
export { isLedgerRequest } from './request/mint.js'
export { toProviderRequest } from './request/to-provider.js'
export type { BeforeRequestPatch, ContextResult } from './request/transforms.js'
export {
  ADDITIONAL_CONTEXT_MAX_BYTES,
  applyBeforeRequestPatches,
  applyContextResults,
} from './request/transforms.js'
export type {
  CurrentRuntimeLookup,
  CurrentSessionRuntime,
  RuntimePromptPreload,
  RuntimePromptPreloader,
} from './runtime/current.js'
export type { SessionOverlayPort } from './runtime/overlay.js'
export { approvalDeadlineMs } from './step/approval-callback.js'
export type { BeforeCompactPayload, CompactionPlan, CompactPayload } from './step/compaction.js'
export { CompactionRunner, runCompaction } from './step/compaction.js'
export { budgetPreflight, checkpointRoutine, contextTokens, contextWindowFor, stopGate } from './step/gate.js'
export type { EnqueueMsg } from './step/inbox.js'
export { claimFrom, inboxEvent } from './step/inbox.js'
export { estimateTokens } from './step/inference.js'
export { modelAllowsTool } from './step/model-tools.js'
export type { PreviewDelta, PreviewSnapshot } from './step/preview.js'
export type { CoreOpName } from './step/reentry.js'
export { CORE_OPS, replacementFor, validateReplacements } from './step/reentry.js'
export type {
  ApprovalReplacementInput,
  BeforeCompactHookSelection,
  BudgetReplacementInput,
  BudgetReplacementOutput,
  CompactionPort,
  CoreReplacementInputMap,
  CoreReplacementOutputMap,
  HookPort,
  InboxReplacementInput,
  InboxReplacementOutput,
  InferenceReplacementInput,
  OpContext,
  Operation,
  OperationEffectResult,
  QuietGate,
  ReplacementContext,
  ReplacementOperation,
  SessionDeps,
  SlotOperation,
  StepOutcome,
  StopGateReplacementInput,
  StopGateReplacementOutput,
  ToolExecutionReplacementInput,
  TurnEndReason,
  TurnMemory,
  TurnOutcome,
} from './step/session.js'
export { noCompaction, noopHooks, SessionImpl } from './step/session.js'
export type { ExecOpts, PlannedCall } from './step/tools.js'
export { approveAndExecute, runToolsPhase } from './step/tools.js'
