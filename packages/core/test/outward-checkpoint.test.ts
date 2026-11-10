import { presetDefaults } from '@agnes/core-common/step/preset'
import { outwardApprover } from '@agnes/core-effects/effects/approval-answer'
import type {
  ApprovalAnswer,
  ApprovalGrantsPort,
  ApprovalRequest,
  Pending,
} from '@agnes/core-effects/effects/seams'
import { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolDef, ToolMeta, ToolPolicy } from '@agnes/extension-api'
import type { DecisionSnapshot, ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { outwardCheckpointEnforced, withCommandFloor } from '../src/command-table/floor.js'
import { Kernel } from '../src/kernel.js'
import { LoopEventRegistry } from '../src/loop/events.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { automaticAnswer, humanDecisionActorAllowed } from '../src/step/decision-authority.js'
import { replacementFor } from '../src/step/reentry.js'
import type { ReplacementOperation } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps } from './helpers/open-session.js'

const clock = () => 1_757_203_200_000
const profileHash = `sha256-${'a'.repeat(64)}`
type Rule = import('../src/command-table/normalize.js').PolicyRule

/** The shell as the official tool declares it: destructive, open network, command in `command`. */
const SHELL: Partial<ToolMeta> = { isDestructive: true, commandArg: 'command' }
/** A plugin tool that declares `always` risk and open network, without saying it is outward. */
const ALWAYS: Partial<ToolMeta> = { requiresApproval: 'always' }
/** A tool that declares itself outward, as the companion's `publish` does. */
const OUTWARD: Partial<ToolMeta> = { requiresApproval: 'always', outward: true }

const META: Record<string, Partial<ToolMeta>> = {
  shell: SHELL,
  publish: OUTWARD,
  pty_open: { isDestructive: true },
  pty_send: { isDestructive: true, commandArg: 'text' },
  run_code: { requiresApproval: 'always', commandArg: 'code' },
}

function tool(name: string, meta: Partial<ToolMeta>, executed: unknown[]): ToolDef {
  return {
    name,
    description: name,
    parameters: Type.Object({}),
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      ...meta,
    },
    execute: async (args) => {
      executed.push(args)
      return { content: [{ type: 'text', text: 'ran' }] }
    },
  }
}

type Answer = ApprovalAnswer | Pending | ApprovalAnswer['verdict']
type Scenario = {
  tool?: string
  meta?: Partial<ToolMeta>
  /** A string is a `command` argument; an object is the whole argument set. */
  commands: Array<string | Record<string, unknown>>
  permission?: 'full-access'
  approvalMode?: 'manual' | 'off' | 'auto-review'
  commandTable?: Rule[]
  policy?: ToolPolicy
  /** The session has outward command rules on. */
  commandRules?: boolean
  /** What the approval seam answers. Omitted, the question parks for `answer`, as a client would. */
  seam?: (request: ApprovalRequest) => Answer
  /** An `Approval` segment replacement that approves everything in a person's name. */
  replaceApproval?: boolean
  /** A tool-call hook and a plugin loop-event handler, each giving the strongest yes a hook has. */
  hooks?: 'allow' | 'deny'
}

/** One session that runs the scripted calls to turn end, recording what reached a person and what ran. */
async function scenario(o: Scenario) {
  const executed: unknown[] = []
  const asked: ApprovalRequest[] = []
  const hookCalls: string[] = []
  const name = o.tool ?? 'shell'
  const registry = new ToolRegistry()
  registry.add(tool(name, o.meta ?? META[name] ?? ALWAYS, executed), {
    source: 'test',
    trust: 'builtin',
    packageIdentity: '@agnes/test-outward',
    packageVersion: '1.0.0',
  })
  const preset = presetDefaults()
  if (o.permission) preset.permission = o.permission
  // `run_code` is offered only where code disclosure is on.
  if (name === 'run_code') preset.disclosure = 'hybrid'
  if (o.commandTable) preset.approval = { ...preset.approval, commandTable: o.commandTable }
  const policies = new ToolPolicyRegistry()
  if (o.policy) {
    policies.register('fixture', o.policy)
    preset.approval.policy = o.policy.id
  }
  const loopEvents = new LoopEventRegistry()
  if (o.hooks)
    loopEvents.on('before_tool_call', (payload) => {
      hookCalls.push(`event:${payload.name}`)
      return o.hooks === 'allow' ? { allow: true } : { allow: false, reason: 'a plugin refused' }
    })
  const grants: Parameters<ApprovalGrantsPort['put']>[0][] = []
  let tickets = 0
  const h = await openSession({
    storage: new MemoryStorage({ clock }),
    clock,
    provider: fakeProvider([
      ...o.commands.map((command) => toolTurn(name, typeof command === 'string' ? { command } : command)),
      textTurn('done'),
    ]),
    registry,
    preset,
    toolPolicies: policies,
    loopEvents,
    ...(o.commandRules ? { outwardCommandRules: true as const } : {}),
    ...(o.approvalMode ? { approvalMode: o.approvalMode } : {}),
    ...(o.replaceApproval
      ? { operations: [approves], segments: { Approval: replacementFor([approves], 'Approval') } as never }
      : {}),
    resolvedProfileHash: profileHash,
    policyDigest: profileHash,
    approvalGrants: {
      list: async () => grants,
      put: async (grant) => {
        grants.push(grant)
      },
    },
    seams: fakeSeams({
      approval: {
        ask: async (request) => {
          asked.push(request)
          return (
            o.seam?.(request) ?? {
              ticket: `t${++tickets}`,
              expiresAt: new Date(clock() + 60_000).toISOString(),
            }
          )
        },
      },
    }),
  })
  if (o.hooks) {
    const hooks = h.session.hooks
    h.session.hooks = {
      ...hooks,
      toolCall: async (payload) => {
        hookCalls.push(`hook:${payload.name}:${payload.meta.outward === true}`)
        return o.hooks === 'allow' ? { allow: true } : { allow: false, reason: 'a hook refused' }
      },
    }
  }
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  const run = async () =>
    (await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason
  const decisions = () => [...h.session.state.registers.decisionStates.values()].map((cell) => cell.value)
  const pending = () =>
    decisions()
      .filter((value) => !value.result && !value.invalidation)
      .at(-1) as DecisionSnapshot | undefined
  const answer = (option: string, by = actor) => {
    const value = pending()
    if (!value) throw new Error('nothing pending')
    return h.session.decisions.answer(
      {
        handle: value.handle,
        revision: value.revision,
        commandId: `c${value.handle.id}${option}`,
        response: { option, value: null },
      },
      { actor: by, category: 'human', authorize() {} },
    )
  }
  const codes = async () =>
    (await h.log.scan({ type: 'tool/result', limit: 50 })).map(
      (row) => (row.data as { code?: string }).code ?? 'ok',
    )
  const answers = () =>
    decisions()
      .map((value) => (value.result?.reason === 'answered' ? value.result.response.option : undefined))
      .filter(Boolean)
  return { h, run, decisions, pending, answer, answers, asked, executed, grants, codes, hookCalls }
}

const approves: ReplacementOperation<'Approval'> = {
  name: 'approves-everything',
  slot: { replace: 'Approval' },
  replay: 'never',
  applicable: async () => 'applied',
  run: async () => ({}),
  replace: async () => ({ verdict: 'allowed-once', answeredBy: actor }),
}
const once = (): ApprovalAnswer => ({ verdict: 'allowed-once', answeredBy: actor })
const allowAll: ToolPolicy = {
  id: 'reviewer-allows',
  version: '1',
  decide: () => ({ effect: 'allow', reason: 'a reviewer approved' }),
}
const humanOnly: ToolPolicy = {
  id: 'human-only',
  version: '1',
  decide: () => ({
    effect: 'ask',
    reason: 'exact review',
    approval: { reviewerRequirement: 'human', grantConstraints: 'once', subjectRevision: 'b'.repeat(64) },
  }),
}

/**
 * The two ways a call is outward: a tool that says so, in any session; and a known command through
 * the shell, in a session with command rules on.
 */
const OUTWARD_CALLS = [
  ['shell git push with command rules', 'shell', 'git push origin main', { commandRules: true }],
  ['declared outward tool', 'publish', 'open the pull request', {}],
] as const

describe('outward checkpoint', () => {
  it.each(OUTWARD_CALLS)(
    '%s: offers only approve and reject, and runs on a person’s approval',
    async (_l, name, command, over) => {
      const t = await scenario({ tool: name, commands: [command], seam: once, ...over })
      expect(await t.run()).toBe('completed')
      expect(t.asked.map((request) => request.options)).toEqual([['allowed-once', 'rejected']])
      expect(t.asked[0]?.approval).toMatchObject({
        reviewerRequirement: 'human',
        grantConstraints: 'once',
        checkpoint: 'outward',
      })
      expect(t.executed).toHaveLength(1)
    },
  )

  it.each(OUTWARD_CALLS)(
    '%s: asks again for every call, under a fresh request',
    async (_l, name, command, over) => {
      const t = await scenario({ tool: name, commands: [command, command], seam: once, ...over })
      await t.run()
      expect(t.asked).toHaveLength(2)
      expect(new Set(t.asked.map((request) => request.requestId)).size).toBe(2)
      expect(t.executed).toHaveLength(2)
    },
  )

  /** Each automatic way to approve, with a control showing it does approve an ordinary call. */
  const automatic: Array<[string, Omit<Scenario, 'tool' | 'commands'>]> = [
    ['full access', { permission: 'full-access' }],
    ['approvals off', { approvalMode: 'off' }],
    ['full access with approvals off', { permission: 'full-access', approvalMode: 'off' }],
    ['a selected policy (stand-in reviewer) that allows', { policy: allowAll }],
    ['auto-review mode under full access', { permission: 'full-access', approvalMode: 'auto-review' }],
    [
      'a require_approval command rule under full access',
      { permission: 'full-access', commandTable: [{ tool: '.*', argv: '.*', action: 'require_approval' }] },
    ],
    ['a command-table allow rule', { commandTable: [{ tool: '.*', argv: '.*', action: 'allow' }] }],
  ]
  for (const [label, mode] of automatic) {
    it.each(OUTWARD_CALLS)(
      `%s: ${label} cannot approve it; with nobody answering it waits`,
      async (_l, name, command, over) => {
        const t = await scenario({ tool: name, commands: [command], ...mode, ...over })
        expect(await t.run()).toBe('parked')
        expect(t.asked).toHaveLength(1)
        expect(t.executed).toHaveLength(0)
        expect(t.pending()?.request.spec.options).toEqual(['allowed-once', 'rejected'])
      },
    )

    it(`control: ${label} runs an ordinary destructive shell call without asking`, async () => {
      const t = await scenario({ commands: ['npm install'], commandRules: true, ...mode })
      expect(await t.run()).toBe('completed')
      expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 1 })
    })
  }

  it.each(OUTWARD_CALLS)(
    '%s: a hook and a plugin handler that allow are consulted and cannot approve it',
    async (_l, name, command, over) => {
      const t = await scenario({
        tool: name,
        commands: [command],
        permission: 'full-access',
        hooks: 'allow',
        ...over,
      })
      expect(await t.run()).toBe('parked')
      expect(t.hookCalls).toEqual([`hook:${name}:${name === 'publish'}`, `event:${name}`])
      expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 1, executed: 0 })
    },
  )

  it.each(OUTWARD_CALLS)(
    '%s: control: a hook that refuses ends it unasked',
    async (_l, name, command, over) => {
      const t = await scenario({ tool: name, commands: [command], hooks: 'deny', ...over })
      expect(await t.run()).toBe('completed')
      expect({ asked: t.asked.length, executed: t.executed.length, codes: await t.codes() }).toEqual({
        asked: 0,
        executed: 0,
        codes: ['HOOK_DENIED'],
      })
    },
  )

  it.each(OUTWARD_CALLS)(
    '%s: an unavailable approver leaves it waiting, never allowed',
    async (_l, name, command, over) => {
      const t = await scenario({
        tool: name,
        commands: [command],
        permission: 'full-access',
        seam: () => 'unavailable',
        ...over,
      })
      expect(await t.run()).toBe('parked')
      expect(t.executed).toHaveLength(0)
      expect(t.pending()).toBeDefined()
    },
  )

  it.each(OUTWARD_CALLS)(
    '%s: an answer from the approval surface by anyone but a person is not taken',
    async (_l, name, command, over) => {
      for (const by of [
        { ...actor, role: 'system' },
        { ...actor, role: 'extension' },
        { ...actor, role: 'trigger' },
        { ...actor, attrs: { permissionPolicy: 'full-access' } },
      ]) {
        const t = await scenario({
          tool: name,
          commands: [command],
          seam: () => ({ verdict: 'allowed-once', answeredBy: by }),
          ...over,
        })
        expect(await t.run()).toBe('parked')
        expect(t.executed).toHaveLength(0)
        await expect(t.answer('allowed-once', by)).rejects.toThrow(/HUMAN_REQUIRED/)
        expect(t.pending()).toBeDefined()
      }
    },
  )

  it.each(OUTWARD_CALLS)(
    '%s: an Approval segment replacement does not answer it',
    async (_l, name, command, over) => {
      const t = await scenario({
        tool: name,
        commands: [command],
        permission: 'full-access',
        replaceApproval: true,
        ...over,
      })
      expect(await t.run()).toBe('parked')
      expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 1, executed: 0 })
    },
  )

  // The daemon's prompter never passes these on (see daemon-rpc permission-scope-outward.test.ts);
  // this is Core's own rule for any seam that does.
  it.each(OUTWARD_CALLS)(
    '%s: a session or lasting allowance from a seam is recorded as a rejection',
    async (_l, name, command, over) => {
      for (const verdict of ['allowed-session', 'allowed-permanent'] as const) {
        const t = await scenario({
          tool: name,
          commands: [command, command],
          seam: () => ({ verdict, answeredBy: actor }),
          ...over,
        })
        expect(await t.run()).toBe('completed')
        expect({ asked: t.asked.length, executed: t.executed.length, grants: t.grants.length }).toEqual({
          asked: 2,
          executed: 0,
          grants: 0,
        })
        expect(t.answers()).toEqual(['rejected', 'rejected'])
        expect(await t.codes()).toEqual(['APPROVAL_REJECTED', 'APPROVAL_REJECTED'])
      }
    },
  )

  // `approval.decide` reaches this path with the person's own option.
  it.each(OUTWARD_CALLS)(
    '%s: an unoffered answer to the pending decision is recorded as a rejection',
    async (_l, name, command, over) => {
      for (const option of [
        'allowed-session',
        'allowed-permanent',
        'allow_prefix_session',
        'something-else',
      ]) {
        const t = await scenario({ tool: name, commands: [command], ...over })
        expect(await t.run()).toBe('parked')
        await t.answer(option)
        expect(await t.run()).toBe('completed')
        expect(t.answers()).toEqual(['rejected'])
        expect(t.executed).toHaveLength(0)
      }
    },
  )

  it.each(OUTWARD_CALLS)('%s: a person’s rejection refuses it', async (_l, name, command, over) => {
    const t = await scenario({ tool: name, commands: [command], permission: 'full-access', ...over })
    expect(await t.run()).toBe('parked')
    await t.answer('rejected')
    expect(await t.run()).toBe('completed')
    expect({ executed: t.executed.length, codes: await t.codes() }).toEqual({
      executed: 0,
      codes: ['APPROVAL_REJECTED'],
    })
  })

  it.each(OUTWARD_CALLS)(
    '%s: a policy or command-table denial still refuses it without asking',
    async (_l, name, command, over) => {
      const denies: ToolPolicy = {
        id: 'denies',
        version: '1',
        decide: () => ({ effect: 'deny', reason: 'no' }),
      }
      for (const deny of [
        { policy: denies },
        { commandTable: [{ tool: '.*', argv: '.*', action: 'deny' as const }] },
      ]) {
        const t = await scenario({
          tool: name,
          commands: [command],
          permission: 'full-access',
          ...deny,
          ...over,
        })
        expect(await t.run()).toBe('completed')
        expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 0 })
      }
    },
  )

  it('a person’s approval under full access runs it once, and the next push asks again', async () => {
    const t = await scenario({
      commands: ['git push', 'git push'],
      permission: 'full-access',
      commandRules: true,
    })
    expect(await t.run()).toBe('parked')
    await t.answer('allowed-once')
    expect(await t.run()).toBe('parked')
    expect(t.executed).toHaveLength(1)
    await t.answer('allowed-once')
    expect(await t.run()).toBe('completed')
    expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 2, executed: 2 })
  })

  it.each([
    ['cd repo && git push -u origin feature'],
    ["bash -c 'gh pr create --fill'"],
    ['npm publish'],
    ['curl -X POST https://example.test/hook'],
    ['scp build.tgz host:/srv'],
    ['eval git push'],
  ])('holds `%s` under full access with command rules', async (command) => {
    const t = await scenario({ commands: [command], permission: 'full-access', commandRules: true })
    expect(await t.run()).toBe('parked')
    expect(t.executed).toHaveLength(0)
  })

  it.each([['npm install'], ['git commit -m push'], ['curl -fsSL https://example.test/x']])(
    'leaves `%s` to run unasked under full access with command rules',
    async (command) => {
      const t = await scenario({ commands: [command], permission: 'full-access', commandRules: true })
      expect(await t.run()).toBe('completed')
      expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 1 })
    },
  )
})

describe('a session with command rules on', () => {
  it.each([
    ['pty_open', { cwd: '/w' }],
    ['pty_send', { jobId: 'j1', text: 'git status\r' }],
    ['pty_send', { jobId: 'j1', text: '\u001b[A\r' }],
    ['shell', { command: 'ls', persistent: true }],
    ['shell', { command: 'ls', sessionId: 's1' }],
  ] as const)('refuses %s %j unasked, even under full access', async (name, args) => {
    const t = await scenario({ tool: name, commands: [args], permission: 'full-access', commandRules: true })
    expect(await t.run()).toBe('completed')
    expect({ asked: t.asked.length, executed: t.executed.length, codes: await t.codes() }).toEqual({
      asked: 0,
      executed: 0,
      codes: ['POLICY_DENIED'],
    })
  })

  it.each(['git push', 'ssh = paramiko.SSHClient()', 'scp = 3'])(
    'does not read run_code source %j as shell text',
    async (code) => {
      const t = await scenario({
        tool: 'run_code',
        commands: [{ code }],
        permission: 'full-access',
        commandRules: true,
      })
      expect(await t.run()).toBe('completed')
      expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 1 })
    },
  )
})

/** Default off: everything but a declared outward tool behaves as before the checkpoint existed. */
describe('a session without command rules', () => {
  it.each([
    ['shell', { command: 'git push origin main' }],
    ['shell', { command: 'git push', persistent: true }],
    ['pty_send', { jobId: 'j1', text: 'git push\r' }],
    ['pty_open', { cwd: '/w' }],
    ['run_code', { code: 'git push' }],
  ] as const)('runs %s %j unasked under full access', async (name, args) => {
    const t = await scenario({ tool: name, commands: [args], permission: 'full-access' })
    expect(await t.run()).toBe('completed')
    expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 1 })
  })

  it('offers a session grant for a push, as before', async () => {
    const t = await scenario({
      commands: ['git push', 'git push'],
      seam: () => ({ verdict: 'allowed-session', answeredBy: actor }),
    })
    await t.run()
    expect(t.asked[0]?.options).toContain('allowed-session')
    expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 1, executed: 2 })
  })
})

/** A tool that declares `always` risk without the outward marker keeps today's behavior. */
describe('an always-risk tool that is not outward', () => {
  it('full access runs it without asking', async () => {
    const t = await scenario({ tool: 'push_branch', commands: ['x'], permission: 'full-access' })
    expect(await t.run()).toBe('completed')
    expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 1 })
  })

  it('offers session and lasting grants, and a session grant covers the next call', async () => {
    const t = await scenario({
      tool: 'push_branch',
      commands: ['x', 'x'],
      seam: () => ({ verdict: 'allowed-session', answeredBy: actor }),
    })
    await t.run()
    expect(t.asked[0]?.options).toEqual(['allowed-once', 'allowed-session', 'allowed-permanent', 'rejected'])
    expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 1, executed: 2 })
  })

  it('an Approval segment replacement still answers it', async () => {
    const t = await scenario({ tool: 'push_branch', commands: ['x'], replaceApproval: true })
    expect(await t.run()).toBe('completed')
    expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 1 })
  })

  it('a human-only policy is still answered by full access', async () => {
    const t = await scenario({
      tool: 'push_branch',
      commands: ['x'],
      policy: humanOnly,
      permission: 'full-access',
    })
    await t.run()
    expect({ asked: t.asked.length, executed: t.executed.length }).toEqual({ asked: 0, executed: 1 })
  })
})

const catalogue = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const kernel = () =>
  Kernel.create({
    loops: defaultLoops(),
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider: Object.assign(fakeProvider([textTurn('child says hi')]), { models: () => [catalogue()] }),
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 2 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    timers: noTimers,
    clock,
  })
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

describe('outwardCheckpointEnforced', () => {
  it('is true only for a session policy with command rules on', async () => {
    const off = await scenario({ commands: [], permission: 'full-access' })
    const on = await scenario({ commands: [], permission: 'full-access', commandRules: true })
    expect(outwardCheckpointEnforced(on.h.session.toolPolicy())).toBe(true)
    expect(outwardCheckpointEnforced(off.h.session.toolPolicy())).toBe(false)
    expect(outwardCheckpointEnforced(withCommandFloor(allowAll, []))).toBe(false)
    // A policy that answers like the floor is still not the floor.
    const mimic: ToolPolicy = {
      id: 'mimic',
      version: '1',
      decide: () => ({
        effect: 'ask',
        reason: 'r',
        approval: {
          reviewerRequirement: 'human',
          grantConstraints: 'once',
          checkpoint: 'outward',
          subjectRevision: 'c'.repeat(64),
        },
      }),
    }
    expect(outwardCheckpointEnforced(mimic)).toBe(false)
  })

  it('a child inherits the switch, and an open session cannot be handed back without it', async () => {
    const k = kernel()
    const parent = await k.session('parent', { ...sessionOpts, outwardCommandRules: true })
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'first' })
    const childSession = k.get(child.key)
    expect(childSession?.d.outwardCommandRules).toBe(true)
    expect(childSession && outwardCheckpointEnforced(childSession.toolPolicy())).toBe(true)
    // A later caller that does not ask still gets the session with the switch on.
    expect(outwardCheckpointEnforced((await k.session('parent', sessionOpts)).toolPolicy())).toBe(true)
    await k.session('plain', { ...sessionOpts, writerRunId: 'r2' })
    await expect(
      k.session('plain', { ...sessionOpts, writerRunId: 'r2', outwardCommandRules: true }),
    ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
    await child.run('first')
    // A fork of a switched-on parent opened without asking still has it.
    const fork = await k.session('fork', {
      ...sessionOpts,
      writerRunId: 'r3',
      parent: { key: parent.key, boundarySeq: parent.lastSeq },
    })
    expect(outwardCheckpointEnforced(fork.toolPolicy())).toBe(true)
    await k.close()
  })
})

describe('automatic answers', () => {
  const spec = (approval: unknown) =>
    ({
      key: 'k',
      purpose: 'tool.permission',
      subject: { approval },
      prompt: 'p',
      options: ['allowed-once', 'rejected'],
    }) as never
  const outward = {
    reviewerRequirement: 'human',
    grantConstraints: 'once',
    checkpoint: 'outward',
    subjectRevision: 'c'.repeat(64),
  }
  const core = { owner: 'core/tool-permission', sourcePackage: '@agnes/core' }
  const context = { policy: 'full-access', actor, sessionKey: 'k', sessionId: 's', epoch: 0 }

  it('full access, including a role that follows its parent, answers everything but an outward checkpoint', () => {
    for (const s of [
      { permissionContext: context },
      { permissionContext: context, refuseApprovals: true, delegatedFullAccess: true },
    ]) {
      expect(automaticAnswer(s as never, spec(null), true, core)).toBeDefined()
      expect(automaticAnswer(s as never, spec(outward), true, core)).toBeUndefined()
    }
  })

  it('only the person roles answer an outward checkpoint; other questions keep their rules', () => {
    const answers = (role: string, approval: unknown) =>
      humanDecisionActorAllowed(
        {} as never,
        { actor: { ...actor, role }, category: 'human', authorize() {} } as never,
        spec(approval),
      )
    expect(['owner', 'user'].map((role) => answers(role, outward))).toEqual([true, true])
    expect(
      ['system', 'agent', 'extension', 'trigger', 'importer', 'admin', ''].map((role) =>
        answers(role, outward),
      ),
    ).toEqual([false, false, false, false, false, false, false])
    expect(['system', 'extension', 'admin'].map((role) => answers(role, null))).toEqual([true, true, true])
    expect(
      outwardApprover({ ...actor, attrs: { confirmationMode: 'auto-confirmed under full access' } }),
    ).toBe(false)
  })
})
