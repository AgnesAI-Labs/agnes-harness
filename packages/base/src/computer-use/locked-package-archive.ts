import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { type LockedPackageManifest, parseLockedPackageManifest } from './locked-package.js'

const BLOCK_BYTES = 512
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 192 * 1024
const MAX_PACKAGE_BYTES = 1024 * 1024
const MAX_FILES = 128
const MAX_ENTRIES = 512
const MAX_DEPTH = 16
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

type ArchiveFile = { path: string; bytes: Uint8Array }

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

export type ImmutableLockedPackageBytes = Readonly<{
  encoding: 'base64'
  value: string
  byteLength: number
  sha256: string
}>

export type ValidatedLockedPackageFile = Readonly<{
  path: string
  sha256: string
  size: number
  content: ImmutableLockedPackageBytes
}>

export type ValidatedLockedPackageArchive = Readonly<{
  /** Validation is not publisher trust and does not admit installation or activation. */
  trust: 'validated-untrusted-archive'
  manifest: DeepReadonly<LockedPackageManifest>
  sourceArchiveBytes: ImmutableLockedPackageBytes
  files: readonly ValidatedLockedPackageFile[]
}>

function fail(reason: string): never {
  throw new Error(`locked package archive ${reason}`)
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('locked package archive validation aborted')
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < offset + BLOCK_BYTES; index += 1) if (bytes[index] !== 0) return false
  return true
}

function field(bytes: Uint8Array, offset: number, length: number, label: string): string {
  const view = bytes.subarray(offset, offset + length)
  const nul = view.indexOf(0)
  const body = nul === -1 ? view : view.subarray(0, nul)
  if (nul !== -1 && view.subarray(nul).some((value) => value !== 0)) fail(`${label} has embedded data`)
  try {
    return fatalUtf8.decode(body)
  } catch {
    return fail(`${label} is not valid UTF-8`)
  }
}

function octal(bytes: Uint8Array, offset: number, length: number, label: string): number {
  let raw: string
  try {
    raw = fatalUtf8
      .decode(bytes.subarray(offset, offset + length))
      .replace(/[\0 ]+$/u, '')
      .trimStart()
  } catch {
    return fail(`${label} is not valid ASCII octal`)
  }
  if (!/^[0-7]+$/u.test(raw)) fail(`${label} is not canonical octal`)
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value)) fail(`${label} exceeds the integer limit`)
  return value
}

function verifyHeaderChecksum(bytes: Uint8Array, offset: number): void {
  const expected = octal(bytes, offset + 148, 8, 'checksum')
  let actual = 0
  for (let index = 0; index < BLOCK_BYTES; index += 1)
    actual += index >= 148 && index < 156 ? 0x20 : (bytes[offset + index] ?? 0)
  if (actual !== expected) fail('header checksum mismatch')
}

function canonicalPath(value: string, directory: boolean): string {
  const path = directory && value.endsWith('/') ? value.slice(0, -1) : value
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path !== path.normalize('NFC') ||
    path.split('/').length > MAX_DEPTH ||
    path.split('/').some((part) => !TOKEN.test(part)) ||
    (path !== 'skill' && !path.startsWith('skill/'))
  )
    fail('entry path escapes the skill root')
  return path
}

function archivePayload(archive: Uint8Array): Uint8Array {
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0) fail('bytes are required')
  if (archive.byteLength > MAX_ARCHIVE_BYTES) fail('exceeds the compressed size limit')
  if (archive[0] !== 0x1f || archive[1] !== 0x8b) return archive
  try {
    return gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES })
  } catch {
    return fail('gzip payload is invalid or exceeds the expanded size limit')
  }
}

function parseArchive(archive: Uint8Array, signal?: AbortSignal): ArchiveFile[] {
  const bytes = archivePayload(archive)
  if (bytes.byteLength > MAX_EXPANDED_BYTES) fail('exceeds the expanded size limit')
  const files: ArchiveFile[] = []
  const paths = new Set<string>()
  const foldedPaths = new Set<string>()
  let aggregateBytes = 0
  let offset = 0
  let entries = 0
  let ended = false
  while (offset + BLOCK_BYTES <= bytes.byteLength) {
    checkCancelled(signal)
    if (isZeroBlock(bytes, offset)) {
      if (offset + BLOCK_BYTES * 2 > bytes.byteLength || !isZeroBlock(bytes, offset + BLOCK_BYTES))
        fail('is missing the second end marker')
      for (let index = offset + BLOCK_BYTES * 2; index < bytes.byteLength; index += 1)
        if (bytes[index] !== 0) fail('contains data after its end markers')
      ended = true
      break
    }
    entries += 1
    if (entries > MAX_ENTRIES) fail('contains too many entries')
    verifyHeaderChecksum(bytes, offset)
    const magic = field(bytes, offset + 257, 6, 'format magic')
    const version = field(bytes, offset + 263, 2, 'format version')
    if (magic !== 'ustar' || version !== '00') fail('must use the POSIX ustar format')
    const name = field(bytes, offset, 100, 'entry name')
    const prefix = field(bytes, offset + 345, 155, 'entry prefix')
    const rawPath = prefix ? `${prefix}/${name}` : name
    const type = bytes[offset + 156]
    const directory = type === 0x35
    if (type !== 0 && type !== 0x30 && !directory) fail('contains a link or special entry')
    const path = canonicalPath(rawPath, directory)
    const folded = path.toLowerCase()
    if (paths.has(path) || foldedPaths.has(folded)) fail('contains duplicate or case-colliding paths')
    for (const prior of paths) {
      const priorIsFile = files.some((file) => file.path === prior)
      if ((priorIsFile && path.startsWith(`${prior}/`)) || (!directory && prior.startsWith(`${path}/`)))
        fail('contains a file and directory path conflict')
    }
    paths.add(path)
    foldedPaths.add(folded)
    const mode = octal(bytes, offset + 100, 8, 'entry mode')
    if (!directory && (mode & 0o111) !== 0) fail('contains an executable entry')
    const size = octal(bytes, offset + 124, 12, 'entry size')
    if (directory && size !== 0) fail('directory entry has content')
    if (size > MAX_FILE_BYTES) fail('entry exceeds the file size limit')
    const dataStart = offset + BLOCK_BYTES
    const dataEnd = dataStart + size
    if (dataEnd > bytes.byteLength) fail('entry content is truncated')
    if (!directory) {
      aggregateBytes += size
      if (files.length + 1 > MAX_FILES) fail('contains too many files')
      if (aggregateBytes > MAX_PACKAGE_BYTES) fail('contents exceed the aggregate size limit')
      files.push({ path, bytes: bytes.slice(dataStart, dataEnd) })
    }
    const nextOffset = dataStart + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES
    for (let index = dataEnd; index < nextOffset; index += 1)
      if (bytes[index] !== 0) fail('entry has non-zero padding')
    offset = nextOffset
  }
  if (!ended) fail('is truncated or missing end markers')
  if (files.length === 0) fail('contains no files')
  return files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
}

function verifyContents(files: ArchiveFile[], manifest: LockedPackageManifest): void {
  if (files.length !== manifest.files.length) fail('contents do not match the detached manifest')
  const aggregate = createHash('sha256')
  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index]
    const actual = files[index]
    if (!expected || !actual || actual.path !== expected.path || actual.bytes.byteLength !== expected.size)
      fail('contents do not match the detached manifest')
    const digest = createHash('sha256').update(actual.bytes).digest('hex')
    if (digest !== expected.sha256) fail('entry digest does not match the detached manifest')
    aggregate.update(`${expected.path}\0${expected.sha256}\0${expected.size}\n`)
  }
  if (aggregate.digest('hex') !== manifest.packageSha256)
    fail('aggregate digest does not match the detached manifest')
}

function immutableBytes(bytes: Uint8Array): ImmutableLockedPackageBytes {
  return Object.freeze({
    encoding: 'base64' as const,
    value: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

function immutableManifest(manifest: LockedPackageManifest): DeepReadonly<LockedPackageManifest> {
  return Object.freeze({
    schemaVersion: 1 as const,
    packageId: manifest.packageId,
    version: manifest.version,
    packageSha256: manifest.packageSha256,
    provenance: Object.freeze({ ...manifest.provenance }),
    signature: Object.freeze({ ...manifest.signature }),
    compatibility: Object.freeze({
      agnesApiVersions: Object.freeze([...manifest.compatibility.agnesApiVersions]),
      platforms: Object.freeze([...manifest.compatibility.platforms]),
      osVersions: Object.freeze([...manifest.compatibility.osVersions]),
    }),
    files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))),
  })
}

/**
 * Validates a detached-manifest locked Skill archive entirely in memory. The immutable output is
 * still untrusted: publisher verification, safe extraction and activation are separate hard gates.
 */
export function validateLockedPackageArchive(input: {
  archiveBytes: Uint8Array
  manifest: unknown
  signal?: AbortSignal
}): ValidatedLockedPackageArchive {
  checkCancelled(input.signal)
  const manifest = parseLockedPackageManifest(input.manifest)
  if (!(input.archiveBytes instanceof Uint8Array)) fail('bytes are required')
  const archiveBytes = Uint8Array.from(input.archiveBytes)
  const artifactDigest = createHash('sha256').update(archiveBytes).digest('hex')
  if (artifactDigest !== manifest.provenance.artifactSha256)
    fail('digest does not match detached manifest provenance')
  const files = parseArchive(archiveBytes, input.signal)
  verifyContents(files, manifest)
  checkCancelled(input.signal)
  return Object.freeze({
    trust: 'validated-untrusted-archive' as const,
    manifest: immutableManifest(manifest),
    sourceArchiveBytes: immutableBytes(archiveBytes),
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({
          path: file.path,
          sha256: createHash('sha256').update(file.bytes).digest('hex'),
          size: file.bytes.byteLength,
          content: immutableBytes(file.bytes),
        }),
      ),
    ),
  })
}
