import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxExecutionRecord } from '@agnes/host-providers/profile/sandbox-state'
import { SessionSandboxStore } from '@agnes/host-providers/profile/sandbox-state'
import { afterEach, expect, it, vi } from 'vitest'
import { windowsAclMaintenance } from '../../src/runtime/lifecycle/windows-acl-maintenance.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const boundary = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
} as const
const execution = (workspaceRoot: string): SandboxExecutionRecord => ({
  workspaceId: `id-${workspaceRoot}`,
  workspaceRoot,
  policyDigest: 'c'.repeat(64),
  staticConfigHash: 'e'.repeat(64),
  provider: 'local',
  providerVersion: '0.0.0',
  target: 'win32',
  implementation: 'unimplemented',
  probeState: 'ready',
  backend: 'windows-acl',
  enforcement: { level: 'partial', scope: ['file'], boundary },
})
const OLD = { volumeId: 'vol', fileId: 'old' }
const NEW = { volumeId: 'vol', fileId: 'new' }

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'agh-acl-maintenance-'))
  roots.push(home)
  const profileDir = join(home, 'profiles', 'test')
  mkdirSync(profileDir, { recursive: true })
  const store = new SessionSandboxStore(profileDir)
  const verify = (key: string, root: string) =>
    store.verifyWindowsExecution(
      key,
      {
        currentExecution: execution(root),
        permissionEvidence: {
          intent: {
            permission: 'workspace-write',
            access: 'workspace-write',
            windowsMode: 'write-restricted',
            windowsModeSource: 'official',
            required: false,
            onUnavailable: 'allow-if-unimplemented',
            customFsDeny: false,
            networkMode: 'allow',
          },
          recordedPermission: 'workspace-write',
          legacyStaticConfigHash: 'd'.repeat(64),
        },
        rootIdentity: OLD,
      },
      false,
    )
  const authority = {
    inspect: vi.fn(async () => ({ state: 'active' as const, issues: [], repairable: true, steps: [] })),
    repair: vi.fn(async () => ({ state: 'revoked' as const, issues: [], repairable: false, steps: [] })),
    dispose: vi.fn(async () => undefined),
  }
  const identity = { current: NEW }
  const maintenance = windowsAclMaintenance({
    authority,
    store,
    // The canonical spelling of the root differs in case from the one the session saved.
    canonicalPath: async (path) => path.toUpperCase(),
    rootIdentity: async () => identity.current,
  })
  return { store, verify, authority, identity, maintenance }
}

it('lists only this root’s sessions whose directory was replaced, and confirms them in place', async () => {
  const { store, verify, maintenance, identity } = setup()
  const first = verify('a', 'C:\\work')
  verify('b', 'C:\\other')
  expect(await maintenance.replacedWorkspaces('c:\\work')).toEqual(['a'])
  await maintenance.confirmWorkspace('c:\\work', 'a')
  // The same session continues at the directory now there; nothing else is listed.
  expect(store.windowsWorkspaces().find((item) => item.sessionKey === 'a')).toEqual({
    sessionKey: 'a',
    workspaceRoot: 'C:\\work',
    rootIdentity: NEW,
  })
  expect(first.rootIdentity).toEqual(OLD)
  expect(await maintenance.replacedWorkspaces('c:\\work')).toEqual([])
  // The same directory is not a replacement; another root's session is not confirmed from here.
  identity.current = OLD
  expect(await maintenance.replacedWorkspaces('C:\\other')).toEqual([])
  await expect(maintenance.confirmWorkspace('c:\\work', 'b')).rejects.toThrow()
})

it('passes inspect and repair through to the authority and closes it', async () => {
  const { authority, maintenance } = setup()
  await maintenance.inspect('C:\\work')
  expect(authority.inspect).toHaveBeenCalledWith('C:\\work')
  const request = { root: 'C:\\work', grantId: 'g', expectedRecordDigest: 'd' }
  await maintenance.repair(request)
  expect(authority.repair).toHaveBeenCalledWith(request)
  await maintenance.close()
  expect(authority.dispose).toHaveBeenCalledOnce()
})
