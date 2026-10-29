import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolDef } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { expect, expectTypeOf, it, vi } from 'vitest'
import type { DefaultSelection, LiteralCeiling } from '../src/child/role-authority.js'
import { readRoleDelegation } from '../src/child/role-snapshot.js'
import {
  intersectRoleToolPolicy,
  ROLE_DELEGATION,
  type RoleDelegation,
  roleToolSnapshot,
} from '../src/child/roles.js'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps, testWorkspaceInvocation, writeTool } from './helpers/open-session.js'

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
const make = (
  storage = new MemoryStorage(),
  provider = fakeProvider([textTurn('done')]),
  extra: Partial<Parameters<typeof Kernel.create>[0]> = {},
) =>
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
    ...extra,
  })

it('keeps default selections and literal ceilings distinct at the type boundary', () => {
  expectTypeOf<DefaultSelection>().not.toMatchTypeOf<LiteralCeiling>()
  expectTypeOf<LiteralCeiling>().not.toMatchTypeOf<DefaultSelection>()
})

it('bounds role catalogue text while retaining normal references and the original tool', async () => {
  const kernel = make()
  const tool: ToolDef = {
    name: 'subagent_spawn',
    description: 'Delegate a task; do not approve business actions.',
    parameters: Type.Object({}),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: 'never',
    },
    execute: async () => ({ content: [] }),
  }
  kernel.tools.add(tool, { source: 'fixture', trust: 'trusted' })
  try {
    const original = kernel.tools.snapshot(0)
    const base = original.byName.get('subagent_spawn')!.description
    for (const count of [12, 64]) {
      const roles = Array.from({ length: count }, (_, index) => ({
        ref:
          count === 12
            ? `@fixture/roles#role-${index}`
            : `@${'p'.repeat(140)}/${'q'.repeat(140)}#${'r'.repeat(60)}-${index}`,
        title: { en: 'Role title '.repeat(100), 'zh-CN': '角色标题'.repeat(100) },
        description: { en: 'Long description '.repeat(200) },
      }))
      const described = roleToolSnapshot(original, roles).byName.get('subagent_spawn')!.description
      expect(described.startsWith(base)).toBe(true)
      expect(described.length).toBeLessThanOrEqual(3800)
      expect(original.byName.get('subagent_spawn')!.description).toBe(base)
      if (count === 12) for (const role of roles) expect(described).toContain(role.ref)
      else expect(described).toContain('Additional roles')
    }
  } finally {
    await kernel.close()
  }
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

it.each(['missing', 'undefined', 'empty'] as const)(
  'i01: %s resource fields never restore as default selection',
  async (mode) => {
    const storage = new MemoryStorage()
    const first = make(storage)
    const snapshot: RoleDelegation = {
      ...captured(),
      ...(mode === 'empty' ? { resources: { mcp: [], skills: [] } } : {}),
    }
    if (mode === 'undefined') {
      await expect(
        first.session('child', {
          ...options,
          roleDelegation: { ...snapshot, resources: undefined } as unknown as RoleDelegation,
        }),
      ).rejects.toMatchObject({
        code: 'E_ENVELOPE',
      })
      await first.close()
      return
    }
    const child = await first.session('child', { ...options, roleDelegation: snapshot })
    expect(child.roleAuthority!.resources.mcp.ids).toEqual([])
    expect(child.roleAuthority!.resources.skills.ids).toEqual([])
    expect(child.currentTools().list()).toEqual([])
    await first.close()
    const second = make(storage)
    try {
      const restored = await second.session('child', options)
      await restored.setYolo(true, actor)
      expect(restored.roleAuthority!.resources.mcp.ids).toEqual([])
      expect(restored.roleAuthority!.resources.skills.ids).toEqual([])
      expect(restored.currentTools().list()).toEqual([])
      expect(restored.permissionContext.policy).toBe('read-only')
    } finally {
      await second.close()
    }
  },
)

it.each([
  { tools: undefined },
  { resources: { mcp: undefined, skills: [] } },
  { resources: { mcp: [], skills: undefined } },
  { permission: undefined },
  { sandboxRequired: undefined },
  { filesystem: undefined },
  { delegatedFullAccess: false },
  { delegatedFullAccess: 'yes' },
])('i01: incomplete persisted authority refuses reopen: %j', async (patch) => {
  const storage = new MemoryStorage()
  const first = make(storage)
  const child = await first.session('child', options)
  await child.append([
    child.ev(ROLE_DELEGATION, JSON.parse(JSON.stringify({ ...captured(), ...patch })), {
      register: ROLE_DELEGATION,
      ignorable: true,
    }),
  ])
  await first.close()
  const second = make(storage)
  try {
    await expect(second.session('child', options)).rejects.toThrow()
  } finally {
    await second.close()
  }
})

it('i01: mutating the capture input after admission cannot widen any live authority gate', async () => {
  const k = make(new MemoryStorage(), fakeProvider([toolTurn('write_note', {}), textTurn('done')]))
  const snapshot = { ...captured(), resources: { mcp: [] as string[], skills: [] as string[] } }
  const effect = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'unexpected effect' }] }))
  k.tools.add(writeTool(effect), { source: 'fixture', trust: 'trusted' })
  try {
    const child = await k.session('child', { ...options, roleDelegation: snapshot })
    expect(child.currentTools().list()).toEqual([])
    snapshot.tools.push('write_note')
    snapshot.resources.mcp.push('mcp/private')
    snapshot.resources.skills.push('skill/private')
    snapshot.permission = 'workspace-write'
    await child.setYolo(true, actor)
    expect(child.currentTools().list()).toEqual([])
    expect(child.roleAuthority!.resources).toEqual({
      mcp: { kind: 'ceiling', ids: [] },
      skills: { kind: 'ceiling', ids: [] },
    })
    expect(child.permissionContext.policy).toBe('read-only')
    await child.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Write beyond the captured empty ceiling' }],
      actor,
    })
    await child.run({ until: 'turn-end', signal: AbortSignal.timeout(5000) })
    expect(effect).not.toHaveBeenCalled()
  } finally {
    await k.close()
  }
})

it.each([false, undefined])(
  'security5: cold role dispatch preserves explicit clean or absent legacy taint (%s)',
  async (parentTainted) => {
    const storage = new MemoryStorage()
    const { parentTainted: _removed, ...base } = captured()
    const legacy: RoleDelegation = {
      ...base,
      permission: 'workspace-write',
      tools: ['write_note'],
      commandTable: [{ tool: 'write_note', argv: '.*', action: 'allow' }],
      ...(parentTainted === undefined ? {} : { parentTainted }),
    }
    let first!: Kernel
    first = make(storage, fakeProvider([textTurn('unused')]), {
      childRoles: {
        list: async () => [legacy.role],
        resolve: async () => ({
          role: legacy.role,
          open: (key, opts) => first.session(key, { ...options, ...opts, roleDelegation: legacy }),
        }),
      },
    })
    first.tools.add(writeTool(), { source: 'fixture', trust: 'trusted' })
    const parent = await first.session('parent', options)
    const handle = await parent.d.children.createWithKind!('spawn', {
      parent: 'parent',
      cwd: '/w',
      role: legacy.role.ref,
      input: 'Write',
      resident: true,
    })
    // Release the crashed writers without an explicit parent/child stop; SIGKILL is
    // covered by the Host e2e case. Kernel.close() would intentionally revoke this task.
    await first.get(handle.key)!.d.log.close()
    await parent.d.log.close()
    const effect = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'written' }] }))
    const prompts: string[] = []
    const restoredSeams = fakeSeams({
      approval: {
        ask: async (request) => {
          prompts.push(request.summary)
          return { verdict: 'rejected', answeredBy: actor }
        },
      },
    })
    let second!: Kernel
    second = make(storage, fakeProvider([toolTurn('write_note', {}), textTurn('done')]), {
      seams: restoredSeams,
      childRoles: {
        list: async () => [legacy.role],
        resolve: async () => {
          throw new Error('Cold resume must use the pinned role')
        },
        reopen: (key, opts) =>
          second.session(key, {
            ...options,
            ...opts,
            workspaceInvocation: testWorkspaceInvocation(testFsOps(), restoredSeams),
          }),
      },
    })
    second.tools.add(writeTool(effect), { source: 'fixture', trust: 'trusted' })
    try {
      const owner = await second.session('parent', options)
      const resumed = await owner.d.children.resume!(handle.key)
      const restored = second.get(handle.key)!
      expect(restored.currentTools().resolve('write_note')).toBeDefined()
      expect(restored.d.roleDelegation?.parentTainted).toBe(parentTainted)
      await vi.waitFor(async () => {
        const status = await resumed.status()
        expect(status.state !== 'running' || status.idle === true).toBe(true)
      })
      expect(
        effect,
        JSON.stringify({ prompts, results: await restored.scan({ type: 'tool/result', limit: 10 }) }),
      ).toHaveBeenCalledTimes(parentTainted === false ? 1 : 0)
      expect(prompts).toHaveLength(parentTainted === false ? 0 : 1)
      if (parentTainted === undefined) {
        expect(prompts[0]).toMatch(/taint/i)
        expect((await restored.decisions.list())[0]).toMatchObject({
          result: { reason: 'answered', response: { option: 'rejected' } },
          consumption: { effectId: null },
        })
      }
    } finally {
      await second.close()
      await first.close()
    }
  },
)

const toolGate = (
  child: Awaited<ReturnType<ReturnType<typeof make>['session']>>,
  owner = 'core/tool-permission',
) =>
  child.decisions.port({
    owner,
    sourcePackage: owner === 'core/tool-permission' ? '@agnes/core' : '@fixture/plugin',
    packageVersion: '1',
    operationId: 'gate',
    permission: true,
    alive() {},
  })
const gateSpec = (key: string, purpose = 'tool.permission') => ({
  key,
  purpose,
  subject: { revision: 0 },
  prompt: 'Write?',
  options: ['allowed-once', 'rejected'],
})

it('delegated full access: a declaring writable role follows the live parent for core tool gates only', async () => {
  const k = make()
  try {
    const principal = { ...actor, id: 'full-access-chooser' }
    const parent = await k.session('parent', options)
    await parent.setYolo(true, principal)
    const open = async (key: string, extra: Partial<RoleDelegation>) => {
      const child = await k.session(key, {
        ...options,
        roleDelegation: { ...captured(), permission: 'workspace-write', ...extra },
      })
      await child.inheritAutomaticPermissions(parent)
      return child
    }
    const child = await open('declared', { delegatedFullAccess: true })
    expect(child.permissionContext).toMatchObject({ policy: 'full-access', actor: principal })
    expect(child.yolo).toBe(false)
    const port = toolGate(child)
    const handle = await port.request(gateSpec('write'))
    expect((await port.get(handle)).result).toMatchObject({
      reason: 'answered',
      code: 'full-access',
      answeredBy: { id: principal.id, role: 'system' },
      authorization: { sessionId: child.permissionContext.sessionId, epoch: child.permissionContext.epoch },
    })
    const admission = await port.admit!(handle)
    // Everything except Core's own tool gate is still refused for the role.
    const sign = {
      ...gateSpec('sign', 'business.confirm'),
      presentation: { en: { title: 'Sign', fields: [], responseValue: 'I sign.' } },
      responseSchema: { type: 'string', const: 'I sign.' },
    }
    for (const [gate, spec] of [
      [toolGate(child, 'fixture/plugin'), gateSpec('plugin')],
      [port, gateSpec('plan', 'plan.exit')],
      [port, sign],
    ] as const)
      expect((await gate.get(await gate.request(spec))).result).toMatchObject({
        code: 'delegated-approval-refused',
      })
    await parent.setYolo(false, actor)
    expect(child.permissionContext.policy).not.toBe('full-access')
    expect(() => admission.assertActive()).toThrow('AUTHORITY_REVOKED')
    expect((await port.get(await port.request(gateSpec('next')))).result).toBeNull()

    await parent.setYolo(true, principal)
    // read-only never upgrades; an undeclared snapshot keeps its captured permission.
    for (const [key, extra, policy] of [
      ['read-only', { delegatedFullAccess: true, permission: 'read-only' }, 'read-only'],
      ['undeclared', {}, 'workspace-write'],
    ] as const) {
      const other = await open(key, extra as Partial<RoleDelegation>)
      expect(other.permissionContext.policy).toBe(policy)
      const otherPort = toolGate(other)
      expect((await otherPort.get(await otherPort.request(gateSpec('write')))).result).toBeNull()
    }
    // Unattended parents answer exactly as the main session does under full access.
    const unattended = await open('unattended', { delegatedFullAccess: true, humanApprovals: false })
    const quiet = toolGate(unattended)
    expect((await quiet.get(await quiet.request(gateSpec('write')))).result).toMatchObject({
      code: 'full-access',
    })
    const undeclared = await open('unattended-undeclared', { humanApprovals: false })
    const noHuman = toolGate(undeclared)
    expect((await noHuman.get(await noHuman.request(gateSpec('write')))).result).toMatchObject({
      code: 'delegated-approval-refused',
    })
  } finally {
    await k.close()
  }
})

it('delegated full access: the captured flag survives reopen', async () => {
  const storage = new MemoryStorage()
  const first = make(storage)
  await first.session('child', {
    ...options,
    roleDelegation: { ...captured(), permission: 'workspace-write', delegatedFullAccess: true },
  })
  await first.close()
  const second = make(storage)
  try {
    expect((await second.session('child', options)).d.roleDelegation?.delegatedFullAccess).toBe(true)
  } finally {
    await second.close()
  }
})
