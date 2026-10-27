import { defaultToolPolicy, type ToolPolicy, type ToolPolicyInput } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { sessionCommandFloor, withCommandFloor } from '../src/command-table/floor.js'
import { normalizeArgv, type PolicyRule } from '../src/command-table/normalize.js'

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
/** What the official tools that run a command declare as `ToolMeta.commandArg`. */
const commandArgOf = (tool: string) => ({ shell: 'command', pty_send: 'text', run_code: 'code' })[tool]
/** What the official tools that name a path declare as `ToolMeta.paths[].nonWorkspaceSchemes`. */
const NON_WORKSPACE_SCHEMES: Record<string, readonly string[]> = {
  read: ['artifact', 'session-file', 'session-image'],
  ls: ['artifact'],
  grep: ['artifact'],
  find: ['artifact'],
}
const nonWorkspaceSchemesOf = (tool: string) => NON_WORKSPACE_SCHEMES[tool]
const decide = (
  rules: PolicyRule[],
  over: Partial<ToolPolicyInput> = {},
  base = defaultToolPolicy,
  schemes = nonWorkspaceSchemesOf,
) => withCommandFloor(base, rules, commandArgOf, undefined, schemes).decide(input(over), signal)

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

  it('admits only Host-classified external paths, preserving normalization, domain asks and denials', async () => {
    const managed = async () => ({ root: '/private/memory/workspace' })
    const external = input({
      call: { id: 'm', name: 'write', args: { path: '/private/memory/workspace/MEMORY.md' } },
    })
    const floor = withCommandFloor(defaultToolPolicy, [EDIT_ALLOW], commandArgOf, managed)
    expect((await floor.decide(external, signal)).effect).toBe('allow')
    expect((await withCommandFloor(defaultToolPolicy, [EDIT_ALLOW]).decide(external, signal)).effect).toBe(
      'deny',
    )
    for (const path of [
      '/private/memory/other/MEMORY.md',
      '/private/memory/workspace/a\\b',
      '/private/memory/workspace/a\0b',
    ])
      expect(
        (await floor.decide({ ...external, call: { ...external.call, args: { path } } }, signal)).effect,
      ).toBe('deny')
    const refusing: ToolPolicy = {
      id: 'read-only',
      version: '1',
      decide: () => ({ effect: 'deny', reason: 'read-only' }),
    }
    expect(
      (await withCommandFloor(refusing, [EDIT_ALLOW], commandArgOf, managed).decide(external, signal)).effect,
    ).toBe('deny')
    expect(
      (
        await withCommandFloor(
          defaultToolPolicy,
          [{ tool: 'write', argv: 'MEMORY', action: 'deny' }],
          commandArgOf,
          managed,
        ).decide(external, signal)
      ).effect,
    ).toBe('deny')
    expect(
      (
        await withCommandFloor(defaultToolPolicy, [EDIT_ALLOW], commandArgOf, async () => {
          throw new Error('identity unavailable')
        }).decide(external, signal)
      ).effect,
    ).toBe('deny')
    const exact: ToolPolicy = {
      id: 'domain',
      version: '1',
      decide: () => ({
        effect: 'ask',
        reason: 'diff',
        approval: { reviewerRequirement: 'human', grantConstraints: 'once', subjectRevision: 'a'.repeat(64) },
      }),
    }
    expect(
      (await withCommandFloor(exact, [EDIT_ALLOW], commandArgOf, managed).decide(external, signal)).effect,
    ).toBe('ask')
  })

  it('asks about a tainted call even when a rule allows it', async () => {
    expect((await decide([EDIT_ALLOW], { tainted: true })).effect).toBe('ask')
  })

  it('never auto-allows a tool that asks always, whatever the table says', async () => {
    const policy = { ...input().policy, requiresApproval: 'always' as const }
    expect((await decide([{ tool: '.*', argv: '.*', action: 'allow' }], { policy })).effect).toBe('ask')
  })

  it('matches an empty argv against the table instead of treating it as a failure', async () => {
    const call = { id: 't', name: 'shell', args: { command: '   ' } }
    expect((await decide([{ tool: 'shell', argv: '', action: 'allow' }], { call })).effect).toBe('allow')
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

  it('matches a rule against the command text of every tool that declares one', async () => {
    const rules: PolicyRule[] = [{ tool: 'shell|pty_send|run_code', argv: 'git push', action: 'deny' }]
    const calls = [
      { id: 't', name: 'shell', args: { command: 'git  push origin' } },
      { id: 't', name: 'pty_send', args: { jobId: 'j1', text: 'git push\n' } },
      { id: 't', name: 'run_code', args: { code: 'run("git push")' } },
    ]
    for (const call of calls) expect((await decide(rules, { call })).effect, call.name).toBe('deny')
    const status = { id: 't', name: 'pty_send', args: { jobId: 'j1', text: 'git status\n' } }
    expect((await decide(rules, { call: status })).effect).toBe('ask')
    // A rule names the tools it covers: one written for `shell` alone does not reach `pty_send`.
    const shellOnly: PolicyRule[] = [{ tool: 'shell', argv: 'git push', action: 'deny' }]
    expect((await decide(shellOnly, { call: calls[1] as never })).effect).toBe('ask')
  })

  it('matches a tool that declares no command on the canonical JSON of its arguments', async () => {
    const rules: PolicyRule[] = [{ tool: 'deploy', argv: '^\\{"env":"prod"\\}$', action: 'deny' }]
    const call = (env: string) => ({ id: 't', name: 'deploy', args: { env } })
    expect((await decide(rules, { call: call('prod') })).effect).toBe('deny')
    expect((await decide(rules, { call: call('dev') })).effect).toBe('ask')
  })

  it('gives one session a stable floor per policy and table, and the hard block even for an empty table', () => {
    const floor = sessionCommandFloor(commandArgOf)
    const bare = floor(defaultToolPolicy, [])
    expect(bare).not.toBe(defaultToolPolicy)
    expect(floor(defaultToolPolicy, undefined)).toBe(bare)
    const floored = floor(defaultToolPolicy, [EDIT_ALLOW])
    expect(floored).not.toBe(defaultToolPolicy)
    expect(floored.id).toBe(defaultToolPolicy.id)
    // A preset view rebuilt with the same rules is not a policy change; a different table is.
    expect(floor(defaultToolPolicy, [{ ...EDIT_ALLOW }])).toBe(floored)
    expect(floor(defaultToolPolicy, [{ ...EDIT_ALLOW, action: 'deny' }])).not.toBe(floored)
  })
})

describe('non-workspace URI identity', () => {
  // The bug this covers: a Windows workspace made every `session-file://` read fail its identity, so
  // the floor refused an ordinary attachment read with "blocked by the command policy".
  const root = 'C:\\work\\repo'
  const READ_POLICY: ToolPolicyInput['policy'] = {
    isReadOnly: true,
    isDestructive: false,
    replay: 'safe',
    requiresApproval: 'never',
    approvalScopes: [],
  }
  const read = (path: string): Partial<ToolPolicyInput> => ({
    workspaceRoot: root,
    cwd: root,
    call: { id: 't', name: 'read', args: { path } },
    policy: READ_POLICY,
  })
  const ask: ToolPolicy = { id: 'ask', version: '1', decide: () => ({ effect: 'ask', reason: 'review' }) }
  // Let no decision come from the policy under test: only the table and the identity may answer.
  const ALLOW_READ: PolicyRule = { tool: 'read', argv: '.*', action: 'allow' }

  it('admits a declared non-workspace scheme instead of refusing its identity', async () => {
    for (const path of [
      'session-file://6/1',
      'session-image://list',
      `artifact://${'a'.repeat(64)}`,
      // The locator the output guard writes for text it cut out of a result.
      `artifact://${'a'.repeat(64)}?size=123`,
    ])
      expect((await decide([ALLOW_READ], read(path))).effect, path).toBe('allow')
  })

  it('matches a rule against one canonical spelling rather than the spelling the model used', async () => {
    expect((await decide([], read('SESSION-FILE://06/01'), ask)).effect).toBe('ask')
    const exact: PolicyRule[] = [{ tool: 'read', argv: 'session-file://6/1', action: 'allow' }]
    expect((await decide(exact, read('SESSION-FILE://06/01'), ask)).effect).toBe('allow')
  })

  it.each([
    'session-file://../../x',
    'session-file://6/1/2',
    'session-file://LIST',
    'artifact://short',
    `artifact://${'a'.repeat(64)}?size=abc`,
    `artifact://${'a'.repeat(64)}?size=`,
    `artifact://${'a'.repeat(64)}?size=1&mode=2`,
    'private://x',
    'D:/other/file',
    'file:stream',
    '\\\\other\\share\\file',
    '../outside',
  ])('still refuses %s on a Windows workspace', async (path) => {
    expect((await decide([ALLOW_READ], read(path))).effect).toBe('deny')
  })

  it('only admits a scheme the tool itself declared', async () => {
    const undeclared = await decide(
      [ALLOW_READ],
      read('session-file://6/1'),
      defaultToolPolicy,
      () => undefined,
    )
    expect(undeclared.effect).toBe('deny')
  })

  it('gives one URI one identity across scheme case, digit padding and digest case', () => {
    const schemes = ['artifact', 'session-file', 'session-image']
    const id = (path: string, declared = schemes) =>
      normalizeArgv('read', { path }, root, undefined, undefined, declared)
    expect(id('SESSION-FILE://06/01')).toBe('session-file://6/1')
    expect(id('session-file://6/1')).toBe(id('session-file://06/01'))
    expect(id('session-image://list')).toBe('session-image://list')
    expect(id(`artifact://${'B'.repeat(64)}`)).toBe(`artifact://${'b'.repeat(64)}`)
    expect(id(`artifact://${'B'.repeat(64)}?size=0012`)).toBe(`artifact://${'b'.repeat(64)}?size=12`)
    // Size is part of the reference: the digest alone is not the locator the guard wrote.
    expect(id(`artifact://${'b'.repeat(64)}`)).not.toBe(id(`artifact://${'b'.repeat(64)}?size=12`))
    // Nothing else may be folded into an identity: the declaration widens which spellings are
    // identifiable, never which spellings are admitted.
    for (const path of [
      'session-file://6/1/2',
      'session-file://LIST',
      'artifact://short',
      `artifact://${'b'.repeat(64)}?size=abc`,
    ])
      expect(() => id(path), path).toThrow('NotCanonical')
    expect(() => normalizeArgv('read', { path: 'session-file://6/1' }, root)).toThrow('NotCanonical')
  })
})

describe('hard block', () => {
  const shell = (command: string) => ({ call: { id: 't', name: 'shell', args: { command } } })
  const allowAll: ToolPolicy = { ...defaultToolPolicy, decide: () => ({ effect: 'allow', reason: 'yolo' }) }

  it('refuses an unrecoverable command under every permission shape, with no table at all', async () => {
    for (const over of [{}, { fullAccess: true }, { approvalMode: 'off' as const }]) {
      for (const base of [defaultToolPolicy, allowAll])
        expect(
          (await decide([], { ...shell('sudo rm -rf /'), ...over }, base)).effect,
          JSON.stringify(over),
        ).toBe('deny')
    }
  })

  it('is not overridden by an allow rule, and leaves ordinary commands alone', async () => {
    const allow: PolicyRule = { tool: 'shell', argv: '.*', action: 'allow' }
    expect((await decide([allow], shell('git status; rm -rf ~'), allowAll)).effect).toBe('deny')
    expect((await decide([allow], shell('rm -rf ./build'))).effect).toBe('allow')
    expect((await decide([], shell('rm -rf ./build'))).effect).toBe('ask')
  })

  it('covers any tool that declares a command argument, not only the built-in shells', async () => {
    const declared = (tool: string) => (tool === 'acme_exec' ? 'cmdline' : undefined)
    const call = { id: 't', name: 'acme_exec', args: { cmdline: 'env rm -rf ~' } }
    const floor = withCommandFloor(allowAll, [], declared)
    expect((await floor.decide(input({ call, fullAccess: true }), signal)).effect).toBe('deny')
    expect(
      (await floor.decide(input({ call: { ...call, args: { cmdline: 'ls' } }, fullAccess: true }), signal))
        .effect,
    ).toBe('allow')
  })
})
