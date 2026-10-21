import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ModelRecord } from '@agnes/protocol'
import { expect, expectTypeOf, it, vi } from 'vitest'
import type { DefaultSelection, LiteralCeiling } from '../src/child/role-authority.js'
import { readRoleDelegation } from '../src/child/role-snapshot.js'
import { intersectRoleToolPolicy, ROLE_DELEGATION, type RoleDelegation } from '../src/child/roles.js'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps, writeTool } from './helpers/open-session.js'

const options = { actor, resolvedProfileHash: 'review', cwd: '/w', writerRunId: 'review' }
const captured = (): RoleDelegation => ({
  role: { ref: '@fixture/roles#reader', title: { en: 'Reader' } },
  parentKey: 'parent',
  actor,
  tools: [],
  generationLimit: 3,
  maxFanOut: 2,
  permission: 'read-only',
  approvalPolicy: 'never',
  parentPolicy: 'default',
  parentTainted: false,
  sandboxRequired: true,
  filesystem: fakeSeams().sandbox.fsPolicy(),
})
const make = (storage = new MemoryStorage(), provider = fakeProvider([textTurn('done')])) =>
  Kernel.create({
    loops: defaultLoops(),
    storage,
    seams: fakeSeams(),
    provider: Object.assign(provider, {
      models: (): ModelRecord[] => [
        {
          id: 'm1',
          name: 'm1',
          route: 'default',
          api: 'openai-completions',
          baseUrl: 'https://example.invalid',
          reasoning: false,
          input: ['text'],
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 128,
          toolCallFormats: ['native'],
          thinkingReplay: 'native',
          contract_id: null,
        },
      ],
    }),
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), generationLimit: 3, maxFanOut: 2, treeBudgetCredits: 100 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    timers: noTimers,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })

it('keeps default selections and literal ceilings distinct at the type boundary', () => {
  expectTypeOf<DefaultSelection>().not.toMatchTypeOf<LiteralCeiling>()
  expectTypeOf<LiteralCeiling>().not.toMatchTypeOf<DefaultSelection>()
})

it.each(['untrusted-core', 'ext-register', 'tombstone'] as const)(
  'review-role: %s rows cannot replace the captured authority on reopen',
  async (kind) => {
    const storage = new MemoryStorage()
    const first = make(storage)
    const child = await first.session('child', { ...options, roleDelegation: captured() })
    expect(child.d.roleDelegation).toEqual(captured())
    expect(child.d.log.latest(ROLE_DELEGATION)).toEqual(captured())
    const forged = {
      ...captured(),
      permission: 'workspace-write',
      tools: ['write_note'],
      role: { ref: '@fixture/roles#writer', title: { en: 'Forged Writer' } },
    }
    await child.append([
      child.ev(
        kind === 'ext-register' ? 'x/fixture/authority' : ROLE_DELEGATION,
        kind === 'tombstone' ? null : forged,
        { origin: 'ext:fixture', trust: 'untrusted', ignorable: true, register: ROLE_DELEGATION },
      ),
    ])
    await first.close()
    const second = make(storage, fakeProvider([toolTurn('write_note', {}), textTurn('done')]))
    const effect = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'unauthorized write' }] }))
    second.tools.add(writeTool(effect), { source: 'fixture', trust: 'trusted' })
    try {
      const reopened = await second.session('child', { ...options, roleDelegation: captured() })
      await reopened.enqueue('next-turn', { content: [{ type: 'text', text: 'write' }], actor })
      await reopened.run({ until: 'turn-end', signal: AbortSignal.timeout(5000) })
      expect({
        permission: reopened.permissionContext.policy,
        role: reopened.d.roleDelegation?.role.ref,
        effects: effect.mock.calls.length,
        tools: reopened
          .currentTools()
          .list()
          .map((t) => t.name),
      }).toEqual({
        permission: 'read-only',
        role: '@fixture/roles#reader',
        effects: 0,
        tools: [],
      })
    } finally {
      await second.close()
    }
  },
)

it('review-role: a trusted role snapshot survives reopen and yolo without a live parent', async () => {
  const storage = new MemoryStorage()
  const first = make(storage)
  const initial = await first.session('child', {
    ...options,
    roleDelegation: { ...captured(), permission: 'workspace-write' },
  })
  expect(initial.d.log.latest(ROLE_DELEGATION)).toMatchObject({ permission: 'workspace-write' })
  await first.close()
  expect(await storage.registers('child')).toContainEqual(
    expect.objectContaining({ register: ROLE_DELEGATION }),
  )
  const second = make(storage)
  try {
    const child = await second.session('child', options)
    await child.setYolo(true, actor)
    expect(child.permissionContext.policy).toBe('workspace-write')
    expect(child.yolo).toBe(false)
    expect(child.d.roleDelegation?.approvalPolicy).toBe('never')
  } finally {
    await second.close()
  }
})

it('review-role: an ordinary descendant cannot bypass refusal through a copied role prefix', async () => {
  const k = make()
  try {
    const parent = await k.session('role-parent', {
      ...options,
      roleDelegation: { ...captured(), permission: 'workspace-write' },
    })
    await expect(
      parent.d.children.createWithKind!('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'inspect',
        resident: true,
      }),
    ).rejects.toThrow('pinned Host composition')
  } finally {
    await k.close()
  }
})

it.each([
  'permission',
  'tool.permission',
  'candidate.test',
  'plugin.publish',
  'memory',
  'credential.admin',
  'skills.install',
  'mcp.connect',
  'gate',
  'refine',
  'calibrate',
  'budget',
  'business.confirm',
])('review-role: %s is refused without a human answer or effect admission', async (purpose) => {
  const k = make()
  try {
    const child = await k.session('child', { ...options, roleDelegation: captured() })
    const port = child.decisions.port(child.loopDecisionSource())
    const handle = await port.request({
      key: 'ask',
      purpose,
      subject: { revision: 0 },
      prompt: 'Approve?',
      options: ['allowed-once', 'rejected'],
      ...(purpose === 'business.confirm'
        ? {
            presentation: { en: { title: 'Sign', fields: [], responseValue: 'I sign.' } },
            responseSchema: { type: 'string', const: 'I sign.' },
          }
        : {}),
    })
    const value = await port.get(handle)
    expect(value.result).toMatchObject({ reason: 'unavailable', code: 'delegated-approval-refused' })
    expect(value.result).not.toHaveProperty('answeredBy')
    expect(value.consumption).toBeNull()
    await expect(port.wait(handle)).rejects.toThrow('hand this action back')
    if (!port.admit) throw new Error('fixture lacks effect admission')
    await expect(port.admit(handle)).rejects.toThrow()
  } finally {
    await k.close()
  }
})

it.each(
  (['always', 'destructive', 'tainted'] as const).flatMap((risk) =>
    (['allow', 'ask', 'deny'] as const).map((effect) => ({ risk, effect })),
  ),
)(
  'review-role: $risk follows the captured policy $effect without answering an approval',
  async ({ risk, effect }) => {
    const policy = intersectRoleToolPolicy(
      { id: 'role', version: '1', decide: () => ({ effect: 'allow', reason: 'Role policy' }) },
      { id: 'parent', version: '1', decide: () => ({ effect, reason: 'Captured parent policy' }) },
      { ...captured(), permission: 'workspace-write' },
    )
    const answer = await policy.decide(
      {
        sessionKey: 'child',
        workspaceRoot: '/w',
        cwd: '/w',
        actor,
        call: { id: 'call', name: 'write', args: {} },
        fullAccess: false,
        approvalMode: 'auto-review',
        tainted: risk === 'tainted',
        policy: {
          isReadOnly: false,
          isDestructive: risk === 'destructive',
          requiresApproval: risk === 'always' ? 'always' : risk === 'destructive' ? 'destructive' : 'never',
          replay: 'never',
          approvalScopes: [],
        },
      },
      new AbortController().signal,
    )
    expect(answer.effect).toBe(effect)
  },
)

it.each([
  ...([false, true, undefined] as const).flatMap((parentTainted) =>
    [false, true].map((tainted) => ({
      parentTainted,
      tainted,
      ceiling: undefined as 'require_approval' | 'deny' | 'deny-policy' | undefined,
    })),
  ),
  ...(['require_approval', 'deny', 'deny-policy'] as const).map((ceiling) => ({
    parentTainted: false,
    tainted: false,
    ceiling,
  })),
])(
  'role command floor keeps captured/current/unknown taint across reopen: %j',
  async ({ parentTainted, tainted, ceiling }) => {
    const storage = new MemoryStorage()
    const first = make(storage)
    const { parentTainted: _ignored, ...legacy } = captured()
    const snapshot: RoleDelegation = {
      ...legacy,
      permission: 'workspace-write',
      commandTable: [{ tool: 'write', argv: '^/w/.*$', action: 'allow' }],
      ...(parentTainted === undefined ? {} : { parentTainted }),
      ...(ceiling
        ? {
            policyCeilings: [
              {
                policy: ceiling === 'deny-policy' ? 'ancestor-deny' : 'default',
                ...(ceiling === 'deny-policy'
                  ? {}
                  : { commandTable: [{ tool: 'write', argv: '^/w/.*$', action: ceiling }] }),
              },
            ],
          }
        : {}),
    }
    const second = make(storage)
    for (const kernel of [first, second])
      kernel.toolPolicies.register('@fixture/ancestor', {
        id: 'ancestor-deny',
        version: '1',
        decide: () => ({ effect: 'deny', reason: 'Ancestor policy' }),
      })
    try {
      const live = await first.session('child', { ...options, roleDelegation: snapshot })
      const input = {
        sessionKey: 'child',
        workspaceRoot: '/w',
        cwd: '/w',
        actor,
        call: { id: 'write', name: 'write', args: { path: '/w/file.md' } },
        fullAccess: false,
        approvalMode: 'manual' as const,
        tainted,
        policy: {
          isReadOnly: false,
          isDestructive: true,
          requiresApproval: 'destructive' as const,
          replay: 'never' as const,
          approvalScopes: [],
        },
      }
      const expected =
        ceiling === 'deny' || ceiling === 'deny-policy'
          ? 'deny'
          : ceiling === 'require_approval'
            ? 'ask'
            : parentTainted === false && !tainted
              ? 'allow'
              : 'ask'
      expect((await live.toolPolicy().decide(input, new AbortController().signal)).effect).toBe(expected)
      await first.close()
      const restored = await second.session('child', options)
      expect((await restored.toolPolicy().decide(input, new AbortController().signal)).effect).toBe(expected)
    } finally {
      await first.close()
      await second.close()
    }
  },
)

it('role resource snapshot restores canonical IDs, command policy and actor without a live parent', async () => {
  const storage = new MemoryStorage()
  const first = make(storage)
  const snapshot = {
    ...captured(),
    resources: { mcp: ['mcp/common'], skills: [] },
    commandTable: [{ tool: 'exec', argv: '.*', action: 'require_approval' as const }],
  }
  const session = await first.session('child', { ...options, roleDelegation: snapshot })
  const boundary = session.lastSeq
  await first.close()
  await storage.createChild('child', boundary, 'ordinary-fork')
  expect(await readRoleDelegation(storage, 'ordinary-fork')).toBeUndefined()
  const second = make(storage)
  try {
    const restored = await second.session('child', {
      ...options,
      actor: { ...actor, id: 'different-reopen-actor' },
    })
    expect(restored.d.roleDelegation).toEqual(snapshot)
    expect(restored.d.actor).toEqual(snapshot.actor)
  } finally {
    await second.close()
  }
})

it.each([
  { resources: { mcp: [], skills: 'defaults' } },
  { approvalPolicy: 'full-access' },
  { parentTainted: 'false' },
  { policyCeilings: [{ policy: 42 }] },
  { policyCeilings: [{ policy: 'default', commandTable: 'all' }] },
  { filesystem: {} },
])('malformed trusted role data is a refusal on reopen: %j', async (patch) => {
  const storage = new MemoryStorage()
  const first = make(storage)
  const child = await first.session('child', options)
  await child.append([
    child.ev(ROLE_DELEGATION, { ...captured(), ...patch }, { ignorable: true, register: ROLE_DELEGATION }),
  ])
  await first.close()
  const second = make(storage)
  try {
    await expect(second.session('child', options)).rejects.toThrow()
  } finally {
    await second.close()
  }
})

const restoreRechecks = [
  { name: 'system-untrusted', type: ROLE_DELEGATION, origin: 'system', trust: 'untrusted' },
  { name: 'ext-trusted', type: ROLE_DELEGATION, origin: 'ext:fixture', trust: 'trusted' },
  { name: 'ext-untrusted', type: ROLE_DELEGATION, origin: 'ext:fixture', trust: 'untrusted' },
  { name: 'ext-namespace', type: 'x/fixture/role-delegation', origin: 'system', trust: 'trusted' },
  { name: 'tombstone', type: ROLE_DELEGATION, origin: 'ext:fixture', trust: 'untrusted' },
] as const
it.each(restoreRechecks)(
  'recheck-role: $name alone cannot restore authority, nor replace a genuine snapshot',
  async (row) => {
    for (const genuine of [false, true]) {
      const storage = new MemoryStorage()
      const first = make(storage)
      const initial = await first.session('child', {
        ...options,
        ...(genuine ? { roleDelegation: captured() } : {}),
      })
      await initial.append([
        initial.ev(
          row.type,
          row.name === 'tombstone'
            ? null
            : {
                ...captured(),
                tools: ['write_note'],
                permission: 'workspace-write',
                role: { ref: '@fixture/roles#writer', title: { en: 'Forged Writer' } },
              },
          { origin: row.origin, trust: row.trust, register: ROLE_DELEGATION, ignorable: true },
        ),
      ])
      await first.close()
      const second = make(storage)
      try {
        const restored = await second.session('child', options)
        expect(restored.d.roleDelegation).toEqual(genuine ? captured() : undefined)
        if (genuine) {
          await restored.setYolo(true, actor)
          expect(restored.yolo).toBe(false)
          expect(restored.permissionContext.policy).toBe('read-only')
          expect(restored.currentTools().list()).toEqual([])
        }
      } finally {
        await second.close()
      }
    }
  },
)

it('recheck-role: an ordinary Core fork does not restore the physical parent role fact', async () => {
  const storage = new MemoryStorage()
  const first = make(storage)
  const role = await first.session('role', { ...options, roleDelegation: captured() })
  const seq = role.lastSeq
  await first.close()
  await storage.createChild('role', seq, 'fork')
  const second = make(storage)
  try {
    const fork = await second.session('fork', options)
    expect(fork.d.roleDelegation).toBeUndefined()
  } finally {
    await second.close()
  }
})

it('recheck-role: a trusted tombstone never restores a role or silently opens an ordinary session', async () => {
  const storage = new MemoryStorage()
  const first = make(storage)
  const child = await first.session('child', options)
  await child.append([child.ev(ROLE_DELEGATION, null, { register: ROLE_DELEGATION, ignorable: true })])
  await first.close()
  const second = make(storage)
  try {
    await expect(second.session('child', options)).rejects.toThrow('Invalid trusted role delegation snapshot')
  } finally {
    await second.close()
  }
})
