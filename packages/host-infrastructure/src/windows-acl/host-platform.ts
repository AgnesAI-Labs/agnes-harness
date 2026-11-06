// The production adapters of the Windows execution authority: the native ACL primitives of
// `@agnes/system-node`, NTFS paths and this process's identity. Only a Windows Host creates them.
import { realpathSync } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { win32 } from 'node:path'
import { hasPrivateDaclSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import {
  applyWindowsAclGrant,
  inspectWindowsAcl,
  readWindowsObjectIdentity,
  restoreWindowsAclGrant,
} from '@agnes/system-node/windows-acl'
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
 * The Host's Windows execution facade over the real authority. Its journal and temp directories
 * live under the account's LocalAppData folder; `privateRoots` are AGH's own data roots, which no
 * workspace may contain or lie inside.
 */
export async function createWindowsAclExecution(input: {
  localAppData: string
  privateRoots: readonly string[]
  localProviderId: string
  pid: number
}): Promise<WindowsAclExecution> {
  const platform = await windowsAclHostPlatform(input.pid)
  const authority = new WindowsExecutionAuthority({
    ...windowsAclLocations(input.localAppData, platform.paths),
    privateRoots: input.privateRoots,
    native: { inspect: inspectWindowsAcl, apply: applyWindowsAclGrant, restore: restoreWindowsAclGrant },
    platform,
  })
  return new WindowsAclExecution({
    authority,
    rootIdentity: platform.rootIdentity,
    localProviderId: input.localProviderId,
  })
}
