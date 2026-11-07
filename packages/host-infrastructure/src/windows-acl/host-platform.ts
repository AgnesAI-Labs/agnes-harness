// The production adapters of the Windows execution authority: the native ACL primitives of
// `@agnes/system-node`, NTFS paths and this process's identity. Only a Windows Host creates them.
import { realpathSync } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasPrivateDaclSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { readWindowsObjectIdentity } from '@agnes/system-node/windows-acl'
import { createWindowsAclWorker } from '@agnes/system-node/windows-acl-worker'
import { windowsProcessIdentity } from '../adapters/process-identity-win32.js'
import { type WindowsAclPlatform, WindowsExecutionAuthority, windowsAclLocations } from './authority.js'
import { WindowsAclExecution } from './execution.js'
import { aclError } from './journal.js'

/** NTFS file system and process facts for the authority; the root identity read walks nothing. */
export async function windowsAclHostPlatform(pid: number): Promise<WindowsAclPlatform> {
  const identity = await windowsProcessIdentity(pid)
  if (identity.state !== 'alive') throw aclError('E_ACL_STATE_UNSAFE', 'This process identity is unavailable')
  return Object.freeze({
    paths: Object.freeze({ ...win32, caseInsensitive: true }),
    canonicalPath: async (path: string) => realpathSync.native(path),
    rootIdentity: async (path: string) => readWindowsObjectIdentity(path),
    ensurePrivateDirectory: async (path: string) => {
      windowsEnsurePrivateDirectorySync(path)
      if ((await lstat(path)).isSymbolicLink() || !hasPrivateDaclSync(path))
        throw aclError('E_ACL_STATE_UNSAFE', 'An AGH private directory is not private to this account')
    },
    createDirectory: async (path: string) => {
      await mkdir(path)
    },
    removeDirectory: (path: string) => rm(path, { recursive: true, force: true, maxRetries: 5 }),
    self: Object.freeze({ pid, startId: identity.startId }),
    processIdentity: (target: number) => windowsProcessIdentity(target),
  })
}

/**
 * Directories of code this Host runs without confinement: its own executable and code, the Node
 * executable that starts process brokers, the broker's package and the native artifact. A module
 * that cannot be resolved here cannot be run by this Host either, so it is left out.
 */
export function windowsAclRuntimeRoots(nodeExecutable?: string): string[] {
  const require = createRequire(import.meta.url)
  const resolved = (id: string, levels: number) => {
    try {
      let path = require.resolve(id)
      for (let level = 0; level < levels; level++) path = win32.dirname(path)
      return [path]
    } catch {
      return []
    }
  }
  return [
    win32.dirname(process.execPath),
    ...(nodeExecutable ? [win32.dirname(nodeExecutable)] : []),
    win32.dirname(fileURLToPath(import.meta.url)),
    // The broker lives in <package>/runtime; the whole package runs in the Host and the broker.
    ...resolved('@agnes/system-node/process-broker', 2),
    ...resolved('@agnes/system-node/native', 1),
  ]
}

/**
 * The Host's Windows execution facade over the real authority. Its journal and temp directories
 * live under the account's LocalAppData folder; `privateRoots` are AGH's own data roots, which no
 * workspace may contain or lie inside, and no workspace may contain the Host's runtime (see
 * windowsAclRuntimeRoots; pass `nodeExecutable` when brokers run under another Node than this
 * process). The tree walks run on a worker thread.
 */
export async function createWindowsAclExecution(input: {
  localAppData: string
  privateRoots: readonly string[]
  localProviderId: string
  pid: number
  nodeExecutable?: string
}): Promise<WindowsAclExecution> {
  const platform = await windowsAclHostPlatform(input.pid)
  const authority = new WindowsExecutionAuthority({
    ...windowsAclLocations(input.localAppData, platform.paths),
    privateRoots: input.privateRoots,
    runtimeRoots: windowsAclRuntimeRoots(input.nodeExecutable),
    native: createWindowsAclWorker(),
    platform,
  })
  return new WindowsAclExecution({
    authority,
    rootIdentity: platform.rootIdentity,
    localProviderId: input.localProviderId,
  })
}

/**
 * The authority alone, for maintenance outside a Host: inspecting and repairing grants under the
 * account's LocalAppData folder. It acquires nothing, so it needs no workspace admission roots.
 */
export async function createWindowsAclMaintenanceAuthority(input: {
  localAppData: string
  pid: number
}): Promise<
  Readonly<{
    authority: Pick<WindowsExecutionAuthority, 'inspect' | 'repair' | 'dispose'>
    platform: Pick<WindowsAclPlatform, 'canonicalPath' | 'rootIdentity'>
  }>
> {
  const platform = await windowsAclHostPlatform(input.pid)
  const authority = new WindowsExecutionAuthority({
    ...windowsAclLocations(input.localAppData, platform.paths),
    privateRoots: [],
    native: createWindowsAclWorker(),
    platform,
  })
  return { authority, platform }
}
