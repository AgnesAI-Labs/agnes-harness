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

describe('approval delivery', () => {
  it('exposes delivery and nothing else', async () => {
    expect(Object.keys(await approvalPolicy(fakeSeamInit()))).toEqual(['ask'])
  })

  it('hands the question to the prompter and returns its answer', async () => {
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

  it('delivers questions that carry no tool, such as a budget quote', async () => {
    const asked: string[] = []
    const init = fakeSeamInit({
      prompter: async (r) => {
        asked.push(r.kind)
        return 'rejected'
      },
    })
    const { tool: _none, ...rest } = req({ kind: 'budget', risk: 'budget' })
    expect(await (await approvalPolicy(init)).ask(rest as ApprovalRequest)).toBe('rejected')
    expect(asked).toEqual(['budget'])
  })

  it("hands the prompter's reason on untouched", async () => {
    const init = fakeSeamInit({ prompter: async () => ({ verdict: 'rejected', reason: 'user-rejected' }) })
    expect(await (await approvalPolicy(init)).ask(req())).toEqual({
      verdict: 'rejected',
      reason: 'user-rejected',
    })
  })

  it('is unavailable without a prompter, and when the prompter throws', async () => {
    expect(await (await approvalPolicy(fakeSeamInit())).ask(req())).toEqual({
      verdict: 'unavailable',
      reason: 'no-approver',
    })
    const broken = fakeSeamInit({
      prompter: async () => {
        throw new Error('ui gone')
      },
    })
    expect(await (await approvalPolicy(broken)).ask(req())).toEqual({
      verdict: 'unavailable',
      reason: 'transport',
    })
  })
})
