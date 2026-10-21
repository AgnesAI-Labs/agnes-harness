import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { clientModuleRowIdForContribution } from '@agnes/daemon-foundation/composite-desired'
import { type CompositionPatch, CompositionSessionStore, compositionModuleAllowed } from '@agnes/host'
import {
  CLIENT_RESOURCE_MAX_FILE_BYTES,
  CLIENT_RESOURCE_MAX_TOTAL_BYTES,
  type InstalledInventory,
  type InstalledPackage,
  isRuntimePackageEligible,
  RuntimeGenerationSnapshotStore,
  resolveClientModuleAsset,
} from '@agnes/package-manager'
import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  type ClientModuleListResult,
  type ClientModuleReadResult,
  DSH_WEB_CLIENT_SLOT_CATALOG_VERSION,
  isDshWebClientModuleSlotName,
  isWebClientModuleSlotName,
  jcs,
} from '@agnes/protocol'
import { validUiComponentDeclaration } from '@agnes/protocol/intelligent-ui'
import { cleanRelative, collectSnapshotFiles, SERVABLE } from './client-asset-references.js'
import { createClientGenerations } from './client-generations.js'
import { createPublicationChecks } from './client-publication-checks.js'
import { runtimeClientTruth } from './client-runtime-truth.js'
import {
  clientContributionDeclarations,
  combineContributionRosters,
  contributionProjection,
  reconcileContributionActivations,
} from './contribution-roster.js'
import type { PackageActivationObservation } from './handler.js'

export const CLIENT_MODULE_RETENTION_MS = 30 * 60 * 1000
export const CLIENT_MODULE_SNAPSHOT_QUOTA_BYTES = 256 * 1024 * 1024

const STATE_FILE = '_client-modules.json'
const SNAPSHOT_FILE = '_snapshot.json'
const CLIENT_PARENT_CHILD_DECLARATION_VERSION = 'dsh-parent-child/v1'
const PACKAGE_ID =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/
const REVISION = /^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/
const GENERATION_ID = /^[a-f0-9-]{36}$/
const MAX_METADATA_BYTES = 1024 * 1024

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

type Retained = Readonly<{ revision: string; expiresAt?: string; protected?: boolean }>
type StoredDeclaration = Readonly<{
  id?: string
  moduleName: string
  legacyRowIds?: readonly string[]
  entry: string
  styles: readonly string[]
  slots: readonly string[]
  slotCatalogVersion?: string
  extIds: readonly string[]
  services: readonly string[]
  streams?: ClientContribution['streams']
  backendRowId?: string
  intelligentComponents?: ClientContribution['intelligentComponents']
  requiresBackendRows?: ClientContribution['requiresBackendRows']
  presentationRoles?: ClientContribution['presentationRoles']
  lifetime?: ClientContribution['lifetime']
  homeEntries?: ClientContribution['homeEntries']
  examplePages?: ClientContribution['examplePages']
  assets?: ClientContribution['assets']
  publicConfig?: Readonly<Record<string, unknown>>
}>
type PackageState = Readonly<{
  current?: string
  retained: readonly Retained[]
  declarations?: Readonly<Record<string, Readonly<Record<string, StoredDeclaration>>>>
  rowAliases?: Readonly<Record<string, string>>
}>
type ProfileState = Readonly<{
  version: 1
  activations?: Readonly<Record<string, { identity: string; id: string; active: boolean }>>
  profile: string
  packages: Readonly<Record<string, PackageState>>
}>
type SnapshotManifest = Readonly<{
  version: 2
  packageId: string
  revision: string
  contentDigest: string
  rows: readonly Readonly<{
    rowId: string
    moduleName: string
    entry: string
    styles: readonly string[]
    slots: readonly string[]
    slotCatalogVersion?: string
    parentChildVersion: string
    contentDigest: string
  }>[]
  files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[]
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
}>

export { type RuntimeArtifactsStore, runtimeArtifactsFromStore } from './client-runtime-truth.js'

export type ClientModuleRegistry = Readonly<{
  list(input: {
    sessionId?: string
    profile: string
    profileDirectory: string
    inventory: InstalledInventory
    actual(packageId: string): Promise<PackageActivationObservation | undefined>
    refreshInventory(): Promise<InstalledInventory>
  }): Promise<ClientModuleListResult>
  refresh(
    input: {
      profile: string
      profileDirectory: string
      inventory: InstalledInventory
      actual(packageId: string): Promise<PackageActivationObservation | undefined>
      refreshInventory(): Promise<InstalledInventory>
    },
    reason: ClientModulesChanged['reason'],
    packageId?: string,
  ): Promise<ClientModuleListResult>
  read(input: {
    profile: string
    profileDirectory: string
    inventory: InstalledInventory
    path: string
    actual(packageId: string): Promise<PackageActivationObservation | undefined>
    refreshInventory(): Promise<InstalledInventory>
  }): Promise<ClientModuleReadResult>
  subscribe(listener: (event: ClientModulesChanged) => void): () => void
  close(): void
}>

function emptyState(profile: string): ProfileState {
  return { version: 1, profile, packages: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isWebRowId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('web:') &&
    value.length >= 5 &&
    value.length <= 256 &&
    !value.includes('\0')
  )
}

function isState(value: unknown, profile: string): value is ProfileState {
  if (!isRecord(value) || value.version !== 1 || value.profile !== profile || !isRecord(value.packages))
    return false
  if (Object.keys(value.packages).length > 256) return false
  if (
    value.activations !== undefined &&
    (!isRecord(value.activations) ||
      Object.keys(value.activations).length > 256 ||
      Object.values(value.activations).some(
        (item) =>
          !isRecord(item) ||
          typeof item.identity !== 'string' ||
          typeof item.id !== 'string' ||
          typeof item.active !== 'boolean',
      ))
  )
    return false
  for (const [packageId, item] of Object.entries(value.packages)) {
    if (!PACKAGE_ID.test(packageId)) return false
    if (!isRecord(item) || !Array.isArray(item.retained)) return false
    if (item.current !== undefined && (typeof item.current !== 'string' || !REVISION.test(item.current)))
      return false
    if (item.retained.length > 8) return false
    if (
      item.retained.some(
        (entry) =>
          !isRecord(entry) ||
          typeof entry.revision !== 'string' ||
          (entry.expiresAt !== undefined && typeof entry.expiresAt !== 'string') ||
          (entry.expiresAt === undefined && entry.protected !== true),
      )
    )
      return false
    for (const entry of item.retained) {
      const retained = entry as { revision: string; expiresAt?: string; protected?: boolean }
      if (!REVISION.test(retained.revision)) return false
      if (retained.protected !== undefined && typeof retained.protected !== 'boolean') return false
      if (retained.expiresAt !== undefined) {
        const timestamp = Date.parse(retained.expiresAt)
        if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== retained.expiresAt)
          return false
      } else if (retained.protected !== true) return false
    }
    const revisions = item.retained.map((entry) => (entry as { revision: string }).revision)
    if (new Set(revisions).size !== revisions.length || (item.current && revisions.includes(item.current)))
      return false
    if (item.declarations !== undefined) {
      if (!isRecord(item.declarations) || Object.keys(item.declarations).length > 16) return false
      for (const [revision, declarations] of Object.entries(item.declarations)) {
        // The same per-revision row bound as the snapshot manifest the declarations describe.
        if (!REVISION.test(revision) || !isRecord(declarations) || Object.keys(declarations).length > 64)
          return false
        for (const [rowId, declaration] of Object.entries(declarations)) {
          if (!rowId.startsWith('web:') || !isRecord(declaration)) return false
          if (
            (declaration.id !== undefined &&
              (typeof declaration.id !== 'string' ||
                !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(declaration.id))) ||
            (declaration.presentationRoles !== undefined &&
              (!Array.isArray(declaration.presentationRoles) ||
                declaration.presentationRoles.some(
                  (role) =>
                    ![
                      'navigation',
                      'conversation',
                      'composer',
                      'goal',
                      'interaction',
                      'deliverables',
                    ].includes(role),
                ))) ||
            typeof declaration.moduleName !== 'string' ||
            (declaration.legacyRowIds !== undefined &&
              (!Array.isArray(declaration.legacyRowIds) ||
                !declaration.legacyRowIds.every((legacyRowId) => isWebRowId(legacyRowId)))) ||
            typeof declaration.entry !== 'string' ||
            !Array.isArray(declaration.styles) ||
            !declaration.styles.every((path) => typeof path === 'string') ||
            !Array.isArray(declaration.slots) ||
            !declaration.slots.every((slot) => typeof slot === 'string') ||
            (declaration.slotCatalogVersion !== undefined &&
              typeof declaration.slotCatalogVersion !== 'string') ||
            !Array.isArray(declaration.extIds) ||
            !declaration.extIds.every((id) => typeof id === 'string') ||
            !Array.isArray(declaration.services) ||
            !declaration.services.every((service) => typeof service === 'string') ||
            (declaration.requiresBackendRows !== undefined &&
              (!Array.isArray(declaration.requiresBackendRows) ||
                declaration.requiresBackendRows.length > 32 ||
                !declaration.requiresBackendRows.every(
                  (id) =>
                    typeof id === 'string' &&
                    id.length > 0 &&
                    id.length <= 256 &&
                    ![...id].some((character) => character.charCodeAt(0) < 32),
                ))) ||
            (declaration.publicConfig !== undefined && !isRecord(declaration.publicConfig)) ||
            (declaration.intelligentComponents !== undefined &&
              (!Array.isArray(declaration.intelligentComponents) ||
                declaration.intelligentComponents.length > 16 ||
                !declaration.intelligentComponents.every(validUiComponentDeclaration)))
          )
            return false
        }
      }
    }
    if (item.rowAliases !== undefined) {
      if (!isRecord(item.rowAliases) || Object.keys(item.rowAliases).length > 256) return false
      for (const [oldRowId, canonicalRowId] of Object.entries(item.rowAliases)) {
        if (
          !isWebRowId(oldRowId) ||
          typeof canonicalRowId !== 'string' ||
          !isWebRowId(canonicalRowId) ||
          oldRowId === canonicalRowId
        )
          return false
      }
    }
  }
  return true
}

function isSnapshotManifest(value: unknown, packageId: string, revision: string): value is SnapshotManifest {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.packageId === packageId &&
    value.revision === revision &&
    typeof value.contentDigest === 'string' &&
    /^sha256-[a-f0-9]{64}$/.test(value.contentDigest) &&
    PACKAGE_ID.test(packageId) &&
    REVISION.test(revision) &&
    Array.isArray(value.rows) &&
    value.rows.length > 0 &&
    value.rows.length <= 64 &&
    value.rows.every(
      (row) =>
        isRecord(row) &&
        isWebRowId(row.rowId) &&
        typeof row.moduleName === 'string' &&
        typeof row.entry === 'string' &&
        cleanRelative(row.entry) === row.entry &&
        Array.isArray(row.styles) &&
        row.styles.every((path) => typeof path === 'string' && cleanRelative(path) === path) &&
        Array.isArray(row.slots) &&
        row.slots.every((slot) => typeof slot === 'string') &&
        (row.slotCatalogVersion === undefined || typeof row.slotCatalogVersion === 'string') &&
        row.parentChildVersion === CLIENT_PARENT_CHILD_DECLARATION_VERSION &&
        typeof row.contentDigest === 'string' &&
        /^sha256-[a-f0-9]{64}$/.test(row.contentDigest),
    ) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.length <= 4096 &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        cleanRelative(file.path) === file.path &&
        SERVABLE.has(extname(file.path).toLowerCase()) &&
        Number.isInteger(file.bytes) &&
        (file.bytes as number) >= 0 &&
        (file.bytes as number) <= CLIENT_RESOURCE_MAX_FILE_BYTES &&
        typeof file.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(file.sha256),
    )
  )
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function snapshotContentDigest(files: SnapshotManifest['files']): string {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path))
  return `sha256-${createHash('sha256').update(jcs(sorted), 'utf8').digest('hex')}`
}

function encodedRevision(revision: string): string {
  return encodeURIComponent(revision)
}

function snapshotDirectory(root: string, packageId: string, revision: string): string {
  if (!PACKAGE_ID.test(packageId) || !REVISION.test(revision))
    throw new Error('invalid client-module snapshot identity')
  return join(root, ...packageId.split('/'), encodedRevision(revision))
}

function route(packageId: string, revision: string, path: string): string {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `/plugins/${packageId}/${encodedRevision(revision)}/${encodedPath}`
}

function declarations(row: InstalledPackage): readonly ClientDeclaration[] {
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
      rowId: clientModuleRowIdForContribution(row.id, owner.id, clients.length, owner.client.id ?? owner.id),
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

function hasClient(row: InstalledPackage): boolean {
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

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function readState(root: string, profile: string): Promise<ProfileState | undefined> {
  try {
    const path = join(root, STATE_FILE)
    if ((await stat(path)).size > MAX_METADATA_BYTES) return undefined
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isState(parsed, profile) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function verifySnapshot(
  root: string,
  packageId: string,
  revision: string,
): Promise<{ bytes: number; manifest: SnapshotManifest } | null> {
  const directory = snapshotDirectory(root, packageId, revision)
  let canonicalRoot: string
  let canonicalDirectory: string
  let parsed: unknown
  try {
    canonicalRoot = await realpath(root)
    canonicalDirectory = await realpath(directory)
    const directoryRel = relative(canonicalRoot, canonicalDirectory)
    if (
      directoryRel === '' ||
      directoryRel === '..' ||
      directoryRel.startsWith(`..${sep}`) ||
      resolve(canonicalRoot, directoryRel) !== canonicalDirectory
    )
      return null
    const manifestPath = join(canonicalDirectory, SNAPSHOT_FILE)
    if ((await stat(manifestPath)).size > MAX_METADATA_BYTES) return null
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (!isSnapshotManifest(parsed, packageId, revision)) return null
  if (new Set(parsed.files.map((file) => file.path)).size !== parsed.files.length) return null
  if (parsed.contentDigest !== snapshotContentDigest(parsed.files)) return null
  if (
    new Set(parsed.rows.map((row) => row.rowId)).size !== parsed.rows.length ||
    parsed.rows.some(
      (row) =>
        row.contentDigest !== parsed.contentDigest ||
        !parsed.files.some((file) => file.path === row.entry) ||
        row.styles.some((style) => !parsed.files.some((file) => file.path === style)),
    )
  )
    return null
  let total = 0
  for (const file of parsed.files) {
    let target: string
    try {
      target = await realpath(resolve(canonicalDirectory, file.path))
    } catch {
      return null
    }
    const rel = relative(canonicalDirectory, target)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null
    try {
      const bytes = await readFile(target)
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) return null
      total += bytes.length
      if (total > CLIENT_RESOURCE_MAX_TOTAL_BYTES) return null
    } catch {
      return null
    }
  }
  return { bytes: total, manifest: parsed }
}

async function removeSnapshot(root: string, packageId: string, revision: string): Promise<void> {
  if (!PACKAGE_ID.test(packageId) || !REVISION.test(revision)) return
  const target = resolve(snapshotDirectory(root, packageId, revision))
  const rel = relative(resolve(root), target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return
  await rm(target, { recursive: true, force: true })
}

async function snapshotBytes(root: string, state: ProfileState): Promise<number> {
  let total = 0
  for (const [packageId, item] of Object.entries(state.packages)) {
    for (const revision of new Set([
      ...(item.current ? [item.current] : []),
      ...item.retained.map((entry) => entry.revision),
    ])) {
      const snapshot = await verifySnapshot(root, packageId, revision)
      if (snapshot !== null) total += snapshot.bytes
    }
  }
  return total
}

/** Declarations only for the revisions a package state still tracks, so the map stays bounded. */
function trackedDeclarations(item: PackageState): PackageState {
  if (!item.declarations) return item
  const revisions = [item.current, ...item.retained.map((entry) => entry.revision)]
  const kept = Object.entries(item.declarations).filter(([revision]) => revisions.includes(revision))
  return { ...item, declarations: Object.fromEntries(kept) }
}

async function pruneUntracked(root: string, state: ProfileState): Promise<boolean> {
  const tracked = new Set<string>()
  for (const [packageId, item] of Object.entries(state.packages))
    for (const revision of [
      ...(item.current ? [item.current] : []),
      ...item.retained.map((entry) => entry.revision),
    ])
      tracked.add(resolve(snapshotDirectory(root, packageId, revision)))
  let changed = false
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.isFile() && entry.name === SNAPSHOT_FILE)) {
      if (!tracked.has(resolve(directory))) {
        await rm(directory, { recursive: true, force: true })
        changed = true
      }
      return
    }
    if (depth >= 3) return
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // A generation registry owns `generations/<id>` and prunes it in its own serialization domain.
      if (directory === join(root, 'generations') && GENERATION_ID.test(entry.name)) continue
      const child = join(directory, entry.name)
      if (entry.name.startsWith('_staging-')) {
        await rm(child, { recursive: true, force: true })
        changed = true
      } else await visit(child, depth + 1)
    }
  }
  await visit(root, 0)
  return changed
}

async function publishSnapshot(input: {
  root: string
  row: InstalledPackage
  declarations: readonly ClientDeclaration[]
  quotaAvailable: number
}): Promise<'published' | 'present' | 'quota' | 'invalid'> {
  const { root, row, declarations } = input
  if (!row.directory) return 'invalid'
  if ((await verifySnapshot(root, row.id, row.entry.integrity)) !== null) return 'present'
  const finalDirectory = snapshotDirectory(root, row.id, row.entry.integrity)
  // A corrupt/incomplete candidate at the final name is never served. Removing it is safe because
  // its manifest failed verification, and the same integrity binds the verified install tree.
  await rm(finalDirectory, { recursive: true, force: true })
  const staging = join(root, `_staging-${randomUUID()}`)
  const files = await collectSnapshotFiles(
    row.directory,
    declarations.flatMap((declared) => [
      declared.entry,
      ...declared.styles,
      ...(declared.client.assets ?? []).map((asset) =>
        posix.join(
          posix.dirname(declared.entry),
          posix.relative(posix.dirname(declared.client.entry), asset),
        ),
      ),
    ]),
  )
  if (!files) return 'invalid'
  const manifestFiles: SnapshotManifest['files'][number][] = []
  try {
    let total = 0
    for (const [path, bytes] of files) {
      total += bytes.length
      if (total > input.quotaAvailable) return 'quota'
      const target = join(staging, path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, bytes, { mode: 0o600 })
      manifestFiles.push({ path, bytes: bytes.length, sha256: digest(bytes) })
    }
    const manifest: SnapshotManifest = {
      version: 2,
      packageId: row.id,
      revision: row.entry.integrity,
      contentDigest: snapshotContentDigest(manifestFiles),
      rows: declarations.map((declared) => ({
        rowId: declared.rowId,
        moduleName: declared.moduleName,
        entry: declared.entry,
        styles: [...declared.styles],
        slots: [...(declared.client.slots ?? [])],
        ...(declared.client.slotCatalogVersion === undefined
          ? {}
          : { slotCatalogVersion: declared.client.slotCatalogVersion }),
        parentChildVersion: CLIENT_PARENT_CHILD_DECLARATION_VERSION,
        contentDigest: snapshotContentDigest(manifestFiles),
      })),
      files: manifestFiles,
    }
    await writeFile(join(staging, SNAPSHOT_FILE), `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
    // Re-read every copied byte before publication. The final rename is the publication point.
    for (const file of manifestFiles) {
      const bytes = await readFile(join(staging, file.path))
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) return 'invalid'
    }
    await mkdir(dirname(finalDirectory), { recursive: true, mode: 0o700 })
    await rename(staging, finalDirectory)
    return 'published'
  } catch {
    return 'invalid'
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function rosterRevision(
  value: Pick<ClientModuleListResult, 'modules' | 'statuses' | 'rows' | 'rowAliases'>,
): string {
  return `sha256-${createHash('sha256').update(jcs(value), 'utf8').digest('hex')}`
}

export function createClientModuleRegistry(options: ClientModuleRegistryOptions): ClientModuleRegistry {
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
    const modules = roster.modules.filter((module) => rows.some((row) => row.entryUrl === module.entryUrl))
    const statuses = roster.statuses.filter((status) =>
      rows.some((row) => row.packageId === status.packageId),
    )
    const selected = { ...roster, rows, modules, statuses }
    return { ...selected, revision: rosterRevision(selected) }
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
  const assetPreparations = new Map<
    string,
    {
      inventory: InstalledInventory
      directory: string
      tail: Promise<void> | undefined
      promise: Promise<void>
    }
  >()
  const inputs = new Map<string, Parameters<ClientModuleRegistry['list']>[0]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const resourceFailures = new Map<string, boolean>()

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
      return await task()
    } finally {
      release()
      if (tails.get(profile) === queued) tails.delete(profile)
    }
  }

  const scheduleExpiry = (profile: string, state: ProfileState): void => {
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
  ): Promise<ClientModuleListResult> => {
    const root = options.snapshotDirectory(input.profile, input.profileDirectory)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const now = clock()
    const nowMs = now.getTime()
    const savedState = await readState(root, input.profile)
    const beforeState = savedState ? jcs(savedState) : undefined
    let state = savedState ?? emptyState(input.profile)
    state = {
      ...state,
      activations: reconcileContributionActivations(state.activations, input.inventory.packages),
    }

    let resourcesChanged = await pruneUntracked(root, state)
    let resourceFailure = false
    const packages: Record<string, PackageState> = {}
    const truth = runtimeClientTruth(options.runtimeArtifacts?.(input.profile))
    const installed = new Map(input.inventory.packages.map((row) => [row.id, row]))
    const trusted = new Map(
      input.inventory.packages
        .filter((row) => row.trusted && row.blockers.length === 0 && hasClient(row))
        .map((row) => [row.id, row]),
    )
    const eligible = new Map(
      input.inventory.packages
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
        (currentPackage === undefined || !currentPackage.enabled) &&
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
    const publications = createPublicationChecks(input.inventory)
    for (const row of [...eligible.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      const installedRevision = row.entry.integrity
      const liveDeclarations = declarations(row)
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
      const saved = current.declarations?.[selectedRevision]
      const declared =
        selectedRevision === installedRevision
          ? liveDeclarations
          : Object.entries(saved ?? {}).map(([rowId, value]) => ({
              rowId,
              moduleName: value.moduleName,
              legacyRowIds: [...(value.legacyRowIds ?? [])],
              client: {
                ...clientContributionDeclarations(value),
                entry: value.entry,
                slots: [...value.slots],
                ...(value.legacyRowIds === undefined ? {} : { legacyRowIds: [...value.legacyRowIds] }),
                ...(value.slotCatalogVersion === undefined
                  ? {}
                  : { slotCatalogVersion: value.slotCatalogVersion }),
                services: [...value.services],
                ...(value.intelligentComponents
                  ? { intelligentComponents: value.intelligentComponents }
                  : {}),
                ...(value.publicConfig === undefined ? {} : { publicConfig: value.publicConfig }),
              },
              entry: value.entry,
              styles: value.styles,
              extIds: value.extIds,
              services: value.services,
              ...(value.backendRowId ? { backendRowId: value.backendRowId } : {}),
              requiresBackend: value.extIds.length > 0,
            }))
      const selectedDeclarations = truth.useArtifact
        ? declared.filter((item) => truth.active.get(item.rowId)?.revision === selectedRevision)
        : declared
      const activeDeclarations = selectedDeclarations.filter((item) => {
        if (item.client.lifetime === 'profile' && selectedRevision !== installedRevision) return false
        if (!item.backendRowId) return true
        const backend = truth.backend.get(item.backendRowId)
        return backend?.packageId === row.id && backend.revision === selectedRevision
      })
      const migration = migrateRowAliases(
        current.current === undefined ? undefined : current.declarations?.[current.current],
        activeDeclarations,
        current.rowAliases,
      )
      let observation: PackageActivationObservation | undefined
      try {
        observation = await input.actual(row.id)
      } catch {
        observation = undefined
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
      if (!activeDeclarations.length || row.blockers.length) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
        resourceFailure = true
        continue
      }
      const unsupportedSlots = [
        ...new Set(
          activeDeclarations.flatMap((item) =>
            (item.client.slots ?? []).filter((slot) => !isWebClientModuleSlotName(slot)),
          ),
        ),
      ]
      const catalogVersionMismatch = activeDeclarations.some((item) =>
        (item.client.slots ?? []).some(
          (slot) =>
            isDshWebClientModuleSlotName(slot) &&
            item.client.slotCatalogVersion !== DSH_WEB_CLIENT_SLOT_CATALOG_VERSION,
        ),
      )
      if (unsupportedSlots.length || catalogVersionMismatch) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'unsupported-slot' })
        resourceFailure = true
        continue
      }
      if (requiresBackend && !backendRevision) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'backend-revision-unavailable' })
        continue
      }
      if (requiresBackend && backendRevision !== selectedRevision) {
        statuses.push({ ...baseStatus, state: 'pending-activation' })
        continue
      }
      if (requiresBackend && observation?.actual !== 'running') {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'backend-not-running' })
        continue
      }
      let publication: Awaited<ReturnType<typeof publishSnapshot>> = 'present'
      if (current.current !== selectedRevision) {
        if (
          selectedRevision !== installedRevision &&
          (await verifySnapshot(root, row.id, selectedRevision)) === null
        ) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
          resourceFailure = true
          continue
        }
        if (current.current && retained.length >= 8) {
          resourceFailure = true
          statuses.push({
            ...baseStatus,
            state: 'blocked',
            reason: 'snapshot-retention-limit',
            retained: reportRetained,
          })
          continue
        }
        const used = await snapshotBytes(root, state)
        publication = await publishSnapshot({
          root,
          row,
          declarations: activeDeclarations,
          quotaAvailable: Math.max(0, quotaBytes - used),
        })
      }
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
      const verifiedSnapshot = await verifySnapshot(root, row.id, selectedRevision)
      if (verifiedSnapshot === null) {
        statuses.push({ ...baseStatus, state: 'blocked', reason: 'resources-invalid' })
        resourceFailure = true
        continue
      }
      if (current.current !== selectedRevision && selectedRevision === installedRevision) {
        const prior = state.packages[row.id]
        publications.add(row, async () => {
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
          for (const key of Object.keys(migration.aliases)) delete rowAliases[key]
          resourcesChanged = true
          resourceFailure = true
        })
      }
      const contentDigest = snapshotContentDigest(verifiedSnapshot.manifest.files)
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
      for (const item of activeDeclarations) {
        if (
          item.client.requiresBackendRows?.some(
            (id) => !truth.backend.has(id) && !truth.activeBackendRows.has(id),
          )
        ) {
          statuses.push({ ...baseStatus, state: 'blocked', reason: 'backend-not-running' })
          continue
        }
        statuses.push({ ...baseStatus, state: 'ready', ...(visible.length ? { retained: visible } : {}) })
        modules.push({
          ...(activeDeclarations.length === 1 ? {} : { rowId: item.rowId }),
          packageId: row.id,
          revision: selectedRevision,
          entryUrl: route(row.id, selectedRevision, item.entry),
          styleUrls: item.styles.map((path) => route(row.id, selectedRevision, path)),
          slots: [...(item.client.slots ?? [])],
          ...(item.client.slotCatalogVersion === undefined
            ? {}
            : { slotCatalogVersion: item.client.slotCatalogVersion }),
          contentDigest,
          extIds: [...item.extIds],
          ...(item.client.intelligentComponents
            ? { intelligentComponents: item.client.intelligentComponents }
            : {}),
          ...(item.client.publicConfig === undefined ? {} : { publicConfig: item.client.publicConfig }),
        })
        rows.push({
          rowId: item.rowId,
          moduleName: item.moduleName,
          ...(await contributionProjection(
            row,
            item.client,
            item.rowId,
            selectedRevision,
            input,
            state.activations?.[row.id]?.id,
          )),
          packageId: row.id,
          enabled: true,
          phase: 'ready',
          revision: selectedRevision,
          entryUrl: route(row.id, selectedRevision, item.entry),
          styleUrls: item.styles.map((path) => route(row.id, selectedRevision, path)),
          slots: [...(item.client.slots ?? [])],
          ...(item.client.slotCatalogVersion === undefined
            ? {}
            : { slotCatalogVersion: item.client.slotCatalogVersion }),
          contentDigest,
          extIds: [...item.extIds],
          services: [...(item.client.services ?? [])],
          ...(item.client.streams ? { streams: [...item.client.streams] } : {}),
          ...(item.client.intelligentComponents
            ? { intelligentComponents: item.client.intelligentComponents }
            : {}),
          ...(item.client.publicConfig === undefined ? {} : { publicConfig: item.client.publicConfig }),
        })
      }
    }
    await publications.verify(input.refreshInventory)
    const bounded = Object.entries(state.packages).map(([id, item]) => [id, trackedDeclarations(item)])
    state = { ...state, packages: Object.fromEntries(bounded) }
    // An unreadable state reads back as empty and prunes every snapshot, so refuse to persist it.
    if (!isState(state, input.profile)) throw new Error('client-module state exceeds its persisted bounds')
    if (beforeState !== jcs(state)) await writeAtomic(join(root, STATE_FILE), state)
    resourceFailures.set(input.profile, resourceFailure)
    scheduleExpiry(input.profile, state)
    const result: ClientModuleListResult = {
      revision: rosterRevision({ modules, statuses, rows, rowAliases }),
      rows,
      modules,
      statuses,
      serverTime: now.toISOString(),
      ...(Object.keys(rowAliases).length ? { rowAliases } : {}),
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
    return result
  }

  return {
    list: async (input) => {
      await pruneGenerationAssets(input)
      inputs.set(input.profile, input)
      return serialize(input.profile, async () => {
        const pin = input.sessionId
          ? new RuntimeGenerationSnapshotStore(input.profileDirectory).session(input.sessionId)
          : undefined
        // Historical publication owns a separate directory/queue. Settle both reads before
        // releasing this profile's queue, including on failure; neither can publish a partial roster.
        const results = await Promise.allSettled([
          reconcile(input, true),
          pin ? generationRoster(input, pin.generationId) : Promise.resolve(undefined),
        ])
        for (const result of results) if (result.status === 'rejected') throw result.reason
        const [profileRead, historicalRead] = results
        if (profileRead.status !== 'fulfilled' || historicalRead.status !== 'fulfilled')
          throw new Error('Roster unavailable')
        const current = filterRoster(profileRead.value, options.composition?.(input.profile))
        const historical = historicalRead.value
        if (!historical || !input.sessionId) return current
        const selection = new CompositionSessionStore(input.profileDirectory).read(input.sessionId)?.tree
          .selection
        const selected = filterRoster(historical, selection)
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
        const result = await reconcile(input, false)
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
    read: async (input) => {
      const generationPath = /^\/plugins\/generations\/([a-f0-9-]{36})\/(.+)$/.exec(input.path)
      if (generationPath) {
        await serialize(input.profile, () => pruneGenerationAssets(input))
        const selected = await generationInput(input, generationPath[1] as string)
        return selected.registry.read({ ...selected.input, path: `/plugins/${generationPath[2]}` })
      }
      const prior = assetPreparations.get(input.profile)
      let preparation: Promise<void>
      if (
        prior?.inventory === input.inventory &&
        prior.directory === input.profileDirectory &&
        prior.tail === tails.get(input.profile)
      )
        preparation = prior.promise
      else {
        // Only requests already sharing the manager's unfinished inventory observation can join.
        // A queued refresh/list/expiry changes the tail; a fresh inventory changes its identity.
        // Nothing is retained after preparation settles, and every asset still checks its bytes.
        preparation = serialize(input.profile, async () => {
          await pruneGenerationAssets(input)
          inputs.set(input.profile, input)
          await reconcile(input, true)
        })
        const pending = {
          inventory: input.inventory,
          directory: input.profileDirectory,
          tail: tails.get(input.profile),
          promise: preparation,
        }
        assetPreparations.set(input.profile, pending)
        const clear = () => {
          if (assetPreparations.get(input.profile) === pending) assetPreparations.delete(input.profile)
        }
        preparation.then(clear, clear)
      }
      await preparation
      return serialize(input.profile, async () => {
        const root = options.snapshotDirectory(input.profile, input.profileDirectory)
        const state = (await readState(root, input.profile)) ?? emptyState(input.profile)
        let declaredFile: SnapshotManifest['files'][number] | undefined
        for (const [packageId, item] of Object.entries(state.packages)) {
          for (const revision of [
            ...(item.current ? [item.current] : []),
            ...item.retained.map((retained) => retained.revision),
          ]) {
            // Reconciliation already checked the roster. At the byte-serving boundary,
            // verify only the snapshot this canonical URL can name, not every earlier package.
            if (!input.path.startsWith(route(packageId, revision, ''))) continue
            const snapshot = await verifySnapshot(root, packageId, revision)
            const file = snapshot?.manifest.files.find(
              (candidate) => route(packageId, revision, candidate.path) === input.path,
            )
            if (file) {
              declaredFile = file
              break
            }
          }
          if (declaredFile) break
        }
        // State membership alone is insufficient: only bytes named and hashed by the immutable
        // snapshot manifest may cross the private read channel.
        if (!declaredFile) return { found: false }
        const resolved = resolveClientModuleAsset(root, input.path)
        if (!resolved) return { found: false }
        try {
          const info = await stat(resolved)
          if (!info.isFile() || info.size !== declaredFile.bytes) return { found: false }
          const bytes = await readFile(resolved)
          if (bytes.length !== declaredFile.bytes || digest(bytes) !== declaredFile.sha256)
            return { found: false }
          return { found: true, base64: bytes.toString('base64') }
        } catch {
          return { found: false }
        }
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      generations.close()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      inputs.clear()
      resourceFailures.clear()
      assetPreparations.clear()
      listeners.clear()
    },
  }
}

/** Default keeps snapshots beside the profile lock but outside every mutable package tree. */
export function defaultClientModuleSnapshotDirectory(_profile: string, profileDirectory: string): string {
  return join(profileDirectory, '.daemon-client-modules')
}
