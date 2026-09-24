import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { type WindowsExecutableFileIdentity, windowsExecutableFileIdentitySync } from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseDriverLock } from './driver-lock.js'

const execute = promisify(execFile)
const EXPECTED_FILES = Object.freeze([
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
  'cua_driver_sdk.dll',
  'cua-cursor-theme.exe',
  'cua-driver-uia.exe',
  'cua-driver.exe',
])
const SIGNED_FILES = new Set(EXPECTED_FILES.filter((name) => name !== 'cua_driver_abi.h'))

export type VerifiedWindowsComputerUseDriver = Readonly<{
  executablePath: string
  version: string
  publisher: string
  leafThumbprint: string
  publisherSha256: string
}>

export type WindowsDriverVerifierDependencies = Readonly<{
  listFiles?: (directory: string) => Promise<readonly string[]>
  inspectExecutable?: (path: string) => WindowsExecutableFileIdentity
  readVersion?: (path: string) => Promise<string>
  // Overrides the target architecture used to pick the locked artifact. Production always verifies
  // against the machine it is running on, so real callers never pass this; tests inject it so the
  // fixture's evidence choice does not depend on the architecture of the machine running the suite.
  architecture?: string
}>

function selectedArtifact(lock: ComputerUseDriverLock, dependencies: WindowsDriverVerifierDependencies) {
  const runtimeArchitecture = dependencies.architecture ?? createPlatform().snapshot().arch
  const architecture = runtimeArchitecture === 'x64' ? 'x86_64' : runtimeArchitecture
  return lock.artifacts.find(
    (artifact) => artifact.platform === 'win32' && artifact.architectures.includes(architecture as never),
  )
}

async function listRegularFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile()))
    throw new Error('Computer Use driver directory contains a non-file entry')
  return entries.map((entry) => entry.name).sort()
}

async function driverVersion(path: string): Promise<string> {
  const { stdout, stderr } = await execute(path, ['--version'], {
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
    env: {
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    },
  })
  if (stderr.trim()) throw new Error('Computer Use driver wrote to stderr during version verification')
  return stdout.trim()
}

/** Verifies every loadable Windows binary before returning a launchable driver path. */
export async function verifyWindowsComputerUseDriver(
  directory: string,
  lock: ComputerUseDriverLock,
  dependencies: WindowsDriverVerifierDependencies = {},
): Promise<VerifiedWindowsComputerUseDriver> {
  if (createPlatform().os !== 'win32' && Object.keys(dependencies).length === 0)
    throw new Error('Windows Computer Use driver verification is unavailable on this platform')
  const artifact = selectedArtifact(lock, dependencies)
  const evidence = artifact?.signatureEvidence
  if (!artifact || evidence?.status !== 'verified' || evidence.kind !== 'windows-authenticode')
    throw new Error('Computer Use lock lacks verified Windows Authenticode evidence')
  const files = [...(await (dependencies.listFiles ?? listRegularFiles)(directory))].sort()
  if (JSON.stringify(files) !== JSON.stringify([...EXPECTED_FILES].sort()))
    throw new Error('Computer Use driver directory contents do not match the locked release')
  const inspect = dependencies.inspectExecutable ?? windowsExecutableFileIdentitySync
  let primary: WindowsExecutableFileIdentity | undefined
  let primaryPath: string | undefined
  for (const name of files) {
    if (!SIGNED_FILES.has(name)) continue
    const candidatePath = win32.join(directory, name)
    const identity = inspect(candidatePath)
    if (
      identity.publisher !== evidence.publisher ||
      identity.leafThumbprint.toUpperCase() !== evidence.leafThumbprint
    )
      throw new Error(`Computer Use driver signer mismatch: ${name}`)
    if (name === 'cua-driver.exe') {
      primary = identity
      primaryPath = candidatePath
    }
  }
  if (!primary || !primaryPath || win32.basename(primary.executablePath).toLowerCase() !== 'cua-driver.exe')
    throw new Error('Computer Use primary driver identity is missing')
  const expectedVersion = lock.source.tag.slice('cua-driver-rs-v'.length)
  const observed = await (dependencies.readVersion ?? driverVersion)(primary.executablePath)
  if (observed !== `cua-driver ${expectedVersion}`)
    throw new Error('Computer Use driver version does not match the lock')
  return Object.freeze({
    // Native verification may report an equivalent \\?\ path. Keep the caller's canonical install
    // path for later re-verification and launch; the identity above is still bound to this file.
    executablePath: primaryPath,
    version: expectedVersion,
    publisher: primary.publisher,
    // Windows APIs do not promise one hex casing. Persist one canonical spelling so a healthy
    // install remains readable after process restart.
    leafThumbprint: primary.leafThumbprint.toUpperCase(),
    publisherSha256: primary.publisherSha256,
  })
}
