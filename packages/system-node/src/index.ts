import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'

export { nodeArtifactGcPreparationRuntime } from './artifact-gc-preparation.js'

import { dirname, isAbsolute, parse, resolve, toNamespacedPath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PipeReservation } from './windows-pipe-listener.js'
import type { OwnedPipe } from './windows-pipe-stream.js'

const windows = process.platform === 'win32' // guards-allow-platform: shared system leaf, independent of Host.
const darwin = process.platform === 'darwin' // guards-allow-platform: shared system leaf, independent of Host.
const linux = process.platform === 'linux' // guards-allow-platform: shared system leaf, independent of Host.
type Native = {
  deleteSkillEntry?(
    path: string,
    dev: bigint,
    ino: bigint,
    size: number,
    mtimeMs: number,
    directory: boolean,
  ): void
  renameDirectoryNoReplace?(from: string, to: string): void
  abiVersion: number
  spawnDetached?(executable: string, command: string, cwd: string, env: string): OwnedDetachedProcess
  reservePipeName(path: string, maximum: number): PipeReservation
  connectVerifiedPipe(path: string, pid: number, start: string): OwnedPipe
  environmentNamesEqual(left: string, right: string): boolean
  createProcessJob(): WindowsProcessJob
  createPrivateFile(path: string): number
  createTemporaryPrivateFile(path: string): number
  createPrivateDirectory(path: string): void
  deletePrivateArtifact(root: string, relativePath: string, sha256: string): bigint
  renameWriteThrough(from: string, to: string): void
  hasPrivateDacl(path: string): boolean
  syncDirectory(path: string): void
  processStartTime(pid: number): string | null
  processExecutableIdentity(pid: number): WindowsProcessExecutableIdentity
  executableFileIdentity(path: string): WindowsExecutableFileIdentity
  readPrivateFile(path: string, maxBytes: number): Buffer
  openPrivateFile(path: string): number
  appendPrivateFile(path: string, bytes: Buffer, flush: boolean): void
  protectPrivateDirectory(path: string): void
  protectPrivateFile?(path: string): void
}

/** Refuse stale identities and link traversal; never fall back to path-based recursive deletion. */
export function skillDeletionPath(path: string): string {
  const target = filePath(path)
  if (windows && !/^[a-z]:\\/i.test(path))
    throw Object.assign(new Error('Skill deletion requires a local drive path'), { code: 'EINVAL' })
  if (typeof native().deleteSkillEntry !== 'function')
    throw Object.assign(new Error('Rebuild native artifact for safe skill deletion'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  // These are OS-owned aliases, not permission to resolve arbitrary user symlinks.
  return darwin ? path.replace(/^\/(var|tmp|etc)(?=\/|$)/, '/private/$1') : windows ? path : target
}

export function deleteSkillEntrySync(entry: {
  path: string
  dev: string
  ino: string
  size: number
  mtimeMs: number
  directory: boolean
}): void {
  if (
    ![entry.dev, entry.ino].every((n) => /^\d{1,20}$/.test(n)) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    !Number.isFinite(entry.mtimeMs)
  )
    throw new Error('SKILL_DELETE_REFUSED')
  const implementation = native().deleteSkillEntry
  if (typeof implementation !== 'function')
    throw Object.assign(new Error('Rebuild native artifact for safe skill deletion'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  implementation(
    filePath(skillDeletionPath(entry.path)),
    BigInt(entry.dev),
    BigInt(entry.ino),
    entry.size,
    entry.mtimeMs,
    entry.directory,
  )
}
let loaded: Native | undefined
function native(): Native {
  if (loaded) return loaded
  try {
    const candidate = createRequire(import.meta.url)('@agnes/system-node/native') as Native
    const required = windows
      ? [
          'reservePipeName',
          'connectVerifiedPipe',
          'environmentNamesEqual',
          'createProcessJob',
          'createPrivateFile',
          'createTemporaryPrivateFile',
          'createPrivateDirectory',
          'deletePrivateArtifact',
          'renameWriteThrough',
          'hasPrivateDacl',
          'syncDirectory',
          'processStartTime',
          'processExecutableIdentity',
          'executableFileIdentity',
          'readPrivateFile',
          'openPrivateFile',
          'appendPrivateFile',
          'protectPrivateDirectory',
        ]
      : ['deletePrivateArtifact']
    if (
      candidate.abiVersion !== 1 ||
      required.some((name) => typeof candidate[name as keyof Native] !== 'function')
    )
      throw new Error('ABI mismatch')
    loaded = candidate
    return candidate
  } catch {
    throw Object.assign(new Error('System module is missing or incompatible; rebuild the native artifact'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  }
}

/** Internal primitives. Applications should use the windows-pipe entry point. */
export type OwnedDetachedProcess = {
  readonly pid: number
  exitCode(): number | null
  terminate(): void
  /** Release ownership without terminating the independent child. */
  close(): void
}
export function windowsSpawnDetachedSync(
  executable: string,
  command: string,
  cwd: string,
  env: string,
): OwnedDetachedProcess {
  if (!windows) throw Object.assign(new Error('Windows detached process unavailable'), { code: 'ENOSYS' })
  const implementation = native().spawnDetached
  if (typeof implementation !== 'function')
    throw Object.assign(new Error('Windows detached process module missing; rebuild native artifact'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  return implementation(executable, command, cwd, env)
}

export function windowsReservePipeName(path: string, maximum: number): PipeReservation {
  if (!windows) throw Object.assign(new Error('Windows pipes unavailable'), { code: 'ENOSYS' })
  return native().reservePipeName(path, maximum)
}

export function windowsConnectPipeSync(path: string, pid: number, start: string): OwnedPipe {
  if (!windows) throw Object.assign(new Error('Windows pipes unavailable'), { code: 'ENOSYS' })
  return native().connectVerifiedPipe(path, pid, start)
}

export function windowsEnvironmentNamesEqual(left: string, right: string): boolean {
  if (!windows)
    throw Object.assign(new Error('Windows environment comparison unavailable'), { code: 'ENOSYS' })
  return native().environmentNamesEqual(left, right)
}

/** Internal lifecycle primitive, not a sandbox. Keep a strong reference until explicit close. */
export type WindowsProcessJob = {
  /** Only assign a controlled process before allowing it to launch business commands. */
  assign(pid: number, expectedStartTime: string): void
  terminate(): void
  activeProcessCount(): number
  /** Drains lifecycle notifications and waits for tracked process handles; false until terminated. */
  terminationComplete(): boolean
  /** Idempotent; force-terminates remaining members. Termination is asynchronous. */
  close(): void
}

export function createWindowsProcessJob(): WindowsProcessJob {
  if (!windows) throw Object.assign(new Error('Windows process jobs are unavailable'), { code: 'ENOSYS' })
  const job = native().createProcessJob()
  if (
    ['assign', 'terminate', 'activeProcessCount', 'terminationComplete', 'close'].some(
      (name) => typeof job[name as keyof WindowsProcessJob] !== 'function',
    )
  ) {
    job.close?.()
    throw Object.assign(new Error('Windows process job ABI mismatch; rebuild the native artifact'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  }
  return job
}

/** Capability probe only; does not create files or change permissions. */
export function windowsPrivateFilesAvailable(): boolean {
  if (!windows) return false
  try {
    native()
    return true
  } catch {
    return false
  }
}

/** Read-only Windows snapshot. Null means confirmed exit/nonexistence; errors remain errors. */
export function windowsProcessStartTimeSync(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff)
    throw Object.assign(new TypeError('Expected a positive Windows process ID'), { code: 'EINVAL' })
  if (!windows) throw Object.assign(new Error('Windows process queries are unavailable'), { code: 'ENOSYS' })
  return native().processStartTime(pid)
}

type WindowsProcessExecutableIdentityBase = Readonly<{
  executablePath: string
  /** NT device path returned for the live process main MEM_IMAGE mapping. */
  mappedImagePath: string
  /** Native proof contract used to bind the mapped main image to the signed file handle. */
  imageBinding: 'mapped-image-file-handle-v1'
  /** Creation FILETIME captured from the same live process handle. */
  processStartTime: string
}>

export type WindowsProcessExecutableIdentity = WindowsProcessExecutableIdentityBase &
  (
    | Readonly<{
        /** SHA-256 of the leaf Authenticode signing certificate. */
        publisherSha256: string
      }>
    | Readonly<{
        /** OS-attested package family for an installed Windows AppX/MSIX process. */
        packageFamilyName: string
      }>
  )

export type WindowsExecutableFileIdentity = Readonly<{
  executablePath: string
  publisherSha256: string
  leafThumbprint: string
  publisher: string
}>

/** Verifies one regular, single-link executable with Windows Authenticode. */
export function windowsExecutableFileIdentitySync(path: string): WindowsExecutableFileIdentity {
  const target = filePath(path)
  if (!windows)
    throw Object.assign(new Error('Windows executable identity queries are unavailable'), { code: 'ENOSYS' })
  const value = native().executableFileIdentity(target)
  if (
    !value ||
    typeof value.executablePath !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.publisherSha256) ||
    !/^[a-f0-9]{40}$/.test(value.leafThumbprint) ||
    typeof value.publisher !== 'string' ||
    value.publisher.length === 0
  )
    throw Object.assign(new Error('Windows executable identity ABI mismatch; rebuild native artifact'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  return Object.freeze({ ...value })
}

/**
 * Binds the live process main MEM_IMAGE mapping to the exact replacement-locked file handle used
 * for Authenticode verification, then rechecks the mapping, path and process start identity.
 */
export function windowsProcessExecutableIdentitySync(pid: number): WindowsProcessExecutableIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff)
    throw Object.assign(new TypeError('Expected a positive Windows process ID'), { code: 'EINVAL' })
  if (!windows)
    throw Object.assign(new Error('Windows process identity queries are unavailable'), { code: 'ENOSYS' })
  const value = native().processExecutableIdentity(pid)
  const stableIdentity = Boolean(
    value &&
      typeof value === 'object' &&
      ('publisherSha256' in value
        ? /^[a-f0-9]{64}$/.test(value.publisherSha256) && !('packageFamilyName' in value)
        : 'packageFamilyName' in value &&
          typeof value.packageFamilyName === 'string' &&
          value.packageFamilyName.length >= 3 &&
          value.packageFamilyName.length <= 255),
  )
  if (
    !value ||
    typeof value.executablePath !== 'string' ||
    typeof value.mappedImagePath !== 'string' ||
    value.mappedImagePath.length === 0 ||
    value.imageBinding !== 'mapped-image-file-handle-v1' ||
    !stableIdentity ||
    !/^[0-9]+$/.test(value.processStartTime)
  )
    throw Object.assign(new Error('Windows process identity ABI mismatch; rebuild native artifact'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  return Object.freeze({ ...value })
}

/**
 * Deletes one content-addressed private artifact by the same handle whose root containment,
 * single-link identity and content digest were verified by the native module.
 */
export function windowsDeletePrivateArtifactSync(
  storeRoot: string,
  rootRelativePath: string,
  sha256: string,
): number {
  const root = filePath(storeRoot)
  if (
    !/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(rootRelativePath) ||
    rootRelativePath.slice(0, 2) !== sha256.slice(0, 2)
  )
    throw Object.assign(new TypeError('Invalid content-addressed artifact identity'), { code: 'EINVAL' })
  if (!/^[a-f0-9]{64}$/.test(sha256) || rootRelativePath.slice(3) !== sha256)
    throw Object.assign(new TypeError('Invalid content-addressed artifact identity'), { code: 'EINVAL' })
  if (!windows)
    throw Object.assign(new Error('Windows private artifact deletion is unavailable'), { code: 'ENOSYS' })
  const count = native().deletePrivateArtifact(root, rootRelativePath.replaceAll('/', '\\'), sha256)
  if (count > BigInt(Number.MAX_SAFE_INTEGER))
    throw Object.assign(new Error('Deleted artifact size exceeds JavaScript safe integer range'), {
      code: 'EFBIG',
    })
  return Number(count)
}

/** macOS openat/unlinkat equivalent of the Windows same-handle artifact deletion primitive. */
export function macOSDeletePrivateArtifactSync(
  storeRoot: string,
  rootRelativePath: string,
  sha256: string,
): number {
  const root = filePath(storeRoot)
  if (
    !/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(rootRelativePath) ||
    rootRelativePath.slice(0, 2) !== sha256.slice(0, 2) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    rootRelativePath.slice(3) !== sha256
  )
    throw Object.assign(new TypeError('Invalid content-addressed artifact identity'), { code: 'EINVAL' })
  if (!darwin)
    throw Object.assign(new Error('macOS private artifact deletion is unavailable'), { code: 'ENOSYS' })
  const count = native().deletePrivateArtifact(root, rootRelativePath, sha256)
  if (count > BigInt(Number.MAX_SAFE_INTEGER))
    throw Object.assign(new Error('Deleted artifact size exceeds JavaScript safe integer range'), {
      code: 'EFBIG',
    })
  return Number(count)
}

/** Linux openat/unlinkat equivalent using an AF_ALG hash over the same opened file. */
export function linuxDeletePrivateArtifactSync(
  storeRoot: string,
  rootRelativePath: string,
  sha256: string,
): number {
  const root = filePath(storeRoot)
  if (
    !/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(rootRelativePath) ||
    rootRelativePath.slice(0, 2) !== sha256.slice(0, 2) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    rootRelativePath.slice(3) !== sha256
  )
    throw Object.assign(new TypeError('Invalid content-addressed artifact identity'), { code: 'EINVAL' })
  if (!linux)
    throw Object.assign(new Error('Linux private artifact deletion is unavailable'), { code: 'ENOSYS' })
  const count = native().deletePrivateArtifact(root, rootRelativePath, sha256)
  if (count > BigInt(Number.MAX_SAFE_INTEGER))
    throw Object.assign(new Error('Deleted artifact size exceeds JavaScript safe integer range'), {
      code: 'EFBIG',
    })
  return Number(count)
}

/** Platform dispatch for the production artifact collector. */
export function deletePrivateArtifactSync(
  storeRoot: string,
  rootRelativePath: string,
  sha256: string,
): number {
  if (windows) return windowsDeletePrivateArtifactSync(storeRoot, rootRelativePath, sha256)
  if (darwin) return macOSDeletePrivateArtifactSync(storeRoot, rootRelativePath, sha256)
  if (linux) return linuxDeletePrivateArtifactSync(storeRoot, rootRelativePath, sha256)
  throw Object.assign(new Error('Private artifact deletion is unavailable'), { code: 'ENOSYS' })
}

export function privateArtifactDeleteAvailable(): boolean {
  if (!windows && !darwin && !linux) return false
  try {
    native()
    return true
  } catch {
    return false
  }
}

/** Validates and reads one file handle. Callers must separately validate the parent directory chain. */
export function windowsReadPrivateFileSync(path: string, maxBytes: number): Buffer {
  const target = filePath(path)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024)
    throw Object.assign(new TypeError('Invalid private file read limit'), { code: 'EINVAL' })
  if (!windows)
    throw Object.assign(new Error('Windows private file reads are unavailable'), { code: 'ENOSYS' })
  return native().readPrivateFile(target, maxBytes)
}

/** Decode a private file and clear its temporary bytes; parent validation remains with the caller. */
export function windowsReadPrivateTextSync(path: string, maxBytes: number): string {
  const bytes = windowsReadPrivateFileSync(path, maxBytes)
  try {
    return bytes.toString('utf8')
  } finally {
    bytes.fill(0)
  }
}

/** ACL-checked read-only Node descriptor; caller closes it and validates the parent directory chain. */
export function windowsOpenPrivateFileSync(path: string): number {
  const target = filePath(path)
  if (!windows)
    throw Object.assign(new Error('Windows private file reads are unavailable'), { code: 'ENOSYS' })
  return native().openPrivateFile(target)
}

/** Validates, appends and optionally flushes the same handle; parent validation belongs to callers. */
export function windowsAppendPrivateFileSync(path: string, bytes: Buffer, flush = false): void {
  const target = filePath(path)
  if (!Buffer.isBuffer(bytes) || typeof flush !== 'boolean')
    throw Object.assign(new TypeError('Expected an append buffer and flush flag'), { code: 'EINVAL' })
  if (!windows) throw Object.assign(new Error('Windows private appends are unavailable'), { code: 'ENOSYS' })
  native().appendPrivateFile(target, bytes, flush)
}

/** Freeze an already-private, trusted-owner, single-link file DACL without changing grants or bytes. */
export function windowsProtectPrivateFileSync(path: string): void {
  const target = filePath(path)
  if (!windows) throw Object.assign(new Error('Windows file protection is unavailable'), { code: 'ENOSYS' })
  const implementation = native().protectPrivateFile
  if (!implementation)
    throw Object.assign(new Error('Rebuild native artifact for private lock migration'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  implementation(target)
}

/** Initialization only: refuses broad/foreign/reparse directories and preserves existing access entries. */
export function windowsProtectPrivateDirectorySync(path: string): void {
  const target = filePath(path)
  if (!windows)
    throw Object.assign(new Error('Windows directory protection is unavailable'), { code: 'ENOSYS' })
  native().protectPrivateDirectory(target)
}

/** Creates missing ancestors privately; never rewrites an existing ancestor's permissions. */
export function windowsEnsurePrivateDirectorySync(path: string): void {
  filePath(path)
  if (!windows)
    throw Object.assign(new Error('Windows directory protection is unavailable'), { code: 'ENOSYS' })
  const missing: string[] = []
  let cursor = resolve(path)
  for (;;) {
    try {
      const stat = lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Object.assign(new Error('Expected a real directory'), { code: 'EACCES' })
      if (missing.length === 0) windowsProtectPrivateDirectorySync(cursor)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missing.push(cursor)
      cursor = parent
    }
  }
  for (const directory of missing.reverse()) {
    try {
      createPrivateDirectorySync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      windowsProtectPrivateDirectorySync(directory)
    }
  }
}
function filePath(path: string): string {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path.includes('\0') ||
    (windows && (parse(path).root.length < 2 || /^\\\\[?.]\\/.test(path) || /:/.test(path.slice(2))))
  )
    throw Object.assign(new TypeError('Expected an absolute filesystem path'), { code: 'EINVAL' })
  return windows ? toNamespacedPath(path) : path
}

/** Creates exclusively with private permissions; caller must close the returned Node fs descriptor. */
export function createPrivateFileSync(path: string): number {
  const target = filePath(path)
  return windows
    ? native().createPrivateFile(target)
    : openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
}

/** Windows private snapshot replacement. A failed commit leaves the previous target intact. */
export async function windowsWritePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  filePath(path)
  windowsEnsurePrivateDirectorySync(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = createPrivateFileSync(temporary)
  let committed = false
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    await renameWriteThrough(temporary, path)
    committed = true
  } finally {
    if (!committed) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* preserve the write/commit error */
      }
    }
  }
}
/** Non-inheritable owner fd; Windows removes the private file after its last handle closes. */
export function windowsCreateTemporaryPrivateFileSync(path: string): number {
  if (!windows) throw Object.assign(new Error('Windows temporary files unavailable'), { code: 'ENOSYS' })
  return native().createTemporaryPrivateFile(filePath(path))
}
/** Never rewrites permissions on a pre-existing directory or recursively changes a parent. */
export function createPrivateDirectorySync(path: string): void {
  const target = filePath(path)
  if (windows) native().createPrivateDirectory(target)
  else mkdirSync(target, { mode: 0o700 })
}
/** Checks this object only. Parent traversal/ownership checks remain the caller's responsibility. */
export function hasPrivateDaclSync(path: string): boolean {
  const target = filePath(path)
  if (windows) return native().hasPrivateDacl(target)
  const stat = lstatSync(target)
  return (stat.isFile() || stat.isDirectory()) && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0
}
export function syncFileSync(path: string): void {
  const target = filePath(path)
  const fd = openSync(target, windows ? 'r+' : 'r')
  try {
    if (!fstatSync(fd).isFile())
      throw Object.assign(new Error('File synchronization requires a regular file'), { code: 'EISDIR' })
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
/** Caller flushes source contents first. Cross-volume copy/delete is deliberately not enabled. */
export function renameWriteThroughSync(from: string, to: string): void {
  const source = filePath(from),
    target = filePath(to)
  if (windows) {
    native().renameWriteThrough(source, target)
    for (const dir of new Set([dirname(resolve(from)), dirname(resolve(to))])) syncDirectorySync(dir)
    return
  }
  renameSync(source, target)
  for (const dir of new Set([dirname(resolve(source)), dirname(resolve(target))])) {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

/** Allows transient Windows readers to close without blocking their event loop. */
export async function renameWriteThrough(
  from: string,
  to: string,
  options: { noFollow?: boolean } = {},
): Promise<void> {
  const source = filePath(from),
    target = filePath(to)
  if (!windows) {
    await rename(source, target)
    for (const dir of new Set([dirname(source), dirname(target)])) await syncDirectory(dir, options)
    return
  }
  const deadline = performance.now() + 1_000
  for (;;) {
    try {
      native().renameWriteThrough(source, target)
      break
    } catch (error) {
      const code = (error as { win32Code?: unknown } | null)?.win32Code
      if (![5, 32, 33].includes(code as number) || performance.now() >= deadline) throw error
      await delay(10)
    }
  }
  // Rename has committed: a subsequent durability failure must never retry the move.
  for (const dir of new Set([dirname(resolve(from)), dirname(resolve(to))])) syncDirectorySync(dir)
}

/** Async callers on POSIX must not block the event loop while flushing a directory. */
export async function syncDirectory(path: string, options: { noFollow?: boolean } = {}): Promise<void> {
  if (windows) return syncDirectorySync(path)
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | (options.noFollow ? constants.O_NOFOLLOW : 0)
  const handle = await open(filePath(path), flags)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Flushes a real directory handle; unsupported filesystems and access failures are errors. */
export function syncDirectorySync(path: string): void {
  const target = filePath(path)
  if (windows) {
    native().syncDirectory(target)
    return
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Publishes a private directory without replacing any destination. No copy/rename fallback. */
export function renameDirectoryNoReplaceSync(from: string, to: string): void {
  const source = filePath(from),
    target = filePath(to)
  if (!lstatSync(from).isDirectory() || !hasPrivateDaclSync(from))
    throw Object.assign(new Error('Private source directory required'), { code: 'EACCES' })
  if (!windows && !darwin && !linux)
    throw Object.assign(new Error('Unsupported platform'), { code: 'ENOSYS' })
  const implementation = native().renameDirectoryNoReplace
  if (typeof implementation !== 'function')
    throw Object.assign(new Error('Rebuild native artifact for no-replace directory publication'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  implementation(source, target)
  if (windows) return
  for (const directory of new Set([dirname(source), dirname(target)])) syncDirectorySync(directory)
}
