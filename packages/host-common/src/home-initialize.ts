import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createPrivateFileSync, hasPrivateDaclSync, renameWriteThroughSync } from '@agnes/system-node'
import { withConfigurationLock } from './configuration-lock.js'
import { HOME_LAYOUT_VERSION, homeVersionFault, inspectHome } from './home-layout.js'
import { createHomeDirectory, prepareHomeLock, prepareWindowsHomeDirectories } from './home-private.js'
import {
  ensureLlmsgKey,
  hasLlmsgKey,
  LLMSG_KEY_FILE,
  type LlmsgKeyEnvironment,
  llmsgFallbackKey,
} from './llmsg-home-key.js'

const MARKER = 'home-layout.json'
const LLMSG_PENDING_MARKER = '.llmsg-home-layout.pending'
const LLMSG_MARKER_PREFIX = `{"version":${HOME_LAYOUT_VERSION},"instanceId":"`
const windows = process.platform === 'win32' // guards-allow-platform: private Windows home initialization uses native ACLs.
const linux = process.platform === 'linux' // guards-allow-platform: LLMSG image bootstrap is Linux-only.
/** Windows daemon startup also validates its explicitly resolved data directory before any writes. */
type InitializeOptions = { dataDir?: string }
type LlmsgBootstrap = { env: LlmsgKeyEnvironment; phase: 'layout' | 'persist-key' }
const homeFault = (code: string) => Object.assign(new Error(code), { code })
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Create only missing directories; never silently repairs permissions on an existing home. */
function directory(path: string, boundary?: string): void {
  if (boundary && path !== boundary) directory(dirname(path), boundary)
  if (present(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw homeFault('E_HOME_UNSAFE')
    return
  }
  if (!present(dirname(path))) directory(dirname(path))
  mkdirSync(path, { mode: 0o700 })
}

function discardInterruptedLlmsgMarker(path: string): void {
  if (!present(path)) return
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 || !hasPrivateDaclSync(path))
    throw homeFault('E_HOME_UNSAFE')
  const bytes = readFileSync(path, 'utf8')
  // A crash during the write can leave a prefix of the marker. Leave other content untouched.
  if (
    !LLMSG_MARKER_PREFIX.startsWith(bytes) &&
    !(
      bytes.startsWith(LLMSG_MARKER_PREFIX) &&
      /^[0-9a-f-]{0,36}(?:"(?:\}\n?)?)?$/u.test(bytes.slice(LLMSG_MARKER_PREFIX.length))
    )
  )
    throw homeFault('E_HOME_UNSAFE')
  unlinkSync(path)
}

function publishMarker(home: string, llmsg = false): void {
  const temporary = join(home, llmsg ? LLMSG_PENDING_MARKER : `.home-layout-${randomUUID()}.tmp`)
  const bytes = `${JSON.stringify({ version: HOME_LAYOUT_VERSION, instanceId: randomUUID() })}\n`
  if (llmsg) {
    discardInterruptedLlmsgMarker(temporary)
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
    renameWriteThroughSync(temporary, join(home, MARKER))
    return
  }
  if (!windows) {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(home, MARKER))
    return
  }
  const fd = createPrivateFileSync(temporary)
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWriteThroughSync(temporary, join(home, MARKER))
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      /* Preserve the publication failure. */
    }
    throw error
  }
}
export function initializeHome(home: string, profile = 'local-dev', options: InitializeOptions = {}) {
  const info = inspectHome(home, profile)
  if (info.state === 'unsupported') throw homeVersionFault(home, 'unversioned')
  // PackageManager remains the only writer of the live package store.
  const paths = Object.values(info.paths).filter((path) => path !== info.paths.packages)
  if (windows) {
    prepareWindowsHomeDirectories(
      home,
      [...paths, ...(options.dataDir ? [resolve(options.dataDir)] : [])],
      info.version !== null ? join(home, MARKER) : undefined,
    )
  } else {
    directory(home)
    for (const path of paths) directory(path, resolve(home))
  }
  if (info.version === null) publishMarker(home)
  return inspectHome(home, profile)
}

/** Serialize process startup before the marker and private directories are published. */
export async function initializeHomeLocked(
  home: string,
  profile = 'local-dev',
  options: InitializeOptions = {},
) {
  return initializeWithLock(home, profile, options)
}

/** LLMSG's Linux entrypoint prepares the layout before installation and persists the fallback after it. */
export async function initializeLlmsgHomeLocked(
  home: string,
  profile: string,
  env: LlmsgKeyEnvironment,
  phase: LlmsgBootstrap['phase'] = 'layout',
) {
  if (!linux) throw homeFault('E_HOME_UNSAFE')
  const deadline = performance.now() + 1_000
  for (;;) {
    try {
      return await initializeWithLock(home, profile, {}, { env, phase })
    } catch (error) {
      if (
        phase !== 'layout' ||
        performance.now() >= deadline ||
        !(
          error instanceof Error &&
          'code' in error &&
          error.code === 'E_HOME_VERSION' &&
          'reason' in error &&
          error.reason === 'unversioned'
        ) ||
        !lstatSync(join(home, LLMSG_KEY_FILE), { throwIfNoEntry: false })?.isFile()
      )
        throw error
      // A provider rotation may have a second directory entry until its atomic rename completes.
      // Reinspect under the lock on each attempt; the layout's accepted contents stay the same.
      await delay(100)
    }
  }
}

function tightenAcceptedLlmsgHome(home: string): void {
  if (!present(home)) {
    directory(home)
    return
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)
  let fd: number
  try {
    fd = openSync(home, flags)
  } catch {
    throw homeFault('E_HOME_UNSAFE')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isDirectory()) throw homeFault('E_HOME_UNSAFE')
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw homeFault('E_HOME_UNSAFE')
    if ((stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700)
  } finally {
    closeSync(fd)
  }
}

function llmsgBootstrapContents(home: string): boolean {
  return readdirSync(home).every((name) => name === LLMSG_KEY_FILE || name === LLMSG_PENDING_MARKER)
}

async function initializeWithLock(
  home: string,
  profile: string,
  options: InitializeOptions,
  llmsg?: LlmsgBootstrap,
) {
  const initial = inspectHome(home, profile)
  const canonicalHome = resolve(home)
  const lock = join(dirname(canonicalHome), `.${basename(canonicalHome)}.initialize.sqlite`)
  if (llmsg && llmsg.phase === 'persist-key' && initial.state !== 'current' && !present(lock))
    throw homeVersionFault(home, 'unversioned')
  // An existing initializer may have created directories without publishing its marker yet.
  // Wait for that lock and inspect again; unknown homes without a lock remain untouched.
  if (initial.state === 'unsupported' && !present(lock) && !(llmsg && llmsgBootstrapContents(canonicalHome)))
    throw homeVersionFault(home, 'unversioned')
  // Keep the lock outside a fresh home so inspection cannot mistake it for unknown user data.
  if (windows) createHomeDirectory(dirname(canonicalHome))
  else directory(dirname(canonicalHome))
  if (windows) prepareHomeLock(lock)
  return withConfigurationLock(lock, async () => {
    if (!llmsg) return initializeHome(canonicalHome, profile, options)
    const info = inspectHome(canonicalHome, profile)
    if (llmsg.phase === 'persist-key' && info.state !== 'current')
      throw homeVersionFault(canonicalHome, 'unversioned')
    if (info.state === 'unsupported' && !llmsgBootstrapContents(canonicalHome))
      throw homeVersionFault(canonicalHome, 'unversioned')
    if (llmsg.phase === 'layout' && !hasLlmsgKey(canonicalHome)) llmsgFallbackKey(llmsg.env)
    tightenAcceptedLlmsgHome(canonicalHome)
    if (!hasPrivateDaclSync(canonicalHome)) throw homeFault('E_HOME_UNSAFE')
    if (info.state !== 'current') {
      // Publish before creating Core directories: a killed initializer can retry either side of the rename.
      if (!llmsgBootstrapContents(canonicalHome)) throw homeVersionFault(canonicalHome, 'unversioned')
      publishMarker(canonicalHome, true)
    }
    const initialized = initializeHome(canonicalHome, profile)
    if (llmsg.phase === 'persist-key') ensureLlmsgKey(canonicalHome, initialized.paths.credentials, llmsg.env)
    return initialized
  })
}
