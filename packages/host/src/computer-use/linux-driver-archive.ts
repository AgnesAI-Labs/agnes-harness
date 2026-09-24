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
import type { VerifiedLinuxComputerUseDriver } from './linux-driver-backend.js'
import {
  type LinuxDriverVerifierDependencies,
  verifyLinuxComputerUseDriver,
} from './linux-driver-verifier.js'

const execute = promisify(execFile)
const MAX_EXPANDED_BYTES = 160 * 1024 * 1024
const PATHS = Object.freeze([
  '',
  'cua-driver',
  'cua-cursor-theme',
  'wayland-helper/',
  'wayland-helper/install.sh',
  'wayland-helper/winrects@cua/',
  'wayland-helper/winrects@cua/metadata.json',
  'wayland-helper/winrects@cua/extension.js',
  'wayland-helper/README.md',
  'libcua_driver_sdk.so',
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
])
const EXECUTABLES = new Set([
  'cua-driver',
  'cua-cursor-theme',
  'wayland-helper/install.sh',
  'libcua_driver_sdk.so',
  'cua_driver_node_runtime.node',
])

export type ExtractedLinuxComputerUseDriver = Readonly<{
  directory: string
  container: string
  verified: VerifiedLinuxComputerUseDriver
  release(): Promise<void>
}>

export type LinuxDriverArchiveDependencies = Readonly<{
  inspect?: (archive: string) => Promise<Readonly<{ names: readonly string[]; verbose: readonly string[] }>>
  extract?: (archive: string, destination: string) => Promise<void>
  verify?: (
    directory: string,
    lock: ComputerUseDriverLock,
    dependencies?: LinuxDriverVerifierDependencies,
  ) => Promise<VerifiedLinuxComputerUseDriver>
  verifierDependencies?: LinuxDriverVerifierDependencies
}>

function runtimeArchitecture(): 'arm64' | 'x86_64' {
  const architecture = createPlatform().snapshot().arch
  if (architecture === 'arm64') return architecture
  if (architecture === 'x64' || architecture === 'x86_64') return 'x86_64'
  throw new Error('Linux Computer Use driver architecture is unsupported')
}

function selectedArtifact(lock: ComputerUseDriverLock) {
  const architecture = runtimeArchitecture()
  return lock.artifacts.find(
    (artifact) => artifact.platform === 'linux' && artifact.architectures.includes(architecture),
  )
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
    throw new Error('Computer Use Linux archive member paths differ from the lock')
  if (listing.verbose.length !== expected.length)
    throw new Error('Computer Use Linux archive verbose listing is incomplete')
  for (let index = 0; index < expected.length; index += 1) {
    const line = listing.verbose[index]
    const name = expected[index]
    const directory = name?.endsWith('/')
    if (!line || !name || !line.endsWith(name) || line[0] !== (directory ? 'd' : '-'))
      throw new Error('Computer Use Linux archive contains an unsafe member type')
  }
}

function hardenTree(root: string, relative = ''): number {
  const directory = join(root, ...relative.split('/').filter(Boolean))
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const name = relative ? `${relative}/${entry.name}` : entry.name
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || stat.nlink !== 1 || (!stat.isDirectory() && !stat.isFile()))
      throw new Error('Computer Use Linux archive extracted an unsafe entry')
    if (stat.isDirectory()) {
      chmodSync(path, 0o700)
      total += hardenTree(root, name)
    } else {
      total += stat.size
      chmodSync(path, EXECUTABLES.has(name) ? 0o700 : 0o600)
    }
    if (total > MAX_EXPANDED_BYTES) throw new Error('Computer Use Linux archive exceeds expanded limit')
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  return total
}

/** Extracts the exact locked tarball into a private fresh tree, then verifies provenance-bound bytes. */
export async function extractLockedLinuxComputerUseDriver(input: {
  archiveBytes: Uint8Array
  stagingParent: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: LinuxDriverArchiveDependencies
}): Promise<ExtractedLinuxComputerUseDriver> {
  if (createPlatform().os !== 'linux' && !input.dependencies)
    throw new Error('Linux Computer Use driver extraction is unavailable on this platform')
  if (!isAbsolute(input.stagingParent) || resolve(input.stagingParent) !== input.stagingParent)
    throw new Error('Computer Use Linux archive requires a canonical staging root')
  input.signal?.throwIfAborted()
  const artifact = selectedArtifact(input.lock)
  if (!artifact) throw new Error('Computer Use lock has no Linux artifact')
  if (input.archiveBytes.byteLength !== artifact.size)
    throw new Error('Computer Use Linux archive size differs from the lock')
  if (createHash('sha256').update(input.archiveBytes).digest('hex') !== artifact.sha256)
    throw new Error('Computer Use Linux archive digest differs from the lock')
  if (!existsSync(input.stagingParent)) createPrivateDirectorySync(input.stagingParent)
  const staging = lstatSync(input.stagingParent)
  if (
    !staging.isDirectory() ||
    staging.isSymbolicLink() ||
    (process.getuid !== undefined && staging.uid !== process.getuid()) ||
    (staging.mode & 0o077) !== 0
  )
    throw new Error('Computer Use Linux staging root is unsafe')
  const version = input.lock.source.tag.slice('cua-driver-rs-v'.length)
  const architecture = runtimeArchitecture()
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
    const prefix = `cua-driver-rs-${version}-linux-${architecture}`
    const dependencies = input.dependencies ?? {}
    verifyListing(await (dependencies.inspect ?? inspect)(archive), prefix)
    input.signal?.throwIfAborted()
    await (dependencies.extract ?? extract)(archive, container)
    input.signal?.throwIfAborted()
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== artifact.sha256)
      throw new Error('Computer Use Linux archive changed during extraction')
    const directory = join(container, prefix)
    hardenTree(directory)
    const verified = await (dependencies.verify ?? verifyLinuxComputerUseDriver)(
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

export function activateExtractedLinuxComputerUseDriver(
  extracted: ExtractedLinuxComputerUseDriver,
  versionDirectory: string,
): void {
  if (!isAbsolute(versionDirectory) || resolve(versionDirectory) !== versionDirectory)
    throw new Error('Computer Use Linux activation requires a canonical version directory')
  renameWriteThroughSync(extracted.directory, versionDirectory)
  rmSync(extracted.container, { recursive: true, force: true })
}
