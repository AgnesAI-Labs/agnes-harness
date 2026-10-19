import { BASE_SEAM_PROVIDERS, presets as basePresets } from '@agnes/base'
import { fakeSeamInit } from '@agnes/base/testkit'
import { loadAllPresets } from '@agnes/code'
import { type ApprovalRequest, readPreset } from '@agnes/core'
import { readCommandRules, withCommandFloor } from '@agnes/core/command-table'
import { defaultToolPolicy, type ToolPolicyInput } from '@agnes/extension-api'
import { resolvePreset } from '@agnes/host'
import { describe, expect, it } from 'vitest'

const docs = { ...basePresets, ...loadAllPresets() }
const approvalPolicy = (init: Parameters<typeof BASE_SEAM_PROVIDERS.approval.create>[0]) =>
  BASE_SEAM_PROVIDERS.approval.create(init, new AbortController().signal)
const request = (path: string): ApprovalRequest => ({
  requestId: 'r',
  kind: 'tool',
  sessionKey: 's',
  stepId: '1/1',
  toolUseId: 't',
  tool: {
    name: 'edit',
    args: { path, edits: [] },
    meta: {
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'idempotent',
      costHint: {},
      deferLoading: false,
      requiresApproval: 'destructive',
    },
  },
  summary: 'edit',
  risk: 'destructive',
  actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  taint: false,
  bindingHash: 'binding',
  deadline: '2999-01-01T00:00:00Z',
  scope: 'local',
})

describe.each(['standard', 'standard-windows'])('%s command floor and approval delivery', (name) => {
  const preset = resolvePreset(name, docs).doc
  it('gives Skill import enough time for bounded GitHub reads and source approval', () => {
    const tools = readPreset(preset, 'standard-windows').tools
    expect(tools.timeoutMs).toBe(120_000)
    expect(tools.timeouts.web_fetch).toBe(30_000)
    expect(tools.timeouts.skill_helper_import).toBe(240_000)
    expect(tools.timeouts.skill_helper_install).toBeUndefined()
  })
  it('inherits all non-policy behavior from standard', () => {
    const standard = resolvePreset('standard', docs).doc
    // It states its own permission (table, sandbox, isolation), so it takes no overlay; the explicit
    // default tool policy the overlay adds to `standard` is the only other difference.
    expect({
      ...preset,
      name: standard.name,
      approval: standard.approval,
      providers: standard.providers,
    }).toEqual(standard)
  })
  it.each(['C:\\work\\repo', '\\\\server\\share\\repo'])(
    'approves contained edits under %s',
    async (root) => {
      const seam = await approvalPolicy(fakeSeamInit({ workspaceRoot: root, preset }))
      const approval = preset.approval
      if (!approval || typeof approval !== 'object' || !('command_policy' in approval))
        throw new Error('Windows preset must declare a command policy')
      const floor = withCommandFloor(defaultToolPolicy, readCommandRules(approval.command_policy))
      const decide = (path: string) => {
        const req = request(path)
        const input: ToolPolicyInput = {
          sessionKey: req.sessionKey,
          workspaceRoot: root,
          cwd: root,
          actor: req.actor,
          call: { id: 't', name: 'edit', args: { path, edits: [] } },
          policy: {
            isReadOnly: false,
            isDestructive: true,
            replay: 'idempotent',
            requiresApproval: 'destructive',
            approvalScopes: ['tool:edit:execute'],
          },
          tainted: false,
          fullAccess: false,
          approvalMode: 'manual',
        }
        return floor.decide(input, new AbortController().signal)
      }
      for (const path of ['CODE.txt', '中文 空格\\file.txt', `${root}\\src\\file.txt`]) {
        expect(await decide(path)).toMatchObject({ effect: 'allow' })
        expect(await seam.ask(request(path))).toEqual({ verdict: 'unavailable', reason: 'no-approver' })
      }
      for (const path of ['../outside', 'D:/other/file', 'NUL', 'file:stream', '\\\\other\\share\\file']) {
        expect(await decide(path)).toMatchObject({ effect: 'deny' })
      }
    },
  )
  it('keeps shell, tainted edits and always-approval tools with the operator', async () => {
    let asked = 0
    const seam = await approvalPolicy(
      fakeSeamInit({
        workspaceRoot: 'C:\\work\\repo',
        preset,
        prompter: async () => {
          asked++
          return 'rejected'
        },
      }),
    )
    const edit = request('file.txt')
    if (!edit.tool) throw new Error('test request must carry a tool')
    expect(await seam.ask({ ...edit, taint: true })).toBe('rejected')
    expect(
      await seam.ask({
        ...edit,
        tool: { ...edit.tool, meta: { ...edit.tool.meta, requiresApproval: 'always' } },
      }),
    ).toBe('rejected')
    expect(
      await seam.ask({ ...edit, tool: { ...edit.tool, name: 'shell', args: { command: 'echo hello' } } }),
    ).toBe('rejected')
    expect(asked).toBe(3)
  })
})
