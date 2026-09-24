import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type {
  CatalogRead,
  InstalledInventory,
  InstalledPackage,
  PackageManager,
  PackageSource,
} from '@agnes/package-manager'
import {
  activeRuntimePinId,
  collectSkinRoster,
  parseSource,
  resolveSkinAsset,
  rewriteSkinAssetUrls,
  SKIN_MAX_ASSET_BYTES,
  SKIN_MAX_CSS_BYTES,
  skinCssUrl,
} from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact, type RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  type ClientModuleEffectCallParams,
  type ClientModuleListResult,
  type ClientModuleReadResult,
  type ClientModuleServiceCallParams,
  type ExtensionCallResult,
  jcs,
  PACKAGE_ADMIN_METHODS,
  type PackageAdminError,
  type PackageAdminMethodName,
  type PackageCatalogDescriptor,
  type PackageInstalledDescriptor,
  type PackageOperation,
  type PackageOperationReceipt,
  type PackagePreview,
  projectClientModuleRows,
  type RuntimePinDescriptor,
  type RuntimePinReleaseResult,
  rpcError,
  type SkinListResult,
  type SkinReadResult,
  validatePackageAdminCall,
  validatePackageAdminData,
} from '@agnes/protocol'
import { packageOfRow } from '../composite-desired.js'
import type { LocalEndpoint } from '../local/endpoint.js'
import { classifyPackageContributions } from '../package-readiness.js'
import { pluginTreeList } from '../plugin-tree-surface.js'
import type { CompositeTargetStore } from '../storage/composite-target-store.js'
import {
  type ClientModuleRegistry,
  type ClientModulesChanged,
  createClientModuleRegistry,
  defaultClientModuleSnapshotDirectory,
} from './client-modules.js'
import {
  type PackageOperationKind,
  type PackageOperationStore,
  packageOperationTerminal,
  type StoredPackageOperation,
  withOperationState,
} from './operations.js'
import {
  type PackageAdminAuthority,
  type PackageAdminAuthorityResolver,
  requirePackageAdmin,
  requirePackageAdminPermissions,
} from './permissions.js'
import type { PackageProfileDirectory } from './project.js'

export type PackageActivationActual = PackageInstalledDescriptor['actual']
export type PackageActivationObservation = Readonly<{
  actual: PackageActivationActual
  actualVersion?: string
  actualIntegrity?: string
  actualReason?: string
  cleanupPending?: boolean
}>

/**
 * CompositeTargetStore owns runtime reconciliation. PackageAdmin invokes this narrow hook only
 * after PackageManager has committed desired state; the adapter cannot write locks or bypass the
 * package manager's lifecycle checks.
 */
export type PackageActivationAdapter = Readonly<{
  /** Whether nothing of the package runs or is about to. Absent means the adapter cannot tell. */
  stopped?(profile: string, packageId: string): Promise<boolean>
  actual(
    profile: string,
    packageId: string,
  ): Promise<PackageActivationActual | PackageActivationObservation | undefined>
  /** Remove dormant target references and active pins before PackageManager's hard removal gate. */
  prepareRemoval?(profile: string, packageId: string): Promise<void>
  reconcile(input: {
    profile: string
    packageId: string
    operationId: string
    operation: 'enable' | 'disable' | 'update' | 'rollback' | 'remove'
    signal: AbortSignal
  }): Promise<PackageActivationObservation & { error?: PackageAdminError }>
}>

export type RuntimePinReleaseOutcome = RuntimePinReleaseResult['outcome']

/**
 * Orphan-pin recovery lane, parallel to PackageActivationAdapter: read-only inspect plus an
 * explicit, re-verified release. Never auto-triggered; every call is an operator action.
 */
export type RuntimePinsAdapter = Readonly<{
  inspect(
    profile: string,
  ): Promise<{ orphans: readonly RuntimePinDescriptor[] } | { error: PackageAdminError }>
  release(
    profile: string,
    pinIds: readonly string[],
  ): Promise<{ results: readonly RuntimePinReleaseResult[] } | { error: PackageAdminError }>
}>

export type PackageAdminService = Readonly<{
  call(
    method: PackageAdminMethodName,
    params: unknown,
    authority: PackageAdminAuthority | undefined,
  ): Promise<unknown>
  recover(): Promise<void>
  rebuildClientModules(profile: string): Promise<void>
  subscribe(listener: (operation: PackageOperation) => void): () => void
  subscribeClientModules(listener: (event: ClientModulesChanged) => void): () => void
  closeClientModules(): void
}>

type Catalog = Readonly<{
  read(input?: { offline?: boolean; signal?: AbortSignal }): Promise<CatalogRead>
}>
type EffectParams = Record<string, unknown> & { profile: string; clientId: string; commandId: string }
type OperationProgress = Readonly<{
  phase: 'fetching' | 'inspecting' | 'committing' | 'completed'
  percent: number
}>
type Applied = 'yes' | 'no' | 'unknown'

const kindByMethod: Partial<Record<PackageAdminMethodName, PackageOperationKind>> = {
  '_agnes/v1/packages.inspect': 'inspect',
  '_agnes/v1/packages.install': 'install',
  '_agnes/v1/packages.trust': 'trust',
  '_agnes/v1/packages.untrust': 'untrust',
  '_agnes/v1/packages.enable': 'enable',
  '_agnes/v1/packages.disable': 'disable',
  '_agnes/v1/packages.update': 'update',
  '_agnes/v1/packages.rollback': 'rollback',
  '_agnes/v1/packages.remove': 'remove',
}
const actuals = new Set<PackageActivationActual>([
  'not-running',
  'starting',
  'running',
  'failed',
  'restart-required',
  'unavailable',
])
const safeMessage: Record<PackageAdminError['code'], string> = {
  E_PACKAGE_SOURCE: 'The package source could not be accepted.',
  E_PACKAGE_INTEGRITY: 'Package data could not be verified.',
  E_PACKAGE_TRUST: 'The package does not meet the required trust policy.',
  E_PACKAGE_STATE: 'The package operation cannot run in the current state.',
  E_PACKAGE_BLOCKED: 'The package operation is blocked by active references or policy.',
  E_PACKAGE_PREVIEW_STALE: 'The preview no longer matches the package source.',
  E_PACKAGE_CANCELLED: 'The package operation was cancelled.',
}
const safeWarningMessage = {
  'unverified-provenance': 'Package provenance has not been independently verified.',
  unlicensed: 'Package license information is unavailable.',
  'capability-change': 'The package requests capabilities that require review.',
  'runtime-support-change': 'The package runtime support changed.',
  'dependency-change': 'The package dependency set changed.',
  'service-grant-change': 'The package service grants changed.',
} as const

function effectPayload(method: PackageAdminMethodName, params: EffectParams): string {
  const { clientId: _clientId, commandId: _commandId, ...payload } = params
  return createHash('sha256').update(jcs({ method, payload }), 'utf8').digest('hex')
}

function receipt(operation: PackageOperation): PackageOperationReceipt {
  return { operationId: operation.operationId, profile: operation.profile }
}

function safeBlockers(input: unknown): PackageAdminError['blockers'] {
  const safeReference = (value: string): string =>
    /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value) && !/[A-Za-z0-9_-]{40,}/.test(value)
      ? value
      : 'redacted'
  if (!Array.isArray(input)) return []
  return input
    .filter((value) => validatePackageAdminData('PackageBlocker', value).ok)
    .map((value) => ({
      code: (value as { code: PackageAdminError['blockers'][number]['code'] }).code,
      references: (value as { references: string[] }).references.map(safeReference),
    }))
}

function safeWarnings(input: unknown): PackagePreview['warnings'] {
  if (!Array.isArray(input)) return []
  return input
    .filter((value) => validatePackageAdminData('PackageWarning', value).ok)
    .map((value) => {
      const code = (value as { code: keyof typeof safeWarningMessage }).code
      return { code, safeMessage: safeWarningMessage[code] }
    })
}

function packageError(error: unknown): PackageAdminError {
  const raw = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const code: PackageAdminError['code'] =
    typeof raw.code === 'string' && Object.hasOwn(safeMessage, raw.code)
      ? (raw.code as PackageAdminError['code'])
      : 'E_PACKAGE_STATE'
  const detail =
    raw.detail && typeof raw.detail === 'object' ? (raw.detail as Record<string, unknown>) : undefined
  const blockers = safeBlockers(detail?.blockers)
  return { code, safeMessage: safeMessage[code], blockers }
}

function operationError(error: PackageAdminError): never {
  throw rpcError('SEMANTIC_REJECTED', { reason: error.code })
}

function projectSource(value: unknown): PackageInstalledDescriptor['source'] {
  const checked = validatePackageAdminData('PackageSource', value)
  if (!checked.ok) throw rpcError('SEMANTIC_REJECTED', { reason: 'E_PACKAGE_STATE' })
  const source = checked.value as PackageInstalledDescriptor['source']
  try {
    const parsed = parseSource(source.ref)
    if (parsed.type !== source.type || parsed.ref !== source.ref) throw new Error('source changed')
  } catch {
    throw rpcError('SEMANTIC_REJECTED', { reason: 'E_PACKAGE_SOURCE' })
  }
  return structuredClone(source)
}

function normalizeObservation(
  value: PackageActivationActual | PackageActivationObservation | undefined,
): PackageActivationObservation | undefined {
  if (typeof value === 'string') return actuals.has(value) ? { actual: value } : undefined
  if (!value || !actuals.has(value.actual)) return undefined
  const reason =
    value.actualReason === undefined
      ? undefined
      : value.actual === 'failed'
        ? 'Runtime activation failed.'
        : 'Runtime state detail is available.'
  return {
    actual: value.actual,
    ...(value.actualVersion === undefined ? {} : { actualVersion: value.actualVersion }),
    ...(value.actualIntegrity === undefined ? {} : { actualIntegrity: value.actualIntegrity }),
    ...(reason === undefined ? {} : { actualReason: reason }),
    ...(value.cleanupPending === undefined ? {} : { cleanupPending: value.cleanupPending }),
  }
}

function projectPackage(
  row: InstalledPackage,
  observation: PackageActivationObservation,
): PackageInstalledDescriptor {
  const value: PackageInstalledDescriptor = {
    id: row.id,
    version: row.entry.version,
    source: projectSource(row.entry.source),
    integrity: row.entry.integrity,
    trusted: row.trusted,
    desired: row.enabled ? 'enabled' : 'installed-disabled',
    actual: observation.actual,
    ...(observation.actualVersion === undefined ? {} : { actualVersion: observation.actualVersion }),
    ...(observation.actualIntegrity === undefined ? {} : { actualIntegrity: observation.actualIntegrity }),
    ...(observation.actualReason === undefined ? {} : { actualReason: observation.actualReason }),
    ...(observation.cleanupPending === undefined ? {} : { cleanupPending: observation.cleanupPending }),
    rollbackTarget: row.verifiedRollbackTarget
      ? {
          version: row.verifiedRollbackTarget.version,
          integrity: row.verifiedRollbackTarget.integrity,
          capabilityHash: row.verifiedRollbackTarget.capabilityHash,
        }
      : null,
    contributions: structuredClone([...row.contributions]),
    blockers: safeBlockers(row.blockers),
    capabilityHash: row.capabilityHash,
  }
  if (!validatePackageAdminData('PackageInstalledDescriptor', value).ok)
    throw rpcError('SEMANTIC_REJECTED', { reason: 'E_PACKAGE_STATE' })
  return value
}

function projectPreview(preview: PackagePreview): PackagePreview {
  const value: PackagePreview = {
    ...preview,
    source: projectSource(preview.source),
    provenance: { ...preview.provenance, source: projectSource(preview.provenance.source) },
    blockers: safeBlockers(preview.blockers),
    warnings: safeWarnings(preview.warnings),
  }
  if (!validatePackageAdminData('PackagePreview', value).ok)
    throw rpcError('SEMANTIC_REJECTED', { reason: 'E_PACKAGE_STATE' })
  return value
}

function projectCatalogDescriptor(value: unknown): PackageCatalogDescriptor {
  const checked = validatePackageAdminData('PackageCatalogDescriptor', value)
  if (!checked.ok) throw rpcError('SEMANTIC_REJECTED', { reason: 'E_PACKAGE_STATE' })
  const entry = checked.value as PackageCatalogDescriptor
  // Keep the canonical PM4 source. It is the inspect/install input, and its grammar already rejects
  // credentials and absolute file paths; replacing it with a display label would break the digest
  // confirmation binding.
  const projected: PackageCatalogDescriptor = {
    ...entry,
    source: projectSource(entry.source),
    contributions: structuredClone(entry.contributions),
  }
  if (!validatePackageAdminData('PackageCatalogDescriptor', projected).ok)
    throw rpcError('SEMANTIC_REJECTED', { reason: 'E_PACKAGE_STATE' })
  return projected
}

function sortCatalog(entries: readonly PackageCatalogDescriptor[]): PackageCatalogDescriptor[] {
  return [...entries].sort((left, right) => {
    const a = `${left.id}\u0000${left.version}\u0000${left.sourceId}`
    const b = `${right.id}\u0000${right.version}\u0000${right.sourceId}`
    return a < b ? -1 : a > b ? 1 : 0
  })
}

class Service implements PackageAdminService {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly active = new Map<string, AbortController>()
  private readonly listeners = new Set<(operation: PackageOperation) => void>()
  private readonly clientModules: ClientModuleRegistry
  private readonly boot: Promise<void>
  private recoveryError: PackageAdminError | undefined

  constructor(
    private readonly options: {
      manager: PackageManager
      profileDirectory: PackageProfileDirectory
      operations: PackageOperationStore
      catalog?: Catalog
      activation?: PackageActivationAdapter
      runtimePins?: RuntimePinsAdapter
      clientModules?: ClientModuleRegistry
      pluginTree?: CompositeTargetStore | (() => CompositeTargetStore | undefined)
      revokeRuntimePackage?: (packageId: string) => Promise<void>
      /** Production publisher: validates in an isolated probe before changing desired state. */
      pluginTreePublisher?: (artifact: RuntimeTargetArtifact) => Promise<void>
      workerGeneration?: () => number | undefined
      /** Private launcher BFF dispatch. The registry performs row/snapshot authority checks first. */
      clientServiceCall?: (
        input: ClientModuleServiceCallParams & Readonly<{ packageId: string; extension: string }>,
      ) => Promise<ExtensionCallResult>
      /** Explicitly authorized effect dispatch; row authority is rechecked immediately before it. */
      clientEffectCall?: (
        input: ClientModuleEffectCallParams & Readonly<{ packageId: string; extension: string }>,
        authority: PackageAdminAuthority,
      ) => Promise<ExtensionCallResult>
      clock: () => string
    },
  ) {
    this.clientModules =
      options.clientModules ??
      createClientModuleRegistry({
        snapshotDirectory: defaultClientModuleSnapshotDirectory,
        clock: () => new Date(options.clock()),
      })
    // A malformed journal must never become an unhandled rejection during daemon startup. Hold the
    // service in a durable-unhealthy state instead: catalog remains available, while profile list,
    // operation history and all work get one deterministic refusal so callers enter recovery mode.
    this.boot = this.recoverPending().catch(() => {
      this.recoveryError = {
        code: 'E_PACKAGE_INTEGRITY',
        safeMessage: safeMessage.E_PACKAGE_INTEGRITY,
        blockers: [],
      }
    })
  }

  subscribe(listener: (operation: PackageOperation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeClientModules(listener: (event: ClientModulesChanged) => void): () => void {
    return this.clientModules.subscribe(listener)
  }

  closeClientModules(): void {
    this.clientModules.close()
  }

  async recover(): Promise<void> {
    await this.boot
  }

  async rebuildClientModules(profile: string): Promise<void> {
    const directory = await this.options.profileDirectory(profile)
    await this.refreshClientModules(profile, directory, 'rebuilt')
  }

  private async recoverPending(): Promise<void> {
    const pending = await this.options.operations.pending()
    for (const operation of pending)
      this.schedule(operation.operation.operationId, operation.operation.profile)
  }

  async call(
    method: PackageAdminMethodName,
    params: unknown,
    authority: PackageAdminAuthority | undefined,
  ): Promise<unknown> {
    const granted = requirePackageAdmin(method, authority)
    const checked = validatePackageAdminCall(method, 'params', params)
    if (!checked.ok) throw rpcError('INVALID_PARAMS', { code: 'INVALID' })
    const data = checked.value as Record<string, unknown>
    if (method === '_agnes/v1/packages.update' && 'activation' in data)
      requirePackageAdminPermissions(method, granted, [
        'packages.install',
        'packages.trust',
        'packages.activate',
      ])
    if (method === '_agnes/v1/packages.rollback' && 'activation' in data)
      requirePackageAdminPermissions(method, granted, [
        'packages.remove',
        'packages.trust',
        'packages.activate',
      ])
    await this.boot
    // `recoveryError` is set only when recoverPending() -- reading the *operations store*'s pending
    // ledger -- fails on boot. `pins.inspect`/`pins.release` never read or write that store (no
    // `operations.admit()`, not in `kindByMethod`, see below): they read CompositeTargetStore pins
    // through `options.runtimePins`. Deliberately NOT gating pins.* on `this.recoveryError` here: a
    // corrupt operations ledger does not make the pin set untrustworthy, and gating on it would refuse
    // a separately-verified read/effect for an unrelated failure.
    if (
      this.recoveryError &&
      (method === '_agnes/v1/packages.list' ||
        // skins.list reads the same profile lockfile packages.list does, so a corrupt operations
        // ledger makes its answer equally untrustworthy.
        method === '_agnes/v1/skins.list' ||
        method === '_agnes/v1/skins.read' ||
        method === '_agnes/v1/clientModules.list' ||
        method === '_agnes/v1/clientModules.read' ||
        // callService/callEffect rebuild the identical roster via clientModules.list(...) before
        // dispatching into extension backend code, so they share its exact untrustworthy-during-
        // recovery risk.
        method === '_agnes/v1/clientModules.callService' ||
        method === '_agnes/v1/clientModules.callEffect' ||
        method === '_agnes/v1/packages.operation.get' ||
        method === '_agnes/v1/packages.operation.cancel' ||
        // packages.trustWorkspace: unlike pins.*, this destructively rewrites the profile lock
        // (dropping every workspace-sourced entry), so it must not run while pending operations are
        // unknown -- gated here even though it never reads the operations store itself.
        method === '_agnes/v1/packages.trustWorkspace' ||
        kindByMethod[method] !== undefined)
    )
      operationError(this.recoveryError)
    try {
      if (method === '_agnes/v1/packages.catalog.list')
        return await this.catalogList(
          data as { profile: string; query?: string; cursor?: string; limit?: number },
        )
      if (method === '_agnes/v1/packages.catalog.get')
        return await this.catalogGet(data as { profile: string; id: string; version?: string })
      if (method === '_agnes/v1/packages.list') return await this.list(data as { profile: string })
      if (method === '_agnes/v1/plugins.tree.get')
        return this.pluginTreeView(data as { profile: string }, true)
      if (method === '_agnes/v1/plugins.tree.list')
        return this.pluginTreeView(data as { profile: string }, false)
      if (method === '_agnes/v1/plugins.tree.apply')
        return this.pluginTreeApplyCall(data as { artifact: RuntimeTargetArtifact })
      if (method === '_agnes/v1/plugins.tree.rollback') return this.pluginTreeRollbackCall()
      if (method === '_agnes/v1/skins.list') return await this.skinsList(data as { profile: string })
      if (method === '_agnes/v1/skins.read')
        return await this.skinsRead(data as { profile: string; path: string })
      if (method === '_agnes/v1/clientModules.list')
        return await this.clientModulesList(data as { profile: string })
      if (method === '_agnes/v1/clientModules.read')
        return await this.clientModulesRead(data as { profile: string; path: string })
      if (method === '_agnes/v1/clientModules.callService')
        return await this.clientModulesCallService(data as ClientModuleServiceCallParams)
      if (method === '_agnes/v1/clientModules.callEffect')
        return await this.clientModulesCallEffect(data as ClientModuleEffectCallParams, granted)
      if (method === '_agnes/v1/packages.operation.get')
        return await this.operationGet(data as { profile: string; operationId: string }, granted)
      if (method === '_agnes/v1/packages.operation.cancel')
        return await this.cancel(data as EffectParams & { operationId: string }, granted)
      if (method === '_agnes/v1/packages.trustWorkspace')
        return await this.trustWorkspace(data as EffectParams & { deployDir: string }, granted)
      // Not gated by `this.recoveryError` above -- see the comment on that check for why.
      if (method === '_agnes/v1/packages.pins.inspect')
        return await this.pinsInspect(data as { profile: string })
      if (method === '_agnes/v1/packages.pins.release')
        return await this.pinsRelease(data as EffectParams & { pinIds: string[] }, granted)
      const kind = kindByMethod[method]
      if (!kind) throw rpcError('METHOD_NOT_FOUND', { method })
      return await this.effect(method, kind, data as EffectParams, granted)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') throw error
      operationError(packageError(error))
    }
  }

  private pluginTreeStore(): CompositeTargetStore | undefined {
    const tree = this.options.pluginTree
    return typeof tree === 'function' ? tree() : tree
  }

  private async skinRosterInput(
    profileDirectory: string,
    inventory: InstalledInventory,
  ): Promise<Readonly<{ inventory: InstalledInventory; activeRows: ReadonlySet<string> }>> {
    const store = this.pluginTreeStore()
    const actual = store && pluginTreeList(store, inventory.profile, this.options.workerGeneration?.()).actual
    const artifact = store?.desired()
    const report = store?.report()
    if (!actual?.actual || !artifact || !report?.ok || report.hash !== artifact.identity.treeHash)
      return { inventory, activeRows: new Set() }
    try {
      const pins = await this.options.manager.listRuntimePins(profileDirectory)
      const activePins = new Map(
        pins
          .filter((pin) => pin.purpose === 'active' && pin.pinId === activeRuntimePinId(pin.snapshot))
          .map((pin) => [`${pin.snapshot.packageId}\0${pin.snapshot.integrity}`, pin.snapshot]),
      )
      const activeIds = new Set(report.rows.filter((row) => row.state === 'active').map((row) => row.id))
      const activeRows = new Set<string>()
      const packageRevisions = new Map<string, string>()
      for (const row of decodeRuntimeTargetArtifact(artifact).tree.rows) {
        if (row.disabled || !activeIds.has(row.id) || row.id.startsWith('web:')) continue
        const packageId = packageOfRow(row.plugin)
        if (packageId && activePins.has(`${packageId}\0${row.entryRevision}`)) {
          activeRows.add(`${row.id}\0${packageId}\0${row.entryRevision}`)
          const prior = packageRevisions.get(packageId)
          packageRevisions.set(packageId, prior && prior !== row.entryRevision ? '' : row.entryRevision)
        }
      }
      return {
        inventory: {
          ...inventory,
          packages: inventory.packages.map((pkg) => {
            const revision = packageRevisions.get(pkg.id)
            const snapshot = revision ? activePins.get(`${pkg.id}\0${revision}`) : undefined
            return snapshot
              ? {
                  ...pkg,
                  entry: { ...pkg.entry, integrity: snapshot.integrity },
                  directory: snapshot.directory,
                  contributions: snapshot.contributions,
                }
              : { ...pkg, directory: null, contributions: [] }
          }),
        },
        activeRows,
      }
    } catch {
      return { inventory, activeRows: new Set() }
    }
  }

  private pluginTreeView(params: { profile: string }, includeDesired: boolean) {
    const store = this.pluginTreeStore()
    if (!store) return { actual: false, pending: false }
    const listed = pluginTreeList(store, params.profile, this.options.workerGeneration?.())
    const actual = listed.actual
    return {
      actual: actual?.actual ?? false,
      pending: actual?.pending ?? Boolean(listed.desired),
      ...(listed.desired ? { desiredDigest: listed.desired.digest, identity: listed.desired.identity } : {}),
      ...(actual?.reportOk !== undefined ? { reportOk: actual.reportOk } : {}),
      ...(actual?.failurePhase ? { failurePhase: actual.failurePhase } : {}),
      ...(actual?.workerGeneration !== undefined ? { workerGeneration: actual.workerGeneration } : {}),
      ...(includeDesired && listed.desired ? { desired: listed.desired } : {}),
    }
  }

  private async pluginTreeApplyCall(params: { artifact: RuntimeTargetArtifact }) {
    const store = this.pluginTreeStore()
    if (!store) throw { code: 'E_PACKAGE_STATE' }
    const publish = this.options.pluginTreePublisher
    if (!publish) throw { code: 'E_PACKAGE_STATE' }
    await publish(params.artifact)
    return { desiredDigest: params.artifact.digest, pending: true }
  }

  private async pluginTreeRollbackCall() {
    const store = this.pluginTreeStore()
    if (!store) return { rolledBack: false }
    const publish = this.options.pluginTreePublisher
    if (!publish) throw { code: 'E_PACKAGE_STATE' }
    const previous = store.previous()
    if (!previous) return { rolledBack: false }
    await publish(previous)
    return { rolledBack: true, desiredDigest: previous.digest }
  }

  private async catalogList(params: { profile: string; query?: string; cursor?: string; limit?: number }) {
    await this.options.profileDirectory(params.profile)
    const read = this.options.catalog ? await this.options.catalog.read({ offline: true }) : { entries: [] }
    const entries = sortCatalog(read.entries.map(projectCatalogDescriptor))
    const query = params.query?.toLowerCase()
    const visible = query ? entries.filter((entry) => entry.id.toLowerCase().includes(query)) : entries
    const cursor = params.cursor
    const start = cursor ? visible.findIndex((entry) => `${entry.id}@${entry.version}` === cursor) + 1 : 0
    const limit = params.limit ?? 50
    const items = visible.slice(Math.max(0, start), Math.max(0, start) + limit)
    const last = items.at(-1)
    return {
      items,
      nextCursor: last && start + items.length < visible.length ? `${last.id}@${last.version}` : null,
    }
  }

  private async catalogGet(params: {
    profile: string
    id: string
    version?: string
  }): Promise<PackageCatalogDescriptor> {
    await this.options.profileDirectory(params.profile)
    const read = this.options.catalog ? await this.options.catalog.read({ offline: true }) : { entries: [] }
    const item = sortCatalog(read.entries.map(projectCatalogDescriptor)).find(
      (entry) => entry.id === params.id && (params.version === undefined || entry.version === params.version),
    )
    if (!item) throw rpcError('SEMANTIC_REJECTED', { reason: 'PACKAGE_CATALOG_ENTRY_UNAVAILABLE' })
    return item
  }

  private async list(params: { profile: string }): Promise<{ packages: PackageInstalledDescriptor[] }> {
    const directory = await this.options.profileDirectory(params.profile)
    const inventory = await this.options.manager.inventory(directory)
    return { packages: await this.projectInventory(params.profile, inventory) }
  }

  /**
   * Selectable skins for one profile. Skin ids are unique across the roster, so `cssUrl` addresses a
   * skin by id alone and the stylesheet's relative `url(...)` references land under `assetBase`.
   */
  private async skinsList(params: { profile: string }): Promise<SkinListResult> {
    const directory = await this.options.profileDirectory(params.profile)
    const inventory = await this.options.manager.inventory(directory)
    const skins = await this.skinRosterInput(directory, inventory)
    const roster = collectSkinRoster(skins.inventory, [], skins.activeRows)
    return {
      revision: roster.revision,
      skins: roster.skins.map((skin) => {
        // The stylesheet rides the roster: it is small text, and sending it here means a skin that
        // ships no assets needs no second request at all. Over the inline cap it is dropped and the
        // client falls back to cssUrl, which does require the asset route.
        // A packaged distribution carries builtin skins in the build; a source checkout reads
        // them from disk. Prefer whatever the roster actually resolved.
        const css = inlineSkinCss(skin)
        return {
          id: skin.id,
          name: skin.name,
          packageName: skin.packageName,
          cssUrl: skinCssUrl(skin.id),
          ...(css === undefined ? {} : { css }),
          ...(skin.assetsDir === undefined ? {} : { assetBase: `/skins/${skin.id}/assets/` }),
          ...(Object.keys(skin.tokens).length === 0 ? {} : { tokens: skin.tokens }),
        }
      }),
      shadowed: roster.shadowed,
    }
  }

  /**
   * Bytes for one skin route path, for the launcher's same-origin asset proxy.
   *
   * The path authority is `resolveSkinAsset` — the very function the in-process HTTP route used
   * before this channel existed — so there is exactly one place that decides which files a skin
   * route may reach. It only answers for ids the enabled+trusted roster claims, and a miss and a
   * refusal are deliberately the same answer, so the response cannot be used to probe the package
   * directory layout (design §22.3).
   */
  private async skinsRead(params: { profile: string; path: string }): Promise<SkinReadResult> {
    const directory = await this.options.profileDirectory(params.profile)
    const inventory = await this.options.manager.inventory(directory)
    const skins = await this.skinRosterInput(directory, inventory)
    const resolved = resolveSkinAsset(collectSkinRoster(skins.inventory, [], skins.activeRows), params.path)
    if (resolved === null) return { found: false }
    // A file that grew after install must not be streamed: the install-time cap for its class is
    // also the ceiling on what this channel will hand out (design §22.3). `resolveSkinAsset` only
    // ever accepts `<id>/skin.css` or `<id>/assets/...`, so the suffix identifies the class.
    const cap = params.path.endsWith('/skin.css') ? SKIN_MAX_CSS_BYTES : SKIN_MAX_ASSET_BYTES
    try {
      if (statSync(resolved).size > cap) return { found: false }
      return { found: true, base64: readFileSync(resolved).toString('base64') }
    } catch {
      // Vanished between resolution and read: the same negative answer as any other miss.
      return { found: false }
    }
  }

  private async clientModulesList(params: { profile: string }): Promise<ClientModuleListResult> {
    const directory = await this.options.profileDirectory(params.profile)
    const inventory = await this.options.manager.inventory(directory)
    const result = await this.clientModules.list({
      profile: params.profile,
      profileDirectory: directory,
      inventory,
      actual: async (packageId) => {
        if (!this.options.activation) return undefined
        return normalizeObservation(await this.options.activation.actual(params.profile, packageId))
      },
      refreshInventory: () => this.options.manager.inventory(directory),
    })
    return projectClientModuleRows(result)
  }

  private async clientModulesRead(params: {
    profile: string
    path: string
  }): Promise<ClientModuleReadResult> {
    const directory = await this.options.profileDirectory(params.profile)
    const inventory = await this.options.manager.inventory(directory)
    return await this.clientModules.read({
      profile: params.profile,
      profileDirectory: directory,
      inventory,
      path: params.path,
      actual: async (packageId) => {
        if (!this.options.activation) return undefined
        return normalizeObservation(await this.options.activation.actual(params.profile, packageId))
      },
      refreshInventory: () => this.options.manager.inventory(directory),
    })
  }

  /**
   * The browser never reaches this typed call directly. The local launcher BFF is the sole caller,
   * but revalidate against a freshly reconciled roster so stale rows, disabled packages, untrust,
   * rollback and a removed backend cannot retain authority between page frames.
   */
  private async clientModulesCallService(
    params: ClientModuleServiceCallParams,
  ): Promise<ExtensionCallResult> {
    const directory = await this.options.profileDirectory(params.profile)
    const inventory = await this.options.manager.inventory(directory)
    const roster = await this.clientModules.list({
      profile: params.profile,
      profileDirectory: directory,
      inventory,
      actual: async (packageId) => {
        if (!this.options.activation) return undefined
        return normalizeObservation(await this.options.activation.actual(params.profile, packageId))
      },
      refreshInventory: () => this.options.manager.inventory(directory),
    })
    const row = roster.rows?.find(
      (candidate) =>
        candidate.rowId === params.rowId &&
        candidate.enabled &&
        candidate.phase === 'ready' &&
        candidate.services?.includes(params.service),
    )
    // A service belongs to the client extension itself, not merely another backend extension in the
    // same package. This blocks a UI row from borrowing a sibling extension's capability by name.
    if (!row?.packageId || !row.extIds?.includes(row.moduleName) || !this.options.clientServiceCall)
      throw rpcError('CAPABILITY_DENIED')
    const result = await this.options.clientServiceCall({
      ...params,
      packageId: row.packageId,
      extension: row.moduleName,
    })
    if (!validatePackageAdminCall('_agnes/v1/clientModules.callService', 'result', result).ok)
      throw rpcError('INTERNAL_ERROR')
    return result
  }

  private async clientModulesCallEffect(
    params: ClientModuleEffectCallParams,
    authority: PackageAdminAuthority,
  ): Promise<ExtensionCallResult> {
    const directory = await this.options.profileDirectory(params.profile)
    const inventory = await this.options.manager.inventory(directory)
    const roster = await this.clientModules.list({
      profile: params.profile,
      profileDirectory: directory,
      inventory,
      actual: async (packageId) => {
        if (!this.options.activation) return undefined
        return normalizeObservation(await this.options.activation.actual(params.profile, packageId))
      },
      refreshInventory: () => this.options.manager.inventory(directory),
    })
    const row = roster.rows?.find(
      (candidate) =>
        candidate.rowId === params.rowId &&
        candidate.enabled &&
        candidate.phase === 'ready' &&
        candidate.services?.includes(params.service),
    )
    if (!row?.packageId || !row.extIds?.includes(row.moduleName) || !this.options.clientEffectCall)
      throw rpcError('CAPABILITY_DENIED')
    const result = await this.options.clientEffectCall(
      { ...params, packageId: row.packageId, extension: row.moduleName },
      authority,
    )
    if (!validatePackageAdminCall('_agnes/v1/clientModules.callEffect', 'result', result).ok)
      throw rpcError('INTERNAL_ERROR')
    return result
  }

  /** Rebuild after a durable package transition; failure is observable through a blocked roster
   * on the next read and must never rewrite an already-terminal package operation. */
  private async refreshClientModules(
    profile: string,
    directory: string,
    reason: ClientModulesChanged['reason'],
    packageId?: string,
  ): Promise<void> {
    try {
      const inventory = await this.options.manager.inventory(directory)
      await this.clientModules.refresh(
        {
          profile,
          profileDirectory: directory,
          inventory,
          actual: async (id) => {
            if (!this.options.activation) return undefined
            return normalizeObservation(await this.options.activation.actual(profile, id))
          },
          refreshInventory: () => this.options.manager.inventory(directory),
        },
        reason,
        packageId,
      )
    } catch {
      // The package operation has already reached its durable terminal state. A later list retries
      // reconstruction and reports a safe blocked status instead of corrupting operation history.
    }
  }

  private async pinsInspect(params: {
    profile: string
  }): Promise<{ orphans: readonly RuntimePinDescriptor[] }> {
    await this.options.profileDirectory(params.profile)
    if (!this.options.runtimePins)
      operationError({ code: 'E_PACKAGE_STATE', safeMessage: safeMessage.E_PACKAGE_STATE, blockers: [] })
    const result = await this.options.runtimePins.inspect(params.profile)
    if ('error' in result) operationError(result.error)
    return { orphans: result.orphans }
  }

  private async pinsRelease(
    params: EffectParams & { pinIds: string[] },
    authority: PackageAdminAuthority,
  ): Promise<{ results: readonly RuntimePinReleaseResult[] }> {
    this.requireBoundClient('_agnes/v1/packages.pins.release', params, authority)
    await this.options.profileDirectory(params.profile)
    if (!this.options.runtimePins)
      operationError({ code: 'E_PACKAGE_STATE', safeMessage: safeMessage.E_PACKAGE_STATE, blockers: [] })
    const result = await this.options.runtimePins.release(params.profile, params.pinIds)
    if ('error' in result) operationError(result.error)
    return { results: result.results }
  }

  private async trustWorkspace(
    params: EffectParams & { deployDir: string },
    authority: PackageAdminAuthority,
  ): Promise<{ hash: string }> {
    this.requireBoundClient('_agnes/v1/packages.trustWorkspace', params, authority)
    const directory = await this.options.profileDirectory(params.profile)
    const result = await this.options.manager.trustWorkspace(directory, params.deployDir)
    await this.refreshClientModules(params.profile, directory, 'trust')
    return result
  }

  private async operationGet(
    params: { profile: string; operationId: string },
    authority: PackageAdminAuthority,
  ): Promise<PackageOperation> {
    await this.options.profileDirectory(params.profile)
    const found = await this.options.operations.get(params.profile, params.operationId)
    // Operation.get is a read method and its approved DTO has no clientId. Principal ownership still
    // prevents one authenticated administrator from observing another administrator's operation.
    if (!found || found.identity.principalId !== authority.principalId)
      throw rpcError('SEMANTIC_REJECTED', { reason: 'PACKAGE_OPERATION_UNAVAILABLE' })
    return structuredClone(found.operation)
  }

  private async effect(
    method: PackageAdminMethodName,
    kind: PackageOperationKind,
    params: EffectParams,
    authority: PackageAdminAuthority,
  ): Promise<PackageOperationReceipt> {
    this.requireBoundClient(method, params, authority)
    await this.options.profileDirectory(params.profile)
    const operation = {
      operationId: `pkg-${createHash('sha256').update(`${authority.principalId}\u0000${params.clientId}\u0000${params.commandId}`).digest('hex').slice(0, 32)}`,
      profile: params.profile,
      operation: kind,
      ...(typeof params.id === 'string' ? { packageId: params.id } : {}),
      cancellable: true,
      retryable: false,
      state: 'received' as const,
      progress: 0,
      startedAt: this.options.clock(),
      updatedAt: this.options.clock(),
    }
    const admitted = await this.options.operations.admit({
      operation,
      identity: {
        principalId: authority.principalId,
        clientId: params.clientId,
        commandId: params.commandId,
      },
      payloadHash: effectPayload(method, params),
      request: { kind, params: structuredClone(params) },
    })
    if (admitted.state === 'conflict')
      throw rpcError('SEMANTIC_REJECTED', { reason: 'PACKAGE_COMMAND_ID_CONFLICT' })
    this.schedule(admitted.record.operation.operationId, admitted.record.operation.profile)
    return receipt(admitted.record.operation)
  }

  private async cancel(
    params: EffectParams & { operationId: string },
    authority: PackageAdminAuthority,
  ): Promise<PackageOperationReceipt> {
    this.requireBoundClient('_agnes/v1/packages.operation.cancel', params, authority)
    await this.options.profileDirectory(params.profile)
    const command = await this.options.operations.admitCancel({
      identity: {
        principalId: authority.principalId,
        clientId: params.clientId,
        commandId: params.commandId,
      },
      payloadHash: effectPayload('_agnes/v1/packages.operation.cancel', params),
      operationId: params.operationId,
      params: structuredClone(params),
    })
    if (command.state === 'conflict')
      throw rpcError('SEMANTIC_REJECTED', { reason: 'PACKAGE_COMMAND_ID_CONFLICT' })
    const record = await this.options.operations.get(params.profile, command.operationId)
    if (
      !record ||
      record.identity.principalId !== authority.principalId ||
      record.identity.clientId !== authority.clientId
    )
      throw rpcError('SEMANTIC_REJECTED', { reason: 'PACKAGE_OPERATION_UNAVAILABLE' })
    if (!packageOperationTerminal(record.operation.state)) {
      this.active
        .get(record.operation.operationId)
        ?.abort(new Error('package operation cancellation requested'))
      const cancelled = await this.update(record.operation.operationId, (current) =>
        withOperationState(current, {
          state: current.operation.state,
          now: this.options.clock(),
          cancelRequested: true,
        }),
      )
      // Queued work is terminal immediately. A manager call already inside its small atomic commit keeps
      // running and reports its real terminal state rather than claiming cancellation prematurely.
      if (cancelled.operation.state === 'received')
        await this.update(record.operation.operationId, (current) =>
          withOperationState(current, {
            state: 'cancelled',
            now: this.options.clock(),
            error: {
              code: 'E_PACKAGE_CANCELLED',
              safeMessage: safeMessage.E_PACKAGE_CANCELLED,
              blockers: [],
            },
            cancelRequested: true,
          }),
        )
    }
    return receipt(record.operation)
  }

  private requireBoundClient(
    method: PackageAdminMethodName,
    params: EffectParams,
    authority: PackageAdminAuthority,
  ): void {
    if (params.clientId !== authority.clientId)
      throw rpcError('CAPABILITY_DENIED', {
        method,
        reason: 'package command client does not match authenticated connection',
      })
  }

  private schedule(operationId: string, profile: string): void {
    if (this.active.has(operationId)) return
    const controller = new AbortController()
    this.active.set(operationId, controller)
    const previous = this.tails.get(profile) ?? Promise.resolve()
    const current = previous.then(
      () => this.run(operationId, controller),
      () => this.run(operationId, controller),
    )
    const settled = current.catch(() => undefined)
    this.tails.set(profile, settled)
    void current.then(
      () => {
        this.active.delete(operationId)
        if (this.tails.get(profile) === settled) this.tails.delete(profile)
      },
      () => {
        this.active.delete(operationId)
        if (this.tails.get(profile) === settled) this.tails.delete(profile)
      },
    )
  }

  private async run(operationId: string, controller: AbortController): Promise<void> {
    let record: StoredPackageOperation | undefined
    let directory: string | undefined
    let execution: StoredPackageOperation | undefined
    let managerCommitted = false
    try {
      record = await this.find(operationId)
      if (!record || packageOperationTerminal(record.operation.state)) return
      directory = await this.options.profileDirectory(record.operation.profile)
      await this.options.manager.recover(directory)
      record = await this.find(operationId)
      if (!record || packageOperationTerminal(record.operation.state)) return
      const pending = record
      if (pending.cancelRequested || controller.signal.aborted) return await this.cancelled(operationId)
      const applied = await this.applied(pending, directory)
      if (applied === 'yes') {
        const reconciliation = await this.reconcile(pending, controller.signal)
        if (reconciliation?.error) return await this.activationFailed(pending, directory, reconciliation)
        return await this.completeFromInventory(pending, directory, reconciliation)
      }
      // Remove without a staging fact is deliberately ambiguous: record the installed target
      // before deciding whether absence proves a committed removal. Other unknown desired-state
      // reads remain fail-closed.
      if (applied === 'unknown' && pending.request.kind !== 'remove')
        return await this.fail(operationId, {
          code: 'E_PACKAGE_INTEGRITY',
          safeMessage: safeMessage.E_PACKAGE_INTEGRITY,
          blockers: [],
        })
      let executing: StoredPackageOperation = pending
      execution = executing
      if (executing.request.kind === 'rollback' && !executing.recovery?.rollbackTargetIntegrity) {
        const inventory = await this.options.manager.inventory(directory)
        const current = inventory.packages.find(
          (entry) => entry.id === (executing.request.params.id as string),
        )
        const target = current?.verifiedRollbackTarget?.integrity
        if (!target)
          return await this.fail(operationId, {
            code: 'E_PACKAGE_STATE',
            safeMessage: safeMessage.E_PACKAGE_STATE,
            blockers: [],
          })
        executing = await this.update(operationId, (value) =>
          withOperationState(value, {
            state: 'staging',
            now: this.options.clock(),
            recovery: { rollbackTargetIntegrity: target },
          }),
        )
        execution = executing
      }
      if (executing.request.kind === 'remove' && !executing.recovery?.removeTargetIntegrity) {
        const inventory = await this.options.manager.inventory(directory)
        const current = inventory.packages.find(
          (entry) => entry.id === (executing.request.params.id as string),
        )
        // Do not turn a missing package into evidence that an unstarted remove committed. The
        // staging record is durable before PackageManager.remove can begin, so recovery can later
        // distinguish a completed destructive effect from an invalid/never-started request.
        if (!current)
          return await this.fail(operationId, {
            code: 'E_PACKAGE_STATE',
            safeMessage: safeMessage.E_PACKAGE_STATE,
            blockers: [],
          })
        executing = await this.update(operationId, (value) =>
          withOperationState(value, {
            state: 'draining',
            now: this.options.clock(),
            recovery: { ...value.recovery, removeTargetIntegrity: current.entry.integrity },
          }),
        )
        execution = executing
      }
      await this.update(operationId, (value) =>
        withOperationState(value, { state: this.startState(value.request.kind), now: this.options.clock() }),
      )
      const outcome = await this.invoke(executing, directory, controller.signal)
      if (outcome.kind === 'preview') {
        await this.update(operationId, (value) =>
          withOperationState(value, {
            state: 'completed',
            progress: 100,
            now: this.options.clock(),
            preview: projectPreview(outcome.preview),
          }),
        )
        return
      }
      // PackageManager completed its desired-state write. A cancellation that arrives while the
      // activation adapter reconciles actual state cannot truthfully roll that committed fact back.
      managerCommitted = true
      await this.update(operationId, (value) =>
        withOperationState(value, {
          state: executing.request.kind === 'remove' ? 'draining' : 'switching',
          now: this.options.clock(),
        }),
      )
      const reconciliation = await this.reconcile(executing, controller.signal)
      if (reconciliation?.error) return await this.activationFailed(executing, directory, reconciliation)
      return await this.completeFromInventory(executing, directory, reconciliation)
    } catch (error) {
      if (controller.signal.aborted || packageError(error).code === 'E_PACKAGE_CANCELLED') {
        // Manager implementations may notice cancellation just after an atomic commit. Re-read the
        // durable desired state before presenting a terminal cancellation; only a proven pre-commit
        // abort becomes `cancelled`.
        const committed =
          managerCommitted ||
          (!!execution &&
            !!directory &&
            (await this.applied(execution, directory).catch(() => 'unknown')) === 'yes')
        if (committed && execution && directory) return this.completeFromInventory(execution, directory)
        return this.cancelled(operationId)
      }
      return this.fail(operationId, packageError(error))
    }
  }

  private async invoke(
    record: StoredPackageOperation,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ kind: 'preview'; preview: PackagePreview } | { kind: 'effect' }> {
    const params = record.request.params as Record<string, unknown>
    if (
      record.request.kind === 'enable' &&
      (params.expectedInstalledIntegrity !== undefined || params.expectedActiveIntegrity !== undefined)
    )
      await this.assertRuntimeBaseline(record.operation.profile, directory, params)
    if (record.request.kind === 'update' && params.activation !== undefined) {
      const activation = params.activation as Record<string, unknown>
      const trust = activation.trust as Record<string, unknown>
      if (trust.integrity !== params.expectedIntegrity) throw { code: 'E_PACKAGE_PREVIEW_STALE' }
      await this.assertRuntimeBaseline(record.operation.profile, directory, {
        ...params,
        expectedInstalledIntegrity: activation.expectedInstalledIntegrity,
        expectedActiveIntegrity: activation.expectedActiveIntegrity,
      })
    }
    if (record.request.kind === 'rollback' && params.activation !== undefined) {
      const activation = params.activation as Record<string, unknown>
      const trust = activation.trust as Record<string, unknown>
      const inventory = await this.options.manager.inventory(directory)
      const row = inventory.packages.find((entry) => entry.id === params.id)
      const target = row?.verifiedRollbackTarget
      if (
        !target ||
        params.expectedTargetIntegrity !== target.integrity ||
        trust.integrity !== params.expectedTargetIntegrity ||
        trust.capabilityHash !== target.capabilityHash
      )
        throw { code: 'E_PACKAGE_PREVIEW_STALE' }
      await this.assertRuntimeBaseline(record.operation.profile, directory, {
        ...params,
        expectedInstalledIntegrity: activation.expectedInstalledIntegrity,
        expectedActiveIntegrity: activation.expectedActiveIntegrity,
      })
    }
    if (
      record.request.kind === 'rollback' &&
      params.activation === undefined &&
      params.expectedTargetIntegrity !== undefined
    ) {
      const inventory = await this.options.manager.inventory(directory)
      const target = inventory.packages.find((entry) => entry.id === params.id)?.verifiedRollbackTarget
      if (!target || target.integrity !== params.expectedTargetIntegrity)
        throw { code: 'E_PACKAGE_PREVIEW_STALE' }
    }
    let progress = Promise.resolve()
    const onProgress = (update: OperationProgress) => {
      progress = progress.then(async () => {
        await this.update(record.operation.operationId, (current) =>
          withOperationState(current, {
            state:
              update.phase === 'inspecting'
                ? 'inspecting'
                : update.phase === 'committing'
                  ? 'staging'
                  : this.startState(current.request.kind),
            progress: update.percent,
            now: this.options.clock(),
          }),
        )
      })
    }
    let preview: PackagePreview | undefined
    try {
      switch (record.request.kind) {
        case 'inspect':
          preview = await this.options.manager.inspect(directory, params.source as PackageSource, {
            signal,
            onProgress,
          })
          break
        case 'install':
          await this.options.manager.install(directory, params.source as PackageSource, {
            expectedIntegrity: params.expectedIntegrity as string,
            signal,
            onProgress,
          })
          break
        case 'trust':
          await this.options.manager.trust(directory, params.id as string, {
            integrity: params.expectedIntegrity as string,
            capabilityHash: params.capabilityHash as string,
          })
          break
        case 'untrust':
          await this.options.manager.untrust(directory, params.id as string, {
            integrity: params.expectedIntegrity as string,
            capabilityHash: params.capabilityHash as string,
          })
          // Trust revocation is stronger than disable: remove the package from every durable
          // runtime target before reconciliation so lastGood/previous recovery cannot resurrect it.
          if (this.options.revokeRuntimePackage) await this.options.revokeRuntimePackage(params.id as string)
          else this.pluginTreeStore()?.revokePackage(params.id as string)
          break
        case 'enable':
          await this.options.manager.setEnabled(directory, params.id as string, true, {
            ...(params.expectedInstalledIntegrity === undefined
              ? {}
              : { expectedInstalledIntegrity: params.expectedInstalledIntegrity as string }),
          })
          break
        case 'disable':
          await this.options.manager.setEnabled(directory, params.id as string, false)
          break
        case 'update':
          await this.options.manager.update(directory, params.id as string, params.source as PackageSource, {
            expectedIntegrity: params.expectedIntegrity as string,
            ...(params.activation === undefined
              ? {}
              : {
                  activation: {
                    expectedInstalledIntegrity: (params.activation as Record<string, unknown>)
                      .expectedInstalledIntegrity as string,
                    trust: {
                      integrity: (
                        (params.activation as Record<string, unknown>).trust as Record<string, unknown>
                      ).integrity as string,
                      capabilityHash: (
                        (params.activation as Record<string, unknown>).trust as Record<string, unknown>
                      ).capabilityHash as string,
                    },
                  },
                }),
            signal,
            onProgress,
          })
          break
        case 'rollback':
          await this.options.manager.rollback(directory, params.id as string, {
            ...(params.expectedTargetIntegrity === undefined
              ? {}
              : { expectedTargetIntegrity: params.expectedTargetIntegrity as string }),
            ...(params.activation === undefined
              ? {}
              : {
                  activation: {
                    expectedInstalledIntegrity: (params.activation as Record<string, unknown>)
                      .expectedInstalledIntegrity as string,
                    trust: {
                      integrity: (
                        (params.activation as Record<string, unknown>).trust as Record<string, unknown>
                      ).integrity as string,
                      capabilityHash: (
                        (params.activation as Record<string, unknown>).trust as Record<string, unknown>
                      ).capabilityHash as string,
                    },
                  },
                }),
          })
          break
        case 'remove':
          await this.assertRemovalReady(record.operation.profile, params.id as string)
          await this.options.activation?.prepareRemoval?.(record.operation.profile, params.id as string)
          await this.options.manager.remove(directory, params.id as string)
          break
      }
    } finally {
      // PackageManager may report progress immediately before rejecting. Drain every queued
      // journal write before run() publishes the terminal failure, otherwise a late progress write
      // can resurrect the operation as cancellable and leave the Web UI polling forever.
      await progress
    }
    return preview ? { kind: 'preview', preview } : { kind: 'effect' }
  }

  private async assertRuntimeBaseline(
    profile: string,
    directory: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const inventory = await this.options.manager.inventory(directory)
    const row = inventory.packages.find((entry) => entry.id === params.id)
    if (
      params.expectedInstalledIntegrity !== undefined &&
      row?.entry.integrity !== params.expectedInstalledIntegrity
    )
      throw { code: 'E_PACKAGE_PREVIEW_STALE' }
    if (params.expectedActiveIntegrity !== undefined) {
      let activeIntegrity: string | null = null
      let activeIntegrityKnown = false
      let actual: PackageActivationActual | undefined
      if (this.options.activation && typeof params.id === 'string') {
        const observed = normalizeObservation(await this.options.activation.actual(profile, params.id))
        actual = observed?.actual
        if (observed?.actualIntegrity !== undefined) {
          activeIntegrity = observed.actualIntegrity
          activeIntegrityKnown = true
        } else if (
          observed?.actual === 'not-running' ||
          (observed?.actual === 'failed' && (await this.stoppedFailure(profile, params.id)))
        )
          activeIntegrityKnown = true
      }
      const clientOnly =
        row !== undefined &&
        classifyPackageContributions(row.contributions) === 'client-only' &&
        params.expectedActiveIntegrity === null &&
        !activeIntegrityKnown &&
        actual === 'starting'
      if (!clientOnly && (!activeIntegrityKnown || activeIntegrity !== params.expectedActiveIntegrity))
        throw { code: 'E_PACKAGE_PREVIEW_STALE' }
    }
  }

  /** A package that failed to start counts as not running once the adapter says nothing runs it. */
  private async stoppedFailure(profile: string, packageId: string): Promise<boolean> {
    return (await this.options.activation?.stopped?.(profile, packageId)) === true
  }

  private async assertRemovalReady(profile: string, packageId: string): Promise<void> {
    if (!this.options.activation) throw { code: 'E_PACKAGE_STATE' }
    const observed = normalizeObservation(await this.options.activation.actual(profile, packageId))
    // `stopped()` is the adapter's precise assertion that nothing is running *or about to run*.
    // Client-only modules can remain visually `starting` while their roster settles, even after
    // the target has been disabled. Treat that stronger lifecycle signal as authoritative for
    // removal instead of retaining an inert package forever on its presentation state alone.
    const stopped = (await this.options.activation.stopped?.(profile, packageId)) === true
    if ((observed?.actual !== 'not-running' && !stopped) || observed?.cleanupPending === true)
      throw { code: 'E_PACKAGE_STATE' }
  }

  private startState(kind: PackageOperationKind): PackageOperation['state'] {
    if (kind === 'inspect') return 'inspecting'
    if (kind === 'install' || kind === 'update') return 'installing'
    if (kind === 'remove') return 'draining'
    return 'switching'
  }

  private async applied(record: StoredPackageOperation, directory: string): Promise<Applied> {
    if (record.request.kind === 'inspect') return 'no'
    let inventory: InstalledInventory
    try {
      inventory = await this.options.manager.inventory(directory)
    } catch {
      return 'unknown'
    }
    const id = record.request.params.id as string | undefined
    const row = id ? inventory.packages.find((entry) => entry.id === id) : undefined
    switch (record.request.kind) {
      case 'install':
        return inventory.packages.some(
          (entry) =>
            entry.entry.integrity === record.request.params.expectedIntegrity &&
            entry.entry.source.ref === (record.request.params.source as PackageSource).ref,
        )
          ? 'yes'
          : 'no'
      case 'update':
        if (!row || row.entry.integrity !== record.request.params.expectedIntegrity) return 'no'
        if (record.request.params.activation !== undefined) {
          const activation = record.request.params.activation as Record<string, unknown>
          const trust = activation.trust as Record<string, unknown>
          return row.enabled &&
            row.trusted &&
            row.entry.trustDecision?.integrity === trust.integrity &&
            row.capabilityHash === trust.capabilityHash
            ? 'yes'
            : 'no'
        }
        return 'yes'
      case 'trust':
        return row?.trusted &&
          row.entry.integrity === record.request.params.expectedIntegrity &&
          row.capabilityHash === record.request.params.capabilityHash
          ? 'yes'
          : 'no'
      case 'untrust':
        return row && !row.trusted && !row.enabled ? 'yes' : 'no'
      case 'enable':
        return row?.enabled ? 'yes' : 'no'
      case 'disable':
        return row && !row.enabled ? 'yes' : 'no'
      case 'remove':
        return record.recovery?.removeTargetIntegrity ? (!row ? 'yes' : 'no') : 'unknown'
      case 'rollback':
        if (
          !record.recovery?.rollbackTargetIntegrity ||
          row?.entry.integrity !== record.recovery.rollbackTargetIntegrity
        )
          return 'no'
        if (record.request.params.activation !== undefined) {
          const activation = record.request.params.activation as Record<string, unknown>
          const trust = activation.trust as Record<string, unknown>
          return row.enabled &&
            row.trusted &&
            row.entry.trustDecision?.integrity === trust.integrity &&
            row.capabilityHash === trust.capabilityHash
            ? 'yes'
            : 'no'
        }
        return 'yes'
      default:
        return 'no'
    }
  }

  private async completeFromInventory(
    record: StoredPackageOperation,
    directory: string,
    actualOverride?: PackageActivationObservation,
  ): Promise<void> {
    const inventory = await this.options.manager.inventory(directory)
    const id = record.request.params.id as string | undefined
    const projected = await this.projectInventory(record.operation.profile, inventory)
    const installed =
      (id ? projected.find((entry) => entry.id === id) : undefined) ??
      (record.request.kind === 'install'
        ? projected.find(
            (entry) =>
              entry.integrity === record.request.params.expectedIntegrity &&
              entry.source.ref === (record.request.params.source as PackageSource).ref,
          )
        : undefined)
    const installedWithActual = installed && actualOverride ? { ...installed, ...actualOverride } : installed
    await this.update(record.operation.operationId, (value) =>
      withOperationState(value, {
        state: 'completed',
        progress: 100,
        now: this.options.clock(),
        ...(installedWithActual ? { installed: installedWithActual } : {}),
      }),
    )
    const packageId = installed?.id ?? id
    const reason: ClientModulesChanged['reason'] =
      record.request.kind === 'trust' || record.request.kind === 'untrust'
        ? 'trust'
        : ['enable', 'disable', 'rollback'].includes(record.request.kind)
          ? 'activation'
          : 'inventory'
    await this.refreshClientModules(record.operation.profile, directory, reason, packageId)
  }

  private async projectInventory(
    profile: string,
    inventory: InstalledInventory,
  ): Promise<PackageInstalledDescriptor[]> {
    const entries: PackageInstalledDescriptor[] = []
    for (const row of inventory.packages) {
      let observation: PackageActivationObservation = { actual: 'unavailable' }
      if (this.options.activation) {
        try {
          const observed = await this.options.activation.actual(profile, row.id)
          observation = normalizeObservation(observed) ?? observation
        } catch {
          // No adapter result is less misleading than a guessed running state.
        }
      }
      entries.push(projectPackage(row, observation))
    }
    return entries
  }

  private async reconcile(
    record: StoredPackageOperation,
    signal: AbortSignal,
  ): Promise<(PackageActivationObservation & { error?: PackageAdminError }) | undefined> {
    if (!this.options.activation) return undefined
    if (!['untrust', 'enable', 'disable', 'update', 'rollback', 'remove'].includes(record.request.kind))
      return undefined
    const packageId = record.request.params.id
    if (typeof packageId !== 'string') return undefined
    const result = await this.options.activation.reconcile({
      profile: record.operation.profile,
      packageId,
      operationId: record.operation.operationId,
      operation:
        record.request.kind === 'untrust'
          ? 'disable'
          : (record.request.kind as 'enable' | 'disable' | 'update' | 'rollback' | 'remove'),
      signal,
    })
    const observation = normalizeObservation(result)
    if (!observation)
      return {
        actual: 'unavailable',
        error: { code: 'E_PACKAGE_STATE', safeMessage: safeMessage.E_PACKAGE_STATE, blockers: [] },
      }
    if (result.error && !validatePackageAdminData('PackageAdminError', result.error).ok)
      return {
        ...observation,
        error: { code: 'E_PACKAGE_STATE', safeMessage: safeMessage.E_PACKAGE_STATE, blockers: [] },
      }
    return result.error
      ? {
          ...observation,
          error: { ...result.error, safeMessage: safeMessage[result.error.code], blockers: [] },
        }
      : observation
  }

  private async activationFailed(
    record: StoredPackageOperation,
    directory: string,
    reconciliation: PackageActivationObservation & { error?: PackageAdminError },
  ): Promise<void> {
    const inventory = await this.options.manager.inventory(directory)
    const installed = (await this.projectInventory(record.operation.profile, inventory)).find(
      (entry) => entry.id === record.request.params.id,
    )
    await this.update(record.operation.operationId, (value) =>
      withOperationState(value, {
        state: 'failed',
        now: this.options.clock(),
        ...(installed
          ? {
              installed: {
                ...installed,
                actual: reconciliation.actual,
                ...(reconciliation.actualVersion === undefined
                  ? {}
                  : { actualVersion: reconciliation.actualVersion }),
                ...(reconciliation.actualIntegrity === undefined
                  ? {}
                  : { actualIntegrity: reconciliation.actualIntegrity }),
                ...(reconciliation.actualReason === undefined
                  ? {}
                  : { actualReason: reconciliation.actualReason }),
                ...(reconciliation.cleanupPending === undefined
                  ? {}
                  : { cleanupPending: reconciliation.cleanupPending }),
              },
            }
          : {}),
        error: reconciliation.error ?? {
          code: 'E_PACKAGE_STATE',
          safeMessage: safeMessage.E_PACKAGE_STATE,
          blockers: [],
        },
      }),
    )
    await this.refreshClientModules(
      record.operation.profile,
      directory,
      'activation',
      typeof record.request.params.id === 'string' ? record.request.params.id : undefined,
    )
  }

  private async cancelled(operationId: string): Promise<void> {
    await this.update(operationId, (value) =>
      packageOperationTerminal(value.operation.state)
        ? value
        : withOperationState(value, {
            state: 'cancelled',
            now: this.options.clock(),
            error: {
              code: 'E_PACKAGE_CANCELLED',
              safeMessage: safeMessage.E_PACKAGE_CANCELLED,
              blockers: [],
            },
            cancelRequested: true,
          }),
    )
  }

  private async fail(operationId: string, error: PackageAdminError): Promise<void> {
    await this.update(operationId, (value) =>
      packageOperationTerminal(value.operation.state)
        ? value
        : withOperationState(value, { state: 'failed', now: this.options.clock(), error }),
    )
  }

  private async find(operationId: string): Promise<StoredPackageOperation | undefined> {
    for (const record of await this.options.operations.pending())
      if (record.operation.operationId === operationId) return record
    return undefined
  }

  private async update(
    operationId: string,
    mutate: (current: StoredPackageOperation) => StoredPackageOperation,
  ): Promise<StoredPackageOperation> {
    const value = await this.options.operations.update(operationId, mutate)
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(value.operation))
      } catch {
        // Observation cannot change the durable operation result.
      }
    }
    return value
  }
}

export function createPackageAdminService(options: {
  manager: PackageManager
  profileDirectory: PackageProfileDirectory
  operations: PackageOperationStore
  catalog?: Catalog
  activation?: PackageActivationAdapter
  runtimePins?: RuntimePinsAdapter
  clientModules?: ClientModuleRegistry
  pluginTree?: CompositeTargetStore | (() => CompositeTargetStore | undefined)
  revokeRuntimePackage?: (packageId: string) => Promise<void>
  pluginTreePublisher?: (artifact: RuntimeTargetArtifact) => Promise<void>
  workerGeneration?: () => number | undefined
  clientServiceCall?: (
    input: ClientModuleServiceCallParams & Readonly<{ packageId: string; extension: string }>,
  ) => Promise<ExtensionCallResult>
  clientEffectCall?: (
    input: ClientModuleEffectCallParams & Readonly<{ packageId: string; extension: string }>,
    authority: PackageAdminAuthority,
  ) => Promise<ExtensionCallResult>
  clock?: () => string
}): PackageAdminService {
  return new Service({ ...options, clock: options.clock ?? (() => new Date().toISOString()) })
}

/** Register the same handler on in-process, Unix and supervisor endpoints. */
/** Stylesheet text for the roster, or `undefined` when it is missing or over the contract cap. */
function readSkinCss(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > SKIN_CSS_INLINE_MAX ? undefined : text
  } catch {
    // A stylesheet that vanished between roster assembly and this read is simply not inlined.
    return undefined
  }
}

/**
 * Stylesheet text ready to inline, or `undefined` when it must not be inlined.
 *
 * Relative `url()` references are rewritten to the skin's own route before the cap check: the client
 * applies this text with `replaceSync`, whose base URL is the document rather than the stylesheet, so
 * an author's `url('assets/x.png')` would otherwise resolve against the page root (design §21).
 * Rewriting can lengthen the text, so the cap is checked *after* it, not before — over the cap the
 * text is dropped entirely and the client falls back to `cssUrl`, whose relative references the
 * browser resolves correctly on its own.
 */
function inlineSkinCss(skin: { id: string; css?: string; cssPath?: string }): string | undefined {
  const raw = skin.css ?? readSkinCss(skin.cssPath)
  if (raw === undefined) return undefined
  const rewritten = rewriteSkinAssetUrls(raw, skin.id)
  return rewritten.length > SKIN_CSS_INLINE_MAX ? undefined : rewritten
}

const SKIN_CSS_INLINE_MAX = 131072

export function registerPackageAdmin(
  endpoint: LocalEndpoint,
  service: PackageAdminService,
  authority: PackageAdminAuthorityResolver,
): void {
  for (const method of Object.keys(PACKAGE_ADMIN_METHODS) as PackageAdminMethodName[])
    endpoint.register(method, async (params, context) => {
      const result = await service.call(method, params, authority(context))
      // Successful roster authorization enrolls this exact connection for profile-scoped invalidation
      // notices. Transport/auth kind alone is insufficient: Unix launchers and denied remote clients
      // can share the same profile but must not receive browser roster events.
      if (method === '_agnes/v1/clientModules.list') context.conn.clientModuleNotices = true
      return result
    })
}
