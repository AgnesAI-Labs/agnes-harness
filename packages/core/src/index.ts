// The model seam is declared in protocol, the one package both sides of it may depend on, and is
// re-exported here so a caller assembling a session against core does not have to reach past core
// for the single interface its step machine calls every step.

export type { Provider } from '@agnes/protocol'
export { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
export { capToMicrocredits, chargeToMicrocredits, conservativeModelCredits } from './child/credits.js'
export type { ChildControlStore } from './child/store.js'
export { hasChildControl, recoverCreatingChildAttempts } from './child/store.js'
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
} from './child/types.js'
export { canTransitionChildState, isTerminalChildState } from './child/types.js'
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
} from './effects/fs-guard.js'
export { platformFacts, platformView } from './effects/platform-facts.js'
export { type RemoteTransport, RemoteTransportClosed } from './effects/remote-transport.js'
export { argvHash } from './effects/runtime.js'
// The model seam itself is re-exported from protocol at the top of this file rather than restated
// here: protocol publishes the interface, and a second declaration would be the one both sides
// disagree with.
export type { BatchCall } from './effects/scheduler.js'
export { scheduleBatch } from './effects/scheduler.js'
export * from './effects/seams.js'
export type {
  ChildHandle,
  ChildrenFactory,
  ChildStatus,
  FsOps,
  ToolContextDeps,
} from './effects/tool-context.js'
export { buildToolContext } from './effects/tool-context.js'
export type {
  HostDispatchObservation,
  HostToolDispatchInput,
  HostToolDispatchPort,
} from './effects/tool-dispatch.js'
export type { SeamFailure } from './effects/wrap.js'
export { SeamRuntime, withTimeout } from './effects/wrap.js'
export { type DispatchContext, HOOK_UNHANDLED, HookEngine, WORKSPACE_HOOK_SANDBOX } from './hooks/engine.js'
export { HookBlockedError } from './hooks/block.js'
export { type SessionHookInputs, SessionHookPort } from './hooks/port.js'
export { defaultIds } from './ids.js'
export { CORE_CHECKS } from './invariants/core-checks.js'
export type { InvariantCheck, Violation } from './invariants/registry.js'
export { InvariantRegistry } from './invariants/registry.js'
export type { CoreDiagName, KernelOptions, SessionOptions } from './kernel.js'
export { CORE_DIAG_NAMES, Kernel, KernelChildren } from './kernel.js'
export type { IntegrityState } from './log/integrity.js'
export {
  INTEGRITY_PAGE_SIZE,
  LEDGER_INTEGRITY_ALGORITHM,
  LedgerIntegrityFailure,
  prepareIntegrity,
  verifyIntegrityRows,
  verifyLedger,
} from './log/integrity.js'
export { MemoryStorage } from './log/memory-storage.js'
export { checkRelations, makeRelationCheck } from './log/relations.js'
export { type ScanRead, scanAll, scanPages } from './log/scan-pages.js'
export type { AppendOptions, OpenLogOptions, Timers } from './log/session-log.js'
export { SessionLogImpl } from './log/session-log.js'
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
} from './log/storage.js'
export { registerKey, SCAN_PAGE_MAX, scanTruncated } from './log/storage.js'
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
export type { ProjectionCacheLine, ProjectionDef, ProjectionSnapshot } from './project/named.js'
export { ProjectionRegistry } from './project/named.js'
export type { RlafDump, RlafRange } from './project/rlaf.js'
export { exportRlaf } from './project/rlaf.js'
export type { SurfaceNode } from './project/surface.js'
export { computeSurface, SurfaceCache, validateReplace } from './project/surface.js'
export type {
  CoreUIProjectionUpdate,
  CoreUITimeline,
  CoreUITimelinePatch,
  SlotFill,
  SlotFillRunner,
  SlotTrigger,
  UIOptions,
  UIProjectionUsageOptions,
} from './project/ui.js'
export { projectUI } from './project/ui.js'
export type { UsageProjectionInput } from './project/usage.js'
export { contextTokensAtCut, projectUsage } from './project/usage.js'
export { foldEvents, initialState, reduce } from './reduce/reducer.js'
export type * from './reduce/shapes.js'
export type { EffectNode, EffectTree, LedgerState, RegisterCell } from './reduce/state.js'
export { effectTree } from './reduce/state.js'
export type { OpenTrackedOptions } from './reduce/tracker.js'
export { openTracked, pendingEffects, StateTracker, verifyRegisters } from './reduce/tracker.js'
export type { RefineLimits } from './refine/apply.js'
export { applyRefine, rollbackRefine } from './refine/apply.js'
export { HookRegistry, type HookSnapshot } from './registry/hooks.js'
export {
  OwnedRegistryTable,
  type PreparedOwnerReplacement,
  prepareOwnerReplacement,
} from './registry/owner-batch.js'
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
export { canonicalJson, sha256Hex, utf8 } from './request/hash.js'
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
export type {
  CheckpointPhase,
  OpStateMeta,
  OpStateObj,
  OpStatePhase,
  ToolCallState,
  ToolsPhase,
} from './step/op-state.js'
export { newOpState, withPhase } from './step/op-state.js'
export type { PresetView } from './step/preset.js'
export { presetDefaults, readPreset } from './step/preset.js'
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
export * from './types.js'
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
} from './workspace/runtime.js'
export { createWorkspaceInvocationPort } from './workspace/runtime.js'
