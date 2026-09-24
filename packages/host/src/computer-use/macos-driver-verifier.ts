import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseDriverLock } from './driver-lock.js'
import type { VerifiedMacOSComputerUseDriver } from './macos-driver-backend.js'

const execute = promisify(execFile)
const EXPECTED = Object.freeze([
  'CuaDriver.app',
  'CuaDriver.app/Contents',
  'CuaDriver.app/Contents/CodeResources',
  'CuaDriver.app/Contents/Info.plist',
  'CuaDriver.app/Contents/MacOS',
  'CuaDriver.app/Contents/MacOS/cua-cursor-theme',
  'CuaDriver.app/Contents/MacOS/cua-driver',
  'CuaDriver.app/Contents/Resources',
  'CuaDriver.app/Contents/Resources/AppIcon.icns',
  'CuaDriver.app/Contents/_CodeSignature',
  'CuaDriver.app/Contents/_CodeSignature/CodeResources',
  'CuaDriver.app/Contents/embedded.provisionprofile',
  'cua-cursor-theme',
  'cua-driver',
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
  'libcua_driver_sdk.dylib',
])
const SIGNED = Object.freeze([
  'cua-driver',
  'cua-cursor-theme',
  'libcua_driver_sdk.dylib',
  'CuaDriver.app/Contents/MacOS/cua-driver',
  'CuaDriver.app/Contents/MacOS/cua-cursor-theme',
])
const UNSIGNED_NODE_RUNTIME_EXCEPTION = Object.freeze({
  name: 'cua_driver_node_runtime.node',
  sourceTag: 'cua-driver-rs-v0.28.1',
  url: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.1/cua-driver-rs-0.28.1-darwin-universal.tar.gz',
  size: 70_074_359,
  sha256: '52fdabd1947c9b252d881a257d3169372ed1a2d4ea90cdcce7dd624e8360d133',
  contentSha256: '554603370c5c5994dfc0d56def917c57fd6d7d479887fe486016eec00197c9c6',
})

export type MacOSDriverVerifierDependencies = Readonly<{
  listEntries?: (directory: string) => Promise<readonly string[]>
  nodeRuntimeSha256?: (path: string) => Promise<string>
  run?: (command: string, args: readonly string[]) => Promise<Readonly<{ stdout: string; stderr: string }>>
}>

async function listEntries(root: string): Promise<readonly string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = await lstat(path)
      // Directories naturally have more than one link on macOS when they contain child
      // directories. Keep the single-link invariant for regular payload files only.
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new Error('Computer Use macOS driver tree contains an unsafe entry')
      const name = relative(root, path).split(sep).join('/')
      found.push(name)
      if (stat.isDirectory()) await walk(path)
    }
  }
  await walk(root)
  return found.sort()
}

async function run(command: string, args: readonly string[]) {
  const result = await execute(command, [...args], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

/** Hash the one upstream unsigned add-on through a no-follow file descriptor on every verification. */
async function nodeRuntimeSha256(path: string): Promise<string> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.nlink !== 1)
      throw new Error('Computer Use macOS unsigned Node runtime is unsafe')
    const digest = createHash('sha256').update(readFileSync(descriptor)).digest('hex')
    const after = fstatSync(descriptor)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.nlink !== after.nlink
    )
      throw new Error('Computer Use macOS unsigned Node runtime changed while verifying')
    return digest
  } finally {
    closeSync(descriptor)
  }
}

function field(output: string, name: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function hasLockedUnsignedNodeRuntimeException(lock: ComputerUseDriverLock): boolean {
  const artifact = lock.artifacts.find((candidate) => candidate.platform === 'darwin')
  return (
    lock.source.tag === UNSIGNED_NODE_RUNTIME_EXCEPTION.sourceTag &&
    artifact?.url === UNSIGNED_NODE_RUNTIME_EXCEPTION.url &&
    artifact.size === UNSIGNED_NODE_RUNTIME_EXCEPTION.size &&
    artifact.sha256 === UNSIGNED_NODE_RUNTIME_EXCEPTION.sha256
  )
}

/** Verifies the exact locked universal bundle and every loadable Mach-O before launch. */
export async function verifyMacOSComputerUseDriver(
  directory: string,
  lock: ComputerUseDriverLock,
  dependencies: MacOSDriverVerifierDependencies = {},
): Promise<VerifiedMacOSComputerUseDriver> {
  if (createPlatform().os !== 'darwin' && Object.keys(dependencies).length === 0)
    throw new Error('macOS Computer Use driver verification is unavailable on this platform')
  const artifact = lock.artifacts.find((candidate) => candidate.platform === 'darwin')
  const evidence = artifact?.signatureEvidence
  if (!artifact || evidence?.status !== 'verified' || evidence.kind !== 'apple-developer-id-notarized')
    throw new Error('Computer Use lock lacks verified macOS Developer ID evidence')
  if (!hasLockedUnsignedNodeRuntimeException(lock))
    throw new Error('Computer Use macOS lock does not authorize the unsigned Node runtime exception')
  const entries = [...(await (dependencies.listEntries ?? listEntries)(directory))].sort()
  if (JSON.stringify(entries) !== JSON.stringify([...EXPECTED].sort()))
    throw new Error('Computer Use macOS driver tree does not match the locked release')
  const invoke = dependencies.run ?? run
  const app = join(directory, 'CuaDriver.app')
  await invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const details = await invoke('/usr/bin/codesign', ['-dv', '--verbose=4', app])
  const identity = `${details.stdout}\n${details.stderr}`
  if (
    field(identity, 'Identifier') !== evidence.bundleId ||
    field(identity, 'TeamIdentifier') !== evidence.teamId ||
    !identity.split(/\r?\n/u).some((line) => line.trim() === `Authority=${evidence.authority}`)
  )
    throw new Error('Computer Use macOS driver signer identity differs from the lock')
  const gatekeeper = await invoke('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
  if (!`${gatekeeper.stdout}\n${gatekeeper.stderr}`.includes('Notarized Developer ID'))
    throw new Error('Computer Use macOS driver is not accepted as a notarized Developer ID app')
  await invoke('/usr/bin/xcrun', ['stapler', 'validate', app])
  // The upstream v0.28.1 archive hashes to the exact lock above and contains this one unsigned
  // Node add-on. It is safe only inside the verified, private activation tree; every other
  // loadable Mach-O remains individually signed and universally built. Its content digest is
  // pinned and rechecked by descriptor below because it carries no individual code signature.
  if (!EXPECTED.includes(UNSIGNED_NODE_RUNTIME_EXCEPTION.name))
    throw new Error('Computer Use macOS unsigned Node runtime exception is not in the locked tree')
  const nodeRuntime = join(directory, UNSIGNED_NODE_RUNTIME_EXCEPTION.name)
  if (
    (await (dependencies.nodeRuntimeSha256 ?? nodeRuntimeSha256)(nodeRuntime)) !==
    UNSIGNED_NODE_RUNTIME_EXCEPTION.contentSha256
  )
    throw new Error('Computer Use macOS unsigned Node runtime digest differs from the locked release')
  for (const name of SIGNED) {
    const path = join(directory, ...name.split('/'))
    await invoke('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path])
    const arch = await invoke('/usr/bin/lipo', ['-archs', path])
    const architectures = new Set(arch.stdout.trim().split(/\s+/u))
    if (!architectures.has('arm64') || !architectures.has('x86_64'))
      throw new Error(`Computer Use macOS driver is not universal: ${name}`)
  }
  const version = lock.source.tag.slice('cua-driver-rs-v'.length)
  const versionResult = await invoke(join(directory, 'cua-driver'), ['--version'])
  if (versionResult.stdout.trim() !== `cua-driver ${version}` || versionResult.stderr.trim())
    throw new Error('Computer Use macOS driver version differs from the lock')
  return Object.freeze({
    executablePath: join(directory, 'cua-driver'),
    appPath: app,
    version,
    bundleId: evidence.bundleId,
    teamId: evidence.teamId,
    authority: evidence.authority,
  })
}
