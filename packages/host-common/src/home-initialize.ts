import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createPrivateFileSync, renameWriteThroughSync } from '@agnes/system-node'
import { withConfigurationLock } from './configuration-lock.js'
import { HOME_LAYOUT_VERSION, homeVersionFault, inspectHome } from './home-layout.js'
import { createHomeDirectory, prepareHomeLock, prepareWindowsHomeDirectories } from './home-private.js'

const MARKER = 'home-layout.json'
const windows = process.platform === 'win32' // guards-allow-platform: private Windows home initialization uses native ACLs.
/** Windows daemon startup also validates its explicitly resolved data directory before any writes. */
type InitializeOptions = { dataDir?: string }
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
function publishMarker(home: string): void {
  const temporary = join(home, `.home-layout-${randomUUID()}.tmp`)
  const bytes = `${JSON.stringify({ version: HOME_LAYOUT_VERSION, instanceId: randomUUID() })}\n`
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
  const initial = inspectHome(home, profile)
  const canonicalHome = resolve(home)
  const lock = join(dirname(canonicalHome), `.${basename(canonicalHome)}.initialize.sqlite`)
  // An existing initializer may have created directories without publishing its marker yet.
  // Wait for that lock and inspect again; unknown homes without a lock remain untouched.
  if (initial.state === 'unsupported' && !present(lock)) throw homeVersionFault(home, 'unversioned')
  // Keep the lock outside a fresh home so inspection cannot mistake it for unknown user data.
  if (windows) createHomeDirectory(dirname(canonicalHome))
  else directory(dirname(canonicalHome))
  if (windows) prepareHomeLock(lock)
  return withConfigurationLock(lock, async () => initializeHome(canonicalHome, profile, options))
}
