import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkSequence,
  type EventEnvelope,
  type Frame,
  type HookEvent,
  listMigrations,
  type MethodName,
  normalize,
  rpcError,
  type SequenceInvariant,
  toRpcError,
  type UiSlotName,
  type ValidationResult,
  validateAction,
  validateActor,
  validateApprovalAction,
  validateBridgeFrame,
  validateChannelCapabilities,
  validateChannelManifest,
  validateClientModuleEffectCallParams,
  validateClientModuleEffectCallResult,
  validateClientModuleListResult,
  validateClientModuleReadParams,
  validateClientModuleReadResult,
  validateClientModuleServiceCallParams,
  validateClientModuleServiceCallResult,
  validateContractManifest,
  validateContractStamp,
  validateCredential,
  validateDecision,
  validateDeployManifest,
  validateDirectoryEntry,
  validateEvent,
  validateExtensionCallError,
  validateExtensionManifest,
  validateHook,
  validateJobSpec,
  validateJobStatus,
  validateLockfile,
  validateManagedPolicy,
  validateMethod,
  validateModelRecord,
  validatePreset,
  validateProfileFragment,
  validateProfileManifest,
  validateProjectionCapability,
  validateProjectionReadResult,
  validateResolvedProfile,
  validateRouteTable,
  validateRuntimeApplyFailedFrame,
  validateRuntimeBootReadyFrame,
  validateRuntimeConvergedFrame,
  validateRuntimeConvergenceReport,
  validateRuntimeConvergenceRow,
  validateRuntimeStaleFrame,
  validateRuntimeTargetArtifact,
  validateServiceCapability,
  validateSkinListResult,
  validateSkinReadParams,
  validateSkinReadResult,
  validateSlotPayload,
  validateSurfaceArtifact,
  validateSurfaceConfigValue,
  validateSurfaceDescriptor,
  validateSurfaceInstance,
  validateSurfacePackageMetadata,
  validateSurfaceServiceGrant,
  validateTarget,
  validateToolDef,
} from '../src/index.js'
import { type PackageAdminDataName, validatePackageAdminData } from '../src/package-admin.js'

export type Fixture = {
  id: string
  // A migrate row asserts a transformation rather than a verdict, so it carries no `kind`.
  kind?: 'valid' | 'invalid'
  target: 'event' | 'method' | 'tooldef' | 'hook' | 'slot' | 'model' | 'migrate' | 'sequence' | 'config'
  // `name` is a method name for target 'method', a hook event name for 'hook', a slot name for 'slot', and a model.json definition name for 'model'.
  name?: MethodName | HookEvent | UiSlotName | string
  side?: 'params' | 'result' | 'payload' | 'return'
  payload?: unknown
  expect?: { errorCode?: number; dataCode?: string; key?: string }
  // Sequence rows only: the recorded frames and which invariants the recording is meant to satisfy.
  frames?: Frame[]
  invariants?: SequenceInvariant[]
  ok?: boolean
  // Migrate rows only. `before` is the data at `fromV`, `after` what normalize() should make of it.
  type?: string
  fromV?: number
  before?: unknown
  after?: unknown
}

// The four model.json definitions a fixture may target. Named rather than reached for by $def so
// that a fixture cannot silently exercise a definition nothing validates in production.
const MODEL_VALIDATORS: Record<string, (x: unknown) => ValidationResult<unknown>> = {
  ModelRecord: validateModelRecord,
  RouteTable: validateRouteTable,
  ContractStamp: validateContractStamp,
  ContractManifest: validateContractManifest,
}

const CONFIG_VALIDATORS: Record<string, (x: unknown) => ValidationResult<unknown>> = {
  PackageAdminPermission: (x) =>
    validatePackageAdminData('PackageAdminPermission' satisfies PackageAdminDataName, x),
  PackageActivationTrust: (x) =>
    validatePackageAdminData('PackageActivationTrust' satisfies PackageAdminDataName, x),
  PackageActivationRequest: (x) =>
    validatePackageAdminData('PackageActivationRequest' satisfies PackageAdminDataName, x),
  PackageRollbackTarget: (x) =>
    validatePackageAdminData('PackageRollbackTarget' satisfies PackageAdminDataName, x),
  PackageAdminContext: (x) =>
    validatePackageAdminData('PackageAdminContext' satisfies PackageAdminDataName, x),
  PackageSource: (x) => validatePackageAdminData('PackageSource' satisfies PackageAdminDataName, x),
  PackageContributionSummary: (x) =>
    validatePackageAdminData('PackageContributionSummary' satisfies PackageAdminDataName, x),
  PackageCapabilityDiff: (x) =>
    validatePackageAdminData('PackageCapabilityDiff' satisfies PackageAdminDataName, x),
  PackageBlocker: (x) => validatePackageAdminData('PackageBlocker' satisfies PackageAdminDataName, x),
  PackageWarning: (x) => validatePackageAdminData('PackageWarning' satisfies PackageAdminDataName, x),
  PackageProvenance: (x) => validatePackageAdminData('PackageProvenance' satisfies PackageAdminDataName, x),
  PackagePreview: (x) => validatePackageAdminData('PackagePreview' satisfies PackageAdminDataName, x),
  PackageTrustDecision: (x) =>
    validatePackageAdminData('PackageTrustDecision' satisfies PackageAdminDataName, x),
  PackageInstalledDescriptor: (x) =>
    validatePackageAdminData('PackageInstalledDescriptor' satisfies PackageAdminDataName, x),
  PackageCatalogDescriptor: (x) =>
    validatePackageAdminData('PackageCatalogDescriptor' satisfies PackageAdminDataName, x),
  PackageAdminError: (x) => validatePackageAdminData('PackageAdminError' satisfies PackageAdminDataName, x),
  PackageOperationReceipt: (x) =>
    validatePackageAdminData('PackageOperationReceipt' satisfies PackageAdminDataName, x),
  PackageOperation: (x) => validatePackageAdminData('PackageOperation' satisfies PackageAdminDataName, x),
  PackageCatalogPage: (x) => validatePackageAdminData('PackageCatalogPage' satisfies PackageAdminDataName, x),
  PackageListResult: (x) => validatePackageAdminData('PackageListResult' satisfies PackageAdminDataName, x),
  PackageCatalogListParams: (x) =>
    validatePackageAdminData('PackageCatalogListParams' satisfies PackageAdminDataName, x),
  PackageCatalogGetParams: (x) =>
    validatePackageAdminData('PackageCatalogGetParams' satisfies PackageAdminDataName, x),
  PackageListParams: (x) => validatePackageAdminData('PackageListParams' satisfies PackageAdminDataName, x),
  PackageInspectParams: (x) =>
    validatePackageAdminData('PackageInspectParams' satisfies PackageAdminDataName, x),
  PackageInstallParams: (x) =>
    validatePackageAdminData('PackageInstallParams' satisfies PackageAdminDataName, x),
  PackageTrustParams: (x) => validatePackageAdminData('PackageTrustParams' satisfies PackageAdminDataName, x),
  PackageUntrustParams: (x) =>
    validatePackageAdminData('PackageUntrustParams' satisfies PackageAdminDataName, x),
  PackageEnableParams: (x) =>
    validatePackageAdminData('PackageEnableParams' satisfies PackageAdminDataName, x),
  PackageDisableParams: (x) =>
    validatePackageAdminData('PackageDisableParams' satisfies PackageAdminDataName, x),
  PackageRollbackParams: (x) =>
    validatePackageAdminData('PackageRollbackParams' satisfies PackageAdminDataName, x),
  PackageRemoveParams: (x) =>
    validatePackageAdminData('PackageRemoveParams' satisfies PackageAdminDataName, x),
  PackageUpdateParams: (x) =>
    validatePackageAdminData('PackageUpdateParams' satisfies PackageAdminDataName, x),
  PackageOperationGetParams: (x) =>
    validatePackageAdminData('PackageOperationGetParams' satisfies PackageAdminDataName, x),
  PackageOperationCancelParams: (x) =>
    validatePackageAdminData('PackageOperationCancelParams' satisfies PackageAdminDataName, x),
  RuntimePinDescriptor: (x) =>
    validatePackageAdminData('RuntimePinDescriptor' satisfies PackageAdminDataName, x),
  RuntimePinReleaseResult: (x) =>
    validatePackageAdminData('RuntimePinReleaseResult' satisfies PackageAdminDataName, x),
  PackagePinsInspectParams: (x) =>
    validatePackageAdminData('PackagePinsInspectParams' satisfies PackageAdminDataName, x),
  PackagePinsInspectResult: (x) =>
    validatePackageAdminData('PackagePinsInspectResult' satisfies PackageAdminDataName, x),
  PackagePinsReleaseParams: (x) =>
    validatePackageAdminData('PackagePinsReleaseParams' satisfies PackageAdminDataName, x),
  PackagePinsReleaseResult: (x) =>
    validatePackageAdminData('PackagePinsReleaseResult' satisfies PackageAdminDataName, x),
  PackageTrustWorkspaceParams: (x) =>
    validatePackageAdminData('PackageTrustWorkspaceParams' satisfies PackageAdminDataName, x),
  PackageTrustWorkspaceResult: (x) =>
    validatePackageAdminData('PackageTrustWorkspaceResult' satisfies PackageAdminDataName, x),
  PluginTreeArtifact: (x) => validatePackageAdminData('PluginTreeArtifact' satisfies PackageAdminDataName, x),
  PluginTreeGetParams: (x) => validatePackageAdminData('PackageListParams' satisfies PackageAdminDataName, x),
  PluginTreeListParams: (x) =>
    validatePackageAdminData('PackageListParams' satisfies PackageAdminDataName, x),
  PluginTreeApplyParams: (x) =>
    validatePackageAdminData('PluginTreeApplyParams' satisfies PackageAdminDataName, x),
  PluginTreeRollbackParams: (x) =>
    validatePackageAdminData('PluginTreeRollbackParams' satisfies PackageAdminDataName, x),
  PluginTreeView: (x) => validatePackageAdminData('PluginTreeView' satisfies PackageAdminDataName, x),
  PluginTreeApplyResult: (x) =>
    validatePackageAdminData('PluginTreeApplyResult' satisfies PackageAdminDataName, x),
  PluginTreeRollbackResult: (x) =>
    validatePackageAdminData('PluginTreeRollbackResult' satisfies PackageAdminDataName, x),

  SurfaceArtifact: validateSurfaceArtifact,
  SurfaceConfigValue: validateSurfaceConfigValue,
  SurfaceDescriptor: validateSurfaceDescriptor,
  SurfaceInstance: validateSurfaceInstance,
  SurfacePackageMetadata: validateSurfacePackageMetadata,
  SurfaceServiceGrant: validateSurfaceServiceGrant,
  preset: validatePreset,
  ServiceCapability: validateServiceCapability,
  ExtensionCallError: validateExtensionCallError,
  ProjectionCapability: validateProjectionCapability,
  ProjectionReadResult: validateProjectionReadResult,
  Actor: validateActor,
  Action: validateAction,
  Target: validateTarget,
  Decision: validateDecision,
  Credential: validateCredential,
  ChannelManifest: validateChannelManifest,
  ApprovalAction: validateApprovalAction,
  DirectoryEntry: validateDirectoryEntry,
  ChannelCapabilities: validateChannelCapabilities,
  BridgeFrame: validateBridgeFrame,
  RuntimeTargetArtifact: validateRuntimeTargetArtifact,
  RuntimeStaleFrame: validateRuntimeStaleFrame,
  RuntimeConvergenceRow: validateRuntimeConvergenceRow,
  RuntimeConvergenceReport: validateRuntimeConvergenceReport,
  RuntimeBootReadyFrame: validateRuntimeBootReadyFrame,
  RuntimeConvergedFrame: validateRuntimeConvergedFrame,
  RuntimeApplyFailedFrame: validateRuntimeApplyFailedFrame,

  RuntimeProfileManifest: validateProfileManifest,
  ProfileFragment: validateProfileFragment,
  ResolvedProfile: validateResolvedProfile,
  ManagedPolicy: validateManagedPolicy,
  Lockfile: validateLockfile,
  ExtensionManifest: validateExtensionManifest,
  DeployManifest: validateDeployManifest,
  JobSpec: validateJobSpec,
  JobStatus: validateJobStatus,
  SkinListResult: validateSkinListResult,
  SkinReadParams: validateSkinReadParams,
  SkinReadResult: validateSkinReadResult,
  ClientModuleListResult: validateClientModuleListResult,
  ClientModuleRosterRow: (x) => validatePackageAdminData('ClientModuleRosterRow', x),
  ClientModuleReadParams: validateClientModuleReadParams,
  ClientModuleReadResult: validateClientModuleReadResult,
  ClientModuleServiceCallParams: validateClientModuleServiceCallParams,
  ClientModuleServiceCallResult: validateClientModuleServiceCallResult,
  ClientModuleEffectCallParams: validateClientModuleEffectCallParams,
  ClientModuleEffectCallResult: validateClientModuleEffectCallResult,
}

/** The single fixture-tree discovery path shared by the CLI runner and the root Vitest gate. */
export function findFixtureFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.jsonl')) files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

function runOne(f: Fixture): ValidationResult<unknown> {
  if (f.target === 'config') {
    const check = CONFIG_VALIDATORS[f.name as string]
    if (!check) throw new Error(`no config validator for ${String(f.name)}`)
    return check(f.payload)
  }
  if (f.target === 'event') return validateEvent(f.payload)
  if (f.target === 'tooldef') return validateToolDef(f.payload)
  if (f.target === 'hook')
    return validateHook(f.name as HookEvent, f.side === 'return' ? 'return' : 'payload', f.payload)
  if (f.target === 'slot') return validateSlotPayload(f.name as UiSlotName, f.payload)
  if (f.target === 'model') {
    const check = MODEL_VALIDATORS[f.name as string]
    if (!check) throw new Error(`no model validator for ${String(f.name)}`)
    return check(f.payload)
  }
  return validateMethod(f.name as MethodName, f.side === 'result' ? 'result' : 'params', f.payload)
}

const MIGRATE_ACTOR = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

/**
 * A migrate fixture is replayed rather than validated: build the event its `before` describes at
 * `fromV`, run normalize(), and compare the result with `after`.
 *
 * A fixture whose migration is not registered in this process is skipped rather than failed. The
 * registry is a process-wide table filled by whoever imports the migrations, and the published
 * runner only carries the real ones; a fixture under the `x/` extension namespace belongs to a
 * deployment that registered it. Skips are counted and reported so that "skipped" can never read as
 * "passed".
 */
function runMigrate(f: Fixture): { id: string; pass: boolean; skipped?: boolean; detail?: string } {
  const type = f.type as string
  const fromV = f.fromV as number
  if (!listMigrations().some((m) => m.type === type && m.fromV === fromV))
    return { id: f.id, pass: true, skipped: true }
  const out = normalize({
    seq: 1,
    ts: '2026-09-07T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type,
    data: f.before,
    actor: MIGRATE_ACTOR,
    origin: 'system',
    trust: 'trusted',
    v: fromV,
    ignorable: true,
  } as unknown as EventEnvelope)
  const got = JSON.stringify(out.data)
  const want = JSON.stringify(f.after)
  if (got !== want) return { id: f.id, pass: false, detail: `data ${got} !== ${want}` }
  return { id: f.id, pass: true }
}

export function runFixtureLine(f: Fixture): {
  id: string
  pass: boolean
  skipped?: boolean
  detail?: string
} {
  if (f.target === 'migrate') return runMigrate(f)
  if (f.target === 'sequence') {
    const r = checkSequence(f.frames as Frame[], f.invariants as SequenceInvariant[])
    return r.ok === f.ok
      ? { id: f.id, pass: true }
      : { id: f.id, pass: false, detail: `ok ${r.ok} !== ${String(f.ok)}: ${JSON.stringify(r.violations)}` }
  }
  const r = runOne(f)
  if (f.kind === 'valid')
    return r.ok ? { id: f.id, pass: true } : { id: f.id, pass: false, detail: JSON.stringify(r.errors) }
  if (r.ok) return { id: f.id, pass: false, detail: 'expected invalid, got valid' }
  // toRpcError intentionally means "the caller supplied invalid params". A handler result that
  // violates its method schema is instead the server's fault, matching LocalEndpoint's production
  // response and preventing a broken server from blaming its client.
  const err =
    f.target === 'method' && f.side === 'result'
      ? rpcError('INTERNAL_ERROR', { code: 'RESULT_INVALID', method: f.name, errors: r.errors })
      : toRpcError(r.errors)
  const e = f.expect ?? {}
  if (e.errorCode !== undefined && err.code !== e.errorCode)
    return { id: f.id, pass: false, detail: `code ${err.code} ≠ ${e.errorCode}` }
  if (e.dataCode !== undefined && err.data.code !== e.dataCode)
    return { id: f.id, pass: false, detail: `data.code ${String(err.data.code)} ≠ ${e.dataCode}` }
  if (e.key !== undefined && err.data.key !== e.key)
    return { id: f.id, pass: false, detail: `key ${String(err.data.key)} ≠ ${e.key}` }
  return { id: f.id, pass: true }
}

export function runFixtureFiles(files: string[]): {
  total: number
  skipped: number
  failed: Array<{ id: string; detail: string }>
} {
  let total = 0
  // Counted and returned rather than swallowed: a runner that silently skips is a runner that
  // reports green for work it never did.
  let skipped = 0
  const failed: Array<{ id: string; detail: string }> = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      total++
      const r = runFixtureLine(JSON.parse(line) as Fixture)
      if (r.skipped) skipped++
      if (!r.pass) failed.push({ id: `${file}#${r.id}`, detail: r.detail ?? '' })
    }
  }
  return { total, skipped, failed }
}
