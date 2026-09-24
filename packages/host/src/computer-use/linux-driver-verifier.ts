import { execFile } from 'node:child_process'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseDriverLock } from './driver-lock.js'
import type { VerifiedLinuxComputerUseDriver } from './linux-driver-backend.js'

const execute = promisify(execFile)
const EXPECTED = Object.freeze([
  'cua-cursor-theme',
  'cua-driver',
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
  'libcua_driver_sdk.so',
  'wayland-helper',
  'wayland-helper/README.md',
  'wayland-helper/install.sh',
  'wayland-helper/winrects@cua',
  'wayland-helper/winrects@cua/extension.js',
  'wayland-helper/winrects@cua/metadata.json',
])
const EXECUTABLES = new Set([
  'cua-cursor-theme',
  'cua-driver',
  'cua_driver_node_runtime.node',
  'libcua_driver_sdk.so',
  'wayland-helper/install.sh',
])

export type LinuxDriverVerifierDependencies = Readonly<{
  listEntries?: (directory: string) => Promise<readonly string[]>
  run?: (command: string, args: readonly string[]) => Promise<Readonly<{ stdout: string; stderr: string }>>
}>

async function listEntries(root: string): Promise<readonly string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || stat.nlink !== 1 || (!stat.isDirectory() && !stat.isFile()))
        throw new Error('Computer Use Linux driver tree contains an unsafe entry')
      if (process.getuid !== undefined && stat.uid !== process.getuid())
        throw new Error('Computer Use Linux driver tree has a foreign owner')
      const name = relative(root, path).split(sep).join('/')
      if (
        (stat.mode & 0o077) !== 0 ||
        (stat.isFile() && EXECUTABLES.has(name) !== ((stat.mode & 0o100) !== 0))
      )
        throw new Error('Computer Use Linux driver tree permissions are unsafe')
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
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

/** Verifies an already provenance-admitted Linux release tree before every activation. */
export async function verifyLinuxComputerUseDriver(
  directory: string,
  lock: ComputerUseDriverLock,
  dependencies: LinuxDriverVerifierDependencies = {},
): Promise<VerifiedLinuxComputerUseDriver> {
  if (createPlatform().os !== 'linux' && Object.keys(dependencies).length === 0)
    throw new Error('Linux Computer Use driver verification is unavailable on this platform')
  const runtimeArchitecture = createPlatform().snapshot().arch
  const architecture = runtimeArchitecture === 'x64' ? 'x86_64' : runtimeArchitecture
  if (architecture !== 'x86_64' && architecture !== 'arm64')
    throw new Error('Linux Computer Use driver architecture is unsupported')
  const artifact = lock.artifacts.find(
    (candidate) => candidate.platform === 'linux' && candidate.architectures.includes(architecture),
  )
  if (
    artifact?.signatureEvidence.status !== 'verified' ||
    artifact.signatureEvidence.kind !== 'linux-provenance' ||
    artifact.signatureEvidence.sourceCommit !== lock.source.commit ||
    artifact.signatureEvidence.artifactSha256 !== artifact.sha256
  )
    throw new Error('Computer Use lock lacks verified Linux provenance')
  const canonical = await realpath(directory)
  if (canonical !== directory) throw new Error('Computer Use Linux driver directory is not canonical')
  const entries = [...(await (dependencies.listEntries ?? listEntries)(directory))].sort()
  if (JSON.stringify(entries) !== JSON.stringify([...EXPECTED].sort()))
    throw new Error('Computer Use Linux driver tree does not match the locked release')
  const version = lock.source.tag.slice('cua-driver-rs-v'.length)
  const executablePath = join(directory, 'cua-driver')
  const result = await (dependencies.run ?? run)(executablePath, ['--version'])
  if (result.stdout.trim() !== `cua-driver ${version}` || result.stderr.trim())
    throw new Error('Computer Use Linux driver version differs from the lock')
  return Object.freeze({
    executablePath,
    version,
    archiveSha256: artifact.sha256,
    architecture,
    provenanceIssuer: artifact.signatureEvidence.issuer,
    provenanceSubject: artifact.signatureEvidence.subject,
  })
}
