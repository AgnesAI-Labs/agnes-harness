import { describe, expect, it } from 'vitest'
import { sandboxToolPolicies } from '../src/tool-policies.js'

describe('sandbox tool policies', () => {
  it('pairs read-only and full-access with public tool policies independently of session approval mode', async () => {
    const input: import('@agnes/extension-api').ToolPolicyInput = {
      sessionKey: 's',
      cwd: '/work',
      workspaceRoot: '/work',
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      call: { id: 'c', name: 'shell', args: {} },
      policy: {
        isReadOnly: false,
        isDestructive: true,
        replay: 'never',
        requiresApproval: 'destructive',
        approvalScopes: [],
      },
      tainted: false,
      fullAccess: true,
      approvalMode: 'off',
    }
    const readOnly = sandboxToolPolicies.find((policy) => policy.id === 'read-only')
    const fullAccess = sandboxToolPolicies.find((policy) => policy.id === 'full-access')
    if (!readOnly || !fullAccess) throw new Error('permission policies are missing')
    expect(await readOnly.decide(input, new AbortController().signal)).toMatchObject({ effect: 'deny' })
    expect(
      await readOnly.decide(
        { ...input, policy: { ...input.policy, isReadOnly: true, isDestructive: false } },
        new AbortController().signal,
      ),
    ).toMatchObject({ effect: 'allow' })
    expect(await fullAccess.decide(input, new AbortController().signal)).toMatchObject({ effect: 'allow' })
  })
})
