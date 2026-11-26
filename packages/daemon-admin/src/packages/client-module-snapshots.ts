import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import {
  CLIENT_RESOURCE_MAX_FILE_BYTES,
  CLIENT_RESOURCE_MAX_TOTAL_BYTES,
  type VerifiedClientTree,
} from '@agnes/package-manager'
import { type ClientContribution, jcs } from '@agnes/protocol'
import { validUiComponentDeclaration } from '@agnes/protocol/intelligent-ui'
import { cleanRelative, SERVABLE } from './client-asset-references.js'

const STATE_FILE = '_client-modules.json'
const SNAPSHOT_FILE = '_snapshot.json'
const CLIENT_PARENT_CHILD_DECLARATION_VERSION = 'dsh-parent-child/v1'
const PACKAGE_ID =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/
const REVISION = /^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/
const GENERATION_ID = /^[a-f0-9-]{36}$/
const MAX_METADATA_BYTES = 1024 * 1024

type ClientDeclaration = Readonly<{
  rowId: string
  moduleName: string
  entry: string
  styles: readonly string[]
  client: Pick<ClientContribution, 'slots' | 'slotCatalogVersion'>
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

type VerifiedAsset = SnapshotManifest['files'][number]

export type { PackageState, ProfileState, Retained, StoredDeclaration, VerifiedAsset }
export {
  digest,
  emptyState,
  encodedRevision,
  pruneUntracked,
  publishSnapshot,
  readState,
  removeSnapshot,
  sameAsset,
  snapshotBytes,
  snapshotContentDigest,
  trackedDeclarations,
  verifySnapshot,
}

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
    let entries: Dirent[]
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

function sameAsset(left: VerifiedAsset | undefined, right: VerifiedAsset): boolean {
  return left?.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256
}

export async function saveState(
  root: string,
  profile: string,
  state: ProfileState,
  beforeState: string | undefined,
): Promise<void> {
  // An unreadable state reads back as empty and prunes every snapshot, so refuse to persist it.
  if (!isState(state, profile)) throw new Error('client-module state exceeds its persisted bounds')
  if (beforeState !== jcs(state)) await writeAtomic(join(root, STATE_FILE), state)
}

async function publishSnapshot(input: {
  root: string
  tree: Pick<VerifiedClientTree, 'packageId' | 'integrity'>
  declarations: readonly ClientDeclaration[]
  files: ReadonlyMap<string, Buffer>
  records: readonly VerifiedAsset[]
  quotaBytes: number
  quotaUsed(): Promise<number>
}): Promise<'published' | 'present' | 'quota' | 'invalid'> {
  const { root, tree, declarations, files, records } = input
  const existing = await verifySnapshot(root, tree.packageId, tree.integrity)
  const existingFiles = new Map(existing?.manifest.files.map((file) => [file.path, file]))
  if (existing && records.every((file) => sameAsset(existingFiles.get(file.path), file))) return 'present'
  const quotaAvailable = Math.max(0, input.quotaBytes - (await input.quotaUsed()) + (existing?.bytes ?? 0))
  const finalDirectory = snapshotDirectory(root, tree.packageId, tree.integrity)
  await rm(finalDirectory, { recursive: true, force: true })
  const staging = join(root, `_staging-${randomUUID()}`)
  const contentDigest = snapshotContentDigest(records)
  try {
    let total = 0
    for (const [path, bytes] of files) {
      total += bytes.length
      if (total > quotaAvailable) return 'quota'
      if (total > CLIENT_RESOURCE_MAX_TOTAL_BYTES) return 'invalid'
      const target = join(staging, path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, bytes, { mode: 0o600 })
    }
    const manifest: SnapshotManifest = {
      version: 2,
      packageId: tree.packageId,
      revision: tree.integrity,
      contentDigest,
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
        contentDigest,
      })),
      files: records,
    }
    await writeFile(join(staging, SNAPSHOT_FILE), `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
    // Re-read every copied byte before publication. The final rename is the publication point.
    for (const file of records) {
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
