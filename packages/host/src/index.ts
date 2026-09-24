export const PACKAGE_NAME = '@agnes/host' as const

// Ledger paging for the packages that reach core only through host.
export {
  REQUEST_MEDIA_ARTIFACT_RECLAIMED,
  SCAN_PAGE_MAX,
  type ScanRead,
  scanAll,
  scanPages,
} from '@agnes/core'
export {
  type CredentialFileEnforcement,
  type CredentialKind,
  CredentialStoreError,
  type CredentialStoreReason,
  credentialFileEnforcement,
} from './adapters/credential-files.js'
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
} from './adapters/credential-store.js'
export { DDL } from './adapters/ddl.js'
export {
  type DetachedChild,
  releaseDetachedProcess,
  spawnDetachedProcess,
} from './adapters/detached-process.js'
export { createExec, type ExecAdapter, type ExecResult } from './adapters/exec.js'
export { createFs, type HostFs } from './adapters/fs.js'
export {
  type AdapterBundle,
  openAdapters,
  type Prompter,
  type SeamAdapters,
  toSeamAdapters,
} from './adapters/index.js'
export {
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityLevel,
  createPlatform,
  createPosixPlatform,
  createWin32Platform,
  type PlatformBackend,
} from './adapters/platform.js'
export { resolveConfiguredPowerShell } from './adapters/powershell.js'
export type { ProcessIdentity } from './adapters/process-identity.js'
export { defaultProcessIdentity } from './adapters/process-identity-default.js'
export {
  composeSecrets,
  createSecretsEnv,
  createSecretsFile,
  parseSecretRef,
  type SecretResolver,
} from './adapters/secrets.js'
export {
  createSqliteStorage,
  type SqliteStorage,
  type SqlParam,
  type TableHandle,
  type TableStore,
} from './adapters/storage-sqlite.js'
export {
  type ApprovalGrantBinding,
  type ApprovalGrantManagement,
  type ApprovalGrantStore,
  createApprovalGrantStore,
} from './approval-grants.js'
export {
  ARTIFACT_RECLAIMED_FAILURE,
  createLocalArtifactReadStore,
  type LocalArtifactReadStore,
} from './artifact-read-store.js'
// MCP-ROWS stage 2b step 3 prep: worker-runtime needs this to build the rows `Assembled['extensionRows']`
// takes (`prepare({..., dynamic})`) without reaching into Host's internal assemble/ directory.
export type { DynamicExtension } from './assemble/ext-rows.js'
export * from './assemble/packages.js'
export * from './assemble/routes.js'
export type { HostPluginTreeBase } from './assemble/seams-cordis.js'
export { ASSEMBLY_STEPS, type AssembleDeps, type Assembled, type AssemblyStep, assemble } from './assemble.js'
export * from './audit.js'
export {
  type ChildCandidate,
  listChildCandidates,
  maintenanceTick,
  type RepairResult,
  repairChildCandidates,
  sessionsDbPath,
} from './child-maintenance.js'
export * from './command-policy.js'
export {
  type ComputerUseAppAdmissionDecision,
  type ComputerUseResolvedAppIdentity,
  evaluateComputerUseAppAdmission,
} from './computer-use/app-admission.js'
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
} from './computer-use/driver-lock.js'
export { createSqliteComputerUseEffectStore } from './computer-use/effect-store-sqlite.js'
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
} from './computer-use/host-enforcement.js'
export {
  activateExtractedLinuxComputerUseDriver,
  type ExtractedLinuxComputerUseDriver,
  extractLockedLinuxComputerUseDriver,
  type LinuxDriverArchiveDependencies,
} from './computer-use/linux-driver-archive.js'
export {
  createLinuxComputerUseBackendProvider,
  createLinuxComputerUseSessionRuntime,
  inspectLinuxComputerUseSession,
  type LinuxComputerUseBackendDependencies,
  type LinuxComputerUseSession,
  type VerifiedLinuxComputerUseDriver,
} from './computer-use/linux-driver-backend.js'
export { downloadLockedLinuxComputerUseDriver } from './computer-use/linux-driver-download.js'
export {
  doctorLockedLinuxComputerUseDriver,
  installOrUpdateLockedLinuxComputerUseDriver,
  type LinuxComputerUseDriverInstallDependencies,
  type LinuxComputerUseDriverInstallResult,
  type LinuxComputerUseDriverRecord,
  type LinuxComputerUseDriverState,
  probeLinuxComputerUseDriverHealth,
  readLinuxComputerUseDriverState,
} from './computer-use/linux-driver-install.js'
export {
  type LinuxDriverVerifierDependencies,
  verifyLinuxComputerUseDriver,
} from './computer-use/linux-driver-verifier.js'
export {
  type LinuxDesktopAppIdentity,
  type LinuxLiveAppIdentity,
  linuxDesktopAppIdentitySync,
  linuxLiveAppIdentitySync,
} from './computer-use/linux-live-app-identity.js'
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
} from './computer-use/locked-package-mutation-runtime.js'
export {
  createSqliteLockedPackageOperationReceiptPort,
  type HostLockedPackageActivationRecord,
  type HostLockedPackageMutationKind,
  type HostLockedPackageOperationReceipt,
  type HostLockedPackageOperationReceiptPort,
} from './computer-use/locked-package-receipts-sqlite.js'
export {
  activateExtractedMacOSComputerUseDriver,
  type ExtractedMacOSComputerUseDriver,
  extractLockedMacOSComputerUseDriver,
  type MacOSDriverArchiveDependencies,
} from './computer-use/macos-driver-archive.js'
export {
  createMacOSComputerUseBackendProvider,
  createMacOSComputerUseSessionRuntime,
  grantMacOSComputerUsePermissions,
  type MacOSComputerUseBackendDependencies,
  type MacOSComputerUsePermissionStatus,
  probeMacOSComputerUsePermissions,
  type VerifiedMacOSComputerUseDriver,
} from './computer-use/macos-driver-backend.js'
export { downloadLockedMacOSComputerUseDriver } from './computer-use/macos-driver-download.js'
export {
  installOrUpdateLockedMacOSComputerUseDriver,
  type MacOSComputerUseDriverInstallDependencies,
  type MacOSComputerUseDriverInstallResult,
  type MacOSComputerUseDriverRecord,
  type MacOSComputerUseDriverState,
  readMacOSComputerUseDriverState,
} from './computer-use/macos-driver-install.js'
export {
  type MacOSDriverVerifierDependencies,
  verifyMacOSComputerUseDriver,
} from './computer-use/macos-driver-verifier.js'
export {
  type MacOSLiveAppIdentity,
  macosLiveAppIdentitySync,
  parseMacOSLiveAppIdentity,
} from './computer-use/macos-live-app-identity.js'
export {
  type ComputerUseRescueAction,
  type ComputerUseRescueReport,
  runComputerUseRescue,
} from './computer-use/rescue.js'
export {
  activateExtractedWindowsComputerUseDriver,
  type ExtractedWindowsComputerUseDriver,
  extractLockedWindowsComputerUseDriver,
  type ValidatedWindowsDriverArchiveFile,
  validateLockedWindowsComputerUseDriverArchive,
} from './computer-use/windows-driver-archive.js'
export {
  type ComputerUseBackendDependencies,
  type ComputerUseBackendProvider,
  type ComputerUseLiveProcessIdentity,
  createComputerUseBackendProvider,
  createWindowsComputerUseBackendProvider,
  type WindowsComputerUseArtifactSink,
  type WindowsComputerUseBackendDependencies,
  type WindowsComputerUseBackendProvider,
} from './computer-use/windows-driver-backend.js'
export {
  type ComputerUseDownloadResponse,
  type ComputerUseDownloadTransport,
  downloadLockedWindowsComputerUseDriver,
} from './computer-use/windows-driver-download.js'
export {
  installOrUpdateLockedWindowsComputerUseDriver,
  readWindowsComputerUseDriverState,
  recoverLockedWindowsComputerUseDriver,
  type WindowsComputerUseDriverInstallDependencies,
  type WindowsComputerUseDriverInstallResult,
  type WindowsComputerUseDriverRecord,
  type WindowsComputerUseDriverRecoveryResult,
  type WindowsComputerUseDriverState,
} from './computer-use/windows-driver-install.js'
export {
  type VerifiedWindowsComputerUseDriver,
  verifyWindowsComputerUseDriver,
  type WindowsDriverVerifierDependencies,
} from './computer-use/windows-driver-verifier.js'
export {
  type ComputerUseArtifactGcRun,
  type ComputerUseArtifactGcRuntime,
  createComputerUseArtifactGcRuntime,
} from './computer-use-artifact-gc.js'
export {
  ConfigurationError,
  type ConfigurationErrorCode,
  type ConfigurationService,
  type ConfigurationServiceOptions,
  createConfigurationService,
} from './configuration.js'
export type { DeploymentPolicy, ResolvedDeployment } from './deploy/index.js'
export { resolveDeployment } from './deploy/index.js'
export * from './errors.js'
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
} from './ext-host/activation-barrier.js'
export type {
  ExtensionIsolationMode,
  ExtensionIsolationOptions,
} from './ext-host/hooks-isolation-assembly.js'
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
} from './ext-host/index.js'
export {
  isServicePreDispatchFailure,
  type ServiceAuthority,
  type ServiceEffectAdmission,
  type ServiceInspection,
} from './ext-host/service-invocation.js'
export { createHost, type Host, type HostOptions, type HostSession } from './host.js'
export { closeHost, Rollback } from './lifecycle.js'
export {
  defaultVerifyIntegrity,
  type LockAudit,
  lockState,
  snapshotPolicy,
  verifyLockIntegrity,
} from './packages/lock-state.js'
export {
  emptyLock,
  type LockEntry,
  type Lockfile,
  lockPath,
  readLock,
  withLock,
  writeLock,
} from './packages/lockfile.js'
export {
  createPackageManager,
  type ManagerOptions,
  type PackageManager,
  type PackageStatus,
  readManifestIn,
} from './packages/manager.js'
export {
  type ExecFn,
  type FetchedSource,
  fetchSource,
  hashDirectory,
  type PackageSource,
  packageDir,
  parseSource,
} from './packages/sources.js'
export {
  isDangerous,
  LICENSE_ALLOWLIST,
  manifestCapabilities,
  runTrustGate,
  verifyInstalledIntegrity,
} from './packages/trust-gate.js'
export {
  hashWorkspace,
  readDeployManifest,
  readProfileFragment,
  verifyWorkspace,
  type WorkspaceVerification,
} from './packages/workspace.js'
export {
  agnesHome,
  cacheDir,
  dataDir,
  hasLegacySessionsDb,
  inDataDir,
  legacySessionsDbPath,
} from './paths.js'
export * from './presets/index.js'
export { canonicalJson, sha256hex } from './profile/canonical.js'
export { DEFAULT_COMPUTER_USE } from './profile/computer-use.js'
export {
  type ConfigurationProfileInputsOptions,
  readConfigurationProfileInputs,
} from './profile/inputs.js'
export { expandHome, hashInput, mergePackages, resolveProfile } from './profile/resolve.js'
export {
  assertNoReservedRouteName,
  BUILTIN_PACKAGES,
  checkTemplateShape,
  loadTemplate,
  RESERVED_ROUTE_NAMES,
  TEMPLATE_NAMES,
} from './profile/templates.js'
export type * from './profile/types.js'
export * from './publication-dispatch.js'
export {
  type PublicationCloseOptions,
  PublicationGate,
  type PublicationReadTicket,
} from './publication-gate.js'
export * from './quiet-state.js'
export {
  composeProductionRequestMedia,
  createProductionImageInputTokenFallback,
  type ProductionRequestMediaConfiguration,
} from './request-media-runtime.js'
export * from './resources/index.js'
export type { McpManageBridge, McpManageInvocation } from './resources/mcp-manage-port.js'
export type { PluginManageBridge, PluginManageInvocation } from './resources/plugin-manage-port.js'
export { createSkillInstaller, type SkillInstallAuthority } from './resources/skill-install.js'
export { validInstallPathPolicy } from './resources/skill-install-files.js'
export type { SkillInstallBridge, SkillInstallInvocation } from './resources/skill-install-port.js'
export * from './runtime-target-publisher.js'
export * from './runtime-target-report.js'
export * from './sandbox-readiness-manager.js'
export {
  type CreateSessionOptions,
  createSession,
  type SessionRecovery,
  sessionKey,
} from './session.js'
export { readProfileTelemetryConsent } from './session-hooks.js'
export { loadSessionTitle } from './session-title.js'
export * from './session-workspace-runtime.js'
export {
  resolveWorkspaceDirectory,
  type WorkspaceDirectory,
  WorkspaceDirectoryError,
  type WorkspaceInvalidReason,
} from './workspace.js'
export {
  type AuthenticatedWorkspaceBindingEnvelope,
  CliWorkspaceAuthority,
  type WorkspaceBinding,
} from './workspace-authority.js'
export * from './workspace-policy.js'
