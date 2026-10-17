import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef, ToolPolicyInput } from '@agnes/extension-api'
import { defaultToolPolicy } from '@agnes/extension-api'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { AGH_DIR } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import planMode from '../src/index.js'
import { decidePlanMode } from '../src/policy.js'
import { createPlanServices } from '../src/services.js'
import { applyPlanCommand, clearPlanMode, planModePath, readPlanMode } from '../src/state.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it.each(['live', 'unknown', 'malformed', 'empty'] as const)(
  'preserves the plan and refuses /plan off when lock owner liveness is %s',
  (liveness) => {
    const root = workspace()
    applyPlanCommand(root, '/plan keep this plan')
    const path = planModePath(root)
    const plan = readFileSync(path, 'utf8')
    const lock =
      liveness === 'empty'
        ? ''
        : liveness === 'malformed'
          ? '{'
          : JSON.stringify({ pid: process.pid, startToken: `0-${randomUUID()}` })
    writeFileSync(`${path}.lock`, lock)
    if (liveness === 'live' || liveness === 'unknown') {
      const old = new Date(Date.now() - 60_000)
      utimesSync(`${path}.lock`, old, old)
    }
    if (liveness === 'unknown')
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('liveness unavailable'), { code: 'EPERM' })
      })
    expect(() => applyPlanCommand(root, '/plan off')).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    expect(readFileSync(path, 'utf8')).toBe(plan)
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(lock)
  },
)

it.each(['', '{'])('reclaims an aged incomplete lock without losing the plan: %j', (contents) => {
  const root = workspace()
  applyPlanCommand(root, '/plan keep this plan')
  const path = planModePath(root)
  writeFileSync(`${path}.lock`, contents)
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${path}.lock`, old, old)
  expect(applyPlanCommand(root, '/plan off')).toEqual({ active: false, text: 'Plan mode is off' })
  expect(readPlanMode(root).active).toBe(false)
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
    const unchanged = readPlanMode(root).revision
    expect(applyPlanCommand(root, '/plan status')).toEqual({ active: true, text: 'Plan mode is on' })
    expect(applyPlanCommand(root, '/plan pending')).toEqual({ active: true, text: 'No pending plan' })
    expect(readPlanMode(root).revision).toBe(unchanged)

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
      approval: {
        reviewerRequirement: 'human',
        grantConstraints: 'once',
        subjectRevision: readPlanMode(root).revision,
      },
    })
    applyPlanCommand(root, '/plan off')
    if (different) applyPlanCommand(cwd, '/plan')
    expect(decidePlanMode(input(root, 'shell', false, cwd), signal, defaultToolPolicy)).toEqual({
      effect: 'allow',
      reason: 'Default tool policy',
    })
  })

  it('keeps a corrupt plan file blocked', () => {
    const cwd = workspace()
    applyPlanCommand(cwd, '/plan')
    writeFileSync(join(cwd, AGH_DIR, 'plan-mode.json'), '{')
    expect(readPlanMode(cwd)).toMatchObject({ active: true, blocked: true })
    for (const name of ['shell', 'read', 'exit_plan_mode'])
      expect(
        decidePlanMode(input(cwd, name, name === 'read'), new AbortController().signal, defaultToolPolicy),
      ).toMatchObject({ effect: 'deny' })
  })
})

it('clears only the reviewed revision once, including same-content rewrites', () => {
  const root = workspace()
  applyPlanCommand(root, '/plan original')
  const first = readPlanMode(root).revision!
  applyPlanCommand(root, '/plan original')
  const second = readPlanMode(root).revision!
  expect(second).not.toBe(first)
  expect(clearPlanMode(root, first, 'stale')).toBe(false)
  expect(readPlanMode(root)).toMatchObject({ active: true, revision: second })
  expect(clearPlanMode(root, second, 'reviewed')).toBe(true)
  expect(clearPlanMode(root, second, 'duplicate')).toBe(false)
  expect(readPlanMode(root)).toMatchObject({ active: false, pendingPlan: 'reviewed' })
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
    extensionFactoryOf(planMode)({
      ctx: { signal: new AbortController().signal },
      providers: { register: () => async () => undefined },
      registerService: () => () => undefined,
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
    const missing = await tool?.execute({ plan: 'unreviewed' }, {
      ...ctx,
      signal: new AbortController().signal,
    } as never)
    expect(missing).toMatchObject({ isError: true })
    expect(readPlanMode(cwd).active).toBe(true)
    const result = await tool?.execute({ plan: 'do the small thing' }, {
      ...ctx,
      cwd: executionDirectory,
      signal: new AbortController().signal,
      approval: {
        subjectRevision: readPlanMode(cwd).revision,
        answeredBy: input(cwd, '', false).actor,
        requestId: 'review',
      },
    } as never)
    expect(readPlanMode(executionDirectory)).toMatchObject({ active: false })
    expect(readPlanMode(executionDirectory).pendingPlan).toBeUndefined()
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('Plan mode is off') }] })
    expect(readPlanMode(cwd)).toMatchObject({ active: false, pendingPlan: 'do the small thing' })
    expect(hooks.get('context')?.({}, ctx)).toEqual({})
  })
})

it('serves canonical plan operations, reads existing state and leaves disabled mode off without writes', async () => {
  const root = workspace()
  let available = true
  const services = createPlanServices(() => available)
  const status = services.find((service) => service.name === 'plan.status')
  const command = services.find((service) => service.name === 'plan.command')
  if (!status || !command) throw new Error('Plan services missing')
  const ctx = { session: { workspaceRoot: root }, actor: { role: 'user' }, source: 'plan-admin' } as never
  applyPlanCommand(root, '/plan')
  writeFileSync(
    join(root, AGH_DIR, 'plan-mode.json'),
    JSON.stringify({
      active: true,
      instruction: 'existing instruction',
      pendingPlan: 'existing pending',
      updatedAt: '2026-10-01T00:00:00Z',
    }),
  )
  await expect(status.handler({}, ctx)).resolves.toMatchObject({
    active: true,
    instruction: 'existing instruction',
    pendingPlan: 'existing pending',
  })
  await expect(command.handler({ line: '/plan pending' }, ctx)).resolves.toMatchObject({
    text: 'existing pending',
  })
  await expect(command.handler({ line: '/plan new instruction' }, ctx)).resolves.toMatchObject({
    active: true,
  })
  expect(readPlanMode(root)).toMatchObject({ instruction: 'new instruction' })
  available = false
  const revision = readPlanMode(root).revision
  await expect(command.handler({ line: '/plan off' }, ctx)).resolves.toMatchObject({
    active: false,
    text: expect.stringContaining('unavailable'),
  })
  await expect(status.handler({}, ctx)).resolves.toMatchObject({ active: false })
  expect(readPlanMode(root).revision).toBe(revision)
  available = true
  await expect(
    command.handler({ line: '/plan off' }, {
      session: { workspaceRoot: root },
      actor: { role: 'extension' },
      source: 'client-web',
    } as never),
  ).rejects.toThrow('human workspace control')
  await command.handler({ line: '/plan off' }, ctx)
  expect(readPlanMode(root).active).toBe(false)
})
