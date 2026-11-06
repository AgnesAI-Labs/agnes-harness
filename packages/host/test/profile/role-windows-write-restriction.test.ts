// A role child of a Windows session that runs under the write restriction: it must still run commands,
// never with more authority than its parent, and never past a stronger requirement of its parent.
import { win32 } from 'node:path'
import type { RoleAuthority } from '@agnes/core'
import {
  compileWorkspacePolicy,
  intersectWorkspacePlan,
  normalizeSandboxStaticConfig,
  planExplicitDeny,
  type WorkspacePolicyPlan,
} from '@agnes/host-common/workspace-policy'
import {
  WINDOWS_ACL_ENFORCEMENT,
  WindowsAclExecution,
} from '@agnes/host-infrastructure/windows-acl/execution'
import { describe, expect, it } from 'vitest'
import {
  windowsHostSpawnOffer,
  windowsSessionGate,
} from '../../src/runtime/assemble/workspace-windows-acl.js'
import { roleSandboxConstraint, roleWorkspacePreset } from '../../src/runtime/sessions/role-policy.js'

const ROOT = 'C:\\work'
const compile = (preset: Record<string, unknown>) =>
  compileWorkspacePolicy({
    canonicalRoot: ROOT,
    dataDir: 'C:\\Users\\me\\.agnes',
    homeDir: 'C:\\Users\\me',
    protectedPaths: ['C:\\Users\\me\\.agnes\\profiles\\local\\secrets'],
    semantics: { flavor: 'win32', caseSensitive: false },
    staticConfig: normalizeSandboxStaticConfig(preset, { target: 'win32' }),
    canonicalize: async (path, options) => win32.resolve(options?.base ?? 'C:\\', path).toLowerCase(),
  })
/** The official Windows default: what a parent under the write restriction was opened with. */
const officialDefault = (sandbox: Record<string, unknown> = {}) => ({
  sandbox: {
    level: 'L1',
    on_unavailable: 'allow-if-unimplemented',
    windows_mode: 'write-restricted',
    ...sandbox,
  },
  providers: { 'tool-policy': { provider: 'default' } },
})
/** A role's own recipe that never mentions Windows. */
const roleRecipe = {
  sandbox: { level: 'L1', on_unavailable: 'allow-if-unimplemented' },
  providers: { 'tool-policy': { provider: 'default' } },
}
// What the parent's sandbox snapshot reports for a local Windows session (role-children reads it).
const localWindowsParent = { local: true, allowsUnconfined: true }

function facade() {
  return new WindowsAclExecution({
    authority: { acquire: async () => Promise.reject(new Error('not used')), dispose: async () => undefined },
    rootIdentity: async () => ({ volumeId: 'v', fileId: 'f' }),
    localProviderId: 'local',
  })
}

const offer = (plan: WorkspacePolicyPlan) =>
  windowsHostSpawnOffer({
    execution: facade(),
    os: 'win32',
    staticConfig: plan.staticConfig,
    customFsDeny: planExplicitDeny(plan),
    providerId: 'local',
    localProviderId: 'local',
    root: plan.policy.workspaceRoot,
    policyDigest: plan.policy.digest,
  })

/** The child's plan: its own recipe as the role authority shapes it, narrowed by the parent's policy. */
async function childPlan(
  authority: Pick<RoleAuthority, 'permission' | 'sandboxRequired' | 'windowsWriteRestricted'>,
  parent: WorkspacePolicyPlan,
) {
  const preset = roleWorkspacePreset(roleRecipe as never, authority as RoleAuthority)
  return intersectWorkspacePlan(await compile(preset as Record<string, unknown>), parent.policy)
}

describe('a role child of a Windows session under the write restriction', () => {
  it('runs its commands under the same restriction, not a required full boundary', async () => {
    const constraint = roleSandboxConstraint({
      sandbox: localWindowsParent,
      enforcement: WINDOWS_ACL_ENFORCEMENT as never,
      parentSandboxRequired: false,
    })
    expect(constraint).toEqual({ sandboxRequired: false, windowsWriteRestricted: true })
    const parent = await compile(officialDefault())
    const plan = await childPlan({ permission: 'workspace-write', ...constraint }, parent)
    // The role's own recipe never opted in; the inherited restriction applies all the same.
    expect(plan.staticConfig).toMatchObject({ windowsMode: 'write-restricted', required: false })
    // The narrowed deny paths list the default protected paths, and those are not an explicit deny.
    expect(plan.staticConfig.denyPaths).toContain('c:\\work\\.git')
    expect(planExplicitDeny(plan)).toBe(false)
    const offered = await offer(plan)
    expect(offered?.boundary).toEqual(WINDOWS_ACL_ENFORCEMENT.boundary)
    expect(() =>
      windowsSessionGate({
        execution: facade(),
        hostSpawn: offered,
        staticConfig: plan.staticConfig,
        customFsDeny: planExplicitDeny(plan),
        requiresFileIsolation: false,
        providerId: 'local',
        root: plan.policy.workspaceRoot,
        policyDigest: plan.policy.digest,
      }),
    ).not.toThrow()
  })

  it('refuses the restriction when the parent policy denies more than the default protected paths', async () => {
    const parent = await compile(officialDefault({ deny_paths: ['secret'] }))
    const plan = await childPlan(
      { permission: 'workspace-write', sandboxRequired: false, windowsWriteRestricted: true },
      parent,
    )
    expect(planExplicitDeny(plan)).toBe(true)
    await expect(offer(plan)).rejects.toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
      detail: { reason: 'windows-acl-read-deny' },
    })
  })

  it('keeps a required boundary of an ancestor required', () => {
    expect(
      roleSandboxConstraint({
        sandbox: localWindowsParent,
        enforcement: WINDOWS_ACL_ENFORCEMENT as never,
        parentSandboxRequired: true,
      }),
    ).toEqual({ sandboxRequired: true })
  })

  it('leaves every other parent posture as it was', () => {
    const decide = (enforcement: object, sandbox = localWindowsParent) =>
      roleSandboxConstraint({ sandbox, enforcement: enforcement as never, parentSandboxRequired: false })
    // The admitted unconfined fallback and no enforcement stay unrequired.
    expect(decide({ level: 'partial', scope: ['file'] })).toEqual({ sandboxRequired: false })
    expect(decide({ level: 'none', scope: [] })).toEqual({ sandboxRequired: false })
    // OS confinement, and a file fence without the fallback, stay required.
    expect(decide({ level: 'full', scope: ['file', 'network', 'process'] })).toEqual({
      sandboxRequired: true,
    })
    expect(decide({ level: 'partial', scope: ['file'] }, { local: true, allowsUnconfined: false })).toEqual({
      sandboxRequired: true,
    })
    // The Windows boundary reported for anything but the local provider is not trusted.
    expect(decide(WINDOWS_ACL_ENFORCEMENT, { local: false, allowsUnconfined: true })).toEqual({
      sandboxRequired: true,
    })
  })

  it('changes nothing in the child preset of a parent without the restriction', () => {
    const authority = { permission: 'workspace-write', sandboxRequired: false } as RoleAuthority
    expect(roleWorkspacePreset(roleRecipe as never, authority).sandbox).toEqual(roleRecipe.sandbox)
  })
})
