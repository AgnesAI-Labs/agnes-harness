import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { jcs } from '@agnes/protocol'
import { type RuntimeWireTypes, validateRuntime } from '@agnes/protocol/runtime'

export const PACKAGE_SOURCE_CONTRACT = 'agh.package-source'
export const PACKAGE_RESOLVER_CONTRACT = 'agh.package-resolver'
export const DEFAULT_SOURCE_PROVIDER_ID = 'agh.default/package-source'
export const DEFAULT_RESOLVER_PROVIDER_ID = 'agh.default/package-resolver'
export const REFERENCE_SOURCE_PROVIDER_ID = 'agh.reference/package-source'
export const REFERENCE_RESOLVER_PROVIDER_ID = 'agh.reference/package-resolver'
export const SNAPSHOT_FORMAT = 'agh.package-snapshot/1'
export const ZERO_DIGEST = '0'.repeat(64)
export const MANIFEST_FILE = 'manifest.json'
export const LOCK_FILE = 'runtime-package-lock.json'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TREE_BYTES = 32 * 1024 * 1024
const HEX = /^[a-f0-9]{64}$/
const VERSION_TEXT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/

export interface PackageRefusal {
  readonly ok: false
  readonly code: 'invalid_input' | 'denied' | 'conflict' | 'cancelled' | 'internal'
  readonly detailCode: string
  readonly message: string
}

export type PackageOutcome<T> = { readonly ok: true; readonly value: T } | PackageRefusal

export interface VersionParts {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly pre: string | null
}

export interface TreeFile {
  readonly path: string
  readonly mode: 'file' | 'executable'
  readonly bytes: Buffer
}

export interface DefinitionRecord {
  readonly contract: string
  readonly major: number
  readonly ownerPackageId: string
  readonly definitionDigest: string
  readonly schemaDigest: string
  readonly operations: readonly string[]
  readonly features: readonly string[]
}

export interface ContractRefRecord {
  readonly contract: string
  readonly major: number
  readonly ownerPackageId: string
  readonly definitionDigest: string
}

export interface PackageDependency {
  readonly packageId: string
  readonly versionRange: string
  readonly optional: boolean
}

export interface IdentifiedPackage {
  readonly packageId: string
  readonly version: string
  readonly treeDigest: string
  readonly archiveDigest: string
  readonly manifestDigest: string
  readonly integrity: string
  readonly archive: Buffer
  readonly manifest: Record<string, unknown>
  readonly dependencies: readonly PackageDependency[]
  readonly requiredFeatures: readonly string[]
  readonly scopes: readonly string[]
  readonly definitions: readonly DefinitionRecord[]
  readonly contractRefs: readonly ContractRefRecord[]
  readonly privatePaths: readonly string[]
  readonly entry: string | null
  readonly claimedPackageDigest: string | null
}

export interface SnapshotCandidate {
  readonly packageId: string
  readonly version: string
  readonly treeDigest: string
  readonly archiveDigest: string
  readonly manifestDigest: string
  readonly integrity: string
  readonly locator: RuntimeWireTypes['PackageLocator']
  readonly manifest: Record<string, unknown>
  readonly dependencies: readonly PackageDependency[]
  readonly requiredFeatures: readonly string[]
  readonly scopes: readonly string[]
  readonly definitions: readonly DefinitionRecord[]
  readonly contractRefs: readonly ContractRefRecord[]
  readonly privatePaths: readonly string[]
  readonly entry: string | null
}

export interface RecoveryRecord {
  readonly sourceKind: 'local' | 'npm' | 'git'
  readonly packageId: string
  readonly phase: 'interrupted' | 'verified' | 'reused'
  readonly bytes: number
  readonly digest: string
}

export interface SourceSnapshotDocument {
  readonly format: typeof SNAPSHOT_FORMAT
  readonly snapshotId: string
  readonly revision: number
  readonly allowedFeatures: readonly string[]
  readonly allowedScopes: readonly string[]
  readonly candidates: readonly SnapshotCandidate[]
  readonly recovery: readonly RecoveryRecord[]
}

export function refuse(code: PackageRefusal['code'], detailCode: string, message: string): PackageRefusal {
  return { ok: false, code, detailCode, message }
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function digestJson(value: unknown): string {
  return sha256Hex(jcs(value))
}

export function providerDigest(providerId: string): string {
  return sha256Hex(providerId)
}

export function acceptWire<K extends keyof RuntimeWireTypes>(
  name: K,
  value: unknown,
): PackageOutcome<RuntimeWireTypes[K]> {
  const parsed = validateRuntime(name, value)
  if (!parsed.ok) {
    return refuse('invalid_input', 'schema_invalid', parsed.errors[0]?.message ?? 'invalid document')
  }
  return { ok: true, value: parsed.value }
}

export function parseVersion(input: string): VersionParts | null {
  const match = VERSION_TEXT.exec(input)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  }
}

export function isStable(version: string): boolean {
  return parseVersion(version)?.pre === null
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return left < right ? -1 : left > right ? 1 : 0
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}

function compareRange(version: string, floor: string, below: VersionParts): boolean {
  const parsed = parseVersion(version)
  const base = parseVersion(floor)
  if (parsed === null || base === null) return false
  if (parsed.pre !== null) return false
  if (compareVersions(version, floor) < 0) return false
  if (parsed.major !== below.major) return parsed.major < below.major
  if (below.minor === 0 && below.patch === 0) return false
  if (parsed.minor !== below.minor) return parsed.minor < below.minor
  return parsed.patch < below.patch
}

export function versionSatisfies(version: string, range: string): boolean {
  const trimmed = range.trim()
  if (parseVersion(version) === null) return false
  if (trimmed === '*') return isStable(version)
  if (trimmed.startsWith('^')) {
    const floor = trimmed.slice(1)
    const base = parseVersion(floor)
    if (base === null || base.pre !== null) return compareVersions(version, floor) === 0
    const below =
      base.major === 0
        ? base.minor === 0
          ? { major: 0, minor: 0, patch: base.patch + 1, pre: null }
          : { major: 0, minor: base.minor + 1, patch: 0, pre: null }
        : { major: base.major + 1, minor: 0, patch: 0, pre: null }
    return compareRange(version, floor, below)
  }
  if (trimmed.startsWith('~')) {
    const floor = trimmed.slice(1)
    const base = parseVersion(floor)
    if (base === null || base.pre !== null) return compareVersions(version, floor) === 0
    return compareRange(version, floor, { major: base.major, minor: base.minor + 1, patch: 0, pre: null })
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 2 && parts[0]?.startsWith('>=') && parts[1]?.startsWith('<')) {
    const lower = parts[0].slice(2)
    const upper = parts[1].slice(1)
    if (!isStable(version)) return false
    return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0
  }
  return compareVersions(version, trimmed) === 0
}

function compareUtf8(left: string, right: string): number {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0
    const bv = b[index] ?? 0
    if (av !== bv) return av - bv
  }
  return a.length - b.length
}

function treeFailure(detailCode: string, message: string): PackageRefusal {
  return refuse('denied', detailCode, message)
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

export function readPackageTree(root: string): PackageOutcome<TreeFile[]> {
  let listed: ReturnType<typeof lstatSync>
  try {
    listed = lstatSync(root)
  } catch {
    return treeFailure('source_unavailable', 'package root is unavailable')
  }
  if (listed.isSymbolicLink()) return treeFailure('symlink_escape', 'package root is a symbolic link')
  if (!listed.isDirectory()) return treeFailure('not_directory', 'package root is not a directory')
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return treeFailure('source_unavailable', 'package root is unavailable')
  }
  const files: TreeFile[] = []
  const folded = new Set<string>()
  let total = 0
  const walk = (dir: string): PackageRefusal | null => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return treeFailure('source_unavailable', 'package directory is unreadable')
    }
    for (const name of names) {
      if (name.includes('\0') || name === '.' || name === '..' || name.includes('\\')) {
        return treeFailure('path_escape', 'package path is not a portable relative path')
      }
      const abs = join(dir, name)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(abs)
      } catch {
        return treeFailure('source_unavailable', 'package entry is unreadable')
      }
      const rel = relative(realRoot, abs).split(sep).join('/')
      if (rel === '' || rel.split('/').some((part) => part === '..' || part === '')) {
        return treeFailure('path_escape', 'package path escapes its root')
      }
      const key = rel.toLowerCase()
      if (folded.has(key))
        return treeFailure('case_conflict', `package path collides after case folding: ${rel}`)
      folded.add(key)
      if (stat.isSymbolicLink()) {
        let target = ''
        try {
          target = realpathSync(abs)
        } catch {
          return treeFailure('symlink_escape', 'symbolic link cannot be resolved inside the package root')
        }
        if (!contained(realRoot, target)) {
          return treeFailure('symlink_escape', 'symbolic link escapes the package root')
        }
        return treeFailure('symlink_escape', 'symbolic link is not part of the package tree')
      }
      if (stat.isDirectory()) {
        const nested = walk(abs)
        if (nested) return nested
        continue
      }
      if (!stat.isFile()) return treeFailure('special_entry', 'package tree contains a special entry')
      let actual: string
      try {
        actual = realpathSync(abs)
      } catch {
        return treeFailure('path_escape', 'package file escapes its root')
      }
      if (!contained(realRoot, actual)) return treeFailure('path_escape', 'package file escapes its root')
      if (stat.size > MAX_FILE_BYTES)
        return treeFailure('package_too_large', 'package file exceeds the size limit')
      total += stat.size
      if (total > MAX_TREE_BYTES)
        return treeFailure('package_too_large', 'package tree exceeds the size limit')
      const bytes = readFileSync(abs)
      files.push({ path: rel, mode: (stat.mode & 0o111) !== 0 ? 'executable' : 'file', bytes })
    }
    return null
  }
  const failure = walk(realRoot)
  if (failure) return failure
  files.sort((left, right) => compareUtf8(left.path, right.path))
  return { ok: true, value: files }
}

function textList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return value.slice()
}

function definitionOf(value: unknown, packageId: string): PackageOutcome<DefinitionRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('invalid_input', 'schema_invalid', 'contract definition is not an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.contract !== 'string' || typeof record.ownerPackageId !== 'string') {
    return refuse('invalid_input', 'schema_invalid', 'contract definition is missing its identity')
  }
  if (typeof record.major !== 'number' || !Number.isInteger(record.major) || record.major < 1) {
    return refuse('invalid_input', 'schema_invalid', 'contract major is not a positive integer')
  }
  if (typeof record.schemaDigest !== 'string' || !HEX.test(record.schemaDigest)) {
    return refuse('invalid_input', 'schema_invalid', 'contract schema digest is not sha256')
  }
  const operations = textList(record.operations)
  const features = textList(record.features ?? [])
  if (operations === null || features === null) {
    return refuse('invalid_input', 'schema_invalid', 'contract operations are not text')
  }
  if (record.ownerPackageId !== packageId) {
    return refuse(
      'denied',
      'definition_owner_mismatch',
      'contract owner does not match the declaring package',
    )
  }
  const definitionDigest = digestJson({
    contract: record.contract,
    features: features.slice().sort(),
    major: record.major,
    operations: operations.slice().sort(),
    ownerPackageId: record.ownerPackageId,
    schemaDigest: record.schemaDigest,
  })
  if (record.definitionDigest !== undefined && record.definitionDigest !== definitionDigest) {
    return refuse(
      'denied',
      'definition_digest_mismatch',
      'contract definition digest does not match its bytes',
    )
  }
  return {
    ok: true,
    value: {
      contract: record.contract,
      major: record.major,
      ownerPackageId: record.ownerPackageId,
      definitionDigest,
      schemaDigest: record.schemaDigest,
      operations,
      features,
    },
  }
}

function contractRefOf(value: unknown): PackageOutcome<ContractRefRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('invalid_input', 'schema_invalid', 'contract reference is not an object')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.contract !== 'string' ||
    typeof record.ownerPackageId !== 'string' ||
    typeof record.definitionDigest !== 'string' ||
    !HEX.test(record.definitionDigest) ||
    typeof record.major !== 'number' ||
    !Number.isInteger(record.major)
  ) {
    return refuse('invalid_input', 'schema_invalid', 'contract reference is incomplete')
  }
  return {
    ok: true,
    value: {
      contract: record.contract,
      major: record.major,
      ownerPackageId: record.ownerPackageId,
      definitionDigest: record.definitionDigest,
    },
  }
}

function dependenciesOf(value: unknown): PackageOutcome<PackageDependency[]> {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return refuse('invalid_input', 'schema_invalid', 'dependencies are not a list')
  const dependencies: PackageDependency[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return refuse('invalid_input', 'schema_invalid', 'dependency is not an object')
    }
    const record = item as Record<string, unknown>
    if (typeof record.packageId !== 'string' || typeof record.versionRange !== 'string') {
      return refuse('invalid_input', 'schema_invalid', 'dependency is missing its identity')
    }
    dependencies.push({
      packageId: record.packageId,
      versionRange: record.versionRange,
      optional: record.optional === true,
    })
  }
  return { ok: true, value: dependencies }
}

export function identifyPackage(files: readonly TreeFile[]): PackageOutcome<IdentifiedPackage> {
  const manifestFile = files.find((file) => file.path === MANIFEST_FILE)
  if (manifestFile === undefined)
    return refuse('invalid_input', 'manifest_missing', 'package manifest is missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestFile.bytes.toString('utf8'))
  } catch {
    return refuse('invalid_input', 'schema_invalid', 'package manifest is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('invalid_input', 'schema_invalid', 'package manifest is not an object')
  }
  const author = parsed as Record<string, unknown>
  if (typeof author.id !== 'string' || author.id === '' || typeof author.version !== 'string') {
    return refuse('invalid_input', 'schema_invalid', 'package manifest is missing id or version')
  }
  if (parseVersion(author.version) === null) {
    return refuse('invalid_input', 'schema_invalid', 'package version is not a semver version')
  }
  const dependencies = dependenciesOf(author.dependencies)
  if (!dependencies.ok) return dependencies
  const requiredFeatures = textList(author.requiredFeatures ?? [])
  const scopes = textList(author.scopes ?? [])
  const privatePaths = textList(author.privatePaths ?? [])
  if (requiredFeatures === null || scopes === null || privatePaths === null) {
    return refuse('invalid_input', 'schema_invalid', 'package manifest lists are not text')
  }
  if (author.entry !== undefined && typeof author.entry !== 'string') {
    return refuse('invalid_input', 'schema_invalid', 'package entry is not text')
  }
  const definitions: DefinitionRecord[] = []
  for (const item of Array.isArray(author.contracts) ? author.contracts : []) {
    const definition = definitionOf(item, author.id)
    if (!definition.ok) return definition
    definitions.push(definition.value)
  }
  if (author.contracts !== undefined && !Array.isArray(author.contracts)) {
    return refuse('invalid_input', 'schema_invalid', 'contracts are not a list')
  }
  const contractRefs: ContractRefRecord[] = []
  if (author.contractRefs !== undefined && !Array.isArray(author.contractRefs)) {
    return refuse('invalid_input', 'schema_invalid', 'contract references are not a list')
  }
  for (const item of Array.isArray(author.contractRefs) ? author.contractRefs : []) {
    const ref = contractRefOf(item)
    if (!ref.ok) return ref
    contractRefs.push(ref.value)
  }
  const claimed = typeof author.packageDigest === 'string' ? author.packageDigest : null
  const zeroed = { ...author, packageDigest: ZERO_DIGEST }
  const manifestBytes = Buffer.from(jcs(zeroed))
  const members = files.map((file) =>
    file.path === MANIFEST_FILE ? { ...file, bytes: manifestBytes } : file,
  )
  const records = members.map((file) => ({
    bytes: file.bytes.length,
    digest: sha256Hex(file.bytes),
    mode: file.mode,
    path: file.path,
  }))
  const treeDigest = digestJson(records)
  const manifest = { ...author, packageDigest: treeDigest }
  const manifestDigest = digestJson(manifest)
  const archive = packTar(
    members.map((file) => ({
      bytes: file.path === MANIFEST_FILE ? Buffer.from(jcs(manifest)) : file.bytes,
      executable: file.mode === 'executable',
      path: file.path,
    })),
  )
  return {
    ok: true,
    value: {
      packageId: author.id,
      version: author.version,
      treeDigest,
      archiveDigest: sha256Hex(archive),
      manifestDigest,
      integrity: `sha256-${sha256Hex(archive)}`,
      archive,
      manifest,
      dependencies: dependencies.value,
      requiredFeatures,
      scopes,
      definitions,
      contractRefs,
      privatePaths,
      entry: typeof author.entry === 'string' ? author.entry : null,
      claimedPackageDigest: claimed,
    },
  }
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0')
}

export function packTar(files: readonly { path: string; bytes: Buffer; executable: boolean }[]): Buffer {
  const blocks: Buffer[] = []
  for (const file of files) {
    const name = Buffer.from(file.path)
    if (name.length > 100) throw new Error('tar path is too long')
    const header = Buffer.alloc(512, 0)
    name.copy(header, 0)
    header.write(`${octal(file.executable ? 0o755 : 0o644, 7)}\0`, 100, 'ascii')
    header.write(`${octal(0, 7)}\0`, 108, 'ascii')
    header.write(`${octal(0, 7)}\0`, 116, 'ascii')
    header.write(`${octal(file.bytes.length, 11)}\0`, 124, 'ascii')
    header.write(`${octal(0, 11)}\0`, 136, 'ascii')
    header.fill(0x20, 148, 156)
    header[156] = 0x30
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(octal(sum, 6), 148, 'ascii')
    header[154] = 0
    header[155] = 0x20
    blocks.push(header, file.bytes)
    const padding = (512 - (file.bytes.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const text = header
    .toString('ascii', offset, offset + length)
    .replace(/\0.*$/, '')
    .trim()
  if (text === '') return 0
  return Number.parseInt(text, 8)
}

export function unpackTar(archive: Buffer): PackageOutcome<TreeFile[]> {
  const files: TreeFile[] = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) break
    let sum = 0
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
    }
    if (readOctal(header, 148, 8) !== sum)
      return refuse('denied', 'archive_invalid', 'archive checksum does not match')
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
    if (name === '' || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) {
      return refuse('denied', 'path_escape', 'archive path escapes the package root')
    }
    const type = header[156] ?? 0
    if (type === 50 || type === 0x32)
      return refuse('denied', 'symlink_escape', 'archive contains a symbolic link')
    if (type !== 0 && type !== 0x30)
      return refuse('denied', 'special_entry', 'archive contains a special entry')
    const size = readOctal(header, 124, 12)
    if (!Number.isInteger(size) || size < 0 || offset + size > archive.length) {
      return refuse('denied', 'archive_invalid', 'archive member size is invalid')
    }
    const bytes = Buffer.from(archive.subarray(offset, offset + size))
    offset += size
    offset += (512 - (size % 512)) % 512
    const mode = readOctal(header, 100, 8)
    files.push({ path: name, mode: (mode & 0o111) !== 0 ? 'executable' : 'file', bytes })
  }
  files.sort((left, right) => compareUtf8(left.path, right.path))
  return { ok: true, value: files }
}

export function emptySnapshot(
  allowedFeatures: readonly string[],
  allowedScopes: readonly string[],
): SourceSnapshotDocument {
  return {
    format: SNAPSHOT_FORMAT,
    snapshotId: 'snapshot-0',
    revision: 0,
    allowedFeatures: allowedFeatures.slice(),
    allowedScopes: allowedScopes.slice(),
    candidates: [],
    recovery: [],
  }
}

export function snapshotPath(cacheDir: string): string {
  return join(cacheDir, 'snapshot.json')
}

export function installedDir(cacheDir: string): string {
  return join(cacheDir, 'installed')
}

export function stagingDir(cacheDir: string, digest: string): string {
  return join(cacheDir, 'staging', digest)
}

function writeAtomic(file: string, bytes: Buffer): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const temporary = `${file}.partial-write`
  const handle = openSync(temporary, 'w')
  try {
    writeSync(handle, bytes)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, file)
}

export function writeSnapshot(cacheDir: string, document: SourceSnapshotDocument): void {
  mkdirSync(cacheDir, { recursive: true })
  writeAtomic(snapshotPath(cacheDir), Buffer.from(`${jcs(document)}\n`))
}

export function readSnapshot(cacheDir: string): PackageOutcome<SourceSnapshotDocument> {
  const file = snapshotPath(cacheDir)
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
  const record = parsed as Partial<SourceSnapshotDocument>
  if (
    record.format !== SNAPSHOT_FORMAT ||
    !Array.isArray(record.candidates) ||
    typeof record.revision !== 'number'
  ) {
    return refuse('denied', 'cache_invalid', 'package snapshot format is not recognized')
  }
  return { ok: true, value: record as SourceSnapshotDocument }
}

export function writeRuntimePackageLock(cacheDir: string, lock: RuntimeWireTypes['PackageLock']): void {
  mkdirSync(cacheDir, { recursive: true })
  writeAtomic(join(cacheDir, LOCK_FILE), Buffer.from(`${jcs(lock)}\n`))
}

export function rememberOwner(cacheDir: string, digest: string, providerId: string): void {
  const dir = stagingDir(cacheDir, digest)
  mkdirSync(dir, { recursive: true })
  writeAtomic(join(dir, 'OWNER'), Buffer.from(providerId))
}

export function writePartialArchive(
  cacheDir: string,
  digest: string,
  bytes: Buffer,
  providerId: string,
): void {
  rememberOwner(cacheDir, digest, providerId)
  writeAtomic(join(stagingDir(cacheDir, digest), 'PARTIAL'), bytes)
}

export function writeVerifiedArchive(
  cacheDir: string,
  digest: string,
  bytes: Buffer,
  providerId: string,
): void {
  rememberOwner(cacheDir, digest, providerId)
  writeAtomic(join(stagingDir(cacheDir, digest), 'archive.tar'), bytes)
  const partial = join(stagingDir(cacheDir, digest), 'PARTIAL')
  if (existsSync(partial)) rmSync(partial)
}

export function readStagedBytes(cacheDir: string, digest: string): Buffer | null {
  const file = join(stagingDir(cacheDir, digest), 'archive.tar')
  if (!existsSync(file)) return null
  return readFileSync(file)
}

export function readVerifiedArchive(cacheDir: string, digest: string, archiveDigest: string): Buffer | null {
  const bytes = readStagedBytes(cacheDir, digest)
  if (bytes === null) return null
  return sha256Hex(bytes) === archiveDigest ? bytes : null
}

export function hasPartialArchive(cacheDir: string, digest: string): boolean {
  return existsSync(join(stagingDir(cacheDir, digest), 'PARTIAL'))
}

export function manifestDataRef(
  manifest: Record<string, unknown>,
  manifestDigest: string,
): PackageOutcome<RuntimeWireTypes['DataRef']> {
  const text = jcs(manifest)
  return acceptWire('DataRef', {
    kind: 'inline',
    schema: { typeId: 'agh.package/manifest@1', revision: 1, digest: sha256Hex('agh.package/manifest@1') },
    value: JSON.parse(text) as unknown,
    digest: manifestDigest,
    bytes: Buffer.byteLength(text),
  })
}

export function stagedDataRef(
  providerId: string,
  packageId: string,
  archiveDigest: string,
  bytes: number,
): RuntimeWireTypes['DataRef'] {
  return {
    kind: 'blob',
    schema: { typeId: 'agh.package/archive@1', revision: 1, digest: sha256Hex('agh.package/archive@1') },
    blob: {
      authorityId: providerId,
      blobId: `stage:${packageId}`,
      digest: archiveDigest,
      bytes,
      mediaType: 'application/x-tar',
      pinId: archiveDigest,
    },
  }
}

export function candidateDataRef(candidate: SnapshotCandidate): RuntimeWireTypes['DataRef'] {
  const value = {
    archiveDigest: candidate.archiveDigest,
    manifestDigest: candidate.manifestDigest,
    packageId: candidate.packageId,
    treeDigest: candidate.treeDigest,
    version: candidate.version,
  }
  const text = jcs(value)
  return {
    kind: 'inline',
    schema: { typeId: 'agh.package/candidate@1', revision: 1, digest: sha256Hex('agh.package/candidate@1') },
    value,
    digest: sha256Hex(text),
    bytes: Buffer.byteLength(text),
  }
}

export function provenance(providerId: string, sourceId: string): RuntimeWireTypes['Provenance'] {
  return {
    sourceRefs: [sourceId],
    producer: {
      bindingId: `${providerId}:${sourceId}`.slice(0, 256),
      contract: PACKAGE_SOURCE_CONTRACT,
      logicalName: 'packages',
      providerId,
    },
    trustLabels: ['content-addressed'],
  }
}

export function lockEntry(
  candidate: SnapshotCandidate,
  dependencies: { packageId: string; digest: string }[],
): PackageOutcome<RuntimeWireTypes['PackageLockEntry']> {
  const manifestRef = manifestDataRef(candidate.manifest, candidate.manifestDigest)
  if (!manifestRef.ok) return manifestRef
  return acceptWire('PackageLockEntry', {
    packageId: candidate.packageId,
    version: candidate.version,
    digest: candidate.treeDigest,
    locator: candidate.locator,
    manifestRef: manifestRef.value,
    dependencies,
  })
}

export function packageLock(
  entries: RuntimeWireTypes['PackageLockEntry'][],
): RuntimeWireTypes['PackageLock'] {
  const sorted = entries.slice().sort((left, right) => {
    if (left.packageId !== right.packageId) return left.packageId < right.packageId ? -1 : 1
    if (left.version !== right.version) return compareVersions(left.version, right.version)
    return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
  })
  return { entries: sorted, digest: digestJson(sorted) }
}

export function emptyPackageLock(): RuntimeWireTypes['PackageLock'] {
  return packageLock([])
}

export function pageCandidates(
  candidates: readonly SnapshotCandidate[],
  query: string,
  cursor: string | null,
  limit: number,
  snapshotId: string,
): PackageOutcome<RuntimeWireTypes['PackageSourceDiscoverResult']> {
  const ranked = candidates
    .filter((candidate) => query === '' || candidate.packageId.includes(query))
    .slice()
    .sort((left, right) => {
      if (left.packageId !== right.packageId) return left.packageId < right.packageId ? -1 : 1
      const version = compareVersions(left.version, right.version)
      if (version !== 0) return version
      return left.treeDigest < right.treeDigest ? -1 : 1
    })
  const offset = cursor === null || cursor === '' ? 0 : Number(cursor)
  if (!Number.isInteger(offset) || offset < 0) {
    return refuse('invalid_input', 'schema_invalid', 'discover cursor is not an offset')
  }
  const items = []
  for (const candidate of ranked.slice(offset, offset + limit)) {
    const entry = lockEntry(
      candidate,
      candidate.dependencies.map((dependency) => ({ packageId: dependency.packageId, digest: ZERO_DIGEST })),
    )
    if (!entry.ok) return entry
    items.push(entry.value)
  }
  const next = offset + items.length
  return acceptWire('PackageSourceDiscoverResult', {
    items,
    snapshot: snapshotId,
    nextCursor: next < ranked.length ? String(next) : null,
    complete: next >= ranked.length,
  })
}

export function appendRecovery(
  document: SourceSnapshotDocument,
  record: RecoveryRecord,
): SourceSnapshotDocument {
  return { ...document, recovery: [...document.recovery, record] }
}
