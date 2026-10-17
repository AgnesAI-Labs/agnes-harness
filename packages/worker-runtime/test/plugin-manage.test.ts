import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolPolicyPlugin } from '@agnes/base'
import { readPlanMode, writePlanMode } from '@agnes/base/plan-mode'
import type { ToolPolicy } from '@agnes/extension-api'
import type { HostSession, PluginManageInvocation } from '@agnes/host'
import { afterEach, expect, it, vi } from 'vitest'
import { requestPluginManage } from '../src/plugin-manage.js'
import type { SharedSessionChannel } from '../src/shared-session-channel.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const candidateTestSandbox = {
  policy: { workspaceRoot: '/synthetic', rules: [], networkAllow: [], digest: 'a'.repeat(64) },
  network: 'deny' as const,
  local: true,
}
const invocation: PluginManageInvocation = {
  packageId: '@agnes/skill-helper',
  snapshotId: 'snap',
  rowId: 'helper',
  sessionKey: 's',
  toolUseId: 'tool',
  turn: 1,
  leaseId: 'lease',
  input: { action: 'candidate.test', candidateId: 'candidate-1', expectedHash: 'hash' },
}

it.each([
  ['full-access', false, 'allow'],
  ['default', false, 'ask'],
  ['read-only', false, 'ask'],
  ['full-access', true, 'ask'],
] as const)(
  'resolves %s plan=%s with the shipped policy before sending %s',
  async (policy, plan, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'agh-candidate-policy-'))
    roots.push(root)
    if (plan)
      writePlanMode(root, { active: true, instruction: 'plan only', updatedAt: new Date().toISOString() })
    const policies = new Map<string, ToolPolicy>()
    toolPolicyPlugin.apply({
      providers: { register: (_kind: unknown, provider: ToolPolicy) => policies.set(provider.id, provider) },
      planMode: { status: readPlanMode },
    } as never)
    const selected = policies.get(policy)
    if (!selected) throw new Error('Missing shipped policy')
    const session = {
      key: 's',
      commandSandboxPolicy: () => candidateTestSandbox,
      workspaceRoot: root,
      preset: { approval: { policy } },
      yolo: true,
      d: {
        cwd: root,
        approvalMode: 'off',
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      },
      toolPolicy: () => selected,
    } as unknown as HostSession
    const request = vi.fn<SharedSessionChannel['request']>(async () => 'ran')
    expect(
      await requestPluginManage(session, invocation, new AbortController().signal, {
        request,
        currentSessionKey: () => 's',
      }),
    ).toBe('ran')
    expect(request.mock.calls).toEqual([
      [
        'plugin-manage',
        { ...invocation, candidateTestPolicy: expected, candidateTestSandbox },
        expect.any(AbortSignal),
      ],
    ])
    // Legacy helpers use exactly the same gate.
    await requestPluginManage(
      session,
      { ...invocation, input: { action: 'test', proposalId: 'candidate-1' } },
      new AbortController().signal,
      { request, currentSessionKey: () => 's' },
    )
    expect(request.mock.calls[1]?.[1]).toMatchObject({ candidateTestPolicy: expected })
  },
)
it.each(['candidate.approve', 'install', 'trust', 'enable', 'candidate.submit'])(
  'does not mint the candidate-test exception for %s',
  async (action) => {
    const input = { ...invocation, input: { action } }
    const request = vi.fn<SharedSessionChannel['request']>(async () => undefined)
    await requestPluginManage(undefined, input, new AbortController().signal, {
      request,
      currentSessionKey: () => 's',
    })
    expect(request.mock.calls[0]?.[1]).toEqual(input)
  },
)
it('refuses missing sessions and cancellation before sending a test request', async () => {
  const request = vi.fn<SharedSessionChannel['request']>(async () => undefined)
  await expect(
    requestPluginManage(undefined, invocation, new AbortController().signal, {
      request,
      currentSessionKey: () => 's',
    }),
  ).rejects.toThrow('not open')
  await expect(
    requestPluginManage(undefined, invocation, AbortSignal.abort(), {
      request,
      currentSessionKey: () => 's',
    }),
  ).rejects.toBeDefined()
  expect(request).not.toHaveBeenCalled()
})

it.each(['ask', 'deny', 'human'] as const)(
  'keeps prompting when the effective full-access policy returns %s',
  async (effect) => {
    const request = vi.fn<SharedSessionChannel['request']>(async () => undefined)
    const session = {
      key: 's',
      commandSandboxPolicy: () => candidateTestSandbox,
      workspaceRoot: '/synthetic',
      preset: { approval: { policy: 'full-access' } },
      d: { cwd: '/synthetic' },
      toolPolicy: () => ({
        decide: () =>
          effect === 'human'
            ? {
                effect: 'allow',
                reason: 'human required',
                approval: { reviewerRequirement: 'human', grantConstraints: 'once', subjectRevision: 'hash' },
              }
            : { effect, reason: 'effective policy' },
      }),
    } as unknown as HostSession
    await requestPluginManage(session, invocation, new AbortController().signal, {
      request,
      currentSessionKey: () => 's',
    })
    expect(request.mock.calls[0]?.[1]).toMatchObject({ candidateTestPolicy: 'ask' })
    const forged = {
      ...invocation,
      candidateTestPolicy: 'allow',
      candidateTestSandbox: { network: 'allow', local: true },
    }
    await requestPluginManage(session, forged, new AbortController().signal, {
      request,
      currentSessionKey: () => 's',
    })
    expect(request.mock.calls[1]?.[1]).toMatchObject({ candidateTestPolicy: 'ask', candidateTestSandbox })
  },
)
