import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { clientModuleRowIdForContribution } from '@agnes/daemon-foundation/composite-desired'
import { type CompositionPatch, CompositionSessionStore, compositionModuleAllowed } from '@agnes/host'
import {
  CLIENT_MAX_TOTAL_BYTES,
  CLIENT_RESOURCE_MAX_TOTAL_BYTES,
  clientReleaseEvidence,
  hashDirectoryAsync,
  type InstalledInventory,
  type InstalledPackage,
  isRuntimePackageEligible,
  RuntimeGenerationSnapshotStore,
  type VerifiedClientTree,
} from '@agnes/package-manager'
import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  type ClientModuleListResult,
  type ClientModuleReadParams,
  type ClientModuleReadResult,
  DSH_WEB_CLIENT_SLOT_CATALOG_VERSION,
  isDshWebClientModuleSlotName,
  isWebClientModuleSlotName,
  jcs,
} from '@agnes/protocol'
import {
  admissionDigest,
  admitClient,
  type ClientAdmission,
  type DocumentAdmission,
  installedClientTree,
  type PresentationObservation,
  type ReleaseEvidence,
} from './client-admission.js'
import { cleanRelative, collectSnapshotFiles } from './client-asset-references.js'
import {
  type AssetPurpose,
  assetRoute as route,
  createPublishedAssetReads,
  MAX_BATCH_READS,
  type ObservationStatus,
  type PendingRead,
  readAssetBatch,
  type ReadInput,
  type RowAssets,
  runtimeObservation,
  sameActivation,
  sameReadAdapters,
  type SelectedAsset,
  type SourceTreeProof,
} from './client-asset-reads.js'
import { createClientGenerations } from './client-generations.js'
import {
  digest,
  emptyState,
  type PackageState,
  type ProfileState,
  pruneUntracked,
  publishSnapshot,
  type Retained,
  readState,
  removeSnapshot,
  type StoredDeclaration,
  sameAsset,
  saveState,
  snapshotBytes,
  snapshotContentDigest,
  trackedDeclarations,
  type VerifiedAsset,
  verifySnapshot,
} from './client-module-snapshots.js'
import { createPublicationChecks } from './client-publication-checks.js'
import { runtimeClientTruth } from './client-runtime-truth.js'
import {
  type ClientRegistryPackage,
  clientContributionDeclarations,
  combineContributionRosters,
  contributionProjection,
  historicalContribution,
  modulesForContributionRows,
  reconcileContributionActivations,
} from './contribution-roster.js'
import type { PackageActivationObservation } from './handler.js'

export const CLIENT_MODULE_RETENTION_MS = 30 * 60 * 1000
export const CLIENT_MODULE_SNAPSHOT_QUOTA_BYTES = 256 * 1024 * 1024

type ClientContribution = NonNullable<
  Extract<InstalledPackage['contributions'][number], { kind: 'extension' }>['client']
>

type ClientDeclaration = Readonly<{
  rowId: string
  moduleName: string
  legacyRowIds: readonly string[]
  client: ClientContribution
  entry: string
  styles: readonly string[]
  extIds: readonly string[]
  requiresBackend: boolean
  backendRowId?: string
}>

export type ClientModulesChanged = Readonly<{
  profile: string
  revision: string
  reason: 'inventory' | 'activation' | 'trust' | 'resources' | 'rebuilt'
  packageId?: string
}>

export type ClientModuleRegistryOptions = Readonly<{
  composition?: (
    profile: string,
  ) => Pick<CompositionPatch, 'packages' | 'uiModules' | 'shell' | 'surfaces'> | undefined
  /** A profile's daemon-owned snapshot directory. It must not be the mutable install tree. */
  snapshotDirectory: (profile: string, profileDirectory: string) => string
  clock?: () => Date
  retentionMs?: number
  quotaBytes?: number
  /** Runtime artifacts are the authoritative enable/disable/revision source when available. */
  runtimeArtifacts?: (profile: string) =>
    | Readonly<{
        desired?: RuntimeTargetArtifact
        previous?: RuntimeTargetArtifact
        lastGood?: RuntimeTargetArtifact
        /** Host-private backend rows confirmed by the current worker, outside package artifacts. */
        activeBackendRows?: ReadonlySet<string>
      }>
    | undefined
  changed?: (event: ClientModulesChanged) => void
  releaseEvidence?: ReleaseEvidence
  activationEpoch?: () => number | undefined
}>

export { type RuntimeArtifactsStore, runtimeArtifactsFromStore } from './client-runtime-truth.js'

type ClientRegistryInput = {
  sessionId?: string
  profile: string
  profileDirectory: string
  inventory: InstalledInventory
  actual(packageId: string): Promise<PackageActivationObservation | undefined>
  refreshInventory(): Promise<InstalledInventory>
  /** Server-owned identity when adjacent requests create equivalent adapter closures. */
  assetAdapterScope?: object
  presentation?(inventory: InstalledInventory): Promise<PresentationObservation>
  archive?: Readonly<{
    id: string
    artifact: RuntimeTargetArtifact
    trees: ReadonlyMap<string, VerifiedClientTree>
    packages: readonly ClientRegistryPackage[]
    current(): Promise<boolean>
  }>
}

type NativeOrIsolated = Exclude<ClientAdmission, { kind: 'denied' }>

type Reconciled = {
  roster: ClientModuleListResult
  assets: readonly RowAssets[]
  state: ProfileState
  checkCurrent(includePresentation: boolean): Promise<ObservationStatus>
}

type ReadBatch = { input: ReadInput; reads: PendingRead[]; tail: Promise<void> | undefined }

export type ClientModuleRegistry = Readonly<{
  list(input: ClientRegistryInput): Promise<ClientModuleListResult>
  refresh(
    input: ClientRegistryInput,
    reason: ClientModulesChanged['reason'],
    packageId?: string,
  ): Promise<ClientModuleListResult>
  read(
    input: ClientRegistryInput & Pick<ClientModuleReadParams, 'path' | 'purpose'>,
  ): Promise<ClientModuleReadResult>
  subscribe(listener: (event: ClientModulesChanged) => void): () => void
  close(): void
}>

function declarations(row: ClientRegistryPackage): readonly ClientDeclaration[] {
  const extensions = row.contributions.filter(
    (item): item is Extract<typeof item, { kind: 'extension' }> => item.kind === 'extension',
  )
  const clients = extensions.filter(
    (item): item is typeof item & { client: ClientContribution } => item.client !== undefined,
  )
  const rowClients = row.contributions.filter(
    (item): item is Extract<typeof item, { kind: 'client'; client: unknown }> =>
      item.kind === 'client' && 'client' in item,
  )
  // A UI-only extension has no backend behavior to synchronize. Any other capability means the
  // client must wait for the activation lane's observed digest before it is published.
  const requiresBackend = extensions.some((item) =>
    Object.keys(item.capabilities).some((key) => key !== 'ui'),
  )
  const output: ClientDeclaration[] = []
  for (const owner of clients) {
    const manifestPath = cleanRelative(owner.path)
    if (!manifestPath) return []
    const prefix = posix.dirname(manifestPath)
    const packagePath = (path: string): string | undefined => {
      const child = cleanRelative(path)
      if (!child) return undefined
      return prefix === '.' ? child : posix.join(prefix, child)
    }
    const entry = packagePath(owner.client.entry)
    const styles = (owner.client.styles ?? []).map(packagePath)
    if (!entry || styles.some((path) => path === undefined)) return []
    output.push({
      rowId: clientModuleRowIdForContribution(
        row.id,
        owner.id,
        clients.length + rowClients.length,
        owner.client.id ?? owner.id,
      ),
      moduleName: owner.id,
      legacyRowIds: [...(owner.client.legacyRowIds ?? [])],
      client: owner.client,
      entry,
      styles: styles as string[],
      extIds: requiresBackend ? extensions.map((item) => item.id).sort() : [],
      requiresBackend,
    })
  }
  // A descriptor row of a package whose manifest declares nothing but `ui` has no backend behavior to
  // wait for either. An entry that declares nothing at all (older locks) stays strict.
  const declaredCapabilities = row.entry.declaredCapabilities
  const rowUiOnly =
    declaredCapabilities !== undefined && Object.keys(declaredCapabilities).every((key) => key === 'ui')
  for (const owner of rowClients) {
    const manifestPath = cleanRelative(owner.path)
    if (!manifestPath) return []
    const prefix = posix.dirname(manifestPath)
    const packagePath = (path: string): string | undefined => {
      const child = cleanRelative(path)
      if (!child) return undefined
      return prefix === '.' ? child : posix.join(prefix, child)
    }
    const entry = packagePath(owner.client.entry)
    const styles = (owner.client.styles ?? []).map(packagePath)
    if (!entry || styles.some((path) => path === undefined)) return []
    output.push({
      rowId: clientModuleRowIdForContribution(
        row.id,
        owner.id,
        clients.length + rowClients.length,
        owner.client.id ?? owner.id,
      ),
      moduleName: owner.id,
      legacyRowIds: [...(owner.client.legacyRowIds ?? [])],
      client: owner.client,
      entry,
      styles: styles as string[],
      extIds: [owner.id],
      requiresBackend: !rowUiOnly,
      backendRowId: owner.rowId,
    })
  }
  return output.sort((left, right) => left.rowId.localeCompare(right.rowId))
}

function hasClient(row: ClientRegistryPackage): boolean {
  return row.contributions.some(
    (item) =>
      (item.kind === 'client' && 'client' in item) ||
      (item.kind === 'extension' && item.client !== undefined),
  )
}

function storedDeclaration(declared: ClientDeclaration): StoredDeclaration {
  return {
    moduleName: declared.moduleName,
    ...(declared.legacyRowIds.length ? { legacyRowIds: [...declared.legacyRowIds] } : {}),
    ...clientContributionDeclarations(declared.client),
    entry: declared.entry,
    styles: [...declared.styles],
    slots: [...(declared.client.slots ?? [])],
    ...(declared.client.slotCatalogVersion === undefined
      ? {}
      : { slotCatalogVersion: declared.client.slotCatalogVersion }),
    extIds: [...declared.extIds],
    services: [...(declared.client.services ?? [])],
    ...(declared.backendRowId ? { backendRowId: declared.backendRowId } : {}),
    ...(declared.client.intelligentComponents
      ? { intelligentComponents: declared.client.intelligentComponents }
      : {}),
    ...(declared.client.publicConfig === undefined ? {} : { publicConfig: declared.client.publicConfig }),
  }
}

type RowDeclarationIdentity = Readonly<{
  moduleName: string
  legacyRowIds?: readonly string[]
}>
type CanonicalRowDeclaration = RowDeclarationIdentity & Readonly<{ rowId: string }>

type RowAliasMigration = Readonly<{
  aliases: Readonly<Record<string, string>>
  ambiguous: readonly string[]
}>

/**
 * Derive row migrations from persisted declarations and the next verified declaration set.
 * Entry/style paths are deliberately absent: changing an asset path keeps the same row. A
 * module-name match is only accepted when it is unique; explicit legacyRowIds are stricter and
 * are also usable when the old declaration was written by a daemon that did not persist metadata.
 */
function migrateRowAliases(
  previous: Readonly<Record<string, RowDeclarationIdentity>> | undefined,
  next: readonly CanonicalRowDeclaration[],
  existing: Readonly<Record<string, string>> | undefined,
): RowAliasMigration {
  const nextByRow = new Map(next.map((item) => [item.rowId, item]))
  const candidates = new Map<string, Set<string>>()
  const addCandidate = (oldRowId: string, canonicalRowId: string): void => {
    if (oldRowId === canonicalRowId) return
    const values = candidates.get(oldRowId) ?? new Set<string>()
    values.add(canonicalRowId)
    candidates.set(oldRowId, values)
  }
  for (const item of next) for (const oldRowId of item.legacyRowIds ?? []) addCandidate(oldRowId, item.rowId)
  for (const [oldRowId, old] of Object.entries(previous ?? {})) {
    for (const item of next) {
      if (old.moduleName === item.moduleName) addCandidate(oldRowId, item.rowId)
    }
  }

  const aliases = new Map<string, string>()
  const ambiguous = new Set<string>()
  const assignAlias = (oldRowId: string, canonicalRowId: string): void => {
    if (ambiguous.has(oldRowId)) return
    const previousTarget = aliases.get(oldRowId)
    if (previousTarget !== undefined && previousTarget !== canonicalRowId) {
      aliases.delete(oldRowId)
      ambiguous.add(oldRowId)
      return
    }
    aliases.set(oldRowId, canonicalRowId)
  }
  for (const [oldRowId, values] of candidates) {
    if (values.size === 1) assignAlias(oldRowId, [...values][0] as string)
    else ambiguous.add(oldRowId)
  }

  // Carry forward persisted aliases across one more canonical-id change, but only when the
  // resulting target is present in this roster. Stale history is intentionally not published.
  for (const [oldRowId, targetRowId] of Object.entries(existing ?? {})) {
    let target = targetRowId
    const seen = new Set<string>()
    while (!nextByRow.has(target) && aliases.has(target) && !seen.has(target)) {
      seen.add(target)
      target = aliases.get(target) as string
    }
    if (nextByRow.has(target) && oldRowId !== target) assignAlias(oldRowId, target)
  }

  return {
    aliases: Object.fromEntries([...aliases].sort(([left], [right]) => left.localeCompare(right))),
    ambiguous: [...ambiguous].sort(),
  }
}

async function rowFiles(tree: VerifiedClientTree, declared: ClientDeclaration, purpose: AssetPurpose) {
  return collectSnapshotFiles(
    tree.directory,
    purpose === 'isolated-component'
      ? [declared.entry]
      : [
          declared.entry,
          ...declared.styles,
          ...(declared.client.assets ?? []).map((asset) =>
            posix.join(
              posix.dirname(declared.entry),
              posix.relative(posix.dirname(declared.client.entry), asset),
            ),
          ),
        ],
    purpose,
  ).catch(() => null)
}

const assetRecords = (files: ReadonlyMap<string, Buffer>): VerifiedAsset[] =>
  [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) }))

function observedTree(row: InstalledPackage, revision: string) {
  if (revision === row.entry.integrity) return installedClientTree(row)
  const previous = row.verifiedRollbackTarget
  if (previous?.integrity === revision) return { packageId: row.id, ...previous }
  return undefined
}

function treeDeclarations(row: ClientRegistryPackage, tree: VerifiedClientTree) {
  const verified = tree.integrity === row.entry.integrity ? row.entry : row.entry.previous
  const { declaredCapabilities: _current, ...entry } = row.entry
  return declarations({
    ...row,
    directory: tree.directory,
    contributions: tree.contributions,
    entry: {
      ...entry,
      integrity: tree.integrity,
      version: tree.version,
      ...(verified?.declaredCapabilities ? { declaredCapabilities: verified.declaredCapabilities } : {}),
    },
  })
}

function supportsClientSlots(client: ClientContribution): boolean {
  return (client.slots ?? []).every(
    (slot) =>
      isWebClientModuleSlotName(slot) &&
      (!isDshWebClientModuleSlotName(slot) ||
        client.slotCatalogVersion === DSH_WEB_CLIENT_SLOT_CATALOG_VERSION),
  )
}

function rosterRevision(
  value: Pick<ClientModuleListResult, 'modules' | 'statuses' | 'rows' | 'rowAliases'>,
): string {
  return `sha256-${createHash('sha256').update(jcs(value), 'utf8').digest('hex')}`
}

function withRosterRows(
  roster: ClientModuleListResult,
  rows: NonNullable<ClientModuleListResult['rows']>,
): ClientModuleListResult {
  const rowIds = new Set(rows.map((row) => row.rowId))
  const rowAliases = Object.fromEntries(
    Object.entries(roster.rowAliases ?? {}).filter(
      ([, target]) => typeof target === 'string' && rowIds.has(target),
    ),
  )
  const { rowAliases: _aliases, ...previous } = roster
  const selected = {
    ...previous,
    rows,
    modules: modulesForContributionRows(roster.modules, rows),
    ...(Object.keys(rowAliases).length ? { rowAliases } : {}),
  }
  return { ...selected, revision: rosterRevision(selected) }
}

export function createClientModuleRegistry(options: ClientModuleRegistryOptions): ClientModuleRegistry {
  const releaseEvidence = options.releaseEvidence ?? clientReleaseEvidence
  const filterRoster = (
    roster: ClientModuleListResult,
    selection: Pick<CompositionPatch, 'packages' | 'uiModules' | 'shell' | 'surfaces'> | undefined,
  ) => {
    if (!selection || (!selection.surfaces && !selection.shell && !selection.uiModules?.length)) return roster
    const rows =
      roster.rows?.filter((row) =>
        compositionModuleAllowed(selection, {
          id: row.rowId,
          aliases: [row.moduleName, row.packageId ?? ''],
          slots: row.slots ?? [],
        }),
      ) ?? []
    const statuses = roster.statuses.filter((status) =>
      rows.some((row) => row.packageId === status.packageId),
    )
    return withRosterRows({ ...roster, statuses }, rows)
  }
  const generations = createClientGenerations(options, createClientModuleRegistry)
  const { prune: pruneGenerationAssets, input: generationInput } = generations
  const generationRoster = async (
    input: Parameters<ClientModuleRegistry['list']>[0],
    id: string,
  ): Promise<ClientModuleListResult> => {
    const selected = await generationInput(input, id)
    const result = await selected.registry.list(selected.input)
    const route = (url: string) => url.replace('/plugins/', `/plugins/generations/${id}/`)
    const roster = {
      ...result,
      modules: result.modules.map((module) => ({
        ...module,
        entryUrl: route(module.entryUrl),
        styleUrls: module.styleUrls.map(route),
      })),
      ...(result.rows
        ? {
            rows: result.rows.map((row) => ({
              ...row,
              ...(row.entryUrl ? { entryUrl: route(row.entryUrl) } : {}),
              ...(row.styleUrls ? { styleUrls: row.styleUrls.map(route) } : {}),
              ...(row.rendererDataUrl ? { rendererDataUrl: route(row.rendererDataUrl) } : {}),
            })),
          }
        : {}),
    }
    return { ...roster, revision: rosterRevision(roster) }
  }
  const clock = options.clock ?? (() => new Date())
  const retentionMs = options.retentionMs ?? CLIENT_MODULE_RETENTION_MS
  const quotaBytes = options.quotaBytes ?? CLIENT_MODULE_SNAPSHOT_QUOTA_BYTES
  const listeners = new Set<(event: ClientModulesChanged) => void>()
  if (options.changed) listeners.add(options.changed)
  const lastRevision = new Map<string, string>()
  const tails = new Map<string, Promise<void>>()
  const queuedReads = new Map<string, ReadBatch>()
  const pendingReads = new Set<PendingRead>()
  let closed = false
  const inputs = new Map<string, Parameters<ClientModuleRegistry['list']>[0]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const resourceFailures = new Map<string, boolean>()
  const publishedReads = createPublishedAssetReads(options, () => clock().getTime())

  const emit = (event: ClientModulesChanged): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // An observer cannot change the roster or snapshot transaction.
      }
    }
  }

  const emitResourceFailure = (input: Parameters<ClientModuleRegistry['list']>[0]): void => {
    const revision =
      lastRevision.get(input.profile) ??
      `sha256-${createHash('sha256')
        .update(jcs({ modules: [], statuses: [] }), 'utf8')
        .digest('hex')}`
    emit({ profile: input.profile, revision, reason: 'resources' })
  }

  const serialize = async <T>(profile: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(profile) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    const queued = previous.then(() => next)
    tails.set(profile, queued)
    await previous
    try {
      if (closed) throw new Error('Client module registry is closed')
      return await task()
    } finally {
      release()
      if (tails.get(profile) === queued) tails.delete(profile)
    }
  }

  const scheduleExpiry = (profile: string, state: ProfileState): void => {
    if (closed) return
    const current = timers.get(profile)
    if (current) clearTimeout(current)
    timers.delete(profile)
    const expiry = Object.values(state.packages)
      .flatMap((item) =>
        item.retained
          .filter((entry) => entry.expiresAt !== undefined)
          .map((entry) => Date.parse(entry.expiresAt as string)),
      )
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0]
    if (expiry === undefined) return
    const timer = setTimeout(
      () => {
        const remembered = inputs.get(profile)
        if (!remembered) return
        void serialize(profile, async () => {
          const inventory = await remembered.refreshInventory()
          if (closed) return
          const fresh = { ...remembered, inventory }
          inputs.set(profile, fresh)
          await reconcile(fresh, true)
        }).catch(() => emitResourceFailure(remembered))
      },
      Math.max(1, Math.min(2_147_483_647, expiry - clock().getTime())),
    )
    timer.unref?.()
    timers.set(profile, timer)
  }

  const reconcile = async (
    input: Parameters<ClientModuleRegistry['list']>[0],
    announce: boolean,
  ): Promise<Reconciled> => {
    if (!input.archive) publishedReads.invalidate(input.profile)
    const root = options.snapshotDirectory(input.profile, input.profileDirectory)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const now = clock()
    const nowMs = now.getTime()
    const savedState = await readState(root, input.profile)
    const beforeState = savedState ? jcs(savedState) : undefined
    let state = savedState ?? emptyState(input.profile)
    const scopePackages = input.archive?.packages ?? input.inventory.packages
    state = {
      ...state,
      activations: reconcileContributionActivations(state.activations, scopePackages),
    }

    let resourcesChanged = await pruneUntracked(root, state)
    let resourceFailure = false
    const packages: Record<string, PackageState> = {}
    const artifacts = input.archive
      ? { desired: input.archive.artifact, lastGood: input.archive.artifact }
      : options.runtimeArtifacts?.(input.profile)
    const observedRuntime = runtimeObservation(artifacts)
    const activationEpoch = input.archive ? undefined : options.activationEpoch?.()
    const truth = runtimeClientTruth(artifacts)
    const presentation = input.archive
      ? undefined
      : await input.presentation?.(input.inventory).catch(() => undefined)
    const observations = new Map<string, PackageActivationObservation>()
    const observedActual = presentation ? new Map<string, PackageActivationObservation | undefined>() : undefined
    const observedSources: SourceTreeProof[] = []
    let activationUnavailable = false
    const checkCurrent = async (includePresentation: boolean): Promise<ObservationStatus> => {
      try {
        if (!input.archive) {
          const fresh = await input.refreshInventory()
          if (fresh.profile !== input.inventory.profile || fresh.hash !== input.inventory.hash)
            return 'runtime-changed'
        }
        for (const [id, prior] of observations)
          if (!sameActivation(await input.actual(id), prior)) return 'runtime-changed'
        if (input.archive) return (await input.archive.current()) ? 'current' : 'runtime-changed'
        const presentationCurrent =
          !includePresentation || (await presentation?.current().catch(() => false)) === true
        if (
          options.activationEpoch?.() !== activationEpoch ||
          runtimeObservation(options.runtimeArtifacts?.(input.profile)) !== observedRuntime
        )
          return 'runtime-changed'
        return presentationCurrent ? 'current' : 'presentation-changed'
      } catch {
        return 'runtime-changed'
      }
    }
    const live = new Map<string, InstalledPackage>(
      input.archive ? [] : input.inventory.packages.map((row) => [row.id, row]),
    )
    const installed = input.archive ? new Map(scopePackages.map((row) => [row.id, row])) : live
    const trusted = new Map(
      scopePackages
        .filter((row) => row.trusted && row.blockers.length === 0 && hasClient(row))
        .map((row) => [row.id, row]),
    )
    const eligible = new Map(
      scopePackages
        .filter((row) =>
          truth.useArtifact ? trusted.has(row.id) : isRuntimePackageEligible(row) && hasClient(row),
        )
        .map((row) => [row.id, row]),
    )

    // Trust is an authorization boundary and revokes immediately. Disabled/deleted packages are
    // different: an artifact may still reference their immutable client bytes for rollback, so keep
    // those bytes until the last desired/previous/lastGood reference disappears and its grace timer
    // expires.
    for (const [packageId, item] of Object.entries(state.packages)) {
      const inventoryRow = installed.get(packageId)
      const packageTrusted =
        inventoryRow === undefined
          ? (truth.referenced.get(packageId)?.size ?? 0) > 0
          : inventoryRow.trusted && inventoryRow.blockers.length === 0
      if ((inventoryRow && !packageTrusted) || (!inventoryRow && !truth.useArtifact)) {
        for (const revision of new Set([
          ...(item.current ? [item.current] : []),
          ...item.retained.map((entry) => entry.revision),
        ]))
          await removeSnapshot(root, packageId, revision)
        resourcesChanged = true
        continue
      }
      if (inventoryRow && !inventoryRow.enabled && !truth.useArtifact) {
        for (const revision of new Set([
          ...(item.current ? [item.current] : []),
          ...item.retained.map((entry) => entry.revision),
        ]))
          await removeSnapshot(root, packageId, revision)
        resourcesChanged = true
        continue
      }
      const retained: Retained[] = []
      for (const itemRetained of item.retained) {
        const referenced = truth.referenced.get(packageId)?.has(itemRetained.revision) ?? false
        if (referenced && (await verifySnapshot(root, packageId, itemRetained.revision)) !== null) {
          retained.push({ revision: itemRetained.revision, protected: true })
        } else if (itemRetained.expiresAt !== undefined && Date.parse(itemRetained.expiresAt) <= nowMs) {
          await removeSnapshot(root, packageId, itemRetained.revision)
          resourcesChanged = true
        } else if (itemRetained.protected) {
          retained.push({
            revision: itemRetained.revision,
            expiresAt: new Date(nowMs + retentionMs).toISOString(),
          })
        } else if ((await verifySnapshot(root, packageId, itemRetained.revision)) !== null)
          retained.push(itemRetained)
        else resourcesChanged = true
      }
      const current =
        item.current && (await verifySnapshot(root, packageId, item.current)) !== null
          ? item.current
          : undefined
      if (item.current && !current) resourcesChanged = true
      const currentReferenced = current && (truth.referenced.get(packageId)?.has(current) ?? false)
      const currentPackage = installed.get(packageId)
      if (
        current &&
        !currentReferenced &&
        (currentPackage === undefined ||
          !currentPackage.enabled ||
          currentPackage.entry.integrity !== current) &&
        retained.length < 8
      ) {
        retained.push({ revision: current, expiresAt: new Date(nowMs + retentionMs).toISOString() })
        packages[packageId] = {
          retained,
          ...(item.declarations ? { declarations: item.declarations } : {}),
          ...(item.rowAliases ? { rowAliases: item.rowAliases } : {}),
        }
      } else {
        packages[packageId] = {
          ...(current ? { current } : {}),
          retained,
          ...(item.declarations ? { declarations: item.declarations } : {}),
          ...(item.rowAliases ? { rowAliases: item.rowAliases } : {}),
        }
      }
    }
    state = { ...state, packages }

    const modules: ClientModuleListResult['modules'] = []
    const rows: NonNullable<ClientModuleListResult['rows']> = []
    const statuses: ClientModuleListResult['statuses'] = []
    const rowAliases: Record<string, string> = {}
    const assets: RowAssets[] = []
    const publications = createPublicationChecks(input.inventory)
    for (const row of [...eligible.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      const installedRevision = row.entry.integrity
      const activeRows = [...truth.active.values()].filter((entry) => entry.packageId === row.id)
      const revisions = new Set(activeRows.map((entry) => entry.revision))
      const selectedRevision = truth.useArtifact
        ? revisions.size === 1
          ? [...revisions][0]
          : undefined
        : row.enabled
          ? installedRevision
          : undefined
      if (!selectedRevision) continue
      const current = state.packages[row.id] ?? { retained: [] }
      const liveRow = live.get(row.id)
      const tree = input.archive
        ? input.archive.trees.get(row.id)
        : liveRow && observedTree(liveRow, selectedRevision)
      const declared = tree ? treeDeclarations(row, tree) : []
      const selectedDeclarations = truth.useArtifact
        ? declared.filter((item) => {
            const active = truth.active.get(item.rowId)
            return active?.packageId === row.id && active.revision === selectedRevision
          })
        : declared
      const activeDeclarations = selectedDeclarations.filter((item) => {
        if (item.client.lifetime === 'profile' && selectedRevision !== installedRevision) return false
        if (!item.backendRowId || !truth.useArtifact) return true
        const backend = truth.backend.get(item.backendRowId)
        return backend?.packageId === row.id && backend.revision === selectedRevision
      })
      const priorRevision = savedState?.packages[row.id]?.current
      const migration = migrateRowAliases(
        priorRevision === undefined ? undefined : current.declarations?.[priorRevision],
        activeDeclarations,
        current.rowAliases,
      )
      let observation: PackageActivationObservation | undefined
      try {
        observation = await input.actual(row.id)
        observedActual?.set(row.id, observation)
      } catch {
        activationUnavailable = true
      }
      const requiresBackend = activeDeclarations.some((item) => item.requiresBackend)
      const backendRevision = requiresBackend ? (observation?.actualIntegrity ?? null) : null
      const retained = current.retained.filter((item) => item.revision !== selectedRevision)
      const reportRetained = retained.filter(
        (item): item is Readonly<{ revision: string; expiresAt: string }> => item.expiresAt !== undefined,
      )
      const baseStatus = { packageId: row.id, installedRevision: selectedRevision, backendRevision }
      if (migration.ambiguous.length) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
        resourceFailure = true
        continue
      }
      if (!tree) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'native-ui-not-admitted' })
        continue
      }
      if (!declared.length || row.blockers.length) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
        resourceFailure = true
        continue
      }
      if (!activeDeclarations.length) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'backend-not-running' })
        continue
      }
      const release = releaseEvidence(tree, input.archive !== undefined)
      const rendererEntries = new Set(
        declared.filter((item) => item.client.intelligentComponents?.length).map((item) => item.entry),
      )
      const candidateRows: {
        item: ClientDeclaration
        admission: NativeOrIsolated
        purpose: AssetPurpose
        files: readonly VerifiedAsset[]
      }[] = []
      const packageFiles = new Map<string, Buffer>()
      const manifestFiles = new Map<string, VerifiedAsset>()
      let packageBytes = 0
      let packageCodeBytes = 0
      for (const item of activeDeclarations) {
        if (!supportsClientSlots(item.client)) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'unsupported-slot' })
          resourceFailure = true
          continue
        }
        const admission = admitClient({
          release,
          profile: input.profile,
          tree,
          rowId: item.rowId,
          clientId: item.client.id ?? item.moduleName,
          client: item.client,
          installed: row.enabled && !input.archive && selectedRevision === installedRevision,
          presentation,
        })
        const needsRunning =
          item.requiresBackend ||
          (admission.kind === 'native' &&
            admission.source === 'approved-presentation' &&
            admission.grants.some((grant) => grant.roles.length))
        if (needsRunning && !observation?.actualIntegrity) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'backend-revision-unavailable' })
          continue
        }
        if (needsRunning && observation?.actualIntegrity !== selectedRevision) {
          statuses.push({ ...baseStatus, state: 'pending-activation' })
          continue
        }
        if (
          (needsRunning && observation?.actual !== 'running') ||
          item.client.requiresBackendRows?.some(
            (id) => !truth.backend.has(id) && !truth.activeBackendRows.has(id),
          )
        ) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'backend-not-running' })
          continue
        }
        if (
          admission.kind === 'denied' ||
          (admission.kind === 'isolated-component' &&
            !input.archive &&
            (!row.enabled || selectedRevision !== installedRevision))
        ) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'native-ui-not-admitted' })
          continue
        }
        const purpose = admission.kind === 'native' ? 'document' : 'isolated-component'
        const files = await rowFiles(tree, item, purpose)
        // A renderer entry is data-only even when another row references the same path.
        if (
          !files ||
          (purpose === 'document' && [...files.keys()].some((path) => rendererEntries.has(path)))
        ) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
          resourceFailure = true
          continue
        }
        const records = assetRecords(files)
        let fileCount = manifestFiles.size
        let nextBytes = packageBytes
        let nextCodeBytes = packageCodeBytes
        let inconsistent = false
        for (const file of records) {
          const prior = manifestFiles.get(file.path)
          if (prior) {
            if (!sameAsset(prior, file)) inconsistent = true
            continue
          }
          fileCount++
          nextBytes += file.bytes
          if (/\.(?:js|mjs|css|map)$/.test(file.path)) nextCodeBytes += file.bytes
        }
        if (
          inconsistent ||
          fileCount > 4096 ||
          nextBytes > CLIENT_RESOURCE_MAX_TOTAL_BYTES ||
          nextCodeBytes > CLIENT_MAX_TOTAL_BYTES
        ) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
          resourceFailure = true
          continue
        }
        packageBytes = nextBytes
        packageCodeBytes = nextCodeBytes
        for (const [path, bytes] of files) packageFiles.set(path, bytes)
        for (const file of records) manifestFiles.set(file.path, file)
        candidateRows.push({ item, admission, purpose, files: records })
        if (needsRunning && observation) observations.set(row.id, observation)
      }
      if (!candidateRows.length) continue
      if (
        new Set(candidateRows.map(({ item }) => item.rowId)).size !== candidateRows.length ||
        (await hashDirectoryAsync(tree.directory, { exclude: [], verifyFiles: packageFiles }).catch(
          () => undefined,
        )) !== tree.treeIntegrity
      ) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
        resourceFailure = true
        continue
      }
      if (current.current && current.current !== selectedRevision && retained.length >= 8) {
        resourceFailure = true
        statuses.push({
          ...baseStatus,
          state: 'blocked',
          reason: 'snapshot-retention-limit',
          retained: reportRetained,
        })
        continue
      }
      const publication = await publishSnapshot({
        root,
        tree,
        declarations: candidateRows.map(({ item }) => item),
        files: packageFiles,
        records: [...manifestFiles.values()],
        quotaBytes,
        quotaUsed: () => snapshotBytes(root, state),
      })
      if (publication === 'invalid' || publication === 'quota') {
        await removeSnapshot(root, row.id, selectedRevision)
        statuses.push({
          ...baseStatus,
          state: 'blocked',
          reason: publication === 'quota' ? 'snapshot-quota-exceeded' : 'resources-invalid',
          ...(reportRetained.length ? { retained: reportRetained } : {}),
        })
        resourcesChanged = true
        resourceFailure = true
        continue
      }
      if (observedActual) observedSources.push({ directory: tree.directory, treeIntegrity: tree.treeIntegrity })
      if (publication === 'published' && liveRow && selectedRevision === installedRevision) {
        const prior = state.packages[row.id]
        publications.add(liveRow, async () => {
          await removeSnapshot(root, row.id, selectedRevision)
          const restored = { ...state.packages }
          if (prior) restored[row.id] = prior
          else delete restored[row.id]
          state = { ...state, packages: restored }
          for (let index = statuses.length - 1; index >= 0; index--)
            if (statuses[index]?.packageId === row.id) statuses.splice(index, 1)
          statuses.push({
            ...baseStatus,
            state: 'blocked',
            reason: 'resources-invalid',
            ...(reportRetained.length ? { retained: reportRetained } : {}),
          })
          for (let index = modules.length - 1; index >= 0; index--)
            if (modules[index]?.packageId === row.id) modules.splice(index, 1)
          for (let index = rows.length - 1; index >= 0; index--)
            if (rows[index]?.packageId === row.id) rows.splice(index, 1)
          for (let index = assets.length - 1; index >= 0; index--)
            if (assets[index]?.packageId === row.id) assets.splice(index, 1)
          for (const key of Object.keys(migration.aliases)) delete rowAliases[key]
          resourcesChanged = true
          resourceFailure = true
        })
      }
      if (current.current && current.current !== selectedRevision)
        retained.push({ revision: current.current, expiresAt: new Date(nowMs + retentionMs).toISOString() })
      const declarationMap = Object.fromEntries(
        activeDeclarations.map((item) => [item.rowId, storedDeclaration(item)]),
      )
      const nextDeclarations = { ...(current.declarations ?? {}), [selectedRevision]: declarationMap }
      state = {
        ...state,
        packages: {
          ...state.packages,
          [row.id]: {
            current: selectedRevision,
            retained,
            declarations: nextDeclarations,
            ...(Object.keys(migration.aliases).length ? { rowAliases: migration.aliases } : {}),
          },
        },
      }
      for (const [oldRowId, canonicalRowId] of Object.entries(migration.aliases))
        rowAliases[oldRowId] = canonicalRowId
      if (publication === 'published') resourcesChanged = true
      const visible = retained.filter(
        (item): item is Readonly<{ revision: string; expiresAt: string }> => item.expiresAt !== undefined,
      )
      for (const { item, admission, purpose, files } of candidateRows) {
        const contentDigest = snapshotContentDigest(files)
        const entryUrl = route(row.id, selectedRevision, item.entry)
        const projection = await contributionProjection(
          row,
          item.client,
          item.rowId,
          selectedRevision,
          input.archive ? { profile: input.profile } : input,
          state.activations?.[row.id]?.id,
          item.moduleName,
          admission.kind === 'native' && admission.source === 'approved-presentation'
            ? admission.grants
            : undefined,
          presentation?.grants,
        )
        assets.push({
          rowId: item.rowId,
          packageId: row.id,
          revision: selectedRevision,
          purpose,
          admission,
          files,
        })
        const commonRow = {
          rowId: item.rowId,
          moduleName: item.moduleName,
          packageId: row.id,
          enabled: true,
          phase: 'ready' as const,
          revision: selectedRevision,
          contentDigest,
        }
        if (admission.kind === 'isolated-component') {
          statuses.push({ ...baseStatus, state: 'ready' })
          rows.push({
            ...commonRow,
            ...(projection.binding ? { binding: projection.binding } : {}),
            rendererDataUrl: `${entryUrl}?agnes_ui_source=1`,
            ...(item.client.intelligentComponents
              ? { intelligentComponents: item.client.intelligentComponents }
              : {}),
          })
          continue
        }
        const bindingDigest = admissionDigest([
          admission.evidence,
          input.profile,
          input.archive?.id ?? null,
          item.rowId,
          selectedRevision,
          contentDigest,
          projection.binding?.activationId ?? null,
          activationEpoch ?? null,
          admissionDigest(item.client),
        ])
        const documentAdmission: DocumentAdmission =
          admission.source === 'release'
            ? { kind: admission.source, bindingDigest }
            : { kind: admission.source, bindingDigest, presentationRevision: admission.presentationRevision }
        statuses.push({ ...baseStatus, state: 'ready', ...(visible.length ? { retained: visible } : {}) })
        modules.push({
          ...(declared.length === 1 ? {} : { rowId: item.rowId }),
          packageId: row.id,
          revision: selectedRevision,
          entryUrl,
          styleUrls: item.styles.map((path) => route(row.id, selectedRevision, path)),
          slots: [...(item.client.slots ?? [])],
          ...(item.client.slotCatalogVersion === undefined
            ? {}
            : { slotCatalogVersion: item.client.slotCatalogVersion }),
          contentDigest,
          extIds: [...item.extIds],
          ...(item.client.publicConfig === undefined ? {} : { publicConfig: item.client.publicConfig }),
        })
        rows.push({
          ...projection,
          ...commonRow,
          documentAdmission,
          entryUrl,
          styleUrls: item.styles.map((path) => route(row.id, selectedRevision, path)),
          slots: [...(item.client.slots ?? [])],
          ...(item.client.slotCatalogVersion === undefined
            ? {}
            : { slotCatalogVersion: item.client.slotCatalogVersion }),
          extIds: [...item.extIds],
          services: [...(item.client.services ?? [])],
          ...(item.client.streams ? { streams: [...item.client.streams] } : {}),
          ...(item.client.publicConfig === undefined ? {} : { publicConfig: item.client.publicConfig }),
        })
      }
    }
    await publications.verify(input.refreshInventory)
    const bounded = Object.entries(state.packages).map(([id, item]) => [id, trackedDeclarations(item)])
    state = { ...state, packages: Object.fromEntries(bounded) }
    await saveState(root, input.profile, state, beforeState)
    const freshness = assets.length
      ? await checkCurrent(
          assets.some(
            ({ admission }) => admission.kind === 'native' && admission.source === 'approved-presentation',
          ),
        )
      : 'current'
    const allowed = assets.filter(
      ({ admission }) =>
        freshness === 'current' ||
        (freshness === 'presentation-changed' &&
          (admission.kind !== 'native' || admission.source !== 'approved-presentation')),
    )
    const allowedRows = new Set(allowed.map((asset) => asset.rowId))
    const selectedRows = rows.filter((row) => allowedRows.has(row.rowId))
    const selectedModules = modulesForContributionRows(modules, selectedRows)
    const selectedAliases = Object.fromEntries(
      Object.entries(rowAliases).filter(([, target]) => allowedRows.has(target)),
    )
    resourceFailures.set(input.profile, resourceFailure)
    scheduleExpiry(input.profile, state)
    const result: ClientModuleListResult = {
      revision: rosterRevision({
        modules: selectedModules,
        statuses,
        rows: selectedRows,
        rowAliases: selectedAliases,
      }),
      rows: selectedRows,
      modules: selectedModules,
      statuses,
      serverTime: now.toISOString(),
      ...(Object.keys(selectedAliases).length ? { rowAliases: selectedAliases } : {}),
    }
    if (
      !closed &&
      !resourceFailure &&
      !activationUnavailable &&
      freshness === 'current' &&
      presentation &&
      observedActual &&
      allowed.some(({ admission }) => admission.kind === 'native' && admission.source === 'approved-presentation')
    ) {
      try {
        const selection = options.composition?.(input.profile)
        const visible = new Set(filterRoster(result, selection).rows?.map(({ rowId }) => rowId))
        publishedReads.remember(input, root, state, allowed, selection, visible, {
          runtime: observedRuntime,
          epoch: activationEpoch,
          presentation,
          actual: observedActual,
          sources: observedSources,
        })
      } catch {
        publishedReads.invalidate(input.profile)
      }
    }
    const previous = lastRevision.get(input.profile)
    lastRevision.set(input.profile, result.revision)
    if (announce) {
      if (previous === undefined)
        emit({ profile: input.profile, revision: result.revision, reason: 'rebuilt' })
      else if (previous !== result.revision)
        emit({
          profile: input.profile,
          revision: result.revision,
          reason: resourcesChanged ? 'resources' : 'inventory',
        })
      else if (resourcesChanged)
        emit({ profile: input.profile, revision: result.revision, reason: 'resources' })
    }
    return { roster: result, assets: allowed, state, checkCurrent }
  }

  const retainedAsset = async (
    input: ClientRegistryInput & { path: string },
    state: ProfileState,
    visible: ReturnType<NonNullable<ClientModuleRegistryOptions['composition']>>,
  ): Promise<SelectedAsset | undefined> => {
    if (input.archive) return undefined
    const now = clock().getTime()
    for (const row of input.inventory.packages) {
      if (!row.trusted || row.blockers.length) continue
      const cached = Object.hasOwn(state.packages, row.id) ? state.packages[row.id] : undefined
      for (const retained of cached?.retained ?? []) {
        const revision = retained.revision
        const expiresAt = retained.expiresAt === undefined ? undefined : Date.parse(retained.expiresAt)
        if (
          (expiresAt !== undefined && expiresAt <= now) ||
          !input.path.startsWith(route(row.id, revision, ''))
        )
          continue
        const tree = observedTree(row, revision)
        if (!tree || !releaseEvidence(tree, false)) continue
        const declared = treeDeclarations(row, tree)
        const rendererPaths = new Set(
          declared.filter(({ client }) => client.intelligentComponents?.length).map(({ entry }) => entry),
        )
        for (const item of declared) {
          if (
            item.client.intelligentComponents?.length ||
            !supportsClientSlots(item.client) ||
            (visible &&
              !compositionModuleAllowed(visible, {
                id: item.rowId,
                aliases: [item.moduleName, row.id],
                slots: item.client.slots ?? [],
              }))
          )
            continue
          const files = await rowFiles(tree, item, 'document')
          if (!files || [...files.keys()].some((path) => rendererPaths.has(path))) continue
          const match = [...files].find(([path]) => route(row.id, revision, path) === input.path)
          if (
            !match ||
            (await hashDirectoryAsync(tree.directory, { exclude: [], verifyFiles: files }).catch(
              () => undefined,
            )) !== tree.treeIntegrity
          )
            continue
          const [path, bytes] = match
          return {
            file: { path, bytes: bytes.length, sha256: digest(bytes) },
            packageId: row.id,
            revision,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }
        }
      }
    }
    return undefined
  }

  const settleRead = (read: PendingRead, result?: ClientModuleReadResult): void => {
    if (pendingReads.delete(read)) read.resolve(result ?? { found: false })
  }

  const delivery = { closed: () => closed, settle: settleRead, now: () => clock().getTime() }

  const readBatch = (reads: readonly PendingRead[], prepared: Reconciled): Promise<void> =>
    readAssetBatch(
      reads,
      async (input) => {
        const root = options.snapshotDirectory(input.profile, input.profileDirectory)
        const visible = options.composition?.(input.profile)
        const rows = new Set(
          filterRoster(prepared.roster, visible)
            .rows?.filter((row) => !input.archive || historicalContribution(row))
            .map(({ rowId }) => rowId),
        )
        let approved: SelectedAsset | undefined
        for (const grant of prepared.assets) {
          if (grant.purpose !== input.purpose || !rows.has(grant.rowId)) continue
          const { packageId, revision } = grant
          const file = grant.files.find(({ path }) => route(packageId, revision, path) === input.path)
          if (!file) continue
          const asset = { file, packageId, revision }
          if (grant.admission.kind !== 'native' || grant.admission.source !== 'approved-presentation')
            return { root, asset, kind: 'current' }
          approved = asset
        }
        if (approved) return { root, asset: approved, kind: 'approved' }
        if (input.purpose === 'document') {
          const asset = await retainedAsset(input, prepared.state, visible)
          if (asset) return { root, asset, kind: 'retained' }
        }
      },
      prepared.checkCurrent,
      delivery,
    )

  const queueRead = (read: PendingRead): void => {
    const { input } = read
    const { profile } = input
    const queued = queuedReads.get(profile)
    if (
      !input.archive &&
      queued?.input.inventory === input.inventory &&
      queued.input.profileDirectory === input.profileDirectory &&
      queued.input.sessionId === input.sessionId &&
      sameReadAdapters(queued.input, input) &&
      queued.tail === tails.get(profile)
    ) {
      queued.reads.push(read)
      if (queued.reads.length === MAX_BATCH_READS) queuedReads.delete(profile)
      return
    }
    const reads = [read]
    void serialize(profile, async () => {
      if (queuedReads.get(profile)?.reads === reads) queuedReads.delete(profile)
      try {
        await pruneGenerationAssets(input)
        if (closed) return
        inputs.set(profile, input)
        const published = await publishedReads.batch(input, reads)
        if (closed) return
        let selected = input
        let remaining = reads
        if (published) {
          await readAssetBatch(reads, published.select, published.checkCurrent, delivery)
          if (closed) return
          const failure = published.failure()
          if (!failure) return
          if (failure.kind === 'terminal') {
            emitResourceFailure(input)
            return
          }
          remaining = reads.filter(
            (member) => pendingReads.has(member) && failure.paths.has(member.input.path),
          )
          if (!remaining.length) return
          selected = { ...input, inventory: failure.inventory }
          inputs.set(profile, selected)
        }
        const prepared = await reconcile(selected, true)
        await readBatch(remaining, prepared)
      } finally {
        for (const member of reads) settleRead(member)
      }
    }).catch(() => undefined)
    // Only callers adjacent at the profile's queue tail may share this preparation.
    if (!input.archive) queuedReads.set(profile, { input, reads, tail: tails.get(profile) })
  }

  const readGeneration = async (
    input: ReadInput,
    generationId: string,
    path: string,
  ): Promise<ClientModuleReadResult> => {
    if (input.archive) return { found: false }
    await serialize(input.profile, () => pruneGenerationAssets(input))
    if (closed) return { found: false }
    const selected = await generationInput(input, generationId)
    if (closed) {
      selected.registry.close()
      return { found: false }
    }
    return selected.registry.read({ ...selected.input, path: `/plugins/${path}`, purpose: input.purpose })
  }

  return {
    list: async (input) => {
      return serialize(input.profile, async () => {
        await pruneGenerationAssets(input)
        inputs.set(input.profile, input)
        const pin = input.sessionId
          ? new RuntimeGenerationSnapshotStore(input.profileDirectory).session(input.sessionId)
          : undefined
        // Historical publication owns a separate directory/queue. Settle both reads before
        // releasing this profile's queue, including on failure; neither can publish a partial roster.
        const results = await Promise.allSettled([
          reconcile(input, true),
          pin ? generationRoster(input, pin.generationId).catch(() => undefined) : Promise.resolve(undefined),
        ])
        for (const result of results) if (result.status === 'rejected') throw result.reason
        const [profileRead, historicalRead] = results
        if (profileRead.status !== 'fulfilled' || historicalRead.status !== 'fulfilled')
          throw new Error('Roster unavailable')
        const prepared = profileRead.value
        let current = prepared.roster
        if (pin && current.rows?.length) {
          const freshness = await prepared.checkCurrent(
            current.rows.some((row) => row.documentAdmission?.kind === 'approved-presentation'),
          )
          if (freshness !== 'current')
            current = withRosterRows(
              current,
              freshness === 'presentation-changed'
                ? current.rows.filter((row) => row.documentAdmission?.kind !== 'approved-presentation')
                : [],
            )
        }
        current = filterRoster(current, options.composition?.(input.profile))
        if (!pin || !input.sessionId) return current
        const historical = historicalRead.value
        const selection = new CompositionSessionStore(input.profileDirectory).read(input.sessionId)?.tree
          .selection
        const selected = historical
          ? filterRoster(historical, selection)
          : { ...current, rows: [], modules: [], statuses: [], rowAliases: {} }
        const result = combineContributionRosters(current, selected)
        return { ...result, revision: rosterRevision(result) }
      }).catch((error: unknown) => {
        emitResourceFailure(input)
        throw error
      })
    },
    refresh: (input, reason, packageId) =>
      serialize(input.profile, async () => {
        await pruneGenerationAssets(input)
        inputs.set(input.profile, input)
        const { roster: result } = await reconcile(input, false)
        emit({
          profile: input.profile,
          revision: result.revision,
          reason: resourceFailures.get(input.profile) ? 'resources' : reason,
          ...(packageId === undefined ? {} : { packageId }),
        })
        return result
      }).catch((error: unknown) => {
        emitResourceFailure(input)
        throw error
      }),
    read: (input) => {
      if (closed) return Promise.resolve({ found: false })
      return new Promise<ClientModuleReadResult>((resolve) => {
        const read = { input, resolve }
        pendingReads.add(read)
        try {
          const generation = /^\/plugins\/generations\/([a-f0-9-]{36})\/(.+)$/.exec(input.path)
          if (generation?.[1] && generation[2])
            void readGeneration(input, generation[1], generation[2]).then(
              (result) => settleRead(read, result),
              () => settleRead(read),
            )
          else queueRead(read)
        } catch {
          settleRead(read)
        }
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      for (const read of pendingReads) settleRead(read)
      generations.close()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      inputs.clear()
      resourceFailures.clear()
      queuedReads.clear()
      publishedReads.clear()
      listeners.clear()
    },
  }
}

/** Default keeps snapshots beside the profile lock but outside every mutable package tree. */
export function defaultClientModuleSnapshotDirectory(_profile: string, profileDirectory: string): string {
  return join(profileDirectory, '.daemon-client-modules')
}
