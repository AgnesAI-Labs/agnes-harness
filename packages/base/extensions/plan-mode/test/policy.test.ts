import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef, ToolPolicyInput } from '@agnes/extension-api'
import { defaultToolPolicy } from '@agnes/extension-api'
import { AGH_DIR } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import planMode from '../src/index.js'
import { decidePlanMode } from '../src/policy.js'
import { applyPlanCommand, readPlanMode } from '../src/state.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-plan-'))
  dirs.push(dir)
  return dir
}

function input(workspaceRoot: string, name: string, readOnly: boolean, cwd = workspaceRoot): ToolPolicyInput {
  return {
    sessionKey: 's',
    workspaceRoot,
    cwd,
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    call: { id: 'c', name, args: {} },
    policy: {
      isReadOnly: readOnly,
      isPresentational: false,
      isDestructive: !readOnly,
      replay: 'never',
      requiresApproval: 'destructive',
      approvalScopes: [],
    },
    tainted: false,
    fullAccess: true,
    approvalMode: 'off',
  }
}

describe('plan mode policy', () => {
  it.each([false, true])('blocks write and exec with a different execution directory: %s', (different) => {
    const root = workspace()
    const cwd = different ? workspace() : root
    if (different) applyPlanCommand(cwd, '/plan off')
    const signal = new AbortController().signal
    applyPlanCommand(root, '/plan ship the smallest change')
    expect(readPlanMode(root)).toMatchObject({ active: true, instruction: 'ship the smallest change' })
    expect(decidePlanMode(input(root, 'shell', false, cwd), signal, defaultToolPolicy)).toEqual({
      effect: 'deny',
      reason: 'Plan mode blocks write and exec tools until the plan is approved',
    })
    expect(
      decidePlanMode(input(root, 'subagent_spawn', false, cwd), signal, defaultToolPolicy),
    ).toMatchObject({
      effect: 'deny',
    })
    expect(decidePlanMode(input(root, 'read', true, cwd), signal, defaultToolPolicy)).toEqual({
      effect: 'allow',
      reason: 'Default tool policy',
    })
    expect(decidePlanMode(input(root, 'exit_plan_mode', false, cwd), signal, defaultToolPolicy)).toEqual({
      effect: 'ask',
      reason: 'Approve the plan to leave plan mode',
    })
    applyPlanCommand(root, '/plan off')
    if (different) applyPlanCommand(cwd, '/plan')
    expect(decidePlanMode(input(root, 'shell', false, cwd), signal, defaultToolPolicy)).toEqual({
      effect: 'allow',
      reason: 'Default tool policy',
    })
  })

  it('fail-closes a corrupt plan file to inactive', () => {
    const cwd = workspace()
    applyPlanCommand(cwd, '/plan')
    writeFileSync(join(cwd, AGH_DIR, 'plan-mode.json'), '{')
    expect(readPlanMode(cwd).active).toBe(false)
  })
})

describe('plan mode extension', () => {
  it('asks with the plan text and clears the file only when exit_plan_mode executes', async () => {
    const cwd = workspace()
    applyPlanCommand(cwd, '/plan')
    const tools: ToolDef[] = []
    const hooks = new Map<
      string,
      (payload: unknown, ctx: { session: { workspaceRoot: string } }) => unknown
    >()
    planMode({
      registerTool(tool: ToolDef) {
        tools.push(tool)
        return () => undefined
      },
      registerHook(
        name: string,
        handler: (payload: unknown, ctx: { session: { workspaceRoot: string } }) => unknown,
      ) {
        hooks.set(name, handler)
        return () => undefined
      },
    } as never)
    const tool = tools.find((item) => item.name === 'exit_plan_mode')
    const ctx = { session: { workspaceRoot: cwd } }
    expect(hooks.get('context')?.({}, ctx)).toMatchObject({
      sections: [{ id: 'plan-mode', order: 162 }],
    })
    const approval = hooks.get('approval_request')?.(
      { request: { tool: 'exit_plan_mode', argv: { plan: 'do the small thing' } } },
      ctx,
    ) as { request?: { summary?: string } }
    expect(approval.request?.summary).toContain('do the small thing')
    expect(readPlanMode(cwd).active).toBe(true)
    const executionDirectory = workspace()
    applyPlanCommand(executionDirectory, '/plan off')
    const result = await tool?.execute({ plan: 'do the small thing' }, {
      ...ctx,
      cwd: executionDirectory,
    } as never)
    expect(readPlanMode(executionDirectory)).toMatchObject({ active: false })
    expect(readPlanMode(executionDirectory).pendingPlan).toBeUndefined()
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('Plan mode is off') }] })
    expect(readPlanMode(cwd)).toMatchObject({ active: false, pendingPlan: 'do the small thing' })
    expect(hooks.get('context')?.({}, ctx)).toEqual({})
  })
})
