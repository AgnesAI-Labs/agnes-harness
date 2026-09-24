export const PACKAGE_NAME = '@agnes/cli' as const

export { parseArgs, resolveMode, usage } from './args.js'
export { agnesVersion, type MainIO, main } from './bin.js'
export {
  type EnsureLocalBackendOptions,
  ensureLocalBackend,
  type LocalBackend,
  type LocalBackendWeb,
  type SpawnDaemonInput,
} from './boot/backend.js'
export { bootConnect, type ConnectBootDeps, parseConnectTarget, unixConnectTarget } from './boot/connect.js'
export {
  bootDefault,
  type DefaultBootDeps,
  type DefaultBootOptions,
} from './boot/default.js'
export { bootLocal, hostRootFrom, type LocalBootDeps } from './boot/local.js'
export { installSignalLadder } from './boot/signals.js'
export { conformanceGateway } from './commands/conformance.js'
export { consentCommand } from './commands/consent.js'
export {
  DOCTOR_SECTIONS,
  type DoctorCommandDeps,
  type DoctorSectionName,
  doctorCommand,
  doctorDaemon,
  renderSections,
  type Section,
} from './commands/doctor.js'
export { doctorCodeRuntime } from './commands/doctor-code-runtime.js'
export {
  type ExportDeps,
  exportSession,
  formatAgnes,
  type LedgerExport,
  readLedger,
  validateExportRequest,
} from './commands/export.js'
export { type ImportDeps, importBatches, importFile } from './commands/import.js'
export {
  createResourceController,
  type ResourceCommandIO,
  resourceCapabilityMissing,
  resourceCommandProfile,
  runResourceCommand,
} from './commands/resources.js'
export { sessionsCommand } from './commands/sessions.js'
export { statsDeviation } from './commands/stats.js'
export { type ConfigWizardIO, runConfigurationWizard } from './config-wizard.js'
export { BootError, ExitCode, type ExitCodeValue, exitCodeForReason, UsageError } from './errors.js'
export { type ApiKeySetupDeps, setupApiKeyProvider } from './onboarding/api-key-provider.js'
export { hasConfiguredApiKey, type PromptIO, runApiKeyPrompt } from './onboarding/prompt.js'
export { onboardingProvider } from './onboarding/provider-registry.js'
export type { ResourceCommandKind, TuiResourceController } from './tui/resource-controller.js'
export type { BootDeps, Booted, Command, ModelSel, ParsedArgs } from './types.js'
