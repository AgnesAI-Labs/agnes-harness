import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isProxy } from 'node:util/types'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  syncDirectory as durableSyncDirectory,
  hasPrivateDaclSync,
  renameWriteThrough,
  windowsEnsurePrivateDirectorySync,
} from '@agnes/system-node'

const SHA256 = /^[a-f0-9]{64}$/
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const REVISION = /^[a-f0-9]{40}$/
const BASE64 = /^[a-zA-Z0-9+/]+={0,2}$/
const MAX_FILES = 128
const MAX_FILE_BYTES = 192 * 1024
const MAX_PACKAGE_BYTES = 1024 * 1024
const MAX_SOURCE_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_COMPATIBILITY_VALUES = 64
const DEFAULT_SIGNATURE_TIMEOUT_MS = 15_000
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

function isWindows(): boolean {
  return process.platform === 'win32' // guards-allow-platform: shared locked-package filesystem dispatch.
}

export type LockedPackageManifest = {
  schemaVersion: 1
  packageId: string
  version: string
  packageSha256: string
  provenance: { source: string; revision: string; artifactSha256: string }
  signature: { algorithm: 'ed25519'; keyId: string; value: string }
  compatibility: { agnesApiVersions: string[]; platforms: string[]; osVersions: string[] }
  files: Array<{ path: string; sha256: string; size: number }>
}

export type LockedPackageEnvironment = {
  agnesApiVersion: string
  platform: string
  osVersion: string
}

export type SignatureEvidence = {
  verified: true
  keyId: string
  publisher: string
  evidenceId: string
}

export type LockedPackageSignatureVerifier = (input: {
  algorithm: 'ed25519'
  keyId: string
  signature: string
  payload: Uint8Array
  signal: AbortSignal
}) => Promise<SignatureEvidence>

export type ActivationRecord = {
  schemaVersion: 1
  packageId: string
  version: string
  packageSha256: string
  manifestSha256: string
  directory: string
  activatedAt: string
  signature: { keyId: string; publisher: string; evidenceId: string }
  provenance: { source: string; revision: string; artifactSha256: string }
  compatibility: LockedPackageManifest['compatibility']
}

type ActivationState = { schemaVersion: 1; active: ActivationRecord | null; lkg: ActivationRecord | null }

export type LockedPackageMutationKind = 'activate' | 'confirm-lkg' | 'rollback'

export type LockedPackageOperationReceipt = {
  schemaVersion: 1
  operationId: string
  kind: LockedPackageMutationKind
  phase: 'prepared' | 'committed'
  fencing: string
  storeBindingSha256: string
  requestSha256: string | null
  beforeStateSha256: string
  afterStateSha256: string
  result: ActivationRecord
}

/**
 * Host-owned durable storage. Implementations must atomically allocate a fresh fencing value in
 * prepare, reject a conflicting reuse of operationId, and fence commit against that value.
 * Calls are deliberately made while the package activation lock is held.
 */
export type LockedPackageOperationReceiptPort = {
  read(operationId: string): Promise<LockedPackageOperationReceipt | null>
  prepare(
    receipt: Omit<LockedPackageOperationReceipt, 'fencing' | 'phase'>,
  ): Promise<LockedPackageOperationReceipt>
  commit(input: { operationId: string; fencing: string }): Promise<LockedPackageOperationReceipt>
}

export type LockedPackageOperation = {
  operationId: string
  receipts: LockedPackageOperationReceiptPort
}

type ValidatedLockedPackageOperation = Readonly<{
  operationId: string
  read: LockedPackageOperationReceiptPort['read']
  prepare: LockedPackageOperationReceiptPort['prepare']
  commit: LockedPackageOperationReceiptPort['commit']
}>

export type LockedPackageOperationReconciliation =
  | { status: 'committed'; record: ActivationRecord }
  | { status: 'not-applied'; record: ActivationRecord }
  | { status: 'unknown'; record: ActivationRecord }

export type LockedPackageOperationHistory =
  | {
      historyOnly: true
      outcome: 'committed' | 'not-applied' | 'unknown'
      record: ActivationRecord
    }
  | { historyOnly: true; outcome: 'not-found' }

const MANIFEST_KEYS = [
  'compatibility',
  'files',
  'packageId',
  'packageSha256',
  'provenance',
  'schemaVersion',
  'signature',
  'version',
] as const

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value))
    throw new Error(`locked package ${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`locked package ${label} must be a plain object`)
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`locked package ${label} contains symbol fields`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor))
      throw new Error(`locked package ${label} contains unsafe property descriptors`)
    copy[key] = descriptor.value
  }
  return copy
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error(`locked package ${label} contains missing or unknown fields`)
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function denseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`locked package ${label} must be an array`)
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`locked package ${label} contains symbol fields`)
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
  const lengthDescriptor = descriptors.length
  if (
    !lengthDescriptor ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.get ||
    lengthDescriptor.set ||
    !('value' in lengthDescriptor)
  )
    throw new Error(`locked package ${label} has an unsafe length`)
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum)
    throw new Error(`locked package ${label} exceeds its item limit`)
  const copy: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || descriptor.get || descriptor.set || !('value' in descriptor))
      throw new Error(`locked package ${label} contains unsafe or sparse entries`)
    copy.push(descriptor.value)
  }
  if (Object.keys(descriptors).some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))
    throw new Error(`locked package ${label} contains unknown fields`)
  if (Object.keys(descriptors).length !== length + 1)
    throw new Error(`locked package ${label} contains out-of-range entries`)
  return copy
}

function stringArray(value: unknown, label: string): string[] {
  const values = denseArray(value, label, MAX_COMPATIBILITY_VALUES)
  if (values.some((item) => typeof item !== 'string' || !item))
    throw new Error(`locked package ${label} must be a non-empty string array`)
  const result = values as string[]
  if (result.some((item) => item !== item.normalize('NFC') || !TOKEN.test(item)))
    throw new Error(`locked package ${label} contains an invalid value`)
  if (new Set(result).size !== result.length) throw new Error(`locked package ${label} contains duplicates`)
  return [...result].sort(utf8Compare)
}

function safeSource(value: unknown): string {
  if (typeof value !== 'string') throw new Error('locked package provenance source is invalid')
  if (value.length > 2048) throw new Error('locked package provenance source exceeds the length limit')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('locked package provenance source is invalid')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('locked package provenance source must be credential-free HTTPS')
  if (value !== value.normalize('NFC')) throw new Error('locked package provenance source is not NFC')
  return parsed.href
}

function safeRelativePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value === 'locked-package.manifest.json' ||
    value !== value.normalize('NFC') ||
    !value.startsWith('skill/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..' || !TOKEN.test(part))
  )
    throw new Error('locked package file path escapes the package root')
  return value
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`locked package ${label} is invalid`)
  return value
}

function parseEnvironment(value: LockedPackageEnvironment): Readonly<LockedPackageEnvironment> {
  const environment = object(value, 'environment')
  exactKeys(environment, ['agnesApiVersion', 'osVersion', 'platform'], 'environment')
  for (const [entry, label] of [
    [environment.agnesApiVersion, 'Agnes API version'],
    [environment.platform, 'platform'],
    [environment.osVersion, 'OS version'],
  ] as const)
    if (typeof entry !== 'string' || !TOKEN.test(entry))
      throw new Error(`locked package environment ${label} is invalid`)
  return Object.freeze({
    agnesApiVersion: environment.agnesApiVersion as string,
    platform: environment.platform as string,
    osVersion: environment.osVersion as string,
  })
}

function snapshotVerificationRuntime(input: {
  verifySignature: LockedPackageSignatureVerifier
  verificationTimeoutMs?: number
  now?: () => Date
}): Readonly<{
  verifySignature: LockedPackageSignatureVerifier
  verificationTimeoutMs: number
  now: () => Date
}> {
  let verifySignature: unknown
  let verificationTimeoutMs: unknown
  let now: unknown
  try {
    verifySignature = input.verifySignature
    verificationTimeoutMs = input.verificationTimeoutMs ?? DEFAULT_SIGNATURE_TIMEOUT_MS
    now = input.now ?? (() => new Date())
  } catch {
    throw new Error('locked package verification runtime is invalid')
  }
  if (typeof verifySignature !== 'function' || isProxy(verifySignature))
    throw new Error('locked package signature verifier is invalid')
  if (
    !Number.isSafeInteger(verificationTimeoutMs) ||
    (verificationTimeoutMs as number) < 1 ||
    (verificationTimeoutMs as number) > 60_000
  )
    throw new Error('locked package signature timeout is invalid')
  if (typeof now !== 'function' || isProxy(now)) throw new Error('locked package clock is invalid')
  return Object.freeze({
    verifySignature: verifySignature as LockedPackageSignatureVerifier,
    verificationTimeoutMs: verificationTimeoutMs as number,
    now: now as () => Date,
  })
}

export function parseLockedPackageManifest(value: unknown): LockedPackageManifest {
  const root = object(value, 'manifest')
  exactKeys(root, MANIFEST_KEYS, 'manifest')
  if (root.schemaVersion !== 1) throw new Error('locked package schema version is unsupported')
  if (typeof root.packageId !== 'string' || !TOKEN.test(root.packageId))
    throw new Error('locked package id is invalid')
  if (typeof root.version !== 'string' || !TOKEN.test(root.version))
    throw new Error('locked package version is invalid')

  const provenance = object(root.provenance, 'provenance')
  exactKeys(provenance, ['artifactSha256', 'revision', 'source'], 'provenance')
  const signature = object(root.signature, 'signature')
  exactKeys(signature, ['algorithm', 'keyId', 'value'], 'signature')
  const compatibility = object(root.compatibility, 'compatibility')
  exactKeys(compatibility, ['agnesApiVersions', 'osVersions', 'platforms'], 'compatibility')
  if (
    signature.algorithm !== 'ed25519' ||
    typeof signature.keyId !== 'string' ||
    !TOKEN.test(signature.keyId)
  )
    throw new Error('locked package signature identity is invalid')
  if (
    typeof signature.value !== 'string' ||
    signature.value.length > 512 ||
    !BASE64.test(signature.value) ||
    Buffer.from(signature.value, 'base64').byteLength !== 64 ||
    Buffer.from(signature.value, 'base64').toString('base64') !== signature.value
  )
    throw new Error('locked package signature value is invalid')
  if (typeof provenance.revision !== 'string' || !REVISION.test(provenance.revision))
    throw new Error('locked package provenance revision is invalid')
  const files = denseArray(root.files, 'files', MAX_FILES).map((entry) => {
    const file = object(entry, 'file entry')
    exactKeys(file, ['path', 'sha256', 'size'], 'file entry')
    if (
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      (file.size as number) > MAX_FILE_BYTES
    )
      throw new Error('locked package file size is invalid')
    return {
      path: safeRelativePath(file.path),
      sha256: requireDigest(file.sha256, 'file digest'),
      size: file.size as number,
    }
  })
  files.sort((left, right) => utf8Compare(left.path, right.path))
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error('locked package manifest contains duplicate paths')
  if (!files.some((file) => file.path === 'skill/SKILL.md'))
    throw new Error('locked package must contain exactly one skill/SKILL.md')
  if (files.reduce((total, file) => total + file.size, 0) > MAX_PACKAGE_BYTES)
    throw new Error('locked package aggregate size exceeds the limit')

  return {
    schemaVersion: 1,
    packageId: root.packageId,
    version: root.version,
    packageSha256: requireDigest(root.packageSha256, 'package digest'),
    provenance: {
      source: safeSource(provenance.source),
      revision: provenance.revision,
      artifactSha256: requireDigest(provenance.artifactSha256, 'artifact digest'),
    },
    signature: {
      algorithm: 'ed25519',
      keyId: signature.keyId,
      value: signature.value,
    },
    compatibility: {
      agnesApiVersions: stringArray(compatibility.agnesApiVersions, 'Agnes API versions'),
      platforms: stringArray(compatibility.platforms, 'platforms'),
      osVersions: stringArray(compatibility.osVersions, 'OS versions'),
    },
    files,
  }
}

export function canonicalLockedPackagePayload(manifest: LockedPackageManifest): Uint8Array {
  const { signature: _signature, ...signed } = parseLockedPackageManifest(manifest)
  return new TextEncoder().encode(JSON.stringify(signed))
}

function manifestDigest(manifest: LockedPackageManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

async function readRegularFile(path: string, maxBytes = MAX_FILE_BYTES): Promise<Uint8Array> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('locked package entry is not a unique regular file')
    if ((stat.mode & 0o111) !== 0) throw new Error('locked skill package cannot contain executable files')
    if (stat.size > maxBytes) throw new Error('locked package entry exceeds the size limit')
    const bytes = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error('locked package entry exceeds the size limit')
    return bytes.subarray(0, offset)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error('locked package symlinks are forbidden')
    throw error
  } finally {
    await handle?.close()
  }
}

async function listEntries(
  root: string,
  current = '',
  files: string[] = [],
  budget = { entries: 0 },
  depth = 0,
): Promise<string[]> {
  if (depth > 16) throw new Error('locked package directory depth exceeds the limit')
  const entries = await readdir(join(root, current), { withFileTypes: true })
  for (const entry of entries) {
    budget.entries += 1
    if (budget.entries > MAX_FILES * 4) throw new Error('locked package directory entries exceed the limit')
    const next = current ? `${current}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('locked package symlinks are forbidden')
    if (entry.isDirectory()) await listEntries(root, next, files, budget, depth + 1)
    else if (entry.isFile()) files.push(next)
    else throw new Error('locked package contains a non-regular entry')
  }
  return files.sort()
}

async function verifyFiles(root: string, manifest: LockedPackageManifest): Promise<void> {
  const actualPaths = (await listEntries(root)).filter((path) => path !== 'locked-package.manifest.json')
  const expectedPaths = manifest.files.map((file) => file.path)
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    throw new Error('locked package contents do not match the manifest')
  const aggregate = createHash('sha256')
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split('/'))
    const resolved = await realpath(path)
    if (!inside(root, resolved)) throw new Error('locked package file escapes the package root')
    const bytes = await readRegularFile(path, file.size)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== file.size || digest !== file.sha256)
      throw new Error('locked package file digest or size mismatch')
    aggregate.update(`${file.path}\0${file.sha256}\0${file.size}\n`)
  }
  if (aggregate.digest('hex') !== manifest.packageSha256)
    throw new Error('locked package aggregate digest mismatch')
}

async function existingDirectory(path: string): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('locked package root must be a real directory')
  return realpath(path)
}

async function privateStoreDirectory(path: string): Promise<string> {
  if (isWindows())
    throw new Error('locked package activation requires a trusted Windows directory-handle implementation')
  const root = await existingDirectory(path)
  const stat = await lstat(root)
  if (!hasPrivateDaclSync(root)) throw new Error('locked package store must have trusted private ownership')
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) throw new Error('locked package store owner is untrusted')
  return root
}

async function secureChildDirectory(root: string, name: string): Promise<string> {
  const expected = resolve(root, name)
  await ensurePrivateDirectory(expected)
  const actual = await existingDirectory(expected)
  if (actual !== expected || !inside(root, actual))
    throw new Error('locked package store contains an unsafe directory link')
  return actual
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  if (isWindows()) windowsEnsurePrivateDirectorySync(path)
  else await mkdir(path, { recursive: true, mode: 0o700 })
}

function writePrivateFileExclusive(path: string, bytes: Uint8Array | string): void {
  const descriptor = createPrivateFileSync(path)
  try {
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

async function syncDirectory(path: string): Promise<void> {
  await durableSyncDirectory(path, { noFollow: true })
}

async function withActivationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(root, '.computer-use-package-lock.sqlite')
  try {
    const descriptor = createPrivateFileSync(lock)
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    await syncDirectory(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const before = await lstat(lock)
  const uid = process.getuid?.()
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !hasPrivateDaclSync(lock) ||
    (uid !== undefined && before.uid !== uid) ||
    (await realpath(lock)) !== lock
  )
    throw new Error('locked package activation lock is unsafe')
  const database = new DatabaseSync(lock)
  const after = await lstat(lock)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (uid !== undefined && after.uid !== uid) ||
    !hasPrivateDaclSync(lock) ||
    (await realpath(lock)) !== lock
  ) {
    database.close()
    throw new Error('locked package activation lock changed during open')
  }
  let began = false
  try {
    try {
      database.exec(
        'PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS activation_lock (id INTEGER PRIMARY KEY);',
      )
      database.exec('BEGIN IMMEDIATE;')
      began = true
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const errorCode = (error as { errcode?: unknown }).errcode
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || errorCode === 5 || errorCode === 6)
        throw new Error('locked package activation is busy')
      throw error
    }
    const result = await operation()
    database.exec('COMMIT;')
    began = false
    return result
  } catch (error) {
    if (began) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Closing the connection below releases and rolls back a crashed transaction.
      }
    }
    throw error
  } finally {
    database.close()
    await syncDirectory(root)
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writePrivateFileExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`)
    await renameWriteThrough(temporary, path, { noFollow: true })
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readState(root: string): Promise<ActivationState> {
  try {
    const bytes = await readRegularFile(join(root, 'activation.json'))
    const text = fatalUtf8.decode(bytes)
    const value = object(JSON.parse(text), 'activation state')
    exactKeys(value, ['active', 'lkg', 'schemaVersion'], 'activation state')
    if (value.schemaVersion !== 1) throw new Error('locked package activation state version is unsupported')
    const state: ActivationState = {
      schemaVersion: 1,
      active: value.active === null ? null : parseActivationRecord(value.active),
      lkg: value.lkg === null ? null : parseActivationRecord(value.lkg),
    }
    if (text !== `${JSON.stringify(state, null, 2)}\n`)
      throw new Error('locked package activation state is not canonical JSON')
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: 1, active: null, lkg: null }
    throw error
  }
}

function parseActivationRecord(value: unknown): ActivationRecord {
  const record = object(value, 'activation record')
  exactKeys(
    record,
    [
      'activatedAt',
      'compatibility',
      'directory',
      'manifestSha256',
      'packageId',
      'packageSha256',
      'provenance',
      'schemaVersion',
      'signature',
      'version',
    ],
    'activation record',
  )
  const signature = object(record.signature, 'activation signature')
  exactKeys(signature, ['evidenceId', 'keyId', 'publisher'], 'activation signature')
  const provenance = object(record.provenance, 'activation provenance')
  exactKeys(provenance, ['artifactSha256', 'revision', 'source'], 'activation provenance')
  const compatibility = object(record.compatibility, 'activation compatibility')
  exactKeys(compatibility, ['agnesApiVersions', 'osVersions', 'platforms'], 'activation compatibility')
  if (record.schemaVersion !== 1) throw new Error('locked package activation record version is unsupported')
  for (const [value, label] of [
    [record.packageId, 'package id'],
    [record.version, 'version'],
    [signature.keyId, 'signature key'],
    [signature.publisher, 'signature publisher'],
    [signature.evidenceId, 'signature evidence'],
  ] as const)
    if (typeof value !== 'string' || !TOKEN.test(value))
      throw new Error(`locked package activation ${label} is invalid`)
  if (
    typeof record.directory !== 'string' ||
    record.directory !== record.directory.normalize('NFC') ||
    basename(record.directory) !== record.directory ||
    record.directory.length > 400
  )
    throw new Error('locked package activation record path is invalid')
  if (
    typeof record.activatedAt !== 'string' ||
    new Date(record.activatedAt).toISOString() !== record.activatedAt
  )
    throw new Error('locked package activation timestamp is invalid')
  return {
    schemaVersion: 1,
    packageId: record.packageId as string,
    version: record.version as string,
    packageSha256: requireDigest(record.packageSha256, 'activation package digest'),
    manifestSha256: requireDigest(record.manifestSha256, 'activation manifest digest'),
    directory: record.directory,
    activatedAt: record.activatedAt,
    signature: {
      keyId: signature.keyId as string,
      publisher: signature.publisher as string,
      evidenceId: signature.evidenceId as string,
    },
    provenance: {
      source: safeSource(provenance.source),
      revision:
        typeof provenance.revision === 'string' && REVISION.test(provenance.revision)
          ? provenance.revision
          : (() => {
              throw new Error('locked package activation provenance revision is invalid')
            })(),
      artifactSha256: requireDigest(provenance.artifactSha256, 'activation artifact digest'),
    },
    compatibility: {
      agnesApiVersions: stringArray(compatibility.agnesApiVersions, 'activation Agnes API versions'),
      platforms: stringArray(compatibility.platforms, 'activation platforms'),
      osVersions: stringArray(compatibility.osVersions, 'activation OS versions'),
    },
  }
}

function activationStateDigest(state: ActivationState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

function storeBindingDigest(root: string): string {
  return createHash('sha256').update(`agnes-locked-package-store\0${root}`).digest('hex')
}

function activateRequestDigest(
  manifest: LockedPackageManifest,
  sourceArtifactSha256: string,
  sourceRoot: string,
  environment: LockedPackageEnvironment,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        manifestSha256: manifestDigest(manifest),
        sourceArtifactSha256,
        sourceRoot,
        environment,
      }),
    )
    .digest('hex')
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value))
    if (child !== null && typeof child === 'object') freezeCanonical(child as object)
  return Object.freeze(value)
}

function snapshotRecord(record: ActivationRecord): ActivationRecord {
  return freezeCanonical(parseActivationRecord(JSON.parse(JSON.stringify(record)))) as ActivationRecord
}

function parseOperationReceipt(value: unknown): LockedPackageOperationReceipt {
  const receipt = object(value, 'operation receipt')
  exactKeys(
    receipt,
    [
      'afterStateSha256',
      'beforeStateSha256',
      'fencing',
      'kind',
      'operationId',
      'phase',
      'requestSha256',
      'result',
      'schemaVersion',
      'storeBindingSha256',
    ],
    'operation receipt',
  )
  if (receipt.schemaVersion !== 1) throw new Error('locked package operation receipt version is unsupported')
  if (typeof receipt.operationId !== 'string' || !TOKEN.test(receipt.operationId))
    throw new Error('locked package operation id is invalid')
  if (!['activate', 'confirm-lkg', 'rollback'].includes(receipt.kind as string))
    throw new Error('locked package operation kind is invalid')
  if (receipt.phase !== 'prepared' && receipt.phase !== 'committed')
    throw new Error('locked package operation phase is invalid')
  if (typeof receipt.fencing !== 'string' || !TOKEN.test(receipt.fencing))
    throw new Error('locked package operation fencing is invalid')
  if (receipt.requestSha256 !== null) requireDigest(receipt.requestSha256, 'operation request digest')
  return {
    schemaVersion: 1,
    operationId: receipt.operationId,
    kind: receipt.kind as LockedPackageMutationKind,
    phase: receipt.phase,
    fencing: receipt.fencing,
    storeBindingSha256: requireDigest(receipt.storeBindingSha256, 'operation store binding'),
    requestSha256: receipt.requestSha256 as string | null,
    beforeStateSha256: requireDigest(receipt.beforeStateSha256, 'operation before-state digest'),
    afterStateSha256: requireDigest(receipt.afterStateSha256, 'operation after-state digest'),
    result: parseActivationRecord(receipt.result),
  }
}

function boundReceiptMethod(
  receipts: object,
  method: 'read' | 'prepare' | 'commit',
): (...args: never[]) => unknown {
  try {
    let target: object | null = receipts
    while (target) {
      if (isProxy(target)) throw new Error('unsafe receipt prototype')
      const descriptor = Object.getOwnPropertyDescriptor(target, method)
      if (descriptor) {
        if (
          descriptor.get ||
          descriptor.set ||
          !('value' in descriptor) ||
          typeof descriptor.value !== 'function' ||
          isProxy(descriptor.value)
        )
          throw new Error('unsafe receipt method')
        return Reflect.apply(Function.prototype.bind, descriptor.value, [receipts]) as (
          ...args: never[]
        ) => unknown
      }
      target = Object.getPrototypeOf(target) as object | null
    }
  } catch {
    throw new Error('locked package operation receipt port is invalid')
  }
  throw new Error('locked package operation receipt port is invalid')
}

function validateOperation(operation: LockedPackageOperation): ValidatedLockedPackageOperation {
  const value = object(operation, 'operation')
  exactKeys(value, ['operationId', 'receipts'], 'operation')
  if (typeof value.operationId !== 'string' || !TOKEN.test(value.operationId))
    throw new Error('locked package operation id is invalid')
  const receipts = value.receipts
  if (receipts === null || typeof receipts !== 'object' || isProxy(receipts))
    throw new Error('locked package operation receipt port is invalid')
  if (Object.getOwnPropertySymbols(receipts).length > 0)
    throw new Error('locked package operation receipt port is invalid')
  return Object.freeze({
    operationId: value.operationId,
    read: boundReceiptMethod(receipts, 'read') as LockedPackageOperationReceiptPort['read'],
    prepare: boundReceiptMethod(receipts, 'prepare') as LockedPackageOperationReceiptPort['prepare'],
    commit: boundReceiptMethod(receipts, 'commit') as LockedPackageOperationReceiptPort['commit'],
  })
}

async function readOperationReceipt(
  operation: ValidatedLockedPackageOperation,
): Promise<LockedPackageOperationReceipt | null> {
  let value: LockedPackageOperationReceipt | null
  try {
    value = await operation.read(operation.operationId)
  } catch {
    throw new Error('locked package operation receipt read failed')
  }
  return value === null ? null : parseOperationReceipt(value)
}

function sameReceipt(
  left: LockedPackageOperationReceipt,
  right: LockedPackageOperationReceipt,
  phase: LockedPackageOperationReceipt['phase'],
): boolean {
  return JSON.stringify({ ...left, phase }) === JSON.stringify(right)
}

async function prepareOperationReceipt(
  operation: ValidatedLockedPackageOperation,
  kind: LockedPackageMutationKind,
  storeBindingSha256: string,
  requestSha256: string | null,
  before: ActivationState,
  after: ActivationState,
  result: ActivationRecord,
): Promise<LockedPackageOperationReceipt> {
  const fixedResult = snapshotRecord(result)
  const proposal = freezeCanonical({
    schemaVersion: 1 as const,
    operationId: operation.operationId,
    kind,
    storeBindingSha256,
    requestSha256,
    beforeStateSha256: activationStateDigest(before),
    afterStateSha256: activationStateDigest(after),
    result: fixedResult,
  })
  const portInput = freezeCanonical({
    ...proposal,
    result: snapshotRecord(fixedResult),
  })
  let raw: LockedPackageOperationReceipt
  try {
    raw = await operation.prepare(portInput)
  } catch {
    throw new Error('locked package operation receipt prepare failed')
  }
  const receipt = parseOperationReceipt(raw)
  if (
    receipt.phase !== 'prepared' ||
    JSON.stringify({ ...receipt, fencing: undefined, phase: undefined }) !==
      JSON.stringify({ ...proposal, fencing: undefined, phase: undefined })
  )
    throw new Error('locked package operation receipt does not match the mutation')
  return receipt
}

async function commitOperationReceipt(
  operation: ValidatedLockedPackageOperation,
  expected: LockedPackageOperationReceipt,
): Promise<LockedPackageOperationReceipt> {
  let raw: LockedPackageOperationReceipt
  try {
    raw = await operation.commit(
      Object.freeze({
        operationId: operation.operationId,
        fencing: expected.fencing,
      }),
    )
  } catch {
    throw new Error('locked package mutation outcome is unknown; reconcile the operation')
  }
  const committed = parseOperationReceipt(raw)
  if (!sameReceipt(expected, committed, 'committed'))
    throw new Error('locked package mutation outcome is unknown; reconcile the operation')
  return committed
}

async function writeMutationState(root: string, state: ActivationState): Promise<void> {
  try {
    await atomicJson(join(root, 'activation.json'), state)
  } catch {
    // rename/write-through may have succeeded even when its acknowledgement was lost.
    throw new Error('locked package mutation outcome is unknown; reconcile the operation')
  }
}

async function assertPreparedMutationState(
  root: string,
  before: ActivationState,
  after: ActivationState,
  receipt: LockedPackageOperationReceipt,
): Promise<void> {
  const current = await readState(root)
  if (
    activationStateDigest(current) !== receipt.beforeStateSha256 ||
    activationStateDigest(before) !== receipt.beforeStateSha256 ||
    activationStateDigest(after) !== receipt.afterStateSha256
  )
    throw new Error('locked package mutation outcome is unknown; reconcile the operation')
}

async function reconcileReceiptUnderLock(
  state: ActivationState,
  root: string,
  operation: ValidatedLockedPackageOperation,
  expectedKind?: LockedPackageMutationKind,
  expectedRequestSha256?: string | null,
): Promise<LockedPackageOperationReconciliation | null> {
  const receipt = await readOperationReceipt(operation)
  if (!receipt) return null
  if (
    receipt.operationId !== operation.operationId ||
    receipt.storeBindingSha256 !== storeBindingDigest(root) ||
    (expectedKind && receipt.kind !== expectedKind) ||
    (expectedRequestSha256 !== undefined && receipt.requestSha256 !== expectedRequestSha256)
  )
    throw new Error('locked package operation receipt does not match the mutation')
  if (receipt.phase === 'committed') return { status: 'committed', record: receipt.result }
  const stateSha256 = activationStateDigest(state)
  if (stateSha256 === receipt.afterStateSha256) {
    await commitOperationReceipt(operation, receipt)
    return { status: 'committed', record: receipt.result }
  }
  if (stateSha256 === receipt.beforeStateSha256) return { status: 'not-applied', record: receipt.result }
  return { status: 'unknown', record: receipt.result }
}

async function verifyTrust(
  manifest: LockedPackageManifest,
  environment: LockedPackageEnvironment,
  verifySignature: LockedPackageSignatureVerifier,
  timeoutMs: number,
): Promise<SignatureEvidence> {
  for (const [value, allowed, label] of [
    [environment.agnesApiVersion, manifest.compatibility.agnesApiVersions, 'Agnes API'],
    [environment.platform, manifest.compatibility.platforms, 'platform'],
    [environment.osVersion, manifest.compatibility.osVersions, 'OS version'],
  ] as const)
    if (!allowed.includes(value)) throw new Error(`locked package ${label} compatibility is unverified`)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('locked package signature timeout is invalid')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('locked package signature verification timed out'))
    }, timeoutMs)
  })
  let rawEvidence: SignatureEvidence
  try {
    rawEvidence = await Promise.race([
      verifySignature({
        algorithm: manifest.signature.algorithm,
        keyId: manifest.signature.keyId,
        signature: manifest.signature.value,
        payload: canonicalLockedPackagePayload(manifest),
        signal: controller.signal,
      }),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const evidence = object(rawEvidence, 'signature evidence')
  exactKeys(evidence, ['evidenceId', 'keyId', 'publisher', 'verified'], 'signature evidence')
  if (
    evidence.verified !== true ||
    evidence.keyId !== manifest.signature.keyId ||
    typeof evidence.publisher !== 'string' ||
    !TOKEN.test(evidence.publisher) ||
    typeof evidence.evidenceId !== 'string' ||
    !TOKEN.test(evidence.evidenceId)
  )
    throw new Error('locked package signature evidence is incomplete or untrusted')
  return {
    verified: true,
    keyId: evidence.keyId as string,
    publisher: evidence.publisher,
    evidenceId: evidence.evidenceId,
  }
}

function buildRecord(
  manifest: LockedPackageManifest,
  evidence: SignatureEvidence,
  activatedAt: string,
): ActivationRecord {
  return {
    schemaVersion: 1,
    packageId: manifest.packageId,
    version: manifest.version,
    packageSha256: manifest.packageSha256,
    manifestSha256: manifestDigest(manifest),
    directory: `${manifest.packageId}-${manifest.version}-${manifest.packageSha256}`,
    activatedAt,
    signature: { keyId: evidence.keyId, publisher: evidence.publisher, evidenceId: evidence.evidenceId },
    provenance: manifest.provenance,
    compatibility: manifest.compatibility,
  }
}

async function verifyStoredRecord(
  root: string,
  record: ActivationRecord,
  environment: LockedPackageEnvironment,
  verifySignature: LockedPackageSignatureVerifier,
  verificationTimeoutMs: number,
): Promise<ActivationRecord> {
  const versions = await secureChildDirectory(root, 'versions')
  const expectedPackageRoot = join(versions, record.directory)
  const packageRoot = await existingDirectory(expectedPackageRoot)
  if (packageRoot !== expectedPackageRoot || !inside(versions, packageRoot))
    throw new Error('locked package activation directory escapes the versions root')
  const manifestBytes = await readRegularFile(join(packageRoot, 'locked-package.manifest.json'))
  const manifestText = fatalUtf8.decode(manifestBytes)
  const manifest = parseLockedPackageManifest(JSON.parse(manifestText))
  if (manifestText !== `${JSON.stringify(manifest, null, 2)}\n`)
    throw new Error('locked package stored manifest is not canonical JSON')
  await verifyFiles(packageRoot, manifest)
  const evidence = await verifyTrust(manifest, environment, verifySignature, verificationTimeoutMs)
  const rebuilt = buildRecord(manifest, evidence, record.activatedAt)
  if (JSON.stringify(rebuilt) !== JSON.stringify(record))
    throw new Error('locked package activation metadata does not match its package')
  return rebuilt
}

async function cleanupInterruptedStaging(root: string): Promise<void> {
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.name.startsWith('.staging-'),
  )
  if (entries.length > 8) throw new Error('locked package has too many interrupted staging directories')
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('locked package interrupted staging entry is unsafe')
    const path = join(root, entry.name)
    await listEntries(path)
    await rm(path, { recursive: true })
  }
  if (entries.length > 0) await syncDirectory(root)
}

async function syncPackageDirectories(staging: string, files: LockedPackageManifest['files']): Promise<void> {
  const directories = new Set<string>()
  for (const file of files) {
    let current = dirname(join(staging, ...file.path.split('/')))
    while (current !== staging) {
      directories.add(current)
      current = dirname(current)
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length))
    await syncDirectory(directory)
  await syncDirectory(staging)
}

export async function activateLockedPackage(input: {
  sourceDirectory: string
  storeDirectory: string
  manifest: unknown
  sourceArchiveBytes: Uint8Array
  environment: LockedPackageEnvironment
  verifySignature: LockedPackageSignatureVerifier
  verificationTimeoutMs?: number
  now?: () => Date
  operation: LockedPackageOperation
}): Promise<ActivationRecord> {
  const operation = validateOperation(input.operation)
  const environment = parseEnvironment(input.environment)
  const runtime = snapshotVerificationRuntime(input)
  const manifest = parseLockedPackageManifest(input.manifest)
  if (!(input.sourceArchiveBytes instanceof Uint8Array) || input.sourceArchiveBytes.byteLength === 0)
    throw new Error('locked package source archive bytes are required')
  if (input.sourceArchiveBytes.byteLength > MAX_SOURCE_ARCHIVE_BYTES)
    throw new Error('locked package source archive exceeds the size limit')
  const sourceArtifactSha256 = createHash('sha256').update(input.sourceArchiveBytes).digest('hex')
  if (sourceArtifactSha256 !== manifest.provenance.artifactSha256)
    throw new Error('locked package source artifact digest does not match provenance')
  const sourceRoot = await existingDirectory(input.sourceDirectory)
  const storeRoot = await privateStoreDirectory(input.storeDirectory)
  if (inside(sourceRoot, storeRoot) || inside(storeRoot, sourceRoot))
    throw new Error('locked package source and store must be separate')
  return withActivationLock(storeRoot, async () => {
    const state = await readState(storeRoot)
    const verificationTimeoutMs = runtime.verificationTimeoutMs
    const requestSha256 = activateRequestDigest(manifest, sourceArtifactSha256, sourceRoot, environment)
    const reconciliation = await reconcileReceiptUnderLock(
      state,
      storeRoot,
      operation,
      'activate',
      requestSha256,
    )
    if (reconciliation?.status === 'committed')
      return verifyStoredRecord(
        storeRoot,
        reconciliation.record,
        environment,
        runtime.verifySignature,
        verificationTimeoutMs,
      )
    if (reconciliation?.status === 'unknown')
      throw new Error('locked package mutation outcome is unknown; manual recovery is required')
    await cleanupInterruptedStaging(storeRoot)
    await verifyFiles(sourceRoot, manifest)
    const evidence = await verifyTrust(manifest, environment, runtime.verifySignature, verificationTimeoutMs)
    const versions = await secureChildDirectory(storeRoot, 'versions')
    const freshRecord = reconciliation?.record ?? buildRecord(manifest, evidence, runtime.now().toISOString())
    const priorRecord = [state.active, state.lkg].find(
      (candidate): candidate is ActivationRecord => candidate?.directory === freshRecord.directory,
    )
    const record = priorRecord ?? freshRecord
    const destination = resolve(versions, record.directory)
    if (!inside(versions, destination)) throw new Error('locked package activation path escapes the store')
    try {
      await lstat(destination)
      const verifiedRecord = await verifyStoredRecord(
        storeRoot,
        record,
        environment,
        runtime.verifySignature,
        verificationTimeoutMs,
      )
      const nextState = { ...state, active: verifiedRecord }
      const receipt = await prepareOperationReceipt(
        operation,
        'activate',
        storeBindingDigest(storeRoot),
        requestSha256,
        state,
        nextState,
        verifiedRecord,
      )
      await assertPreparedMutationState(storeRoot, state, nextState, receipt)
      await writeMutationState(storeRoot, nextState)
      await commitOperationReceipt(operation, receipt)
      return verifiedRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const staging = join(storeRoot, `.staging-${randomUUID()}`)
    createPrivateDirectorySync(staging)
    try {
      for (const file of manifest.files) {
        const target = join(staging, ...file.path.split('/'))
        await ensurePrivateDirectory(dirname(target))
        const bytes = await readRegularFile(join(sourceRoot, ...file.path.split('/')), file.size)
        writePrivateFileExclusive(target, bytes)
      }
      await verifyFiles(staging, manifest)
      writePrivateFileExclusive(
        join(staging, 'locked-package.manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
      await syncPackageDirectories(staging, manifest.files)
      await renameWriteThrough(staging, destination, { noFollow: true })
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    const verifiedRecord = await verifyStoredRecord(
      storeRoot,
      record,
      environment,
      runtime.verifySignature,
      verificationTimeoutMs,
    )
    const nextState = { ...state, active: verifiedRecord }
    const receipt = await prepareOperationReceipt(
      operation,
      'activate',
      storeBindingDigest(storeRoot),
      requestSha256,
      state,
      nextState,
      verifiedRecord,
    )
    await assertPreparedMutationState(storeRoot, state, nextState, receipt)
    await writeMutationState(storeRoot, nextState)
    await commitOperationReceipt(operation, receipt)
    return verifiedRecord
  })
}

type StoredPackageOperation = {
  storeDirectory: string
  environment: LockedPackageEnvironment
  verifySignature: LockedPackageSignatureVerifier
  verificationTimeoutMs?: number
  operation: LockedPackageOperation
}

export async function confirmLockedPackageLkg(input: StoredPackageOperation): Promise<ActivationRecord> {
  const operation = validateOperation(input.operation)
  const environment = parseEnvironment(input.environment)
  const runtime = snapshotVerificationRuntime(input)
  const root = await privateStoreDirectory(input.storeDirectory)
  return withActivationLock(root, async () => {
    const state = await readState(root)
    const reconciliation = await reconcileReceiptUnderLock(state, root, operation, 'confirm-lkg', null)
    if (reconciliation?.status === 'committed')
      return verifyStoredRecord(
        root,
        reconciliation.record,
        environment,
        runtime.verifySignature,
        runtime.verificationTimeoutMs,
      )
    if (reconciliation?.status === 'unknown')
      throw new Error('locked package mutation outcome is unknown; manual recovery is required')
    if (!state.active) throw new Error('locked package has no active candidate to confirm')
    const record = await verifyStoredRecord(
      root,
      state.active,
      environment,
      runtime.verifySignature,
      runtime.verificationTimeoutMs,
    )
    const nextState = { ...state, lkg: record }
    const receipt = await prepareOperationReceipt(
      operation,
      'confirm-lkg',
      storeBindingDigest(root),
      null,
      state,
      nextState,
      record,
    )
    await assertPreparedMutationState(root, state, nextState, receipt)
    await writeMutationState(root, nextState)
    await commitOperationReceipt(operation, receipt)
    return record
  })
}

export async function rollbackLockedPackage(input: StoredPackageOperation): Promise<ActivationRecord> {
  const operation = validateOperation(input.operation)
  const environment = parseEnvironment(input.environment)
  const runtime = snapshotVerificationRuntime(input)
  const root = await privateStoreDirectory(input.storeDirectory)
  return withActivationLock(root, async () => {
    const state = await readState(root)
    const reconciliation = await reconcileReceiptUnderLock(state, root, operation, 'rollback', null)
    if (reconciliation?.status === 'committed')
      return verifyStoredRecord(
        root,
        reconciliation.record,
        environment,
        runtime.verifySignature,
        runtime.verificationTimeoutMs,
      )
    if (reconciliation?.status === 'unknown')
      throw new Error('locked package mutation outcome is unknown; manual recovery is required')
    if (!state.lkg) throw new Error('locked package has no last-known-good candidate')
    const record = await verifyStoredRecord(
      root,
      state.lkg,
      environment,
      runtime.verifySignature,
      runtime.verificationTimeoutMs,
    )
    const nextState = { ...state, active: record }
    const receipt = await prepareOperationReceipt(
      operation,
      'rollback',
      storeBindingDigest(root),
      null,
      state,
      nextState,
      record,
    )
    await assertPreparedMutationState(root, state, nextState, receipt)
    await writeMutationState(root, nextState)
    await commitOperationReceipt(operation, receipt)
    return record
  })
}

export async function reconcileLockedPackageOperation(input: {
  storeDirectory: string
  operation: LockedPackageOperation
}): Promise<LockedPackageOperationHistory> {
  const operation = validateOperation(input.operation)
  const root = await privateStoreDirectory(input.storeDirectory)
  return withActivationLock(root, async () => {
    const result = await reconcileReceiptUnderLock(await readState(root), root, operation)
    return result
      ? { historyOnly: true, outcome: result.status, record: result.record }
      : { historyOnly: true, outcome: 'not-found' }
  })
}
