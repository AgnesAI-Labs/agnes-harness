import { defaultToolPolicy, type ToolPolicy, type ToolPolicyInput } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { withCommandFloor, withCommandFloorRegistry } from '../src/command-table/floor.js'
import type { PolicyRule } from '../src/command-table/normalize.js'

const input = (over: Partial<ToolPolicyInput> = {}): ToolPolicyInput => ({
  sessionKey: 's',
  workspaceRoot: '/work/proj',
  cwd: '/work/proj',
  actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  call: { id: 't1', name: 'edit', args: { path: 'src/a.ts', edits: [] } },
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
  ...over,
})

const EDIT_ALLOW: PolicyRule = { tool: 'edit|write', argv: '/work/proj/(?:[^/]+/)*[^/]+', action: 'allow' }
const signal = new AbortController().signal
const decide = (rules: PolicyRule[], over: Partial<ToolPolicyInput> = {}, base = defaultToolPolicy) =>
  withCommandFloor(base, rules).decide(input(over), signal)

describe('command floor', () => {
  it('lets an allow rule answer a call the selected policy would ask about', async () => {
    expect(await decide([EDIT_ALLOW])).toMatchObject({ effect: 'allow' })
  })

  it('denies by rule, ahead of an allow and of the selected policy, even in full access', async () => {
    const rules: PolicyRule[] = [EDIT_ALLOW, { tool: 'edit', argv: 'a\\.ts', action: 'deny' }]
    expect(await decide(rules)).toEqual({ effect: 'deny', reason: 'blocked by the command policy' })
    expect((await decide(rules, { fullAccess: true })).effect).toBe('deny')
  })

  it('does not narrow calls no deny rule matches', async () => {
    const rules: PolicyRule[] = [{ tool: 'shell', argv: '^rm', action: 'deny' }]
    const pwd = { id: 't', name: 'shell', args: { command: 'pwd' } }
    const rm = { id: 't', name: 'shell', args: { command: 'rm -rf /' } }
    expect((await decide(rules, { call: pwd })).effect).toBe('ask')
    expect((await decide(rules, { call: rm })).effect).toBe('deny')
  })

  it('refuses a call whose arguments have no canonical identity', async () => {
    const call = { id: 't', name: 'edit', args: { path: 'a\0b' } }
    expect((await decide([EDIT_ALLOW], { call })).effect).toBe('deny')
  })

  it('asks about a tainted call even when a rule allows it', async () => {
    expect((await decide([EDIT_ALLOW], { tainted: true })).effect).toBe('ask')
  })

  it('never auto-allows a tool that asks always, whatever the table says', async () => {
    const policy = { ...input().policy, requiresApproval: 'always' as const }
    expect((await decide([{ tool: '.*', argv: '.*', action: 'allow' }], { policy })).effect).toBe('ask')
  })

  it('treats require_approval like a miss', async () => {
    expect((await decide([{ tool: 'edit', argv: 'a\\.ts', action: 'require_approval' }])).effect).toBe('ask')
  })

  // A third-party policy may tighten the floor's answer, never loosen it.
  it('keeps a selected policy’s own deny and human-only requirement over a table allow', async () => {
    const deny: ToolPolicy = { id: 'x', version: '1', decide: () => ({ effect: 'deny', reason: 'no' }) }
    expect((await decide([EDIT_ALLOW], {}, deny)).effect).toBe('deny')
    const human: ToolPolicy = {
      id: 'h',
      version: '1',
      decide: () => ({
        effect: 'ask',
        reason: 'exact content',
        approval: { reviewerRequirement: 'human', grantConstraints: 'once', subjectRevision: 'a'.repeat(64) },
      }),
    }
    expect((await decide([EDIT_ALLOW], {}, human)).effect).toBe('ask')
  })

  it('applies to a third-party policy that would allow everything, for a denied call', async () => {
    const open: ToolPolicy = { id: 'open', version: '1', decide: () => ({ effect: 'allow', reason: 'ok' }) }
    const rules: PolicyRule[] = [{ tool: 'edit', argv: 'a\\.ts', action: 'deny' }]
    expect((await decide(rules, {}, open)).effect).toBe('deny')
  })

  it('wraps every policy a registry resolves, stably, and is absent for an empty table', () => {
    const registry = {
      register: () => async () => undefined,
      resolve: () => defaultToolPolicy,
      catalog: () => [],
    }
    expect(withCommandFloorRegistry(registry, [])).toBe(registry)
    const floored = withCommandFloorRegistry(registry, [EDIT_ALLOW])
    expect(floored.resolve('default')).toBe(floored.resolve('default'))
    expect(floored.resolve('default')).not.toBe(defaultToolPolicy)
    expect(floored.resolve('default').id).toBe(defaultToolPolicy.id)
  })
})
