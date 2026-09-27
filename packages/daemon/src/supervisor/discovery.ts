import { randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProcessIdentity } from '@agnes/host'
import { defaultProcessIdentity } from '@agnes/host'
import {
  createPrivateFileSync,
  renameWriteThroughSync,
  windowsEnsurePrivateDirectorySync,
  windowsProtectPrivateDirectorySync,
  windowsReadPrivateFileSync,
} from '@agnes/system-node'
import type { Owner } from './owner-record.js'
import { readOwner } from './owner-record.js'
import type { DaemonScope } from './scope.js'

const windows = process.platform === 'win32' // guards-allow-platform: Windows private file validation and publication.

export type DaemonDiscoveryWeb = Readonly<{
  url: string
  origin: string
}>

/** Public, nonsecret information needed by local SDK/Web launchers. */
export type DaemonDiscovery = Readonly<{
  protocol: 'agnesd-discovery'
  version: 1
  capabilities: readonly string[]
  scopeID: string
  profile: string
  profileHash: string
  dataDir: string
  socketPath: string
  owner: Pick<Owner, 'pid' | 'processStartId' | 'generation' | 'startedAt'>
  ready: true
  web?: DaemonDiscoveryWeb
}>

type WebCredentialFile = {
  protocol: 'agnesd-web-credential'
  version: 1
  scopeID: string
  generation: string
  token: string
}

export class DaemonDiscoveryError extends Error {
  override name = 'DaemonDiscoveryError'
}

export type DaemonDiscoveryReadOptions = {
  processIdentity?: (pid: number) => Promise<ProcessIdentity>
  identityTimeoutMs?: number
  expectedWeb?: DaemonDiscoveryWeb
}

export type DaemonWebCredentialReadOptions = Pick<
  DaemonDiscoveryReadOptions,
  'processIdentity' | 'identityTimeoutMs'
> & {
  expectedGeneration?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key)
}

function text(value: unknown, max = 2048): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function webShape(value: unknown): value is DaemonDiscoveryWeb {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['url', 'origin']) ||
    !text(value.url, 2048) ||
    !text(value.origin, 2048)
  )
    return false
  try {
    const url = new URL(value.url)
    const origin = new URL(value.origin)
    const authority = /^ws:\/\/([^/?#]+)(?:\/)?$/u.exec(value.url)?.[1]
    return (
      authority === url.host &&
      url.protocol === 'ws:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.port !== '' &&
      Number(url.port) > 0 &&
      Number(url.port) <= 65_535 &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      origin.protocol === 'http:' &&
      origin.origin === value.origin &&
      ['127.0.0.1', '[::1]'].includes(origin.hostname) &&
      origin.port !== '' &&
      Number(origin.port) > 0 &&
      Number(origin.port) <= 65_535 &&
      origin.username === '' &&
      origin.password === '' &&
      origin.pathname === '/' &&
      origin.search === '' &&
      origin.hash === ''
    )
  } catch {
    return false
  }
}

function sameOwner(owner: Owner, candidate: DaemonDiscovery['owner']): boolean {
  return (
    owner.pid === candidate.pid &&
    owner.processStartId === candidate.processStartId &&
    owner.generation === candidate.generation &&
    owner.startedAt === candidate.startedAt
  )
}

async function identity(
  pid: number,
  query: (pid: number) => Promise<ProcessIdentity>,
  timeoutMs: number,
): Promise<ProcessIdentity> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => query(pid)),
      new Promise<ProcessIdentity>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unknown', reason: 'identity deadline' }), timeoutMs)
        timer.unref()
      }),
    ])
  } catch {
    return { state: 'unknown', reason: 'identity query failed' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readJsonFile(path: string, maxBytes: number, mode: number): Promise<unknown | undefined> {
  if (windows) {
    for (let attempt = 0; ; attempt++) {
      try {
        windowsProtectPrivateDirectorySync(dirname(path))
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(windowsReadPrivateFileSync(path, maxBytes)),
        ) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EBUSY' && attempt < 40) {
          // Concurrent launchers can briefly hold an exclusive Windows directory validation handle.
          await new Promise((done) => setTimeout(done, 25))
          continue
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
      }
    }
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o777) !== mode)
      throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
    const bytes = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > maxBytes)
      throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)),
      ) as unknown
    } catch {
      throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function parseDiscovery(value: unknown): DaemonDiscovery {
  if (!isRecord(value)) throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  const keys = [
    'protocol',
    'version',
    'capabilities',
    'scopeID',
    'profile',
    'profileHash',
    'dataDir',
    'socketPath',
    'owner',
    'ready',
  ]
  if (!exactKeys(value, keys) && !exactKeys(value, [...keys, 'web']))
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  if (value.protocol !== 'agnesd-discovery' || value.version !== 1 || value.ready !== true)
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((v) => text(v, 64)))
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  if (
    !text(value.scopeID, 128) ||
    !text(value.profile, 128) ||
    !text(value.profileHash, 256) ||
    !text(value.dataDir, 4096) ||
    !text(value.socketPath, 4096)
  )
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  if (!isRecord(value.owner) || !exactKeys(value.owner, ['pid', 'processStartId', 'generation', 'startedAt']))
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  const owner = value.owner
  if (
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !text(owner.processStartId, 256) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(String(owner.generation)) ||
    !text(owner.startedAt, 64)
  )
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  if (value.web !== undefined && !webShape(value.web))
    throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  const capabilities = value.capabilities
  const validCapabilities =
    (capabilities.length === 1 && capabilities[0] === 'unix' && value.web === undefined) ||
    (capabilities.length === 2 &&
      capabilities[0] === 'unix' &&
      capabilities[1] === 'local-web' &&
      value.web !== undefined)
  if (!validCapabilities) throw new DaemonDiscoveryError('daemon discovery file is unavailable or invalid')
  return value as unknown as DaemonDiscovery
}

function parseCredential(value: unknown): WebCredentialFile {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['protocol', 'version', 'scopeID', 'generation', 'token']) ||
    value.protocol !== 'agnesd-web-credential' ||
    value.version !== 1 ||
    !text(value.scopeID, 128) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(String(value.generation)) ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(String(value.token))
  )
    throw new DaemonDiscoveryError('daemon Web credential is unavailable or invalid')
  return value as WebCredentialFile
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const parent = dirname(path)
  if (windows) windowsEnsurePrivateDirectorySync(parent)
  else await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (windows) {
      const fd = createPrivateFileSync(temporary)
      try {
        writeFileSync(fd, contents, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameWriteThroughSync(temporary, path)
      return
    }
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

/** Read and validate a ready descriptor; absent is distinct from corrupt or stale. */
export async function readDaemonDiscovery(
  scope: DaemonScope,
  options: DaemonDiscoveryReadOptions = {},
): Promise<DaemonDiscovery | null> {
  const owner = await readOwner(scope.dataDir)
  if (!owner) return null
  const descriptor = await readJsonFile(scope.discoveryPath, 64 * 1024, 0o600)
  if (descriptor === undefined) return null
  const parsed = parseDiscovery(descriptor)
  // Owner replacement is the normal crash/restart path. A previous generation's valid descriptor
  // may survive until the new daemon publishes its ready record; it is stale, not a scope conflict.
  // Scope mismatches are refused only when the descriptor belongs to the current owner generation.
  if (!sameOwner(owner, parsed.owner)) return null
  if (
    parsed.scopeID !== scope.scopeID ||
    parsed.profile !== scope.profile ||
    parsed.dataDir !== scope.dataDir ||
    parsed.socketPath !== owner.socketPath ||
    (options.expectedWeb !== undefined &&
      (parsed.web === undefined ||
        parsed.web.url !== options.expectedWeb.url ||
        parsed.web.origin !== options.expectedWeb.origin))
  )
    throw new DaemonDiscoveryError('daemon discovery does not match the selected scope')
  const found = await identity(
    owner.pid,
    options.processIdentity ?? defaultProcessIdentity,
    options.identityTimeoutMs ?? 1000,
  )
  if (found.state === 'dead') return null
  if (found.state !== 'alive')
    throw new DaemonDiscoveryError('daemon discovery owner identity is unavailable')
  if (found.startId !== owner.processStartId) return null
  return parsed
}

/** Publish endpoint metadata and, separately, the local Web bearer after all listeners are ready. */
export async function publishDaemonDiscovery(
  scope: DaemonScope,
  input: {
    owner: Owner
    socketPath: string
    profileHash: string
    web?: DaemonDiscoveryWeb & { token: string }
  },
): Promise<DaemonDiscovery> {
  const current = await readOwner(scope.dataDir)
  if (!current || !sameOwner(current, input.owner))
    throw new DaemonDiscoveryError('cannot publish discovery for a non-current owner')
  if (input.socketPath !== current.socketPath || input.owner.socketPath !== input.socketPath)
    throw new DaemonDiscoveryError('cannot publish discovery for a mismatched socket')
  if (!text(input.profileHash, 256))
    throw new DaemonDiscoveryError('cannot publish discovery without profile hash')
  if (
    input.web !== undefined &&
    (!webShape({ url: input.web.url, origin: input.web.origin }) ||
      !/^[A-Za-z0-9_-]{32,256}$/u.test(input.web.token))
  )
    throw new DaemonDiscoveryError('cannot publish an invalid local Web endpoint')
  const descriptor: DaemonDiscovery = {
    protocol: 'agnesd-discovery',
    version: 1,
    capabilities: input.web ? ['unix', 'local-web'] : ['unix'],
    scopeID: scope.scopeID,
    profile: scope.profile,
    profileHash: input.profileHash,
    dataDir: scope.dataDir,
    socketPath: input.socketPath,
    owner: {
      pid: input.owner.pid,
      processStartId: input.owner.processStartId,
      generation: input.owner.generation,
      startedAt: input.owner.startedAt,
    },
    ready: true,
    ...(input.web ? { web: { url: input.web.url, origin: input.web.origin } } : {}),
  }
  if (input.web) {
    const credential: WebCredentialFile = {
      protocol: 'agnesd-web-credential',
      version: 1,
      scopeID: scope.scopeID,
      generation: input.owner.generation,
      token: input.web.token,
    }
    await atomicWrite(scope.webCredentialPath, JSON.stringify(credential))
  } else {
    await unlink(scope.webCredentialPath).catch((error) => {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
      throw error
    })
  }
  try {
    await atomicWrite(scope.discoveryPath, JSON.stringify(descriptor))
  } catch (error) {
    await unlink(scope.webCredentialPath).catch(() => undefined)
    throw error
  }
  return descriptor
}

/** Read the private Web bearer after validating scope, owner generation and strict file permissions. */
export async function readDaemonWebCredential(
  scope: DaemonScope,
  expectedGenerationOrOptions?: string | DaemonWebCredentialReadOptions,
): Promise<string | null> {
  const readOptions: DaemonDiscoveryReadOptions =
    typeof expectedGenerationOrOptions === 'string' || expectedGenerationOrOptions === undefined
      ? {}
      : expectedGenerationOrOptions
  const descriptor = await readDaemonDiscovery(scope, readOptions)
  if (!descriptor?.web) return null
  const value = await readJsonFile(scope.webCredentialPath, 16 * 1024, 0o600)
  if (value === undefined) throw new DaemonDiscoveryError('daemon Web credential is unavailable or invalid')
  const credential = parseCredential(value)
  const generation =
    typeof expectedGenerationOrOptions === 'string'
      ? expectedGenerationOrOptions
      : (expectedGenerationOrOptions?.expectedGeneration ?? descriptor.owner.generation)
  if (
    credential.scopeID !== scope.scopeID ||
    credential.generation !== generation ||
    credential.generation !== descriptor.owner.generation
  )
    throw new DaemonDiscoveryError('daemon Web credential does not match the current owner')
  return credential.token
}

/** Remove only records belonging to the supplied owner generation; stale cleanup cannot erase a new daemon. */
export async function removeDaemonDiscovery(scope: DaemonScope, generation: string): Promise<void> {
  let descriptor: unknown | undefined
  try {
    descriptor = await readJsonFile(scope.discoveryPath, 64 * 1024, 0o600)
  } catch {
    // A malformed or wrong-mode descriptor cannot establish ownership of the generation being
    // removed. Preserve it for diagnosis and fail closed.
    return
  }
  let matchedGeneration = false
  if (descriptor !== undefined) {
    let parsed: DaemonDiscovery
    try {
      parsed = parseDiscovery(descriptor)
    } catch {
      return
    }
    if (parsed.owner.generation !== generation) return
    matchedGeneration = true
  }

  let credential: unknown | undefined
  try {
    credential = await readJsonFile(scope.webCredentialPath, 16 * 1024, 0o600)
  } catch {
    // As above, an unreadable credential cannot be proven to belong to this generation.
    return
  }
  if (credential !== undefined) {
    let parsed: WebCredentialFile
    try {
      parsed = parseCredential(credential)
    } catch {
      return
    }
    if (parsed.generation !== generation) return
    matchedGeneration = true
  }
  if (!matchedGeneration) return
  await unlink(scope.discoveryPath).catch(() => undefined)
  await unlink(scope.webCredentialPath).catch(() => undefined)
}
