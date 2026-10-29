import { presetDefaults } from '@agnes/core-common/step/preset'
import { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import type { DecisionSpec, LoopContext, LoopFactory } from '@agnes/extension-api'
import { loopCheckpointCodec } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
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

it.each(['read-only', 'workspace-write', 'standard', 'custom', 'named-full-access', 'mutated-yolo', 'off'])(
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
    if (name === 'mutated-yolo') expect(Reflect.set(f.session, 'yolo', true)).toBe(false)
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

it.each(['decision/state', 'x/core/yolo-switch'])(
  'review: failure to persist %s fails closed',
  async (eventType) => {
    const f = await fixture(eventType === 'decision/state' ? 'full-access' : 'standard')
    const append = f.log.append.bind(f.log)
    const spy = vi.spyOn(f.log, 'append').mockImplementation((events, options) => {
      if (events.some((event) => event.type === eventType))
        return Promise.reject(new Error('synthetic disk failure'))
      return append(events, options)
    })
    try {
      if (eventType === 'decision/state')
        await expect(f.ctx.decisions.request(spec)).rejects.toThrow('disk failure')
      else {
        await expect(f.session.setYolo(true, actor)).rejects.toThrow('disk failure')
        expect(f.session.permissionContext.policy).not.toBe('full-access')
      }
      expect(await f.session.decisions.list()).toEqual([])
    } finally {
      spy.mockRestore()
      await f.session.close()
    }
  },
)

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
it.each(['standard', 'workspace-write', 'full-access', 'yolo', 'pending-yolo', 'wake-yolo'])(
  'business consent: %s uses the human principal and exact declared meaning',
  async (permission) => {
    const f = await fixture(permission)
    try {
      const switched = ['yolo', 'pending-yolo', 'wake-yolo'].includes(permission)
      const principal = switched ? { ...actor, id: 'full-access-chooser' } : actor
      if (permission === 'yolo' || permission === 'wake-yolo') await f.session.setYolo(true, principal)
      if (permission === 'wake-yolo') {
        await f.session.enqueue('next-turn', {
          actor: { ...actor, id: 'scheduler', role: 'system' },
          content: [{ type: 'text', text: 'Scheduled business signature' }],
        })
        await f.session.acceptInput()
        expect(f.session.permissionContext.actor.id).toBe(principal.id)
      }
      const handle = await f.author.request(business)
      if (permission === 'pending-yolo') {
        expect((await f.author.get(handle)).result).toBeNull()
        await f.session.setYolo(true, principal)
      }
      const value = await f.author.get(handle)
      if (permission !== 'full-access' && !switched) {
        expect(value.result).toBeNull()
        return
      }
      expect(value.result).toMatchObject({
        reason: 'answered',
        code: 'full-access',
        response: { option: 'allowed-once', value: 'I confirm.' },
        answeredBy: {
          id: principal.id,
          role: principal.role,
          attrs: { confirmationMode: 'auto-confirmed under full access' },
        },
        authorization: { sessionId: f.session.permissionContext.sessionId, epoch: switched ? 1 : 0 },
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
            decision: expect.objectContaining({ reason: 'full-access', byLabel: principal.id }),
          }),
        ]),
      )
      if (switched) await f.session.setYolo(false, actor)
      else await f.session.setPreset(presetDefaults())
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

it.each(['standard', 'full-access'])(
  'business consent: %s switch round trips cannot resurrect a lease from the prior switch',
  async (baseline) => {
    const f = await fixture(baseline)
    try {
      await f.session.setYolo(true, actor)
      const pending = await f.author.request(business)
      await f.session.setYolo(false, actor)
      expect(f.session.permissionContext.policy === 'full-access').toBe(baseline === 'full-access')
      expect(f.session.yolo).toBe(baseline === 'full-access')
      await f.session.setYolo(true, actor)
      await expect(f.author.admit!(pending)).rejects.toThrow('AUTHORITY_REVOKED')
      const fresh = await f.author.request({ ...business, key: 'fresh-switch' })
      const admission = await f.author.admit!(fresh)
      await admission.verify()
      await f.session.setYolo(false, actor)
      expect(() => admission.assertActive()).toThrow('AUTHORITY_REVOKED')
    } finally {
      await f.session.close()
    }
  },
)

it.each(['yolo', 'preset', 'close', 'revoke', 'rebind'] as const)(
  'waits for the backend revocation fence before acknowledging %s',
  async (operation) => {
    const f = await fixture('workspace-write')
    await f.session.setYolo(true, actor)
    const epoch = f.session.permissionContext.epoch
    let release!: () => void,
      enter!: () => void,
      acknowledged = false
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const off = f.session.onBeforePermissionChange(async () => {
      enter()
      await held
    })
    const operator = structuredClone(actor)
    const changing = (
      operation === 'yolo'
        ? f.session.setYolo(false, operator)
        : operation === 'preset'
          ? f.session.setPreset(presetDefaults())
          : operation === 'revoke'
            ? f.session.revokeAutomaticPermissions()
            : operation === 'rebind'
              ? f.session.inheritAutomaticPermissions(undefined)
              : f.session.close()
    ).then(() => {
      acknowledged = true
    })
    operator.id = 'changed-after-call'
    try {
      await entered
      expect(acknowledged).toBe(false)
      release()
      await changing
      expect(acknowledged).toBe(true)
      expect(f.session.permissionContext.epoch).toBeGreaterThan(epoch)
      if (operation === 'yolo') {
        const [row] = await f.session.scan({ type: 'x/core/yolo-switch', order: 'desc', limit: 1 })
        expect(row?.actor.id).toBe(actor.id)
      }
      if (operation !== 'preset' && operation !== 'revoke')
        expect(f.session.permissionContext.policy).not.toBe('full-access')
    } finally {
      release()
      off()
      await changing
      await f.session.close()
    }
  },
)

it('refuses a permission switch when the remote fence is unavailable', async () => {
  const f = await fixture('full-access')
  const off = f.session.onBeforePermissionChange(async () => {
    throw new Error('fence unavailable')
  })
  try {
    await expect(f.session.setYolo(false, actor)).rejects.toThrow('fence unavailable')
    expect(await f.session.scan({ type: 'x/core/yolo-switch', limit: 10 })).toEqual([])
  } finally {
    off()
    await f.session.close()
  }
})

it('waits for descendant effect owners before acknowledging a parent downgrade', async () => {
  const parent = await fixture('workspace-write'),
    child = await fixture('workspace-write')
  await parent.session.setYolo(true, actor)
  await child.session.inheritAutomaticPermissions(parent.session)
  let release!: () => void,
    enter!: () => void,
    acknowledged = false
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const off = child.session.onBeforePermissionChange(async () => {
    enter()
    await held
  })
  const changing = parent.session.setYolo(false, actor).then(() => {
    acknowledged = true
  })
  try {
    await entered
    expect(acknowledged).toBe(false)
    release()
    await changing
    expect(child.session.permissionContext.policy).not.toBe('full-access')
  } finally {
    release()
    off()
    await changing
    await child.session.close()
    await parent.session.close()
  }
})
