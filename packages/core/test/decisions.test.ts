import { presetDefaults } from '@agnes/core-common/step/preset'
import { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import type { DecisionSpec, LoopContext, LoopFactory } from '@agnes/extension-api'
import { loopCheckpointCodec } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool, shellTool } from './helpers/open-session.js'

const spec: DecisionSpec = {
  key: 'review',
  purpose: 'business.confirm',
  subject: { text: 'Complete synthetic review' },
  prompt: 'Continue?',
  presentation: {
    en: { title: 'Review', fields: [{ label: 'Object', value: 'NCR-018' }], responseValue: 'review' },
  },
  options: ['continue', 'reject'],
}
const codec = loopCheckpointCodec(1, (value) => {
  if (value !== 'ready' && value !== 'done') throw new Error('Invalid stage')
  return value
})
function loop(capture: (ctx: LoopContext) => void): LoopFactory {
  const create: LoopFactory['create'] = (ctx) => {
    capture(ctx)
    return {
      checkpoint: () => codec.encode('ready'),
      step: async () => ({ outcome: 'idle', phase: 'idle' }),
      cancel() {},
      dispose() {},
    }
  }
  return {
    id: 'community.review',
    version: '1.0.0',
    capabilities: [],
    codec,
    create,
    resume: (ctx) => create(ctx),
  }
}
const context = { actor, category: 'human' as const, authorize() {} }
async function fixture(extra: Partial<Parameters<typeof openSession>[0]> = {}) {
  let ctx!: LoopContext
  const opened = await openSession({
    provider: fakeProvider([textTurn('ok')]),
    loopFactory: loop((value) => {
      ctx = value
    }),
    loopSourcePackage: '@community/review',
    ...extra,
  })
  return { ...opened, ctx }
}

describe('session decision authority', () => {
  it('injects the same admitted port into ordinary tool execution', async () => {
    const f = await openSession({ provider: fakeProvider([toolTurn('read', {}), textTurn('done')]) })
    let handle: Awaited<ReturnType<LoopContext['decisions']['request']>> | undefined
    f.session.d.registry.add(
      readTool(async (_args, ctx) => {
        handle = await ctx.decisions.request({ ...spec, options: ['allowed-once', 'rejected'] })
        expect((await ctx.decisions.get(handle)).request).toMatchObject({
          owner: 'fixture/author',
          sourcePackage: '@fixture/plugin',
          packageVersion: '1.2.3',
          operationId: ctx.session.toolUseId,
        })
        return { content: [] }
      }),
      {
        source: 'fixture/author',
        trust: 'trusted',
        packageIdentity: '@fixture/plugin',
        packageVersion: '1.2.3',
      },
    )
    try {
      await f.session.enqueue('next-turn', {
        commandId: 'input',
        content: [{ type: 'text', text: 'read' }],
        actor,
      })
      await f.session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(handle).toBeDefined()
      expect((await f.session.decisions.get(handle!)).result).toBeNull()
      expect(
        (await f.session.projectUI(undefined, { surface: 'web' })).nodes.find(
          (node) => node.kind === 'approval',
        ),
      ).toMatchObject({ presentation: spec.presentation })
    } finally {
      await f.session.close()
    }
  })
  it.each(['safe', 'never'] as const)(
    'blocks cold decision reentry and reconciles an unknown %s outcome',
    async (replay) => {
      let entered!: () => void
      let release!: () => void
      const called = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let handle!: Awaited<ReturnType<LoopContext['decisions']['request']>>
      let executions = 0
      const registry = new ToolRegistry()
      const toolName = replay === 'never' ? 'shell' : 'read'
      const tool = replay === 'never' ? shellTool : readTool
      const seams = fakeSeams({
        approval: {
          ask: async (request) =>
            request.kind === 'unknown-outcome'
              ? { ticket: 'reconcile-original', expiresAt: request.deadline }
              : { verdict: 'allowed-once', answeredBy: actor },
        },
      })
      registry.add(
        tool(async (_args, ctx) => {
          executions++
          handle = await ctx.decisions.request(spec)
          entered()
          await gate
          return { content: [] }
        }),
        { source: 'fixture/author', trust: 'trusted' },
      )
      const first = await openSession({ registry, seams, provider: fakeProvider([toolTurn(toolName, {})]) })
      await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'read' }], actor })
      await first.session.step()
      await first.session.step()
      await first.session.step()
      const inFlight = first.session.step().catch(() => undefined)
      await called
      const original = await first.session.decisions.get(handle)
      const anotherOperation = first.session.decisions.port({
        owner: original.request.owner,
        sourcePackage: original.request.sourcePackage,
        packageVersion: original.request.packageVersion,
        operationId: 'tool-call-B',
        alive() {},
      })
      await expect(anotherOperation.request(spec)).rejects.toThrow('KEY_CONFLICT')
      expect((await first.session.decisions.get(handle)).request).toEqual(original.request)
      await first.log.close()
      release()
      await inFlight
      const second = await openSession({
        registry,
        storage: first.storage,
        writerRunId: 'cold-tool',
        seams,
        provider: fakeProvider([]),
      })
      try {
        expect((await second.session.resume()).actions).toEqual([
          { effectId: expect.any(String), action: 'unknown' },
        ])
        expect(executions).toBe(1)
        expect((await second.session.decisions.get(handle)).result).toBeNull()
        expect((await second.log.scan({ type: 'tool/result', limit: 20 })).at(-1)?.data).toMatchObject({
          code: 'DECISION_CONTINUATION_BLOCKED',
        })
        expect(
          (await second.log.scan({ type: 'effect/intent', limit: 20 })).filter(
            (row) => (row.data as { kind?: string })?.kind === 'tool',
          ),
        ).toHaveLength(1)
        const reconciliations = (await second.session.decisions.list()).filter(
          (value) => value.request.spec.purpose === 'unknown-outcome',
        )
        expect(reconciliations).toHaveLength(1)
        expect(reconciliations[0]).toMatchObject({ result: null, consumption: null })
        expect((await second.log.scan({ type: 'effect/settled', limit: 20 })).at(-1)?.data).toMatchObject({
          outcome: 'unknown',
        })
        await second.session.close()
        const third = await openSession({
          registry,
          seams,
          storage: first.storage,
          writerRunId: 'second-restart',
          provider: fakeProvider([]),
        })
        try {
          await third.session.resume()
          expect(
            (await third.session.decisions.list()).filter(
              (value) => value.request.spec.purpose === 'unknown-outcome',
            ),
          ).toEqual(reconciliations)
          expect(executions).toBe(1)
        } finally {
          await third.session.close()
        }
      } finally {
        await second.session.close()
      }
    },
  )
  it('reopens the original request and consumes its human answer with the next checkpoint', async () => {
    const first = await fixture()
    const handle = await first.ctx.decisions.request(spec)
    const original = await first.ctx.decisions.get(handle)
    expect(original.request).toMatchObject({
      owner: 'community.review',
      sourcePackage: '@community/review',
      operationId: 'loop:community.review',
      requestedBy: actor,
    })
    await first.session.close()
    const second = await fixture({ storage: first.storage, writerRunId: 'second' })
    try {
      expect(await second.ctx.decisions.request(spec)).toEqual(handle)
      expect((await second.ctx.decisions.get(handle)).request).toEqual(original.request)
      const command = {
        handle,
        revision: 1,
        commandId: 'answer-1',
        response: { option: 'continue', value: null },
      }
      const waiting = second.ctx.decisions.wait(handle)
      const receipt = await second.session.decisions.answer(command, context)
      expect(await waiting).toMatchObject({
        status: 'resolved',
        snapshot: { result: { reason: 'answered', answeredBy: actor } },
      })
      await second.ctx.checkpoints.write(codec.encode('done'), { decisionRefs: [handle] })
      const consumed = await second.ctx.decisions.get(handle)
      expect(consumed.consumption).toMatchObject({
        effectId: null,
        operationId: original.request.operationId,
      })
      const rows = await second.log.scan({ limit: 100 })
      const at = rows.findIndex((row) => (row.data as { consumption?: unknown })?.consumption != null)
      expect(rows[at + 1]?.type).toBe('x/core/loop-checkpoint')
      expect(rows.some((row) => row.type === 'effect/intent')).toBe(false)
      expect(await second.session.decisions.answer(command, context)).toEqual(receipt)
      await expect(
        second.session.decisions.answer({ ...command, response: { option: 'reject', value: null } }, context),
      ).rejects.toThrow('COMMAND_CONFLICT')
      await expect(
        second.ctx.checkpoints.write(codec.encode('done'), { decisionRefs: [handle] }),
      ).rejects.toThrow('NOT_CONSUMABLE')
    } finally {
      await second.session.close()
    }
  })
  it('keeps detached delivery pending and refuses changed keys, options and response values', async () => {
    const f = await fixture()
    try {
      const handle = await f.ctx.decisions.request({
        ...spec,
        responseSchema: { type: 'integer', minimum: 1 },
      })
      const controller = new AbortController()
      const wait = f.ctx.decisions.wait(handle, { signal: controller.signal })
      controller.abort()
      expect(await wait).toEqual({ status: 'pending', handle, waitEndedBy: 'detached' })
      expect((await f.ctx.decisions.get(handle)).result).toBeNull()
      await expect(f.ctx.decisions.request({ ...spec, subject: 'changed' })).rejects.toThrow('KEY_CONFLICT')
      await expect(
        f.ctx.decisions.request({
          ...spec,
          responseSchema: { type: 'integer', minimum: 1 },
          presentation: { en: { title: 'Changed', fields: [] } },
        }),
      ).rejects.toThrow('KEY_CONFLICT')
      const command = {
        handle,
        revision: 1,
        commandId: 'answer',
        response: { option: 'unoffered', value: 1 },
      }
      await expect(f.session.decisions.answer(command, context)).rejects.toThrow('ANSWER')
      await expect(
        f.session.decisions.answer(
          { ...command, response: { option: 'continue', value: 'invalid' } },
          context,
        ),
      ).rejects.toThrow('RESPONSE_SCHEMA')
      await expect(
        f.session.decisions.answer(
          { ...command, response: { option: 'continue', value: 1 } },
          {
            ...context,
            authorize() {
              throw new Error('revoked')
            },
          },
        ),
      ).rejects.toThrow('revoked')
      expect((await f.ctx.decisions.get(handle)).revision).toBe(1)
    } finally {
      await f.session.close()
    }
  })
  it('serializes answer races and invalidates answered but unconsumed requests at expiry and stop', async () => {
    let now = 1_757_203_200_000
    const f = await fixture({ clock: () => now })
    try {
      const handle = await f.ctx.decisions.request(spec)
      const command = {
        handle,
        revision: 1,
        commandId: 'first',
        response: { option: 'continue', value: null },
      }
      const results = await Promise.allSettled([
        f.session.decisions.answer(command, context),
        f.session.decisions.answer({ ...command, commandId: 'second' }, context),
      ])
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
      now += f.session.preset.approval.pendingTtlMs
      const expired = await f.ctx.decisions.get(handle)
      expect(expired.result?.reason).toBe('answered')
      expect(expired.invalidation?.code).toBe('deadline')
      await expect(f.ctx.checkpoints.write(codec.encode('done'), { decisionRefs: [handle] })).rejects.toThrow(
        'NOT_CONSUMABLE',
      )
      const pending = await f.ctx.decisions.request({ ...spec, key: 'second' })
      await f.session.abort(actor)
      expect((await f.ctx.decisions.get(pending)).result?.reason).toBe('stopped')
      await expect(f.session.decisions.answer({ ...command, handle: pending }, context)).rejects.toThrow(
        'NOT_PENDING',
      )
    } finally {
      await f.session.close()
    }
  })
  it('refuses an expired decision read that loses execution authority before commit', async () => {
    let now = 1_757_203_200_000
    const f = await fixture({ clock: () => now })
    try {
      const handle = await f.ctx.decisions.request(spec)
      now += f.session.preset.approval.pendingTtlMs
      const before = await f.session.scan({ fromSeq: 1, limit: 200 })
      const append = f.log.append.bind(f.log)
      const gate = vi.spyOn(f.log, 'append').mockImplementation((events, options) =>
        append(events, {
          ...options,
          beforeCommit: async () => {
            await options?.beforeCommit?.()
            f.session.loopScope.revoke()
          },
        }),
      )
      await expect(f.ctx.decisions.get(handle)).rejects.toMatchObject({ code: 'E_CLOSED' })
      gate.mockRestore()
      expect(await f.session.scan({ fromSeq: 1, limit: 200 })).toEqual(before)
    } finally {
      await f.session.close()
    }
  })

  it('revokes a no-op-state execution scope, including queued and late callbacks', async () => {
    const contexts: LoopContext[] = []
    const f = await fixture({ loopFactory: loop((ctx) => contexts.push(ctx)) })
    const old = contexts[0]!
    try {
      const pending = await old.decisions.request(spec)
      expect(f.session.op()).toBeNull()
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const answer = f.session.decisions.answer(
        { handle: pending, revision: 1, commandId: 'late', response: { option: 'continue', value: null } },
        {
          ...context,
          async authorize() {
            entered()
            await gate
          },
        },
      )
      await started
      const queued = old.decisions.request({ ...spec, key: 'racing-stop' })
      const stop = f.session.abort(actor)
      release()
      await expect(answer).rejects.toThrow('STOPPED')
      await expect(queued).rejects.toThrow('STOPPED')
      await stop
      expect((await old.decisions.get(pending)).result?.reason).toBe('stopped')
      await expect(old.decisions.request({ ...spec, key: 'after-stop' })).rejects.toThrow('STOPPED')
      await expect(old.checkpoints.write(codec.encode('done'), { decisionRefs: [pending] })).rejects.toThrow(
        'STOPPED',
      )
      await f.session.run({ until: 'idle', signal: new AbortController().signal })
      const fresh = contexts.at(-1)!
      expect(fresh).not.toBe(old)
      const handle = await fresh.decisions.request({ ...spec, key: 'new-run' })
      await f.session.decisions.answer(
        { handle, revision: 1, commandId: 'fresh', response: { option: 'continue', value: null } },
        context,
      )
      await fresh.checkpoints.write(codec.encode('done'), { decisionRefs: [handle] })
      expect((await fresh.decisions.get(handle)).consumption?.effectId).toBeNull()
      await expect(old.decisions.request({ ...spec, key: 'still-old' })).rejects.toThrow('STOPPED')
      await expect(old.checkpoints.write(codec.encode('done'), { decisionRefs: [handle] })).rejects.toThrow(
        'STOPPED',
      )
    } finally {
      await f.session.close()
    }
  })
  it('refuses a no-op-state stop in the final authorization microtask gap', async () => {
    const f = await fixture()
    let stop: Promise<unknown> | undefined
    try {
      const handle = await f.ctx.decisions.request(spec)
      let checks = 0
      await expect(
        f.session.decisions.answer(
          { handle, revision: 1, commandId: 'commit-race', response: { option: 'continue', value: null } },
          {
            ...context,
            async authorize() {
              if (++checks === 2)
                queueMicrotask(() =>
                  queueMicrotask(() => {
                    stop = f.session.abort(actor)
                  }),
                )
            },
          },
        ),
      ).rejects.toThrow('STOPPED')
      await stop
      expect((await f.ctx.decisions.get(handle)).answerCommand).toBeNull()
    } finally {
      await stop
      await f.session.close()
    }
  })
  it('consumes all required references or none and refuses authority bypass writes', async () => {
    const f = await fixture()
    try {
      const one = await f.ctx.decisions.request(spec)
      const two = await f.ctx.decisions.request({ ...spec, key: 'two' })
      await f.session.decisions.answer(
        { handle: one, revision: 1, commandId: 'one', response: { option: 'continue', value: null } },
        context,
      )
      await expect(
        f.ctx.checkpoints.write(codec.encode('done'), { decisionRefs: [one, two] }),
      ).rejects.toThrow('NOT_CONSUMABLE')
      expect((await f.ctx.decisions.get(one)).consumption).toBeNull()
      const original = await f.ctx.decisions.get(two)
      await expect(
        f.log.append([
          f.session.ev(
            'decision/state',
            { ...original, revision: 2, request: { ...original.request, spec: { ...spec, key: 'changed' } } },
            { register: 'decision/state' },
          ),
        ]),
      ).rejects.toThrow('immutable')
      await expect(
        f.log.append([
          f.session.ev('decision/state', original, { origin: 'ext:synthetic', register: 'decision/state' }),
        ]),
      ).rejects.toThrow('Core-owned')
    } finally {
      await f.session.close()
    }
  })
})

it.each(['full-access', 'workspace-write', 'custom'])(
  'durably resolves permission gates using the effective %s permission without inventing a human answer',
  async (policy) => {
    const preset = presetDefaults()
    preset.name = 'standard'
    if (policy !== 'custom') preset.permission = policy as 'full-access' | 'workspace-write'
    preset.approval.policy = policy === 'custom' ? 'full-access' : policy
    // This test exercises decision authority independently of provider registration.
    const toolPolicies = new ToolPolicyRegistry()
    toolPolicies.register('fixture', {
      id: preset.approval.policy,
      version: '1.0.0',
      decide: () => ({ effect: 'allow', reason: 'fixture' }),
    })
    const f = await fixture({ preset, toolPolicies })
    try {
      const port = f.session.decisions.port({
        permission: true,
        owner: 'fixture/permission',
        operationId: 'operation',
        sourcePackage: '@fixture/permission',
        packageVersion: '1.0.0',
        alive() {},
      })
      for (const purpose of [
        'candidate.test',
        'plugin.publish',
        'memory',
        'credential.admin',
        'skills.install',
        'mcp.connect',
        'gate',
        'tool.permission',
      ]) {
        const handle = await port.request({
          key: purpose,
          purpose,
          subject: { hash: 'exact' },
          prompt: 'Allow?',
          options: ['allowed-once', 'rejected'],
          responseSchema: { type: 'null' },
        })
        const value = await port.get(handle)
        if (policy === 'full-access') {
          expect(value.result).toMatchObject({
            reason: 'answered',
            code: 'full-access',
            response: { option: 'allowed-once', value: null },
            answeredBy: { id: actor.id, role: 'system' },
          })
          expect((await port.wait(handle)).status).toBe('resolved')
          expect(value.answerCommand).toBeNull()
        } else expect(value.result).toBeNull()
      }
      const question = await port.request({ ...spec, key: 'question' })
      expect((await port.get(question)).result).toBeNull()
      for (const purpose of ['plan.exit', 'unknown-outcome']) {
        const handle = await port.request({
          ...spec,
          key: purpose,
          purpose,
          options: ['allowed-once', 'rejected'],
        })
        expect((await port.get(handle)).result).toBeNull()
      }
      const persisted = await f.session.scan({ type: 'decision/state', limit: 100 })
      expect(persisted.length).toBeGreaterThan(0)
      expect(
        persisted.filter(
          (row) => (row.data as { result?: { code?: string } }).result?.code === 'full-access',
        ),
      ).toHaveLength(policy === 'full-access' ? 8 : 0)
    } finally {
      await f.session.close()
    }
  },
)

it('auto-resolves an outstanding permission when the effective preset switches to full access', async () => {
  const f = await fixture()
  try {
    const port = f.session.decisions.port({
      permission: true,
      owner: 'fixture/permission',
      operationId: 'switch',
      sourcePackage: '@fixture/permission',
      packageVersion: '1.0.0',
      alive() {},
    })
    const handle = await port.request({
      ...spec,
      key: 'switch',
      purpose: 'tool.permission',
      options: ['allowed-once', 'rejected'],
    })
    expect((await port.get(handle)).result).toBeNull()
    const next = presetDefaults()
    next.name = 'standard'
    next.permission = 'full-access'
    next.approval.policy = 'full-access'
    await f.session.setPreset(next)
    expect((await port.get(handle)).result).toMatchObject({
      reason: 'answered',
      code: 'full-access',
      response: { option: 'allowed-once' },
    })
  } finally {
    await f.session.close()
  }
})
