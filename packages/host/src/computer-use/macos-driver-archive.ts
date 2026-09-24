import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createPrivateDirectorySync, createPrivateFileSync, renameWriteThroughSync } from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseDriverLock } from './driver-lock.js'
import type { VerifiedMacOSComputerUseDriver } from './macos-driver-backend.js'
import {
  type MacOSDriverVerifierDependencies,
  verifyMacOSComputerUseDriver,
} from './macos-driver-verifier.js'

const execute = promisify(execFile)
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
const PATHS = Object.freeze([
  '',
  'cua-driver',
  'CuaDriver.app/',
  'cua_driver_node_runtime.node',
  'cua_driver_abi.h',
  'cua-cursor-theme',
  'libcua_driver_sdk.dylib',
  'CuaDriver.app/Contents/',
  'CuaDriver.app/Contents/CodeResources',
  'CuaDriver.app/Contents/_CodeSignature/',
  'CuaDriver.app/Contents/MacOS/',
  'CuaDriver.app/Contents/Resources/',
  'CuaDriver.app/Contents/embedded.provisionprofile',
  'CuaDriver.app/Contents/Info.plist',
  'CuaDriver.app/Contents/Resources/AppIcon.icns',
  'CuaDriver.app/Contents/MacOS/cua-driver',
  'CuaDriver.app/Contents/MacOS/cua-cursor-theme',
  'CuaDriver.app/Contents/_CodeSignature/CodeResources',
])
const EXECUTABLES = new Set([
  'cua-driver',
  'cua-cursor-theme',
  'cua_driver_node_runtime.node',
  'libcua_driver_sdk.dylib',
  'CuaDriver.app/Contents/MacOS/cua-driver',
  'CuaDriver.app/Contents/MacOS/cua-cursor-theme',
])

export type ExtractedMacOSComputerUseDriver = Readonly<{
  directory: string
  container: string
  verified: VerifiedMacOSComputerUseDriver
  release(): Promise<void>
}>

export type MacOSDriverArchiveDependencies = Readonly<{
  inspect?: (archive: string) => Promise<Readonly<{ names: readonly string[]; verbose: readonly string[] }>>
  extract?: (archive: string, destination: string) => Promise<void>
  verify?: (
    directory: string,
    lock: ComputerUseDriverLock,
    dependencies?: MacOSDriverVerifierDependencies,
  ) => Promise<VerifiedMacOSComputerUseDriver>
  verifierDependencies?: MacOSDriverVerifierDependencies
}>

function selectedArtifact(lock: ComputerUseDriverLock) {
  return lock.artifacts.find((artifact) => artifact.platform === 'darwin')
}

async function inspect(archive: string) {
  const options = { timeout: 20_000, maxBuffer: 128 * 1024, env: { PATH: '/usr/bin:/bin' } }
  const [names, verbose] = await Promise.all([
    execute('/usr/bin/tar', ['-tzf', archive], options),
    execute('/usr/bin/tar', ['-tvzf', archive], options),
  ])
  return {
    names: names.stdout.trimEnd().split(/\r?\n/u),
    verbose: verbose.stdout.trimEnd().split(/\r?\n/u),
  }
}

async function extract(archive: string, destination: string): Promise<void> {
  await execute(
    '/usr/bin/tar',
    ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'],
    { timeout: 60_000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin' } },
  )
}

function verifyListing(
  listing: Readonly<{ names: readonly string[]; verbose: readonly string[] }>,
  prefix: string,
): void {
  const expected = PATHS.map((path) => `${prefix}/${path}`)
  if (JSON.stringify(listing.names) !== JSON.stringify(expected))
    throw new Error('Computer Use macOS archive member paths differ from the lock')
  if (listing.verbose.length !== expected.length)
    throw new Error('Computer Use macOS archive verbose listing is incomplete')
  for (let index = 0; index < expected.length; index += 1) {
    const line = listing.verbose[index]
    const name = expected[index]
    const directory = name?.endsWith('/')
    if (!line || !name || !line.endsWith(name) || line[0] !== (directory ? 'd' : '-'))
      throw new Error('Computer Use macOS archive contains an unsafe member type')
  }
}

function hardenTree(root: string, relative = ''): number {
  const directory = join(root, ...relative.split('/').filter(Boolean))
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const name = relative ? `${relative}/${entry.name}` : entry.name
    const stat = lstatSync(path)
    // Directories acquire one link for themselves plus one for each child directory on macOS,
    // so their normal link count is greater than one. Only a regular file with extra links can
    // alias a writable payload outside the verified tree.
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      throw new Error('Computer Use macOS archive extracted an unsafe entry')
    if (stat.isDirectory()) {
      chmodSync(path, 0o700)
      total += hardenTree(root, name)
      if (total > MAX_EXPANDED_BYTES) throw new Error('Computer Use macOS archive exceeds expanded limit')
      if (createPlatform().os !== 'win32') {
        const fd = openSync(path, 'r')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }
      continue
    }
    total += stat.size
    if (total > MAX_EXPANDED_BYTES) throw new Error('Computer Use macOS archive exceeds expanded limit')
    chmodSync(path, EXECUTABLES.has(name) ? 0o700 : 0o600)
    if (createPlatform().os !== 'win32') {
      const fd = openSync(path, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
  }
  return total
}

/** Extracts the exact locked tarball into a private, fresh tree and verifies Apple signatures. */
export async function extractLockedMacOSComputerUseDriver(input: {
  archiveBytes: Uint8Array
  stagingParent: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: MacOSDriverArchiveDependencies
}): Promise<ExtractedMacOSComputerUseDriver> {
  if (createPlatform().os !== 'darwin' && !input.dependencies)
    throw new Error('macOS Computer Use driver extraction is unavailable on this platform')
  if (!isAbsolute(input.stagingParent) || resolve(input.stagingParent) !== input.stagingParent)
    throw new Error('Computer Use macOS archive requires a canonical staging root')
  input.signal?.throwIfAborted()
  const artifact = selectedArtifact(input.lock)
  if (!artifact) throw new Error('Computer Use lock has no macOS artifact')
  if (input.archiveBytes.byteLength !== artifact.size)
    throw new Error('Computer Use macOS archive size differs from the lock')
  if (createHash('sha256').update(input.archiveBytes).digest('hex') !== artifact.sha256)
    throw new Error('Computer Use macOS archive digest differs from the lock')
  if (!existsSync(input.stagingParent)) createPrivateDirectorySync(input.stagingParent)
  const stat = lstatSync(input.stagingParent)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    (createPlatform().os !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new Error('Computer Use macOS staging root is unsafe')
  const version = input.lock.source.tag.slice('cua-driver-rs-v'.length)
  const id = randomUUID()
  const container = join(input.stagingParent, `.cua-${version}-${id}.tmp`)
  const archive = join(input.stagingParent, `.cua-${version}-${id}.tar.gz`)
  createPrivateDirectorySync(container)
  const fd = createPrivateFileSync(archive)
  let keep = false
  try {
    try {
      writeFileSync(fd, input.archiveBytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const prefix = `cua-driver-rs-${version}-darwin-universal`
    const dependencies = input.dependencies ?? {}
    verifyListing(await (dependencies.inspect ?? inspect)(archive), prefix)
    input.signal?.throwIfAborted()
    await (dependencies.extract ?? extract)(archive, container)
    input.signal?.throwIfAborted()
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== artifact.sha256)
      throw new Error('Computer Use macOS archive changed during extraction')
    const directory = join(container, prefix)
    hardenTree(directory)
    const verified = await (dependencies.verify ?? verifyMacOSComputerUseDriver)(
      directory,
      input.lock,
      dependencies.verifierDependencies,
    )
    unlinkSync(archive)
    keep = true
    let released = false
    return Object.freeze({
      directory,
      container,
      verified,
      async release() {
        if (released) return
        released = true
        rmSync(container, { recursive: true, force: true })
      },
    })
  } finally {
    if (!keep) rmSync(container, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
}

export function activateExtractedMacOSComputerUseDriver(
  extracted: ExtractedMacOSComputerUseDriver,
  versionDirectory: string,
): void {
  if (!isAbsolute(versionDirectory) || resolve(versionDirectory) !== versionDirectory)
    throw new Error('Computer Use macOS activation requires a canonical version directory')
  renameWriteThroughSync(extracted.directory, versionDirectory)
  rmSync(extracted.container, { recursive: true, force: true })
}
