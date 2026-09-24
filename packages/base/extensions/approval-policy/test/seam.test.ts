import type { ApprovalRequest } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { approvalPolicy } from '../src/seam.js'

const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'idempotent' as const,
  costHint: {},
  deferLoading: false,
  requiresApproval: 'destructive' as const,
}
const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  requestId: 'r1',
  kind: 'tool',
  sessionKey: 's',
  stepId: '1/1',
  toolUseId: 't1',
  tool: { name: 'edit', args: { path: 'src/a.ts', edits: [] }, meta },
  summary: 'edit src/a.ts',
  risk: 'destructive',
  actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  taint: false,
  bindingHash: 'bh',
  deadline: '2999-01-01T00:00:00Z',
  scope: 'local',
  ...over,
})

/** The same request with no tool at all, which is what a budget or unknown-outcome question is. */
const withoutTool = (over: Partial<ApprovalRequest>): ApprovalRequest => {
  const { tool: _none, ...rest } = req(over)
  return rest as ApprovalRequest
}

// fakeSeamInit's workspace is /work/proj, which is what normalizeArgv resolves the path against.
const EDIT_ALLOW = { tool: 'edit|write', argv: '/work/proj/(?:[^/]+/)*[^/]+', action: 'allow' }

describe('approval-policy sync path', () => {
  it('allows by policy without asking anyone', async () => {
    const init = fakeSeamInit({ preset: { approval: { command_policy: [EDIT_ALLOW] } } })
    expect(await (await approvalPolicy(init)).ask(req())).toBe('allowed-once')
  })

  it('binds path normalization to the invocation workspace instead of the startup root', async () => {
    const init = fakeSeamInit({
      preset: {
        approval: {
          command_policy: [{ tool: 'edit', argv: '/work/other/src/a\\.ts', action: 'allow' }],
        },
      },
    })
    const seam = await approvalPolicy(init)
    expect(await seam.ask(req())).toBe('unavailable')
    const workspace = await seam.forWorkspace?.({ root: '/work/other' })
    expect(workspace).toBeDefined()
    expect(await workspace?.ask(req())).toBe('allowed-once')
  })

  it('rejects by policy deny', async () => {
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [{ tool: 'shell', argv: '^rm', action: 'deny' }] } },
    })
    const verdict = await (await approvalPolicy(init)).ask(
      req({
        tool: {
          name: 'shell',
          args: { command: 'rm -rf /' },
          meta: { ...meta, replay: 'never', requiresApproval: undefined },
        },
      }),
    )
    expect(verdict).toBe('rejected')
  })

  // A deny in the table beats the prompter too: nobody is asked a question whose answer is already
  // no, so an operator cannot click past it.
  it('does not ask the prompter about a denied call', async () => {
    let asked = 0
    const init = fakeSeamInit({
      preset: {
        approval: { command_policy: [EDIT_ALLOW, { tool: 'edit', argv: 'a\\.ts', action: 'deny' }] },
      },
      prompter: async () => {
        asked++
        return 'allowed-session'
      },
    })
    expect(await (await approvalPolicy(init)).ask(req())).toBe('rejected')
    expect(asked).toBe(0)
  })

  it('asks the prompter when no rule applies', async () => {
    const asked: string[] = []
    const init = fakeSeamInit({
      prompter: async (r) => {
        asked.push(r.summary)
        return 'allowed-session'
      },
    })
    expect(await (await approvalPolicy(init)).ask(req())).toBe('allowed-session')
    expect(asked).toEqual(['edit src/a.ts'])
  })

  it('asks about a tainted call even when a rule allows it', async () => {
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [EDIT_ALLOW] } },
      prompter: async () => 'rejected',
    })
    expect(await (await approvalPolicy(init)).ask(req({ taint: true }))).toBe('rejected')
  })

  // A delegated child's own scope is always `<parentKey>/<childUlid>` (the sole place core's
  // KernelChildren.createWithKind produces that separator); a top-level scope never contains one.
  // The child runs unattended, so falling through to "ask a human" here just means nobody answers
  // — the table's own allow rule is the only real answer available to it.
  it('lets the table answer a tainted call for a delegated child instead of asking nobody', async () => {
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [EDIT_ALLOW] } },
      prompter: async () => 'rejected',
    })
    expect(await (await approvalPolicy(init)).ask(req({ taint: true, scope: 'parent/childUlid' }))).toBe(
      'allowed-once',
    )
  })

  it('still asks a tainted, table-unmatched call for a delegated child', async () => {
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [{ tool: 'edit', argv: 'never-matches', action: 'allow' }] } },
      prompter: async () => 'rejected',
    })
    expect(await (await approvalPolicy(init)).ask(req({ taint: true, scope: 'parent/childUlid' }))).toBe(
      'rejected',
    )
  })

  it('never auto-allows a tool that asks always, whatever the table says', async () => {
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [{ tool: '.*', argv: '.*', action: 'allow' }] } },
    })
    const verdict = await (await approvalPolicy(init)).ask(
      req({ tool: { name: 'edit', args: {}, meta: { ...meta, requiresApproval: 'always' } } }),
    )
    expect(verdict).toBe('unavailable')
  })

  // require_approval is a match that does not end the question: it reaches the prompter like a miss.
  it('sends a require_approval match to the prompter rather than allowing it', async () => {
    let asked = 0
    const init = fakeSeamInit({
      preset: {
        approval: { command_policy: [{ tool: 'edit', argv: 'a\\.ts', action: 'require_approval' }] },
      },
      prompter: async () => {
        asked++
        return 'allowed-once'
      },
    })
    expect(await (await approvalPolicy(init)).ask(req())).toBe('allowed-once')
    expect(asked).toBe(1)
  })

  // The default with nothing configured: no rules, no prompter, so the answer is a refusal.
  it('is unavailable without a prompter, and when the prompter throws', async () => {
    expect(await (await approvalPolicy(fakeSeamInit())).ask(req())).toBe('unavailable')
    const broken = fakeSeamInit({
      prompter: async () => {
        throw new Error('ui gone')
      },
    })
    expect(await (await approvalPolicy(broken)).ask(req())).toBe('unavailable')
  })

  // A request with no tool - a budget quote, an unknown outcome - skips the command table entirely.
  // Deliberate, and asserted so nobody "fixes" it into matching rules written about command lines.
  it('a request with no tool bypasses the policy table and asks', async () => {
    const asked: string[] = []
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [{ tool: '.*', argv: '.*', action: 'allow' }] } },
      prompter: async (r) => {
        asked.push(r.kind)
        return 'rejected'
      },
    })
    const seam = await approvalPolicy(init)
    expect(await seam.ask(withoutTool({ kind: 'budget', risk: 'budget' }))).toBe('rejected')
    expect(await seam.ask(withoutTool({ kind: 'unknown-outcome', risk: 'unknown' }))).toBe('rejected')
    expect(asked).toEqual(['budget', 'unknown-outcome'])
  })

  // An argument that cannot be canonicalized is not a policy miss to be waved through; it is a
  // question for a human. It must reach the prompter, and must never be auto-allowed by a rule.
  it('an argv that cannot be canonicalized asks instead of matching a rule', async () => {
    let asked = 0
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [{ tool: 'read', argv: '.*', action: 'allow' }] } },
      prompter: async () => {
        asked++
        return 'rejected'
      },
    })
    const verdict = await (await approvalPolicy(init)).ask(
      req({ tool: { name: 'read', args: { path: 'a\u0000b.ts' }, meta } }),
    )
    expect(verdict).toBe('rejected')
    expect(asked).toBe(1)
  })

  it('an argv that cannot be canonicalized is unavailable when nobody is connected', async () => {
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [{ tool: 'read', argv: '.*', action: 'allow' }] } },
    })
    const verdict = await (await approvalPolicy(init)).ask(
      req({ tool: { name: 'read', args: { path: '../../etc/passwd' }, meta } }),
    )
    expect(verdict).toBe('unavailable')
  })

  // A whitespace-only shell command normalizes to the empty string, which is a value and not a
  // failure. It must still be matched against the table rather than treated as uncanonicalizable.
  it('matches an empty argv against the table instead of treating it as a failure', async () => {
    const init = fakeSeamInit({
      preset: { approval: { command_policy: [{ tool: 'shell', argv: '', action: 'allow' }] } },
    })
    const verdict = await (await approvalPolicy(init)).ask(
      req({ tool: { name: 'shell', args: { command: '   ' }, meta } }),
    )
    expect(verdict).toBe('allowed-once')
  })

  it('refuses to assemble against a table it cannot read', async () => {
    await expect(
      approvalPolicy(
        fakeSeamInit({
          preset: { approval: { command_policy: [{ tool: '^shell$', argv: 'ls', action: 'allow' }] } },
        }),
      ),
    ).rejects.toThrow(/anchor/)
  })

  // The parked half is not built. It rejects loudly rather than answering something allow-shaped:
  // a deployment configured to park and quietly told "fine" would run with nobody asked.
  it('fails loudly when configured to park, which is not implemented yet', async () => {
    const init = fakeSeamInit({ preset: { approval: { on_unavailable: 'park' } } })
    const seam = await approvalPolicy(init)
    await expect(seam.ask(req())).rejects.toThrow(/parking is not implemented/)
    await expect(seam.resume('t', 'allowed-once')).rejects.toThrow(/parking is not implemented/)
  })
})
