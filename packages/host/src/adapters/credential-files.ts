import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  createPrivateFileSync,
  hasPrivateDaclSync,
  renameWriteThroughSync,
  syncDirectorySync,
  windowsEnsurePrivateDirectorySync,
  windowsPrivateFilesAvailable,
  windowsReadPrivateFileSync,
  windowsReadPrivateTextSync,
} from '@agnes/system-node'
import type { PlatformBackend } from './platform.js'

export type CredentialKind = 'api-key' | 'oauth'
export type CredentialStoreReason =
  | 'bad-ref'
  | 'enforcement-unavailable'
  | 'io'
  | 'symlink'
  | 'not-directory'
  | 'not-file'
  | 'mode'
  | 'owner'
  | 'link-count'
  | 'changed'
  | 'too-large'
  | 'invalid-json'
  | 'schema'
  | 'kind-conflict'

export type CredentialFileEnforcement =
  | { level: 'full'; mechanism: 'windows-acl' }
  | {
      level: 'full'
      mechanism: 'posix-mode-owner'
      ownerUid: number
    }
  | {
      level: 'unavailable'
      mechanism: 'posix-mode-owner' | 'windows-acl'
      reason: string
    }

/**
 * Turns the selected platform adapter into an explicit answer about private-file enforcement.
 * Credential code uses the selected backend; Windows requires the complete native ACL implementation.
 */
export function credentialFileEnforcement(platform: Pick<PlatformBackend, 'os'>): CredentialFileEnforcement {
  if (platform.os === 'win32')
    return windowsPrivateFilesAvailable()
      ? { level: 'full', mechanism: 'windows-acl' }
      : {
          level: 'unavailable',
          mechanism: 'windows-acl',
          reason: 'private credential ACL enforcement is unavailable',
        }
  const getuid = process.getuid
  if (getuid === undefined)
    return {
      level: 'unavailable',
      mechanism: 'posix-mode-owner',
      reason: 'credential owner enforcement is unavailable',
    }
  return { level: 'full', mechanism: 'posix-mode-owner', ownerUid: getuid() }
}

export class CredentialStoreError extends Error {
  readonly code = 'CREDENTIAL_STORE_UNSAFE' as const
  readonly ref: string
  readonly reason: CredentialStoreReason

  constructor(ref: string, reason: CredentialStoreReason) {
    // The path, OS error and file content are deliberately absent. `ref` and `reason` are exposed
    // as structured fields; the message contains only the stable code and stable reason.
    super(`CREDENTIAL_STORE_UNSAFE: ${reason}`)
    this.name = 'CredentialStoreError'
    this.ref = ref
    this.reason = reason
  }
}

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/
const CONTROL = /\p{Cc}/u
const MAX_CREDENTIAL_BYTES = 1024 * 1024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const DIRECTORY = constants.O_DIRECTORY ?? 0

const storeError = (ref: string, reason: CredentialStoreReason): CredentialStoreError =>
  new CredentialStoreError(ref, reason)

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined

export function parseCredentialRef(ref: string): { provider: string; name: string } {
  const badRef = (): never => {
    // An invalid "ref" may actually be a key pasted into the wrong field. Do not reflect it into
    // an error object before it has passed the credential-ref grammar.
    throw storeError('<invalid>', 'bad-ref')
  }
  if (CONTROL.test(ref)) return badRef()
  const prefix = 'secret://'
  if (!ref.startsWith(prefix)) return badRef()
  const rest = ref.slice(prefix.length)
  const parts = rest.split('/')
  if (parts.length !== 2) return badRef()
  const [provider, name] = parts
  if (provider === undefined || name === undefined || !PROVIDER.test(provider) || !NAME.test(name))
    return badRef()
  if (provider === '.' || provider === '..' || name === '.' || name === '..') return badRef()
  return { provider, name }
}

export function resolveCredentialFile(root: string, ref: string, kind: CredentialKind): string {
  const { provider, name } = parseCredentialRef(ref)
  const anchoredRoot = resolve(root)
  return kind === 'api-key'
    ? join(anchoredRoot, 'secrets', provider, name)
    : join(anchoredRoot, 'auth', provider, `${name}.json`)
}

function requireEnforcement(
  ref: string,
  enforcement: CredentialFileEnforcement,
): asserts enforcement is Extract<CredentialFileEnforcement, { level: 'full' }> {
  if (enforcement.level !== 'full') throw storeError(ref, 'enforcement-unavailable')
}

type FileStat = Awaited<ReturnType<typeof lstat>>

function validateWindowsPermissions(path: string, ref: string): void {
  try {
    if (!hasPrivateDaclSync(path)) throw storeError(ref, 'mode')
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error
    throw storeError(ref, 'io')
  }
}

function validateDirectory(
  stat: FileStat,
  ref: string,
  enforcement: Extract<CredentialFileEnforcement, { level: 'full' }>,
  path: string,
): void {
  if (stat.isSymbolicLink()) throw storeError(ref, 'symlink')
  if (!stat.isDirectory()) throw storeError(ref, 'not-directory')
  if (enforcement.mechanism === 'windows-acl') {
    validateWindowsPermissions(path, ref)
    return
  }
  if ((Number(stat.mode) & 0o7777) !== 0o700) throw storeError(ref, 'mode')
  if (Number(stat.uid) !== enforcement.ownerUid) throw storeError(ref, 'owner')
}

function validateFile(
  stat: FileStat,
  ref: string,
  enforcement: Extract<CredentialFileEnforcement, { level: 'full' }>,
): void {
  if (stat.isSymbolicLink()) throw storeError(ref, 'symlink')
  if (!stat.isFile()) throw storeError(ref, 'not-file')
  if (enforcement.mechanism === 'posix-mode-owner') {
    if ((Number(stat.mode) & 0o7777) !== 0o600) throw storeError(ref, 'mode')
    if (Number(stat.uid) !== enforcement.ownerUid) throw storeError(ref, 'owner')
  }
  if (Number(stat.nlink) !== 1) throw storeError(ref, 'link-count')
  if (Number(stat.size) > MAX_CREDENTIAL_BYTES) throw storeError(ref, 'too-large')
}

async function safeLstat(path: string, ref: string): Promise<FileStat | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw storeError(ref, 'io')
  }
}

async function checkDirectory(
  path: string,
  ref: string,
  enforcement: Extract<CredentialFileEnforcement, { level: 'full' }>,
): Promise<boolean> {
  const stat = await safeLstat(path, ref)
  if (stat === null) return false
  validateDirectory(stat, ref, enforcement, path)
  return true
}

async function createDirectory(
  path: string,
  ref: string,
  enforcement: Extract<CredentialFileEnforcement, { level: 'full' }>,
): Promise<void> {
  let created = false
  if (enforcement.mechanism === 'windows-acl') {
    try {
      windowsEnsurePrivateDirectorySync(path)
      const stat = await safeLstat(path, ref)
      if (!stat) throw storeError(ref, 'changed')
      validateDirectory(stat, ref, enforcement, path)
      return
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error
      throw storeError(ref, 'io')
    }
  }
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw storeError(ref, 'io')
  }
  if (created)
    try {
      await chmod(path, 0o700)
    } catch {
      throw storeError(ref, 'io')
    }
  const stat = await safeLstat(path, ref)
  if (stat === null) throw storeError(ref, 'changed')
  validateDirectory(stat, ref, enforcement, path)
}

async function ensureCredentialDirectories(
  root: string,
  provider: string,
  kind: CredentialKind,
  ref: string,
  enforcement: Extract<CredentialFileEnforcement, { level: 'full' }>,
): Promise<void> {
  const anchoredRoot = resolve(root)
  await createDirectory(anchoredRoot, ref, enforcement)
  for (const base of ['auth', 'secrets', 'locks'])
    await createDirectory(join(anchoredRoot, base), ref, enforcement)
  await createDirectory(
    join(anchoredRoot, kind === 'api-key' ? 'secrets' : 'auth', provider),
    ref,
    enforcement,
  )
}

async function checkCredentialParents(
  root: string,
  provider: string,
  kind: CredentialKind,
  ref: string,
  enforcement: Extract<CredentialFileEnforcement, { level: 'full' }>,
): Promise<boolean> {
  const anchoredRoot = resolve(root)
  for (const path of [
    anchoredRoot,
    join(anchoredRoot, kind === 'api-key' ? 'secrets' : 'auth'),
    join(anchoredRoot, kind === 'api-key' ? 'secrets' : 'auth', provider),
  ])
    if (!(await checkDirectory(path, ref, enforcement))) return false
  return true
}

export async function prepareCredentialWrite(
  root: string,
  ref: string,
  kind: CredentialKind,
  enforcement: CredentialFileEnforcement,
): Promise<void> {
  if (enforcement.level !== 'full') return
  const { provider } = parseCredentialRef(ref)
  await ensureCredentialDirectories(root, provider, kind, ref, enforcement)
}

async function checkedFileStat(
  path: string,
  ref: string,
  enforcement: Extract<CredentialFileEnforcement, { level: 'full' }>,
): Promise<FileStat | null> {
  // A concurrent atomic rename can leave an already-resolved old inode at nlink=0 for the instant
  // lstat returns. That is neither a hard link nor a safe snapshot; retry the name and validate the
  // inode currently installed there. A real hard link has nlink>1 and is still refused immediately.
  for (let attempt = 0; attempt < 64; attempt++) {
    const stat = await safeLstat(path, ref)
    if (stat === null) return null
    if (Number(stat.nlink) === 0) {
      await new Promise<void>((done) => setImmediate(done))
      continue
    }
    validateFile(stat, ref, enforcement)
    if (enforcement.mechanism === 'windows-acl') validateWindowsPermissions(path, ref)
    return stat
  }
  throw storeError(ref, 'changed')
}

export async function readCredentialFile(options: {
  root: string
  ref: string
  kind: CredentialKind
  enforcement: CredentialFileEnforcement
}): Promise<string | null> {
  const { provider } = parseCredentialRef(options.ref)
  requireEnforcement(options.ref, options.enforcement)
  if (!(await checkCredentialParents(options.root, provider, options.kind, options.ref, options.enforcement)))
    return null
  const path = resolveCredentialFile(options.root, options.ref, options.kind)
  const before = await checkedFileStat(path, options.ref, options.enforcement)
  if (before === null) return null

  if (options.enforcement.mechanism === 'windows-acl') {
    try {
      return windowsReadPrivateTextSync(path, MAX_CREDENTIAL_BYTES)
    } catch {
      throw storeError(options.ref, 'io')
    }
  }

  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW)
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw storeError(options.ref, 'symlink')
    throw storeError(options.ref, 'io')
  }
  try {
    const after = await handle.stat()
    if (Number(after.nlink) === 0) throw storeError(options.ref, 'changed')
    validateFile(after, options.ref, options.enforcement)
    if (before.dev !== after.dev || before.ino !== after.ino) throw storeError(options.ref, 'changed')
    return await handle.readFile('utf8')
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error
    throw storeError(options.ref, 'io')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function syncDirectory(
  path: string,
  ref: string,
  enforcement: CredentialFileEnforcement,
): Promise<void> {
  if (enforcement.mechanism === 'windows-acl') {
    try {
      syncDirectorySync(path)
      return
    } catch {
      throw storeError(ref, 'io')
    }
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW)
  } catch {
    throw storeError(ref, 'io')
  }
  try {
    await handle.sync()
  } catch {
    throw storeError(ref, 'io')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function atomicWriteCredentialFile(options: {
  root: string
  ref: string
  kind: CredentialKind
  contents: string
  enforcement: CredentialFileEnforcement
}): Promise<void> {
  const { provider } = parseCredentialRef(options.ref)
  requireEnforcement(options.ref, options.enforcement)
  await ensureCredentialDirectories(options.root, provider, options.kind, options.ref, options.enforcement)
  const path = resolveCredentialFile(options.root, options.ref, options.kind)
  await checkedFileStat(path, options.ref, options.enforcement)

  const parent = dirname(path)
  const temp = join(parent, `.${provider}.tmp-${randomUUID()}`)
  if (options.enforcement.mechanism === 'windows-acl') {
    let fd: number | undefined
    try {
      fd = createPrivateFileSync(temp)
      writeFileSync(fd, options.contents, 'utf8')
      validateFile(fstatSync(fd), options.ref, options.enforcement)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      if (
        !windowsReadPrivateFileSync(temp, MAX_CREDENTIAL_BYTES).equals(Buffer.from(options.contents, 'utf8'))
      )
        throw storeError(options.ref, 'changed')
      renameWriteThroughSync(temp, path)
      return
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Preserve the original write failure if cleanup also fails.
        }
      }
      if (error instanceof CredentialStoreError) throw error
      throw storeError(options.ref, 'io')
    } finally {
      await unlink(temp).catch(() => undefined)
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    try {
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    } catch {
      throw storeError(options.ref, 'io')
    }
    await handle.chmod(0o600)
    await handle.writeFile(options.contents, 'utf8')
    await handle.sync()
    const stat = await handle.stat()
    validateFile(stat, options.ref, options.enforcement)
    await handle.close()
    handle = undefined
    try {
      await rename(temp, path)
    } catch {
      throw storeError(options.ref, 'io')
    }
    await syncDirectory(parent, options.ref, options.enforcement)
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error
    throw storeError(options.ref, 'io')
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
  }
}

export async function removeCredentialFile(options: {
  root: string
  ref: string
  kind: CredentialKind
  enforcement: CredentialFileEnforcement
}): Promise<boolean> {
  const { provider } = parseCredentialRef(options.ref)
  requireEnforcement(options.ref, options.enforcement)
  if (!(await checkCredentialParents(options.root, provider, options.kind, options.ref, options.enforcement)))
    return false
  const path = resolveCredentialFile(options.root, options.ref, options.kind)
  if ((await checkedFileStat(path, options.ref, options.enforcement)) === null) return false
  try {
    await unlink(path)
  } catch {
    throw storeError(options.ref, 'io')
  }
  await syncDirectory(dirname(path), options.ref, options.enforcement)
  return true
}
