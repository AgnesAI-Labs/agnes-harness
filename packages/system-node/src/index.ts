import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'

export { nodeArtifactGcPreparationRuntime } from './artifact-gc-preparation.js'

import { dirname, isAbsolute, join, parse, resolve, toNamespacedPath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { replacePublishedFileSync } from './durable-replace.js'
import { syncTreeBatched } from './tree-sync.js'
import type { PipeReservation } from './windows-pipe-listener.js'
import type { OwnedPipe } from './windows-pipe-stream.js'

const windows = process.platform === 'win32' // guards-allow-platform: shared system leaf, independent of Host.
const darwin = process.platform === 'darwin' // guards-allow-platform: shared system leaf, independent of Host.
const linux = process.platform === 'linux' // guards-allow-platform: shared system leaf, independent of Host.
type Native = {
  openLoopbackListener?(ipv6: boolean): { fd: number; port: number }
  openUnixListener?(path: string): number
  openCanonicalFile?(path: string): number
  openCanonicalWritableFile?(path: string): number
  openCanonicalExclusiveFile?(path: string): number
  canonicalFs?(operation: string, path: string, recursive: boolean, mode: number): Promise<unknown>
  listCanonicalDirectory?(path: string): string[]
  landlockAbi?(): number
  deleteSkillEntry?(
    path: string,
    dev: bigint,
    ino: bigint,
    size: number,
    mtimeMs: number,
    directory: boolean,
  ): void
  renameDirectoryNoReplace?(from: string, to: string): void
  syncDescriptor?(fd: number, full: boolean): void
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

/** Bind an ephemeral TCP listener strictly to one numeric loopback address; caller owns the fd. */
export function openLoopbackListener(family: 'ipv4' | 'ipv6' = 'ipv4'): { fd: number; port: number } {
  if (family !== 'ipv4' && family !== 'ipv6') throw new Error('Invalid loopback address family')
  const implementation = darwin ? native().openLoopbackListener : undefined
  if (typeof implementation !== 'function')
    throw Object.assign(
      new Error('Loopback socket activation requires the macOS native module; rebuild it'),
      { code: 'E_SYSTEM_NATIVE_UNAVAILABLE' },
    )
  return implementation(family === 'ipv6')
}

/** Reserved macOS activation namespace, denied to sandbox writes even when cwd is an ancestor. */
export const LOOPBACK_GATE_PATH_PREFIX = '/private/tmp/agh-loopback-'

/** Host-private socket activation transport; the caller owns the fd and path cleanup. */
export function openUnixListener(path: string): number {
  const implementation = darwin ? native().openUnixListener : undefined
  if (typeof implementation !== 'function')
    throw Object.assign(new Error('Unix socket activation requires the macOS native module; rebuild it'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  return implementation(path)
}

/** Read-only kernel availability query; this does not establish a command boundary. */
export function linuxLandlockAbiSync(): number {
  const implementation = linux ? native().landlockAbi : undefined
  if (typeof implementation !== 'function')
    throw Object.assign(new Error('Linux Landlock diagnostic is unavailable; rebuild the native artifact'), {
      code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
    })
  return implementation()
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
    (!windows && /\p{Surrogate}/u.test(path)) ||
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
  syncFileWith(path, fsyncSync)
}
function syncFileWith(path: string, flush: (fd: number) => void): void {
  const target = filePath(path)
  const fd = openSync(target, windows ? 'r+' : 'r')
  try {
    if (!fstatSync(fd).isFile())
      throw Object.assign(new Error('File synchronization requires a regular file'), { code: 'EISDIR' })
    flush(fd)
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

/**
 * Publishes one small record so that, once this returns, both its content and its directory entry
 * are durable: a private temporary in the same directory is flushed, then linked (never replacing)
 * or renamed over the destination, then the parent directory is flushed. Returns false only when
 * `replace` is not set and the destination already exists.
 *
 * A process crash at any point leaves the previous file or the complete new one, never a torn file;
 * unreferenced `*.tmp` leftovers are inert. A power loss before this returns may keep either state.
 * Records that depend on one another (an intent written before the pin it announces, a pin written
 * before the head that names its generation) get their order from sequencing the calls: each one is
 * durable before the next starts, so after power loss a later record never exists without the
 * earlier one it depends on.
 */
export function publishFileDurablySync(
  path: string,
  bytes: string,
  options: { replace?: boolean; mode?: number } = {},
): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { mode: options.mode ?? 0o600, flag: 'wx', flush: true })
    if (options.replace) replacePublishedFileSync(temporary, path, windows)
    else
      try {
        linkSync(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
  } finally {
    rmSync(temporary, { force: true })
  }
  syncDirectorySync(dirname(resolve(path)))
  return true
}

const durableEntries = new Set<string>()

/**
 * Creates the directories between `through` (exclusive) and `path` and makes each directory entry
 * durable, so a record later published inside `path` cannot outlive the path leading to it. `through`
 * must already exist and is never created: a caller that holds a directory open as its anchor learns
 * by ENOENT that the anchor was removed, instead of resurrecting it. Every level's parent is flushed
 * the first time this process sees it, also when the level already existed, because a previous
 * process may have stopped between its mkdir and its flush.
 */
export function mkdirDurablySync(path: string, through: string, mode = 0o700): void {
  const target = resolve(path),
    base = resolve(through),
    levels: string[] = []
  for (let level = target; level !== base; level = dirname(level)) {
    if (level === dirname(level)) throw new Error(`${path} is not inside ${through}`)
    levels.unshift(level)
  }
  for (const level of levels) {
    let created = true
    try {
      mkdirSync(filePath(level), { mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      created = false
    }
    if (created || !durableEntries.has(level)) {
      syncDirectorySync(dirname(level))
      durableEntries.add(level)
    }
  }
}

/** Flushes every file and directory under `root` (and `root` itself), children before parents. */
export function syncTreeSync(root: string): void {
  for (const entry of readdirSync(filePath(root), { withFileTypes: true })) {
    const child = join(root, entry.name)
    if (entry.isDirectory()) syncTreeSync(child)
    else if (entry.isFile()) syncFileSync(child)
  }
  syncDirectorySync(root)
}

let plainFlush: Native['syncDescriptor'] | null | undefined
/** The macOS native fsync that does not also drain the drive cache; null elsewhere or in an older artifact. */
function plainDescriptorFlush(): NonNullable<Native['syncDescriptor']> | null {
  if (plainFlush === undefined)
    try {
      plainFlush = darwin ? (native().syncDescriptor ?? null) : null
    } catch {
      plainFlush = null
    }
  return plainFlush
}

/**
 * `syncTreeSync` for each tree of one publication: the trees are durable when this returns. Node's fsync
 * on macOS drains the whole drive cache on every call, so there each entry gets a plain fsync and the
 * last root one full flush (see `syncTreeBatched`). Elsewhere, or with a native artifact lacking that
 * flush, this is `syncTreeSync` on each root, in order.
 */
export function syncTreeBatchedSync(...roots: string[]): void {
  const sync = plainDescriptorFlush()
  if (!sync) for (const root of roots) syncTreeSync(root)
  else
    syncTreeBatched(roots.map(filePath), (path, directory, full) =>
      (directory ? syncDirectoryWith : syncFileWith)(path, (fd) => sync(fd, full)),
    )
}

/** Removes one file and flushes the parent directory so the removal survives power loss. A missing file or directory is success. */
export function removeFileDurablySync(path: string): void {
  rmSync(path, { force: true })
  try {
    syncDirectorySync(dirname(resolve(path)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
  syncDirectoryWith(path, fsyncSync)
}
function syncDirectoryWith(path: string, flush: (fd: number) => void): void {
  const fd = openSync(filePath(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    flush(fd)
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

/** Every component must be real. Refuse when the native boundary is unavailable; never fall back. */
export function openCanonicalFileSync(path: string): number {
  const implementation = native().openCanonicalFile
  if (!implementation)
    throw Object.assign(new Error('Safe canonical open is unavailable'), { code: 'ENOSYS' })
  return implementation(filePath(path))
}
/** Bounded directory enumeration through a no-follow descriptor, capped at 5,001 names. */
export function listCanonicalDirectorySync(path: string): string[] {
  const implementation = native().listCanonicalDirectory
  if (!implementation)
    throw Object.assign(new Error('Safe canonical list is unavailable'), { code: 'ENOSYS' })
  return implementation(filePath(path))
}

/** Open without truncating; callers write and close this descriptor, never reopen the path. */
export function openCanonicalWritableFileSync(path: string, exclusive = false): number {
  const implementation = exclusive ? native().openCanonicalExclusiveFile : native().openCanonicalWritableFile
  if (!implementation)
    throw Object.assign(new Error('Safe canonical write is unavailable'), { code: 'ENOSYS' })
  return implementation(filePath(path))
}
export type CanonicalFsStat = {
  kind: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  linkTarget?: string
}
export function canonicalFs(operation: 'stat', path: string): Promise<CanonicalFsStat>
export function canonicalFs(
  operation: 'list',
  path: string,
): Promise<{ name: string; kind: CanonicalFsStat['kind'] }[]>
export function canonicalFs(operation: 'readlink' | 'finalPath', path: string): Promise<string>
export function canonicalFs(operation: 'mkdir' | 'rm', path: string, recursive?: boolean): Promise<void>
/** Async no-follow operations anchored to real directory handles; unavailable natives fail closed. */
export function canonicalFs(operation: string, path: string, recursive = false): Promise<unknown> {
  const implementation = native().canonicalFs
  if (!implementation)
    throw Object.assign(new Error('Safe canonical filesystem is unavailable'), { code: 'ENOSYS' })
  return implementation(operation, filePath(path), recursive, 0o777)
}
