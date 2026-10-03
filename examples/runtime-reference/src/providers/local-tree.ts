import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type JsonValue,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'

const LIMITS = { maxBytes: 1_000_000, maxDepth: 32, maxMembers: 10_000 } as const
const ZERO = '0'.repeat(64)
const MANIFEST = 'agnes.plugin.json'
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.]+)?$/
const FILE_LIMIT = 8 * 1024 * 1024
const TREE_LIMIT = 32 * 1024 * 1024
const SHELF_FORMAT = 'reference-local-packages'
const SHELF_FILE = 'snapshot.json'

export interface ReferenceRefusal {
  readonly ok: false
  readonly code: 'invalid_input' | 'denied' | 'conflict' | 'cancelled' | 'internal'
  readonly detailCode: string
  readonly message: string
}

export type ReferenceOutcome<T> = { readonly ok: true; readonly value: T } | ReferenceRefusal

export interface MemoryMember {
  readonly path: string
  readonly bytes?: Uint8Array
  readonly executable?: boolean
  readonly symlink?: boolean
}

export interface MemoryPackage {
  readonly packageId: string
  readonly version: string
  readonly members: readonly MemoryMember[]
}

export interface PackageIdentity {
  readonly packageId: string
  readonly version: string
  readonly treeDigest: string
  readonly manifestDigest: string
  readonly manifest: JsonValue
  readonly payload: Buffer
}

export interface ShelfRow {
  readonly packageId: string
  readonly version: string
  readonly treeDigest: string
  readonly manifestDigest: string
  readonly sourceId: string
  readonly pathRef: string
  readonly manifest: JsonValue
}

export interface Shelf {
  readonly revision: number
  readonly snapshotId: string
  readonly rows: readonly ShelfRow[]
}

interface StoredFile {
  readonly path: string
  readonly bytes: Buffer
  readonly executable: boolean
}

export function refuse(
  code: ReferenceRefusal['code'],
  detailCode: string,
  message: string,
): ReferenceRefusal {
  return { ok: false, code, detailCode, message }
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function acceptWire<K extends keyof RuntimeWireTypes>(
  name: K,
  value: unknown,
): ReferenceOutcome<RuntimeWireTypes[K]> {
  const parsed = validateRuntime(name, value)
  if (!parsed.ok) {
    return refuse('invalid_input', 'schema_invalid', parsed.errors[0]?.message ?? 'invalid document')
  }
  return { ok: true, value: parsed.value }
}

function canonicalText(
  value: unknown,
): ReferenceOutcome<{ readonly text: string; readonly json: JsonValue }> {
  const encoded = boundedCanonicalJson(value, LIMITS)
  if (!encoded.ok) return refuse('invalid_input', 'schema_invalid', 'package document is not canonical JSON')
  return { ok: true, value: { text: encoded.value.canonical, json: encoded.value.json } }
}

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function outside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function identityDocument(record: Record<string, unknown>, identity: string): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
  copy.packageDigest = identity
  for (const group of ['providers', 'renderers', 'clientServices']) {
    const items = copy[group]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const owned = group === 'providers' ? item.descriptor : item
      if (
        owned !== null &&
        typeof owned === 'object' &&
        !Array.isArray(owned) &&
        Object.hasOwn(owned, 'packageDigest')
      ) {
        owned.packageDigest = identity
      }
    }
  }
  return copy
}

function digestFiles(files: readonly StoredFile[]): ReferenceOutcome<PackageIdentity> {
  const listed = files.slice().sort((left, right) => comparePath(left.path, right.path))
  const manifestFile = listed.find((file) => file.path === MANIFEST)
  if (manifestFile === undefined)
    return refuse('invalid_input', 'manifest_missing', 'package manifest is missing')
  let author: unknown
  try {
    author = JSON.parse(manifestFile.bytes.toString('utf8'))
  } catch {
    return refuse('invalid_input', 'schema_invalid', 'package manifest is not JSON')
  }
  if (typeof author !== 'object' || author === null || Array.isArray(author)) {
    return refuse('invalid_input', 'schema_invalid', 'package manifest is not an object')
  }
  const record = author as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '' || typeof record.version !== 'string') {
    return refuse('invalid_input', 'schema_invalid', 'package manifest is missing id or version')
  }
  if (!VERSION.test(record.version)) {
    return refuse('invalid_input', 'schema_invalid', 'package version is not a semver version')
  }
  const zeroed = canonicalText(identityDocument(record, ZERO))
  if (!zeroed.ok) return zeroed
  const replaced = listed.map((file) =>
    file.path === MANIFEST ? { ...file, bytes: Buffer.from(zeroed.value.text) } : file,
  )
  const records = replaced.map((file) => ({
    bytes: file.bytes.length,
    digest: sha256(file.bytes),
    mode: file.executable ? 'executable' : 'file',
    path: file.path,
  }))
  const treeText = canonicalText(records)
  if (!treeText.ok) return treeText
  const treeDigest = canonicalJsonDigest(treeText.value.json)
  const manifest = canonicalText(identityDocument(record, treeDigest))
  if (!manifest.ok) return manifest
  const payloadText = canonicalText(records)
  if (!payloadText.ok) return payloadText
  return {
    ok: true,
    value: {
      packageId: record.id,
      version: record.version,
      treeDigest,
      manifestDigest: canonicalJsonDigest(manifest.value.json),
      manifest: manifest.value.json,
      payload: Buffer.from(payloadText.value.text),
    },
  }
}

export function digestMembers(members: readonly MemoryMember[]): ReferenceOutcome<PackageIdentity> {
  const files: StoredFile[] = []
  const folded = new Set<string>()
  for (const member of members) {
    if (member.symlink === true) {
      return refuse('denied', 'symlink_escape', 'symbolic link is not part of the package tree')
    }
    const parts = member.path.split('/')
    if (
      member.path.includes('\0') ||
      member.path.includes('\\') ||
      parts.some((part) => part === '' || part === '.' || part === '..')
    ) {
      return refuse('denied', 'path_escape', 'package path is not a portable relative path')
    }
    const key = member.path.toLowerCase()
    if (folded.has(key))
      return refuse('denied', 'case_conflict', `package path collides after case folding: ${member.path}`)
    folded.add(key)
    const bytes = Buffer.from(member.bytes ?? new Uint8Array())
    if (bytes.length > FILE_LIMIT)
      return refuse('denied', 'package_too_large', 'package file exceeds the size limit')
    files.push({ path: member.path, bytes, executable: member.executable === true })
  }
  return digestFiles(files)
}

export function digestDirectory(root: string): ReferenceOutcome<PackageIdentity> {
  let rootStat: ReturnType<typeof lstatSync>
  try {
    rootStat = lstatSync(root)
  } catch {
    return refuse('denied', 'source_unavailable', 'package root is unavailable')
  }
  if (rootStat.isSymbolicLink()) return refuse('denied', 'symlink_escape', 'package root is a symbolic link')
  if (!rootStat.isDirectory()) return refuse('denied', 'not_directory', 'package root is not a directory')
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return refuse('denied', 'source_unavailable', 'package root is unavailable')
  }
  const files: StoredFile[] = []
  const folded = new Set<string>()
  const pending = [realRoot]
  let total = 0
  while (pending.length > 0) {
    const dir = pending.pop()
    if (dir === undefined) break
    let entries: { name: string; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return refuse('denied', 'source_unavailable', 'package directory is unreadable')
    }
    for (const entry of entries) {
      if (
        entry.name.includes('\0') ||
        entry.name === '.' ||
        entry.name === '..' ||
        entry.name.includes('\\')
      ) {
        return refuse('denied', 'path_escape', 'package path is not a portable relative path')
      }
      const abs = join(dir, entry.name)
      const rel = relative(realRoot, abs).split(sep).join('/')
      const key = rel.toLowerCase()
      if (folded.has(key)) {
        return refuse('denied', 'case_conflict', `package path collides after case folding: ${rel}`)
      }
      folded.add(key)
      if (entry.isSymbolicLink()) {
        return refuse('denied', 'symlink_escape', 'symbolic link is not part of the package tree')
      }
      if (entry.isDirectory()) {
        pending.push(abs)
        continue
      }
      if (!entry.isFile()) return refuse('denied', 'special_entry', 'package tree contains a special entry')
      let actual: string
      try {
        actual = realpathSync(abs)
      } catch {
        return refuse('denied', 'path_escape', 'package file escapes its root')
      }
      if (outside(realRoot, actual)) return refuse('denied', 'path_escape', 'package file escapes its root')
      const bytes = readFileSync(abs)
      if (bytes.length > FILE_LIMIT)
        return refuse('denied', 'package_too_large', 'package file exceeds the size limit')
      total += bytes.length
      if (total > TREE_LIMIT)
        return refuse('denied', 'package_too_large', 'package tree exceeds the size limit')
      const stat = lstatSync(abs)
      files.push({ path: rel, bytes, executable: (stat.mode & 0o111) !== 0 })
    }
  }
  return digestFiles(files)
}

export function emptyShelf(): Shelf {
  return { revision: 0, snapshotId: 'snapshot-0', rows: [] }
}

export function writeShelf(cacheDir: string, shelf: Shelf): void {
  mkdirSync(cacheDir, { recursive: true })
  const body = canonicalText({ format: SHELF_FORMAT, ...shelf })
  const text = body.ok ? body.value.text : JSON.stringify({ format: SHELF_FORMAT, ...shelf })
  writeFileSync(join(cacheDir, SHELF_FILE), `${text}\n`)
}

export function readShelf(cacheDir: string): ReferenceOutcome<Shelf> {
  const file = join(cacheDir, SHELF_FILE)
  if (!existsSync(file))
    return refuse('denied', 'cache_miss', 'package snapshot is not in the authorized cache')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return refuse('denied', 'cache_invalid', 'package snapshot is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('denied', 'cache_invalid', 'package snapshot is not an object')
  }
  const record = parsed as { format?: unknown; revision?: unknown; snapshotId?: unknown; rows?: unknown }
  if (record.format !== SHELF_FORMAT || typeof record.revision !== 'number' || !Array.isArray(record.rows)) {
    return refuse('denied', 'cache_invalid', 'package snapshot format is not recognized')
  }
  if (typeof record.snapshotId !== 'string') {
    return refuse('denied', 'cache_invalid', 'package snapshot format is not recognized')
  }
  return {
    ok: true,
    value: { revision: record.revision, snapshotId: record.snapshotId, rows: record.rows as ShelfRow[] },
  }
}

export function inlineRef(typeId: string, value: JsonValue): ReferenceOutcome<RuntimeWireTypes['DataRef']> {
  const encoded = canonicalText(value)
  if (!encoded.ok) return encoded
  return acceptWire('DataRef', {
    kind: 'inline',
    schema: { typeId, revision: 1, digest: sha256(typeId) },
    value: encoded.value.json,
    digest: canonicalJsonDigest(encoded.value.json),
    bytes: Buffer.byteLength(encoded.value.text),
  })
}

export function packageEntry(row: ShelfRow): ReferenceOutcome<RuntimeWireTypes['PackageLockEntry']> {
  const manifestRef = inlineRef('agh.package/manifest@1', row.manifest)
  if (!manifestRef.ok) return manifestRef
  return acceptWire('PackageLockEntry', {
    packageId: row.packageId,
    version: row.version,
    digest: row.treeDigest,
    locator: { kind: 'local', sourceId: row.sourceId, pathRef: row.pathRef, digest: row.treeDigest },
    manifestRef: manifestRef.value,
    dependencies: [],
  })
}

export function contentProvenance(providerId: string, sourceId: string): RuntimeWireTypes['Provenance'] {
  return {
    sourceRefs: [sourceId],
    producer: {
      bindingId: `${providerId}:${sourceId}`.slice(0, 256),
      contract: 'agh.package-source',
      logicalName: 'packages',
      providerId,
    },
    trustLabels: ['content-addressed'],
  }
}
