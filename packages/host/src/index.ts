export const PACKAGE_NAME = '@agnes/host' as const

// Ledger paging for the packages that reach core only through host.
export {
  projectFactChain,
  REQUEST_MEDIA_ARTIFACT_RECLAIMED,
  SCAN_PAGE_MAX,
  type ScanRead,
  scanAll,
  scanPages,
} from '@agnes/core'
export {
  ARTIFACT_RECLAIMED_FAILURE,
  createLocalArtifactReadStore,
  type LocalArtifactReadStore,
} from '@agnes/host-artifacts/artifact-read-store'
export {
  type ComputerUseArtifactGcRun,
  type ComputerUseArtifactGcRuntime,
  createComputerUseArtifactGcRuntime,
} from '@agnes/host-artifacts/computer-use-artifact-gc'
export {
  composeProductionRequestMedia,
  createProductionImageInputTokenFallback,
  type ProductionRequestMediaConfiguration,
} from '@agnes/host-artifacts/request-media-runtime'
export {
  installProviderRegistry,
  installProviders,
  ProviderRegistry,
  ProvidersService,
} from '@agnes/host-common/assemble/provider-registry'
export * from '@agnes/host-common/command-policy'
export * from '@agnes/host-common/errors'
export { initializeHome } from '@agnes/host-common/home-initialize'
export {
  HOME_LAYOUT_VERSION,
  homeLayout,
  inspectHome,
} from '@agnes/host-common/home-layout'
export {
  defaultVerifyIntegrity,
  type LockAudit,
  lockState,
  snapshotPolicy,
  verifyLockIntegrity,
} from '@agnes/host-common/packages/lock-state'
export {
  emptyLock,
  type LockEntry,
  type Lockfile,
  lockPath,
  readLock,
  withLock,
  writeLock,
} from '@agnes/host-common/packages/lockfile'
export {
  createPackageManager,
  type ManagerOptions,
  type PackageManager,
  type PackageStatus,
  readManifestIn,
} from '@agnes/host-common/packages/manager'
export {
  type ExecFn,
  type FetchedSource,
  fetchSource,
  hashDirectory,
  type PackageSource,
  packageDir,
  parseSource,
} from '@agnes/host-common/packages/sources'
export {
  isDangerous,
  LICENSE_ALLOWLIST,
  manifestCapabilities,
  runTrustGate,
  verifyInstalledIntegrity,
} from '@agnes/host-common/packages/trust-gate'
export {
  hashWorkspace,
  readDeployManifest,
  readProfileFragment,
  verifyWorkspace,
  type WorkspaceVerification,
} from '@agnes/host-common/packages/workspace'
export {
  agnesHome,
  cacheDir,
  dataDir,
  fileSecretsDir,
  hasLegacySessionsDb,
  inDataDir,
  legacySessionsDbPath,
  ownStateRoots,
} from '@agnes/host-common/paths'
export * from '@agnes/host-common/presets/index'
export { canonicalJson, sha256hex } from '@agnes/host-common/profile/canonical'
export * from '@agnes/host-common/profile/composition'
export { DEFAULT_COMPUTER_USE } from '@agnes/host-common/profile/computer-use'
export { expandHome, hashInput, mergePackages, resolveProfile } from '@agnes/host-common/profile/resolve'
export {
  assertNoReservedRouteName,
  BUILTIN_PACKAGES,
  checkTemplateShape,
  loadTemplate,
  RESERVED_ROUTE_NAMES,
  TEMPLATE_NAMES,
} from '@agnes/host-common/profile/templates'
export type * from '@agnes/host-common/profile/types'
export * from '@agnes/host-common/publication-dispatch'
export {
  type PublicationCloseOptions,
  PublicationGate,
  type PublicationReadTicket,
} from '@agnes/host-common/publication-gate'
export * from '@agnes/host-common/quiet-state'
export {
  type AuthenticatedWorkspaceBindingEnvelope,
  CliWorkspaceAuthority,
  type WorkspaceBinding,
} from '@agnes/host-common/workspace-authority'
export * from '@agnes/host-common/workspace-policy'
export {
  type ComputerUseAppAdmissionDecision,
  type ComputerUseResolvedAppIdentity,
  evaluateComputerUseAppAdmission,
} from '@agnes/host-computer-use/computer-use/app-admission'
export {
  type ComputerUseDriverArchitecture,
  type ComputerUseDriverLock,
  type ComputerUseDriverPlatform,
  computerUseDriverLockSchema,
  type DriverAdmissionDecision,
  type DriverAdmissionEvidence,
  type DriverLockInspection,
  evaluateComputerUseDriverAdmission,
  evaluateComputerUsePlatformAdmission,
  evaluateFixedComputerUseDriverAdmission,
  evaluateFixedComputerUsePlatformAdmission,
  inspectComputerUseDriverLock,
  inspectFixedComputerUseDriverLock,
} from '@agnes/host-computer-use/computer-use/driver-lock'
export { createSqliteComputerUseEffectStore } from '@agnes/host-computer-use/computer-use/effect-store-sqlite'
export {
  type ComputerUseAttempt,
  type ComputerUseAttemptDecision,
  type ComputerUseAuthorityResolver,
  type ComputerUseAuthorization,
  type ComputerUseDeliveryMode,
  type ComputerUseDispatchFailure,
  type ComputerUseEffectBinding,
  type ComputerUseEffectStore,
  type ComputerUseEnforcementRequest,
  type ComputerUseEnforcementResult,
  type ComputerUseHostAuthority,
  type ComputerUseHostEnforcer,
  type ComputerUseMutationClaimDecision,
  type ComputerUsePermissionMode,
  type ComputerUsePolicyDecision,
  createComputerUseHostEnforcer,
  evaluateComputerUseAttempt,
  evaluateComputerUseHostPolicy,
  evaluateComputerUseMutationClaim,
} from '@agnes/host-computer-use/computer-use/host-enforcement'
export {
  activateExtractedLinuxComputerUseDriver,
  type ExtractedLinuxComputerUseDriver,
  extractLockedLinuxComputerUseDriver,
  type LinuxDriverArchiveDependencies,
} from '@agnes/host-computer-use/computer-use/linux-driver-archive'
export {
  createLinuxComputerUseBackendProvider,
  createLinuxComputerUseSessionRuntime,
  inspectLinuxComputerUseSession,
  type LinuxComputerUseBackendDependencies,
  type LinuxComputerUseSession,
  type VerifiedLinuxComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/linux-driver-backend'
export { downloadLockedLinuxComputerUseDriver } from '@agnes/host-computer-use/computer-use/linux-driver-download'
export {
  doctorLockedLinuxComputerUseDriver,
  installOrUpdateLockedLinuxComputerUseDriver,
  type LinuxComputerUseDriverInstallDependencies,
  type LinuxComputerUseDriverInstallResult,
  type LinuxComputerUseDriverRecord,
  type LinuxComputerUseDriverState,
  probeLinuxComputerUseDriverHealth,
  readLinuxComputerUseDriverState,
} from '@agnes/host-computer-use/computer-use/linux-driver-install'
export {
  type LinuxDriverVerifierDependencies,
  verifyLinuxComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/linux-driver-verifier'
export {
  type LinuxDesktopAppIdentity,
  type LinuxLiveAppIdentity,
  linuxDesktopAppIdentitySync,
  linuxLiveAppIdentitySync,
} from '@agnes/host-computer-use/computer-use/linux-live-app-identity'
export {
  createHostLockedPackageMutationRuntime,
  type HostLockedPackageMutationBlocker,
  type HostLockedPackageMutationEngine,
  type HostLockedPackageMutationOptions,
  type HostLockedPackageMutationRuntime,
  type HostLockedPackageMutationSession,
  type HostLockedPackageMutationStatus,
  type HostLockedPackageSafeExtractor,
  type HostLockedPackageSignatureVerifier,
} from '@agnes/host-computer-use/computer-use/locked-package-mutation-runtime'
export {
  createMetadataLockedPackageOperationReceiptPort,
  createSqliteLockedPackageOperationReceiptPort,
  type HostLockedPackageActivationRecord,
  type HostLockedPackageMutationKind,
  type HostLockedPackageOperationReceipt,
  type HostLockedPackageOperationReceiptPort,
} from '@agnes/host-computer-use/computer-use/locked-package-receipts-sqlite'
export {
  activateExtractedMacOSComputerUseDriver,
  type ExtractedMacOSComputerUseDriver,
  extractLockedMacOSComputerUseDriver,
  type MacOSDriverArchiveDependencies,
} from '@agnes/host-computer-use/computer-use/macos-driver-archive'
export {
  createMacOSComputerUseBackendProvider,
  createMacOSComputerUseSessionRuntime,
  grantMacOSComputerUsePermissions,
  type MacOSComputerUseBackendDependencies,
  type MacOSComputerUsePermissionStatus,
  probeMacOSComputerUsePermissions,
  type VerifiedMacOSComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/macos-driver-backend'
export { downloadLockedMacOSComputerUseDriver } from '@agnes/host-computer-use/computer-use/macos-driver-download'
export {
  installOrUpdateLockedMacOSComputerUseDriver,
  type MacOSComputerUseDriverInstallDependencies,
  type MacOSComputerUseDriverInstallResult,
  type MacOSComputerUseDriverRecord,
  type MacOSComputerUseDriverState,
  readMacOSComputerUseDriverState,
} from '@agnes/host-computer-use/computer-use/macos-driver-install'
export {
  type MacOSDriverVerifierDependencies,
  verifyMacOSComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/macos-driver-verifier'
export {
  type MacOSLiveAppIdentity,
  macosLiveAppIdentitySync,
  parseMacOSLiveAppIdentity,
} from '@agnes/host-computer-use/computer-use/macos-live-app-identity'
export {
  type ComputerUseRescueAction,
  type ComputerUseRescueReport,
  runComputerUseRescue,
} from '@agnes/host-computer-use/computer-use/rescue'
export {
  activateExtractedWindowsComputerUseDriver,
  type ExtractedWindowsComputerUseDriver,
  extractLockedWindowsComputerUseDriver,
  type ValidatedWindowsDriverArchiveFile,
  validateLockedWindowsComputerUseDriverArchive,
} from '@agnes/host-computer-use/computer-use/windows-driver-archive'
export {
  type ComputerUseBackendDependencies,
  type ComputerUseBackendProvider,
  type ComputerUseLiveProcessIdentity,
  createComputerUseBackendProvider,
  createWindowsComputerUseBackendProvider,
  type WindowsComputerUseArtifactSink,
  type WindowsComputerUseBackendDependencies,
  type WindowsComputerUseBackendProvider,
} from '@agnes/host-computer-use/computer-use/windows-driver-backend'
export {
  type ComputerUseDownloadResponse,
  type ComputerUseDownloadTransport,
  downloadLockedWindowsComputerUseDriver,
} from '@agnes/host-computer-use/computer-use/windows-driver-download'
export {
  installOrUpdateLockedWindowsComputerUseDriver,
  readWindowsComputerUseDriverState,
  recoverLockedWindowsComputerUseDriver,
  type WindowsComputerUseDriverInstallDependencies,
  type WindowsComputerUseDriverInstallResult,
  type WindowsComputerUseDriverRecord,
  type WindowsComputerUseDriverRecoveryResult,
  type WindowsComputerUseDriverState,
} from '@agnes/host-computer-use/computer-use/windows-driver-install'
export {
  type VerifiedWindowsComputerUseDriver,
  verifyWindowsComputerUseDriver,
  type WindowsDriverVerifierDependencies,
} from '@agnes/host-computer-use/computer-use/windows-driver-verifier'
// MCP-ROWS stage 2b step 3 prep: worker-runtime needs this to build the rows `Assembled['extensionRows']`
// takes (`prepare({..., dynamic})`) without reaching into Host's internal assemble/ directory.
export type { DynamicExtension } from '@agnes/host-extensions/assemble/ext-rows'
export * from '@agnes/host-extensions/assemble/packages'
export type { HostPluginTreeBase } from '@agnes/host-extensions/assemble/seams-cordis'
export type { DeploymentPolicy, ResolvedDeployment } from '@agnes/host-extensions/deploy/index'
export { resolveDeployment } from '@agnes/host-extensions/deploy/index'
export {
  type ActivationBarrierSnapshot,
  ActivationInProgressError,
  type ActivationInvocation,
  ActivationInvocationCancelledError,
  type ActivationInvocationKind,
  type ActivationPermit,
  ActivationTimeoutError,
  createExtensionActivationBarrier,
  type ExtensionActivationBarrier,
  type QueuedActivationInvocation,
} from '@agnes/host-extensions/ext-host/activation-barrier'
export type {
  ExtensionIsolationMode,
  ExtensionIsolationOptions,
} from '@agnes/host-extensions/ext-host/hooks-isolation-assembly'
export {
  buildExtensionApi,
  checkApiRange,
  createLoader,
  createManagedExtHost,
  type ExtensionManifest,
  type ExtensionSpec,
  type ExtensionStatus,
  MANIFEST_FILE,
  readBundledExtensionDirs,
  readExtensionManifest,
  resolveEntry,
  type ToolAuthority,
  type ToolPort,
} from '@agnes/host-extensions/ext-host/index'
export {
  isServicePreDispatchFailure,
  type ServiceAuthority,
  type ServiceEffectAdmission,
  type ServiceInspection,
} from '@agnes/host-extensions/ext-host/service-invocation'
export * from '@agnes/host-extensions/resources/index'
export type { McpManageBridge, McpManageInvocation } from '@agnes/host-extensions/resources/mcp-manage-port'
export type {
  PluginManageBridge,
  PluginManageInvocation,
} from '@agnes/host-extensions/resources/plugin-manage-port'
export {
  createSkillInstaller,
  type SkillInstallAuthority,
} from '@agnes/host-extensions/resources/skill-install'
export { validInstallPathPolicy } from '@agnes/host-extensions/resources/skill-install-files'
export type {
  SkillInstallBridge,
  SkillInstallInvocation,
} from '@agnes/host-extensions/resources/skill-install-port'
export {
  type CredentialFileEnforcement,
  type CredentialKind,
  CredentialStoreError,
  type CredentialStoreReason,
  credentialFileEnforcement,
} from '@agnes/host-infrastructure/adapters/credential-files'
export {
  type ApiKeyCredentialV1,
  type CodexCredentialV2,
  type CreateCredentialStoreOptions,
  type CredentialStore,
  type CredentialWriter,
  createCredentialStore,
  type OAuthCredential,
  type OAuthCredentialV1,
  type StoredCredential,
  type StoredCredentialV1,
  type SubscriptionCredentialV2,
} from '@agnes/host-infrastructure/adapters/credential-store'
export { DDL } from '@agnes/host-infrastructure/adapters/ddl'
export {
  type DetachedChild,
  releaseDetachedProcess,
  spawnDetachedProcess,
} from '@agnes/host-infrastructure/adapters/detached-process'
export { createExec, type ExecAdapter, type ExecResult } from '@agnes/host-infrastructure/adapters/exec'
export { resolveFileSecretsDirectory } from '@agnes/host-infrastructure/adapters/file-secrets-dir'
export { createFs, type HostFs } from '@agnes/host-infrastructure/adapters/fs'
export {
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityLevel,
  createPlatform,
  createPosixPlatform,
  createWin32Platform,
  type PlatformBackend,
  probeLinuxSandboxSupport,
} from '@agnes/host-infrastructure/adapters/platform'
export { resolveConfiguredPowerShell } from '@agnes/host-infrastructure/adapters/powershell'
export type { ProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity'
export {
  defaultProcessIdentity,
  legacyMacosProcessIdentity,
} from '@agnes/host-infrastructure/adapters/process-identity-default'
export {
  composeSecrets,
  createSecretsEnv,
  createSecretsFile,
  parseSecretRef,
  type SecretResolver,
} from '@agnes/host-infrastructure/adapters/secrets'
export {
  openConfiguredPersistence,
  sqlitePersistenceProvider,
} from '@agnes/host-infrastructure/adapters/storage-provider'
export {
  createSqliteStorage,
  type SqliteStorage,
  type SqlParam,
  type TableHandle,
  type TableStore,
} from '@agnes/host-infrastructure/adapters/storage-sqlite'
export {
  createAdminSessionSelection,
  type HostAdminSessionCatalog,
} from '@agnes/host-infrastructure/admin-session-selection'
export * from '@agnes/host-infrastructure/audit'
export {
  type ChildEnginesConfigurationService,
  type ChildEnginesSnapshot,
  ConfigurationError,
  type ConfigurationErrorCode,
  type ConfigurationService,
  type ConfigurationServiceOptions,
  createConfigurationService,
  type SessionDefaultsConfigurationService,
} from '@agnes/host-infrastructure/configuration'
export { type DoctorOptions, type DoctorProbe, runDoctor } from '@agnes/host-infrastructure/doctor'
export { RequestTraceStore } from '@agnes/host-infrastructure/request-traces'
export * from '@agnes/host-infrastructure/sandbox-readiness-manager'
export * from '@agnes/host-infrastructure/session-workspace-runtime'
export { SystemPromptSettingsStore } from '@agnes/host-infrastructure/system-prompt-settings'
export {
  resolveWorkspaceDirectory,
  type WorkspaceDirectory,
  WorkspaceDirectoryError,
  type WorkspaceInvalidReason,
} from '@agnes/host-infrastructure/workspace'
export {
  CompactionEngineRegistry,
  compactionEngineCatalog,
} from '@agnes/host-providers/assemble/compaction-engines'
export { ModelAdapterRegistry, modelAdapterCatalog } from '@agnes/host-providers/assemble/model-adapters'
export {
  applyProviderSelections,
  PROVIDER_KINDS,
  readProviderSelection,
  readProviderSelections,
} from '@agnes/host-providers/assemble/provider-selection'
export * from '@agnes/host-providers/assemble/routes'
export * from '@agnes/host-providers/profile/composition-state'
export { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
export * from '@agnes/host-providers/runtime-target-publisher'
export * from '@agnes/host-providers/runtime-target-report'
export {
  type AdapterBundle,
  openAdapters,
  type Prompter,
  type SeamAdapters,
  toSeamAdapters,
} from './runtime/adapters/index.js'
export {
  type ApprovalGrantBinding,
  type ApprovalGrantManagement,
  type ApprovalGrantStore,
  createApprovalGrantStore,
} from './runtime/approval/grants.js'
export {
  ASSEMBLY_STEPS,
  type AssembleDeps,
  type Assembled,
  type AssemblyStep,
  assemble,
} from './runtime/assemble/assemble.js'
export { ChildAgentRegistry, childAgentCatalog } from './runtime/assemble/child-agents.js'
export {
  childEnginePluginLayers,
  loadChildEnginePluginLayers,
  overlayChildEngineTarget,
} from './runtime/children/child-engine-layers.js'
export {
  type ChildCandidate,
  listChildCandidates,
  maintenanceTick,
  type RepairResult,
  repairChildCandidates,
  sessionsDbPath,
} from './runtime/children/child-maintenance.js'
export { readFactChainBinding } from './runtime/sessions/fact-chain-binding.js'
export { createHost, type Host, type HostOptions, type HostSession } from './runtime/lifecycle/host.js'
export {
  assertHostPublication,
  type HostConvergenceReport,
  HostPublicationError,
  type HostPublicationReport,
  hostInspectionSource,
} from './runtime/lifecycle/host-facade.js'
export { closeHost, Rollback } from './runtime/lifecycle/lifecycle.js'
export { manageMemory } from './runtime/memory/admin.js'
export * from './runtime/profile/bundle-selection.js'
export {
  compositionAllowsTool,
  profileForComposition,
} from './runtime/profile/composition-selection.js'
export * from './runtime/profile/composition-visibility.js'
export {
  type ConfigurationProfileInputsOptions,
  readConfigurationProfileInputs,
} from './runtime/profile/inputs.js'
export * from './runtime/profile/session-capabilities.js'
export type { PluginGenerationStatus } from './runtime/generation/host.js'
export {
  type CreateSessionOptions,
  createSession,
  type SessionRecovery,
  sessionKey,
} from './runtime/sessions/session.js'
export { readProfileTelemetryConsent } from './runtime/sessions/session-hooks.js'
export { loadSessionTitle } from './runtime/sessions/session-title.js'
export type { CapabilityReason, SessionCapability, SessionCapabilitySet } from '@agnes/protocol'

export { createFeedbackService } from './runtime/feedback/service.js'
export { draftFeedbackSkill, feedbackSkillFiles } from './runtime/feedback/draft.js'
