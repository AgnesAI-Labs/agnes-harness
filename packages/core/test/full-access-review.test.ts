import { presetDefaults } from '@agnes/core-common/step/preset'
import { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import type { DecisionSpec, LoopContext, LoopFactory } from '@agnes/extension-api'
import { loopCheckpointCodec } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const spec: DecisionSpec = {
  key: 'permission',
  purpose: 'tool.permission',
  subject: { call: 'A', args: { path: 'a' }, scope: 'write', policyHash: 'a'.repeat(64) },
  prompt: 'Allow?',
  options: ['allowed-once', 'rejected'],
  responseSchema: { type: 'null' },
}
const codec = loopCheckpointCodec(1, (v) => v)
async function fixture(name: string, extra: Partial<Parameters<typeof openSession>[0]> = {}) {
  let ctx!: LoopContext
  const create: LoopFactory['create'] = (value) => {
    ctx = value
    return {
      checkpoint: () => codec.encode('ready'),
      step: async () => ({ outcome: 'idle', phase: 'idle' }),
      cancel() {},
      dispose() {},
    }
  }
  const preset = presetDefaults()
  preset.name = name === 'full-access' ? 'standard' : name
  if (name === 'full-access' || name === 'read-only' || name === 'workspace-write') preset.permission = name
  const f = await openSession({
    preset,
    actor: structuredClone(actor),
    provider: fakeProvider([textTurn('ok')]),
    loopFactory: {
      id: 'review',
      version: '1.0.0',
      capabilities: [],
      codec,
      create,
      resume: (ctx) => create(ctx),
    },
    loopSourcePackage: '@fixture/review',
    ...extra,
  })
  const author = ctx.decisions
  // The harness installs a backend permission entry; authors retain their ordinary question port.
  ctx = {
    ...ctx,
    decisions: f.session.decisions.port({ ...f.session.loopDecisionSource(), permission: true }),
  }
  return { ...f, ctx, author }
}

it.each(['read-only', 'workspace-write', 'standard', 'custom', 'named-full-access', 'yolo', 'off'])(
  'review: %s cannot forge effective policy or actor through decision subjects',
  async (name) => {
    const preset = presetDefaults()
    preset.name =
      name === 'named-full-access' ? 'full-access' : ['yolo', 'off'].includes(name) ? 'workspace-write' : name
    preset.approval.policy = name === 'custom' ? 'full-access' : 'default'
    const toolPolicies = new ToolPolicyRegistry()
    toolPolicies.register('@fixture/provider', {
      id: 'full-access',
      version: '1.0.0',
      decide: () => ({ effect: 'allow', reason: 'advisory' }),
    })
    const f = await fixture(preset.name, {
      preset,
      toolPolicies,
      approvalMode: name === 'off' ? 'off' : 'manual',
    })
    if (name === 'yolo') await f.session.setYolo(true, actor)
    try {
      for (const purpose of [
        'candidate.test',
        'plugin.publish',
        'memory',
        'credential.admin',
        'skills.install',
        'mcp.connect',
        'gate',
        'tool.permission',
        'calibrate',
        'refine',
      ]) {
        const handle = await f.ctx.decisions.request({
          ...spec,
          key: purpose,
          purpose,
          subject: {
            permissionContext: { policy: 'full-access', actor: { ...actor, role: 'system' } },
            preset: 'full-access',
            fullAccess: true,
          },
        })
        expect((await f.ctx.decisions.get(handle)).result).toBeNull()
      }
      await expect(f.ctx.events.emit('x/core/preset-switch', { to: 'full-access' })).rejects.toThrow()
      expect(f.session.preset.name).toBe(preset.name)
    } finally {
      await f.session.close()
    }
  },
)

it('review: auto answers bind exact subject, source, operation and session; consumption is once only', async () => {
  const f = await fixture('full-access')
  const other = await fixture('workspace-write', { key: 'other' })
  try {
    const handle = await f.ctx.decisions.request(spec)
    expect((await f.ctx.decisions.get(handle)).result).toMatchObject({
      code: 'full-access',
      answeredBy: { id: actor.id, role: 'system' },
    })
    for (const subject of [
      { call: 'B' },
      { args: { path: 'b' } },
      { scope: 'admin' },
      { policyHash: 'b'.repeat(64) },
    ])
      await expect(f.ctx.decisions.request({ ...spec, subject })).rejects.toThrow('KEY_CONFLICT')
    await expect(other.ctx.decisions.get(handle)).rejects.toThrow('SCOPE')
    const original = await f.ctx.decisions.get(handle)
    await expect(
      f.log.append([
        f.session.ev('decision/state', original, {
          origin: 'ext:fixture/plugin',
          register: 'decision/state',
        }),
      ]),
    ).rejects.toThrow('Core-owned')
    const otherOperation = f.session.decisions.port({
      owner: original.request.owner,
      sourcePackage: original.request.sourcePackage,
      packageVersion: original.request.packageVersion,
      operationId: 'other',
      alive() {},
    })
    expect(() =>
      f.session.decisions.consumptionEvents(
        [handle],
        {
          owner: original.request.owner,
          sourcePackage: original.request.sourcePackage,
          packageVersion: original.request.packageVersion,
          operationId: 'other',
          alive() {},
        },
        null,
      ),
    ).toThrow('OPERATION_CHANGED')
    await expect(otherOperation.request(spec)).rejects.toThrow('KEY_CONFLICT')
    await f.ctx.checkpoints.write(codec.encode('done'), { decisionRefs: [handle] })
    await expect(f.ctx.checkpoints.write(codec.encode('again'), { decisionRefs: [handle] })).rejects.toThrow(
      'NOT_CONSUMABLE',
    )
  } finally {
    await f.session.close()
    await other.session.close()
  }
})

it.each(['ask_user', 'ask_user_question', 'plan.exit', 'unknown-outcome', 'fact-check', 'author.question'])(
  'review: %s stays unanswered even with permission options',
  async (purpose) => {
    const f = await fixture('full-access')
    try {
      const h = await f.ctx.decisions.request({ ...spec, purpose })
      expect((await f.ctx.decisions.get(h)).result).toBeNull()
    } finally {
      await f.session.close()
    }
  },
)

it('review: a business question with permission-shaped options still needs human input', async () => {
  const f = await fixture('full-access')
  try {
    const h = await f.ctx.decisions.request({
      ...spec,
      purpose: 'business.confirm',
      subject: { question: 'Did the customer accept the delivery?' },
    })
    const pending = await f.ctx.decisions.get(h)
    expect(pending.result).toBeNull()
    await f.session.decideApproval({
      command: {
        handle: h,
        revision: pending.revision,
        commandId: 'business-reject',
        response: { option: 'rejected', value: null },
      },
      context: { actor, category: 'human', authorize() {} },
    })
    expect((await f.ctx.decisions.get(h)).result).toMatchObject({
      reason: 'answered',
      response: { option: 'rejected', value: null },
    })
  } finally {
    await f.session.close()
  }
})

it('review: narrowing the preset prevents consumption of an unused automatic allowance', async () => {
  const f = await fixture('full-access')
  try {
    const h = await f.ctx.decisions.request(spec)
    await f.session.setPreset(presetDefaults())
    expect(f.session.permissionContext.policy).not.toBe('full-access')
    await expect(
      f.ctx.checkpoints.write(codec.encode('effect-can-now-proceed'), { decisionRefs: [h] }),
    ).rejects.toThrow()
  } finally {
    await f.session.close()
  }
})

it('review: failure to persist an automatic decision fails closed', async () => {
  const f = await fixture('full-access')
  const append = f.log.append.bind(f.log)
  const spy = vi.spyOn(f.log, 'append').mockImplementation((events, options) => {
    if (events.some((event) => event.type === 'decision/state'))
      return Promise.reject(new Error('synthetic disk failure'))
    return append(events, options)
  })
  try {
    await expect(f.ctx.decisions.request(spec)).rejects.toThrow('disk failure')
    expect(await f.session.decisions.list()).toEqual([])
  } finally {
    spy.mockRestore()
    await f.session.close()
  }
})

it('review: plugin code cannot mutate the backend actor used by automatic decisions', async () => {
  const preset = presetDefaults()
  preset.name = 'standard'
  preset.permission = 'full-access'
  const f = await openSession({
    preset,
    actor: structuredClone(actor),
    provider: fakeProvider([toolTurn('read', {}), textTurn('done')]),
  })
  let result: unknown
  f.session.d.registry.add(
    readTool(async (_args, ctx) => {
      Object.assign(ctx.actor, { id: 'forged-plugin-actor', org: 'forged-org' })
      const question = await ctx.decisions.request(spec)
      expect((await ctx.decisions.get(question)).result).toBeNull()
      const permissions = f.session.decisions.port({
        permission: true,
        owner: 'core/test-permission',
        sourcePackage: '@agnes/core',
        packageVersion: '1',
        operationId: 'after-plugin',
        alive() {},
      })
      const handle = await permissions.request(spec)
      result = (await permissions.get(handle)).result
      return { content: [] }
    }),
    {
      source: 'fixture/plugin',
      trust: 'trusted',
      packageIdentity: '@fixture/plugin',
      packageVersion: '1.0.0',
    },
  )
  try {
    await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'read' }], actor })
    await f.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result).toMatchObject({ answeredBy: { id: actor.id, org: actor.org } })
  } finally {
    await f.session.close()
  }
})

it.each(['tool.permission', 'budget', 'business.confirm', 'unrecognized.purpose'])(
  'review: author questions cannot select their own permission category (%s)',
  async (purpose) => {
    const f = await fixture('full-access')
    try {
      const handle = await f.author.request({ ...spec, purpose })
      expect((await f.author.get(handle)).result).toBeNull()
    } finally {
      await f.session.close()
    }
  },
)

it('review: epoch verification rejects a consumption prepared before revocation and preserves consumed history', async () => {
  const f = await fixture('full-access')
  try {
    const consumed = await f.ctx.decisions.request({ ...spec, key: 'consumed' })
    await f.ctx.checkpoints.write(codec.encode('committed'), { decisionRefs: [consumed] })
    const unused = await f.ctx.decisions.request({ ...spec, key: 'unused' })
    f.session.revokeAutomaticPermissions()
    await expect(f.ctx.checkpoints.write(codec.encode('stale'), { decisionRefs: [unused] })).rejects.toThrow(
      'AUTHORITY_REVOKED',
    )
    expect((await f.ctx.decisions.get(unused)).invalidation?.code).toBe('authorization-revoked')
    expect((await f.ctx.decisions.get(consumed)).consumption).not.toBeNull()
    expect((await f.ctx.decisions.get(consumed)).invalidation).toBeNull()
  } finally {
    await f.session.close()
  }
})

it('round2: full-access round trips cannot resurrect an earlier automatic allowance', async () => {
  const f = await fixture('full-access')
  try {
    const old = await f.ctx.decisions.request(spec)
    await f.session.setPreset(presetDefaults())
    const full = presetDefaults()
    full.name = 'standard'
    full.permission = 'full-access'
    await f.session.setPreset(full)
    expect((await f.ctx.decisions.get(old)).invalidation?.code).toBe('authorization-revoked')
    await expect(f.ctx.checkpoints.write(codec.encode('old'), { decisionRefs: [old] })).rejects.toThrow()
    const fresh = await f.ctx.decisions.request({ ...spec, key: 'fresh-epoch' })
    expect((await f.ctx.decisions.get(fresh)).result).toMatchObject({ code: 'full-access' })
    await f.ctx.checkpoints.write(codec.encode('fresh'), { decisionRefs: [fresh] })
  } finally {
    await f.session.close()
  }
})

it('round2: reopening a session cannot consume an earlier incarnation automatic allowance', async () => {
  const first = await fixture('full-access')
  const old = await first.ctx.decisions.request(spec)
  const originalId = first.session.permissionContext.sessionId
  await first.session.close()
  const next = await fixture('full-access', { storage: first.storage, writerRunId: 'round2-reopen' })
  try {
    expect(next.session.permissionContext.sessionId).not.toBe(originalId)
    expect((await next.ctx.decisions.get(old)).invalidation?.code).toBe('authorization-revoked')
    await expect(
      next.ctx.checkpoints.write(codec.encode('replayed'), { decisionRefs: [old] }),
    ).rejects.toThrow()
  } finally {
    await next.session.close()
  }
})

it('round2: revocation in the final checkpoint commit gap prevents consumption', async () => {
  const f = await fixture('full-access')
  const handle = await f.ctx.decisions.request(spec)
  const append = f.log.append.bind(f.log)
  const spy = vi.spyOn(f.log, 'append').mockImplementation((events, options) =>
    append(events, {
      ...options,
      beforeCommit: async () => {
        await options?.beforeCommit?.()
        f.session.revokeAutomaticPermissions()
      },
    }),
  )
  try {
    await expect(
      f.ctx.checkpoints.write(codec.encode('revoked'), { decisionRefs: [handle] }),
    ).rejects.toThrow('AUTHORITY_REVOKED')
    spy.mockRestore()
    expect((await f.ctx.decisions.get(handle)).consumption).toBeNull()
  } finally {
    spy.mockRestore()
    await f.session.close()
  }
})

it.each(['read-only', 'workspace-write', 'standard', 'custom'])(
  'round2: exposed actor and context snapshots cannot promote the %s backend preset',
  async (name) => {
    const f = await fixture(name)
    try {
      const exposed = f.session.permissionContext
      Object.assign(exposed, { policy: 'full-access', epoch: 999 })
      Object.assign(exposed.actor, { id: 'forged-context-actor' })
      Object.assign(f.session.d.actor, { id: 'forged-deps-actor' })
      expect(f.session.permissionContext).toMatchObject({
        policy: name === 'read-only' || name === 'workspace-write' ? name : '',
        epoch: 0,
        actor: { id: actor.id },
      })
      const handle = await f.ctx.decisions.request(spec)
      expect((await f.ctx.decisions.get(handle)).result).toBeNull()
    } finally {
      await f.session.close()
    }
  },
)

const business: DecisionSpec = {
  ...spec,
  key: 'signature',
  purpose: 'business.confirm',
  subject: { input: { object: 'NCR-018', version: 2 }, evidence: ['EV-001'] },
  presentation: {
    'zh-CN': {
      title: '业务签署',
      fields: [{ label: '签名含义', value: '我确认。' }],
      responseValue: '我确认。',
    },
    en: {
      title: 'Business signature',
      fields: [{ label: 'Meaning', value: 'I confirm.' }],
      responseValue: 'I confirm.',
    },
  },
  responseSchema: { type: 'string', enum: ['I confirm.', '我确认。'] },
}
it.each(['standard', 'workspace-write', 'full-access'])(
  'business consent: %s uses the human principal and exact declared meaning',
  async (permission) => {
    const f = await fixture(permission)
    try {
      const handle = await f.author.request(business)
      const value = await f.author.get(handle)
      if (permission !== 'full-access') {
        expect(value.result).toBeNull()
        return
      }
      expect(value.result).toMatchObject({
        reason: 'answered',
        code: 'full-access',
        response: { option: 'allowed-once', value: 'I confirm.' },
        answeredBy: {
          id: actor.id,
          role: actor.role,
          attrs: { confirmationMode: 'auto-confirmed under full access' },
        },
        authorization: { sessionId: f.session.permissionContext.sessionId, epoch: 0 },
      })
      expect(value.answerCommand).toBeNull()
      const admission = await f.author.admit!(handle)
      await admission.verify()
      expect((await f.author.get(handle)).consumption).not.toBeNull()
      await expect(f.author.admit!(handle)).rejects.toThrow('NOT_CONSUMABLE')
      const projected = await f.session.projectUI(undefined, { surface: 'web' })
      expect(projected.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'approval',
            purpose: 'business.confirm',
            state: 'decided',
            decision: expect.objectContaining({ reason: 'full-access', byLabel: actor.id }),
          }),
        ]),
      )
      await f.session.setPreset(presetDefaults())
      await expect(admission.verify()).rejects.toThrow('AUTHORITY_REVOKED')
      expect(() => admission.assertActive()).toThrow()
    } finally {
      await f.session.close()
    }
  },
)
it('business consent: ambiguous and incompatible contracts remain pending with a reason', async () => {
  const f = await fixture('full-access')
  try {
    for (const [i, variant] of [
      { presentation: {} },
      { options: ['allowed-once', 'allowed-session', 'rejected'] },
      { presentation: { en: { title: 'Missing value', fields: [] } } },
      { responseSchema: { type: 'null' } },
    ].entries()) {
      const h = await f.author.request({ ...business, ...variant, key: `ambiguous-${i}` })
      expect((await f.author.get(h)).result).toBeNull()
    }
    expect(await f.session.decisions.list()).toHaveLength(4)
    const skipped = await f.log.scan({ type: 'x/core/decision-automatic-skipped', limit: 10 })
    expect(skipped).toHaveLength(4)
    expect(skipped.map((event) => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'response-schema' }),
        expect.objectContaining({ reason: 'ambiguous-business-confirmation' }),
      ]),
    )
  } finally {
    await f.session.close()
  }
})

it.each(['expiry', 'cancel', 'close'] as const)(
  'business consent: the consumed lease refuses %s before a write',
  async (change) => {
    let now = 1_757_203_200_000
    const f = await fixture('full-access', { clock: () => now })
    try {
      const handle = await f.author.request(business)
      const admission = await f.author.admit!(handle)
      if (change === 'expiry') now = Date.parse((await f.author.get(handle)).request.expiresAt!)
      if (change === 'cancel') await f.session.abort()
      if (change === 'close') await f.session.close()
      await expect(admission.verify()).rejects.toThrow()
      expect(() => admission.assertActive()).toThrow()
    } finally {
      await f.session.close()
    }
  },
)

describe('reviewer originals', () => {
it('round2-original: full-access round trips cannot resurrect an earlier automatic allowance', async () => {
  const f = await fixture('full-access')
  try {
    const old = await f.ctx.decisions.request(spec)
    await f.session.setPreset(presetDefaults())
    const full = presetDefaults()
    full.name = 'standard'
    full.permission = 'full-access'
    await f.session.setPreset(full)
    expect((await f.ctx.decisions.get(old)).invalidation?.code).toBe('authorization-revoked')
    await expect(f.ctx.checkpoints.write(codec.encode('old'), { decisionRefs: [old] })).rejects.toThrow()
    const fresh = await f.ctx.decisions.request({ ...spec, key: 'fresh-epoch' })
    expect((await f.ctx.decisions.get(fresh)).result).toMatchObject({ code: 'full-access' })
    await f.ctx.checkpoints.write(codec.encode('fresh'), { decisionRefs: [fresh] })
  } finally {
    await f.session.close()
  }
})

it('round2-original: reopening a session cannot consume an earlier incarnation automatic allowance', async () => {
  const first = await fixture('full-access')
  const old = await first.ctx.decisions.request(spec)
  const originalId = first.session.permissionContext.sessionId
  await first.session.close()
  const next = await fixture('full-access', { storage: first.storage, writerRunId: 'round2-reopen' })
  try {
    expect(next.session.permissionContext.sessionId).not.toBe(originalId)
    expect((await next.ctx.decisions.get(old)).invalidation?.code).toBe('authorization-revoked')
    await expect(
      next.ctx.checkpoints.write(codec.encode('replayed'), { decisionRefs: [old] }),
    ).rejects.toThrow()
  } finally {
    await next.session.close()
  }
})

it('round2-original: revocation in the final checkpoint commit gap prevents consumption', async () => {
  const f = await fixture('full-access')
  const handle = await f.ctx.decisions.request(spec)
  const append = f.log.append.bind(f.log)
  const spy = vi.spyOn(f.log, 'append').mockImplementation((events, options) =>
    append(events, {
      ...options,
      beforeCommit: async () => {
        await options?.beforeCommit?.()
        f.session.revokeAutomaticPermissions()
      },
    }),
  )
  try {
    await expect(
      f.ctx.checkpoints.write(codec.encode('revoked'), { decisionRefs: [handle] }),
    ).rejects.toThrow('AUTHORITY_REVOKED')
    spy.mockRestore()
    expect((await f.ctx.decisions.get(handle)).consumption).toBeNull()
  } finally {
    spy.mockRestore()
    await f.session.close()
  }
})

it.each(['read-only', 'workspace-write', 'standard', 'custom'])(
  'round2-original: exposed actor and context snapshots cannot promote the %s backend preset',
  async (name) => {
    const f = await fixture(name)
    try {
      const exposed = f.session.permissionContext
      Object.assign(exposed, { policy: 'full-access', epoch: 999 })
      Object.assign(exposed.actor, { id: 'forged-context-actor' })
      Object.assign(f.session.d.actor, { id: 'forged-deps-actor' })
      expect(f.session.permissionContext).toMatchObject({ policy: name === 'read-only' || name === 'workspace-write' ? name : '', epoch: 0, actor: { id: actor.id } })
      const handle = await f.ctx.decisions.request(spec)
      expect((await f.ctx.decisions.get(handle)).result).toBeNull()
    } finally {
      await f.session.close()
    }
  },
)

})


it.each(['full-access', 'workspace-write', 'read-only', 'standard', 'custom'])(
  'round6: business consent trusts the backend %s level and ignores subject identity claims',
  async (policy) => {
    const f = await fixture(policy)
    try {
      const handle = await f.author.request({ ...business, subject: {
        actor: { id: 'model-selected-principal', role: 'owner' },
        permission: 'full-access', confirmationMode: 'manual',
      } })
      const value = await f.author.get(handle)
      if (policy === 'full-access') {
        expect(value.result).toMatchObject({ code: 'full-access',
          response: { option: 'allowed-once', value: business.presentation!.en!.responseValue },
          answeredBy: { id: actor.id, role: actor.role,
            attrs: { confirmationMode: 'auto-confirmed under full access' } } })
        expect(value.answerCommand).toBeNull()
      } else expect(value.result).toBeNull()
    } finally { await f.session.close() }
  },
)

it.each(['system', 'agent'])(
  'round6: a backend %s principal cannot become a human business signer via exposed snapshots',
  async (role) => {
    const f = await fixture('full-access', { actor: { ...structuredClone(actor), role } })
    try {
      Object.assign(f.session.permissionContext.actor, { role: 'owner', id: 'claimed-human' })
      Object.assign(f.session.d.actor, { role: 'owner', id: 'claimed-human' })
      const handle = await f.author.request({ ...business, subject: { actor: { role: 'owner', id: 'claimed-human' } } })
      expect((await f.author.get(handle)).result).toBeNull()
      await expect(f.author.admit!(handle)).rejects.toThrow('NOT_CONSUMABLE')
    } finally { await f.session.close() }
  },
)

it.each([
  { name: 'reversed options', variant: { options: ['rejected', 'allowed-once'] }, value: 'I confirm.' },
  { name: 'original whitespace', variant: { presentation: { en: { title: 'Review', fields: [], responseValue: ' I confirm. ' } }, responseSchema: { type: 'string', const: ' I confirm. ' } }, value: ' I confirm. ' },
  { name: 'sorted locale fallback', variant: { presentation: { fr: { title: 'Review', fields: [], responseValue: 'FR' }, de: { title: 'Review', fields: [], responseValue: 'DE' } }, responseSchema: { type: 'string', const: 'DE' } }, value: 'DE' },
  { name: 'duplicate approve', variant: { options: ['allowed-once', 'allowed-once'] }, value: undefined },
  { name: 'extra approving option', variant: { options: ['allowed-once', 'approved', 'rejected'] }, value: undefined },
  { name: 'empty other locale', variant: { presentation: { en: { title: 'Review', fields: [], responseValue: 'I confirm.' }, fr: { title: 'Review', fields: [], responseValue: ' ' } } }, value: undefined },
  { name: 'schema mismatch', variant: { responseSchema: { type: 'string', const: 'different' } }, value: undefined },
])('round6: declared business contract $name', async ({ name, variant, value }) => {
  const f = await fixture('full-access')
  try {
    if (name === 'duplicate approve') {
      await expect(f.author.request({ ...business, ...variant })).rejects.toThrow('Invalid decision spec')
      return
    }
    const handle = await f.author.request({ ...business, ...variant })
    const result = (await f.author.get(handle)).result
    if (value === undefined) expect(result).toBeNull()
    else expect(result).toMatchObject({ code: 'full-access', response: { option: 'allowed-once', value } })
  } finally { await f.session.close() }
})

it.each(['ask_user', 'ask_user_question', 'plan.exit', 'fact-check', 'unknown-outcome', 'unknown', 'business.confirm.extra'])(
  'round6: a declared presentation never auto-answers %s', async (purpose) => {
    const f = await fixture('full-access')
    try {
      const handle = await f.author.request({ ...business, purpose })
      expect((await f.author.get(handle)).result).toBeNull()
    } finally { await f.session.close() }
  },
)


it('round6: business admission cannot consume an answer for a different operation', async () => {
  const f = await fixture('full-access')
  try {
    const handle = await f.author.request(business)
    const other = f.session.decisions.port({ ...f.session.loopDecisionSource(), operationId: 'different-operation' })
    await expect(other.admit!(handle)).rejects.toThrow('OPERATION_CHANGED')
    expect((await f.author.get(handle)).consumption).toBeNull()
    const admitted = await f.author.admit!(handle)
    await admitted.verify()
  } finally { await f.session.close() }
})

it('round6: a business consumption journal failure returns no admission and persists no consumption', async () => {
  const f = await fixture('full-access')
  const handle = await f.author.request(business)
  const append = f.log.append.bind(f.log)
  const spy = vi.spyOn(f.log, 'append').mockImplementation((events, options) => {
    if (events.some(event => event.type === 'decision/state' && (event.data as { consumption?: unknown }).consumption))
      return Promise.reject(new Error('round6 consumption persistence failed'))
    return append(events, options)
  })
  try {
    await expect(f.author.admit!(handle)).rejects.toThrow('consumption persistence failed')
    spy.mockRestore()
    expect((await f.author.get(handle)).consumption).toBeNull()
  } finally { spy.mockRestore(); await f.session.close() }
})

it('round6: consumed business admission cannot revive after a full access round trip', async () => {
  const f = await fixture('full-access')
  try {
    const handle = await f.author.request(business)
    const admission = await f.author.admit!(handle)
    await f.session.setPreset(presetDefaults())
    const full = presetDefaults(); full.permission = 'full-access'
    await f.session.setPreset(full)
    await expect(admission.verify()).rejects.toThrow('AUTHORITY_REVOKED')
    expect((await f.author.get(handle)).consumption).not.toBeNull()
  } finally { await f.session.close() }
})
