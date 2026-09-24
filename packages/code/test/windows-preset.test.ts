import { presets as basePresets, seams } from '@agnes/base'
import { fakeSeamInit } from '@agnes/base/testkit'
import { type ApprovalRequest, readPreset } from '@agnes/core'
import { resolvePreset } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { loadAllPresets } from '../src/presets/load.js'

const docs = { ...basePresets, ...loadAllPresets() }
const approvalPolicy = seams.approval
const preset = resolvePreset('standard-windows', docs).doc
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

describe('standard-windows through the real approval seam', () => {
  it('gives Skill import enough time for bounded GitHub reads and source approval', () => {
    const tools = readPreset(preset, 'standard-windows').tools
    expect(tools.timeoutMs).toBe(120_000)
    expect(tools.timeouts.web_fetch).toBe(30_000)
    expect(tools.timeouts.skill_helper_import).toBe(240_000)
    expect(tools.timeouts.skill_helper_install).toBeUndefined()
  })
  it('inherits all non-policy behavior from standard', () => {
    const standard = resolvePreset('standard', docs).doc
    expect({ ...preset, name: standard.name, approval: standard.approval }).toEqual(standard)
  })
  it.each(['C:\\work\\repo', '\\\\server\\share\\repo'])(
    'approves contained edits under %s',
    async (root) => {
      const seam = await approvalPolicy(fakeSeamInit({ workspaceRoot: root, preset }))
      for (const path of ['CODE.txt', '中文 空格\\file.txt', `${root}\\src\\file.txt`]) {
        expect(await seam.ask(request(path))).toBe('allowed-once')
      }
      for (const path of ['../outside', 'D:/other/file', 'NUL', 'file:stream', '\\\\other\\share\\file']) {
        expect(await seam.ask(request(path))).toBe('unavailable')
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
