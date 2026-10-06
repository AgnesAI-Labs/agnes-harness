import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { contextInline } from '../../../extension-api/testkit/runtime/contracts/context.js'
import {
  type LoopContractFixture,
  runLoopContractScenario,
} from '../../../extension-api/testkit/runtime/contracts/loop.js'
import { createDefaultLoopFactory } from '../../src/runtime/providers/loop.js'
import { createDefaultModelFactory } from '../../src/runtime/providers/model.js'
import { fakeDeployment } from './model-deployment-fixture.js'
import { fixtureModel } from './model-fixture.js'

type Fixture = LoopContractFixture & {
  receipts: Map<string, W.ActionResultView>
  bindings: Record<string, W.BindingRef>
  source: {
    allowed: boolean
    blocked?: Promise<{ ok: true; value: undefined } | { ok: false; error: W.RuntimeError }>
  }
  issued: W.PreparedAction[]
}
type FixtureCredentials = { binding: W.SecretConsumerBinding | null; handle: W.SecretHandle | null }
async function open(credentials?: FixtureCredentials): Promise<Fixture> {
  const module = (await import(
    new URL('../../../../tools/acceptance/runtime/platform/loop-conformance.ts', import.meta.url).href
  )) as { openLoopFixture(options?: { credentials: FixtureCredentials }): Promise<Fixture> }
  return module.openLoopFixture(credentials ? { credentials } : undefined)
}
async function ready(credentials?: FixtureCredentials, modelProviderId?: string) {
  const fixture = await open(credentials)
  if (modelProviderId) required(fixture.bindings.model).providerId = modelProviderId
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  expect(await provider.ready(fixture.context)).toEqual({ ok: true, value: undefined })
  return { ...fixture, provider }
}
async function pendingAt(
  f: Awaited<ReturnType<typeof ready>>,
  stage: 'first-model' | 'tool' | 'second-model',
) {
  let transition = await f.provider.start(f.frame, f.ports)
  for (const key of ['first-model', 'tool'] as const) {
    if (stage === key) break
    await f.accept(required(transition.actions[0]))
    transition = await f.provider.resume(f.nextFrame(transition), f.ports)
  }
  expect(transition.actions[0]?.key).toBe(stage)
  return transition
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Loop fixture value absent')
  return value
}
function failure(transition: W.LoopTransition, detail?: string) {
  expect(transition.actions).toEqual([])
  expect(transition.next.kind).toBe('fail')
  if (transition.next.kind === 'fail' && detail) expect(transition.next.error.detailCode).toBe(detail)
}

/** The Loop's own model peer becomes the real model service: the handle it plans against is real. */
async function realModelPorts(f: Fixture) {
  const owner = required(f.bindings.model)
  const pick = {
    route: { route: 'fixture-model', api: 'openai-completions', baseUrl: 'https://fake.invalid' },
    model: { ...fixtureModel, id: 'f02-text', route: 'fixture-model' },
  }
  const { deployment } = fakeDeployment({
    catalog: {
      capture: () => ({
        ok: true,
        value: {
          digest: canonicalJsonDigest({ routes: [pick] } as never) as string,
          select: (route: string, model: string) =>
            route === pick.route.route && model === pick.model.id ? pick : undefined,
        },
      }),
    },
    adapters: { select: (target) => ({ binding: target, packageDigest: 'package-1' }) },
  })
  const config = deployment.config.encode({})
  if (!config.ok) throw new Error('model config rejected')
  const { signal } = f.context
  const model = await createDefaultModelFactory(deployment).create(config.value, f.dependencies, {
    instanceId: 'model-instance',
    bindingId: owner.bindingId,
    scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as W.ScopeRef,
    signal,
  })
  expect(await model.ready(f.context)).toEqual({ ok: true, value: undefined })
  const prepared: W.ModelPrepareResult[] = []
  const ports = {
    ...f.ports,
    async compute(request: W.ServiceOperation) {
      if (request.target.contract !== 'agh.model' || request.method !== 'prepare')
        return f.ports.compute(request)
      // The first wire slice has no tools, so the catalog is dropped on the way in; the handle the
      // service returns is still real and its header does not carry the catalog.
      const body = validateRuntime(
        'ModelPrepareRequest',
        request.input.kind === 'inline' ? request.input.value : null,
      )
      if (!body.ok) throw new Error('Preparation request fixture')
      const input = contextInline(
        request.input.kind === 'inline'
          ? request.input.schema
          : RuntimeMethodSchemaRefs['agh.model'].prepare.input,
        { ...body.value, toolCatalog: null },
      )
      const reply = await model.compute?.({ ...request, input }, f.context)
      if (reply?.ok && reply.value.kind === 'inline') {
        const result = validateRuntime('ModelPrepareResult', reply.value.value)
        if (result.ok) prepared.push(result.value)
      }
      return reply ?? f.ports.compute(request)
    },
  }
  return { ports, prepared, close: () => model.close('shutdown') }
}

describe('full C01 SPI text Loop candidate, restricted background peers', () => {
  it.each([
    'normal',
    'missing-handle',
    'unconfigured-handle',
    'wrong-secret',
    'wrong-audience',
    'wrong-consumer',
    'expired',
    'substituted-handle',
    'expired-after-prepare',
  ] as const)(
    'consumes only the native source credential locked by model preparation: %s',
    async (scenario) => {
      // F02 supplies synthetic source facts; production issuance is owned by C22/model preparation.
      const binding: W.SecretConsumerBinding = {
        consumer: 'model',
        secretId: 'fixed-secret',
        accountRef: null,
        serverRef: 'restricted-peer',
        audience: 'restricted',
        purpose: 'model-inference',
      }
      const handle: W.SecretHandle = {
        handleId: 'fixed-handle',
        secretId: binding.secretId,
        version: 'fixed-version',
        audience: binding.audience,
        expiresAt: new Date(
          Date.now() + (scenario === 'expired-after-prepare' ? 1000 : 300_000),
        ).toISOString(),
      }
      if (scenario === 'wrong-secret') handle.secretId = 'another-secret'
      if (scenario === 'wrong-audience') handle.audience = 'another-consumer'
      if (scenario === 'wrong-consumer') binding.consumer = 'mcp'
      if (scenario === 'expired') handle.expiresAt = new Date(Date.now() - 1000).toISOString()
      const f = await ready({
        binding: scenario === 'unconfigured-handle' ? null : binding,
        handle: scenario === 'missing-handle' ? null : handle,
      })
      let clock: ReturnType<typeof vi.spyOn> | undefined
      try {
        const ports = {
          ...f.ports,
          async compute(request: W.ServiceOperation) {
            const reply = await f.ports.compute(request)
            if (request.target.contract === 'agh.model' && request.method === 'prepare' && reply.ok) {
              if (scenario === 'expired-after-prepare')
                clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(handle.expiresAt) + 1)
              if (scenario === 'substituted-handle' && reply.value.kind === 'inline') {
                const prepared = validateRuntime('ModelPrepareResult', reply.value.value)
                if (!prepared.ok || prepared.value.preparedRef.kind !== 'inline')
                  throw new Error('Preparation fixture')
                const locked = validateRuntime('PreparedModelHandle', prepared.value.preparedRef.value)
                if (!locked.ok) throw new Error('Prepared source fixture')
                return {
                  ok: true as const,
                  value: contextInline(reply.value.schema, {
                    ...prepared.value,
                    preparedRef: contextInline(RuntimeSchemaRefs.PreparedModelHandle, {
                      ...locked.value,
                      header: {
                        ...locked.value.header,
                        credentialRef: { ...handle, version: 'substituted-version' },
                      },
                    }),
                  }),
                }
              }
            }
            return reply
          },
        }
        const first = await f.provider.start(f.frame, ports)
        if (scenario !== 'normal') {
          failure(
            first,
            scenario === 'missing-handle'
              ? 'loop_model_credentials_unavailable'
              : scenario === 'substituted-handle'
                ? 'loop_prepared_identity'
                : scenario === 'expired' || scenario === 'expired-after-prepare'
                  ? 'loop_credential_expired'
                  : 'loop_credential_binding',
          )
          expect(f.issued).toEqual([])
          return
        }
        const modelAction = required(first.actions[0])
        const inference = validateRuntime(
          'ModelInferRequest',
          modelAction.input.kind === 'inline' ? modelAction.input.value : null,
        )
        if (!inference.ok || inference.value.preparedRef.kind !== 'inline')
          throw new Error('Inference fixture')
        expect(validateRuntime('PreparedModelHandle', inference.value.preparedRef.value)).toMatchObject({
          ok: true,
          value: { header: { credentialRef: handle } },
        })
        await f.accept(modelAction)
        const tool = await f.provider.resume(f.nextFrame(first), ports)
        await f.accept(required(tool.actions[0]))
        const second = await f.provider.resume(f.nextFrame(tool), ports)
        expect(second.actions.map((action) => action.key)).toEqual(['second-model'])
        await f.accept(required(second.actions[0]))
        expect((await f.provider.resume(f.nextFrame(second), ports)).next.kind).toBe('complete')
      } finally {
        clock?.mockRestore()
        await f.provider.close('shutdown')
        await f.close()
      }
    },
  )
  it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)(
    'public contract %s',
    async (scenario) => {
      await runLoopContractScenario(scenario, open)
    },
  )
  it('does not claim cold State recovery from a map or a replacement instance', async () => {
    await expect(runLoopContractScenario('recover', open)).rejects.toThrow(
      'loop_cold_state_consumer_unavailable',
    )
  })
  it('plans stable actions, waits for visibility, and does not re-emit a pending effect', async () => {
    const f = await ready()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const repeated = await f.provider.start(f.frame, f.ports)
      expect(repeated).toEqual(first)
      expect(first.actions[0]?.key).toBe('first-model')
      const frame = f.nextFrame(first)
      frame.observedAt = new Date(Date.parse(frame.observedAt) + 30_000).toISOString()
      const waiting = await f.provider.resume(frame, f.ports)
      expect(waiting.actions).toEqual([])
      expect(waiting.continuation).toEqual(
        first.continuation ? { ...first.continuation, createdAt: frame.observedAt } : null,
      )
      expect(waiting.next).toEqual(first.next)
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each(['first-model', 'tool', 'second-model'] as const)(
    'keeps %s unknown effects unresolved even after the saved deadline',
    async (stage) => {
      const f = await ready()
      try {
        const first = await pendingAt(f, stage)
        const action = required(first.actions[0])
        await f.accept(action)
        required(f.receipts.get(action.key)).outcome = 'unknown_effect'
        const frame = f.nextFrame(first)
        frame.observedAt = '2090-01-01T00:00:00Z'
        const waiting = await f.provider.resume(frame, f.ports)
        expect(waiting.actions).toEqual([])
        expect(waiting.next).toEqual({
          kind: 'wait',
          condition: {
            anyOf: [{ kind: 'actions', mode: 'all', actions: [{ localKey: stage }], readyWhen: 'resolved' }],
          },
        })
      } finally {
        await f.provider.close('shutdown')
        await f.close()
      }
    },
  )
  it.each([
    ['first-model', 'model_prepared_lost'],
    ['second-model', 'model_prepared_lost'],
    ['first-model', 'model_not_sent'],
    ['second-model', 'model_not_sent'],
  ] as const)('ends %s on %s without planning another handle or action', async (stage, detailCode) => {
    const f = await ready()
    try {
      const pending = await pendingAt(f, stage)
      const action = required(pending.actions[0])
      expect(action.retry).toEqual({ mode: 'never', maxAttempts: 1, backoffMs: [] })
      await f.accept(action)
      const receipt = required(f.receipts.get(action.key))
      receipt.outcome = 'failed'
      delete receipt.result
      receipt.error = {
        code: 'incompatible',
        detailCode,
        message: 'Model failed',
        diagnosticId: 'fixture',
        retryAdvice: { kind: 'never' },
      }
      expect(validateRuntime('ActionResultView', receipt).ok).toBe(true)
      const ports = {
        ...f.ports,
        async compute() {
          throw new Error('Failure must not replan')
        },
      }
      const frame = f.nextFrame(pending)
      for (let replay = 0; replay < 2; replay++) {
        const result = await f.provider.resume(frame, ports)
        failure(result, detailCode)
        expect(result.next).toMatchObject({ kind: 'fail', error: { retryAdvice: { kind: 'never' } } })
        expect(result.continuation).toEqual(pending.continuation)
      }
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each(['inputDigest', 'bindingId', 'visibility'] as const)(
    'rejects a receipt with wrong %s',
    async (field) => {
      const f = await ready()
      try {
        const first = await f.provider.start(f.frame, f.ports)
        const action = required(first.actions[0])
        await f.accept(action)
        const receipt = required(f.receipts.get(action.key))
        if (field === 'inputDigest') receipt.inputDigest = canonicalJsonDigest('wrong input')
        else if (field === 'bindingId') receipt.bindingId = 'other-binding'
        else Object.assign(receipt, { visibility: 'pending' })
        failure(await f.provider.resume(f.nextFrame(first), f.ports))
      } finally {
        await f.provider.close('shutdown')
        await f.close()
      }
    },
  )
  it('plans against the handle the real model service returns', async () => {
    const f = await ready(undefined, 'agh.default/model')
    const model = await realModelPorts(f)
    try {
      const first = await f.provider.start(f.frame, model.ports)
      const action = required(first.actions[0])
      expect(first.next.kind).toBe('wait')
      const sent = model.prepared[0]
      expect(sent?.preparedRef.kind === 'inline' && sent.preparedRef.schema).toEqual(
        RuntimeSchemaRefs.PreparedModelHandle,
      )
      const infer = validateRuntime(
        'ModelInferRequest',
        action.input.kind === 'inline' ? action.input.value : null,
      )
      expect(infer.ok && infer.value.preparedRef).toEqual(sent?.preparedRef)
    } finally {
      await model.close()
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('refuses a handle whose input digest differs from the prepare result', async () => {
    const f = await ready(undefined, 'agh.default/model')
    const model = await realModelPorts(f)
    try {
      const ports = {
        ...model.ports,
        async compute(request: W.ServiceOperation) {
          const reply = await model.ports.compute(request)
          if (request.method !== 'prepare' || !reply.ok || reply.value.kind !== 'inline') return reply
          const result = validateRuntime('ModelPrepareResult', reply.value.value)
          if (!result.ok || result.value.preparedRef.kind !== 'inline') throw new Error('Preparation fixture')
          const handle = validateRuntime('PreparedModelHandle', result.value.preparedRef.value)
          if (!handle.ok) throw new Error('Handle fixture')
          return {
            ok: true as const,
            value: contextInline(reply.value.schema, {
              ...result.value,
              preparedRef: contextInline(RuntimeSchemaRefs.PreparedModelHandle, {
                ...handle.value,
                inputDigest: canonicalJsonDigest('another input'),
              }),
            }),
          }
        },
      }
      failure(await f.provider.start(f.frame, ports), 'loop_prepared_identity')
      expect(f.issued).toEqual([])
    } finally {
      await model.close()
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each([
    'announced',
    'plan the handle header does not commit to',
    'header commitment without an announced plan',
    'announcement that differs from the committed plan',
    'plan wider than the locked target',
  ] as const)('accepts only the media plans the handle header commits to: %s', async (scenario) => {
    const f = await ready(undefined, 'agh.default/model')
    const model = await realModelPorts(f)
    try {
      const ports = {
        ...model.ports,
        async compute(request: W.ServiceOperation) {
          const reply = await model.ports.compute(request)
          if (request.method !== 'prepare' || !reply.ok || reply.value.kind !== 'inline') return reply
          const result = validateRuntime('ModelPrepareResult', reply.value.value)
          if (!result.ok || result.value.preparedRef.kind !== 'inline') throw new Error('Preparation fixture')
          const handle = validateRuntime('PreparedModelHandle', result.value.preparedRef.value)
          if (!handle.ok) throw new Error('Handle fixture')
          const planFor = (features: W.ModelFeatures): W.MediaPlan => ({
            key: 'media:fixed',
            sourceRefs: [],
            sourceDigest: 'a'.repeat(64),
            transformSchema: { typeId: 'agh.media/transform-native@1', revision: 1, digest: 'b'.repeat(64) },
            parameters: contextInline(
              { typeId: 'agh.media/parameters@1', revision: 1, digest: 'c'.repeat(64) },
              {},
            ),
            targetFeatures: features,
            provider: {
              bindingId: 'media',
              providerId: 'agh.default/media',
              contract: 'agh.media',
              logicalName: 'default',
            },
          })
          const features = handle.value.header.route.features
          const plan = planFor(
            scenario === 'plan wider than the locked target'
              ? { ...features, input: [...features.input, 'audio'] }
              : features,
          )
          const committed = scenario === 'plan the handle header does not commit to' ? [] : [plan]
          const announced =
            scenario === 'header commitment without an announced plan'
              ? []
              : [
                  contextInline(
                    { typeId: 'agh.media/plan@1', revision: 1, digest: 'd'.repeat(64) },
                    scenario === 'announcement that differs from the committed plan'
                      ? { ...plan, key: 'media:other' }
                      : plan,
                  ),
                ]
          return {
            ok: true as const,
            value: contextInline(reply.value.schema, {
              ...result.value,
              mediaPlanRefs: announced,
              preparedRef: contextInline(RuntimeSchemaRefs.PreparedModelHandle, {
                ...handle.value,
                header: {
                  ...handle.value.header,
                  mediaPlanDigests: committed.map((p) => canonicalJsonDigest(p as never)),
                },
              }),
            }),
          }
        },
      }
      const first = await f.provider.start(f.frame, ports)
      if (scenario === 'announced') {
        expect(first.next.kind).toBe('wait')
        expect(first.actions.map((a) => a.method)).toEqual(['infer'])
      } else failure(first, 'loop_prepared_identity')
    } finally {
      await model.close()
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('binds the classified tool to the original prepared model request and canonical definition', async () => {
    const f = await ready()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const firstAction = required(first.actions[0])
      await f.accept(firstAction)
      const tool = await f.provider.resume(f.nextFrame(first), f.ports)
      const action = required(tool.actions[0])
      expect(action.resultSchema).toEqual(RuntimeSchemaRefs.ToolResult)
      if (action.input.kind !== 'inline' || firstAction.input.kind !== 'inline')
        throw new Error('inline fixture')
      const call = validateRuntime('ToolCall', action.input.value)
      const infer = validateRuntime('ModelInferRequest', firstAction.input.value)
      expect(call.ok && infer.ok).toBe(true)
      if (call.ok && infer.ok) {
        expect(call.value.modelContextRef).toEqual(infer.value.preparedRef)
        expect(call.value.expectedDefinitionDigest).toBe(canonicalJsonDigest(call.value.definition))
      }
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('refuses a real conversation until its content codec and State consumption exist', async () => {
    const f = await ready()
    try {
      const frame = structuredClone(f.frame)
      frame.conversation = {
        turnId: 'turn',
        inputMessageId: 'message',
        kind: 'prompt',
        inputRef: frame.input,
      }
      failure(await f.provider.start(frame, f.ports), 'loop_conversation_codec_unavailable')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('refuses missing authorized source before accepting traffic', async () => {
    const f = await open()
    try {
      const provider = await createDefaultLoopFactory(f.factory.descriptor).create(
        f.config,
        f.dependencies,
        f.factoryContext,
      )
      const result = await provider.ready(f.context)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.detailCode).toBe('loop_source_unavailable')
      await provider.close('shutdown')
    } finally {
      await f.close()
    }
  })
  it('rejects a foreign continuation producer or substituted checkpoint content', async () => {
    const f = await ready()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const frame = f.nextFrame(first)
      if (!frame.continuation) throw new Error('continuation expected')
      frame.continuation.provenance.producer.bindingId = 'other-loop'
      failure(await f.provider.resume(frame, f.ports), 'loop_state_producer')
      frame.continuation = structuredClone(first.continuation)
      if (frame.continuation?.data.kind !== 'inline') throw new Error('inline state')
      frame.continuation.data.value = { fake: 'replacement' }
      failure(await f.provider.resume(frame, f.ports), 'loop_data_integrity')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('rechecks authorization after a slow read before preparing any effect', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        async compute(request: W.ServiceOperation) {
          const value = await f.ports.compute(request)
          f.revoke()
          return value
        },
      }
      failure(await f.provider.start(f.frame, ports), 'loop_fixture_revoked')
      expect(f.issued).toEqual([])
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('does not downgrade automatic preparation requests to an invented envelope', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        prepare: () => ({
          ok: false as const,
          error: {
            code: 'incompatible' as const,
            detailCode: 'preparation_required',
            message: 'Official owner required',
            retryAdvice: { kind: 'never' as const },
            diagnosticId: 'f02',
          },
        }),
      }
      failure(await f.provider.start(f.frame, ports), 'preparation_required')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each(['first-model', 'tool'] as const)('refuses substituted %s preparation intent', async (stage) => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        prepare(spec: W.ActionSpec) {
          const result = f.ports.prepare(spec)
          return result.ok
            ? {
                ok: true as const,
                value: { ...result.value, key: 'substituted', target: required(f.bindings.supervisor) },
              }
            : result
        },
      }
      if (stage === 'first-model')
        failure(await f.provider.start(f.frame, ports), 'loop_prepared_action_substituted')
      else {
        const first = await f.provider.start(f.frame, f.ports)
        await f.accept(required(first.actions[0]))
        failure(
          await f.provider.resume(f.nextFrame(first), {
            ...ports,
            prepare(spec) {
              if (spec.key !== 'tool') return f.ports.prepare(spec)
              return ports.prepare(spec)
            },
          }),
          'loop_prepared_action_substituted',
        )
      }
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('rejects same-input context output from a different snapshot', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        async query(request: W.ServiceQuery) {
          const reply = await f.ports.query(request)
          return reply.ok && reply.value.kind === 'value' && request.target.contract === 'agh.context'
            ? { ok: true as const, value: { ...reply.value, snapshot: 'different-snapshot' } }
            : reply
        },
      }
      failure(await f.provider.start(f.frame, ports), 'loop_context_snapshot')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('refuses preparation that mutates its request object in place', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        prepare(spec: W.ActionSpec) {
          spec.key = 'substituted'
          return f.ports.prepare(spec)
        },
      }
      failure(await f.provider.start(f.frame, ports), 'loop_prepared_action_substituted')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('fixes the original factory binding instead of rereading a mutable assembly object', async () => {
    const f = await ready()
    try {
      f.factoryContext.bindingId = 'changed-after-create'
      const planned = await f.provider.start(f.frame, f.ports)
      expect(planned.next.kind).toBe('wait')
      expect(planned.actions[0]?.key).toBe('first-model')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each([RuntimeMethodSchemaRefs['agh.tools'].invoke.output, RuntimeSchemaRefs.ToolResult])(
    'rejects non-model-visible Tool result codec before calling the next model',
    async (schema) => {
      const f = await ready()
      try {
        const first = await f.provider.start(f.frame, f.ports)
        await f.accept(required(first.actions[0]))
        const tool = await f.provider.resume(f.nextFrame(first), f.ports)
        await f.accept(required(tool.actions[0]))
        const receipt = required(f.receipts.get('tool'))
        if (receipt.result?.kind !== 'inline') throw new Error('tool output')
        receipt.result = contextInline(schema, receipt.result.value)
        failure(await f.provider.resume(f.nextFrame(tool), f.ports), 'loop_data_schema')
      } finally {
        await f.provider.close('shutdown')
        await f.close()
      }
    },
  )
  it('times out a noncooperative source and keeps drain blocked until that read settles', async () => {
    const f = await ready()
    let release: ((value: { ok: true; value: undefined }) => void) | undefined
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      f.source.blocked = new Promise((resolve) => {
        release = resolve
      })
      const frame = structuredClone(f.frame)
      frame.context.deadline = new Date(Date.now() + 25).toISOString()
      const pending = f.provider.start(frame, f.ports)
      await vi.advanceTimersByTimeAsync(26)
      failure(await pending, 'loop_invocation_expired')
      const draining = await f.provider.drain(f.context.deadline, f.context)
      expect(draining.ok && draining.value.state).toBe('blocked')
      required(release)({ ok: true, value: undefined })
      await f.source.blocked
      await new Promise<void>((resolve) => setImmediate(resolve))
      const drained = await f.provider.drain(f.context.deadline, f.context)
      expect(drained.ok && drained.value.state).toBe('drained')
    } finally {
      vi.useRealTimers()
      release?.({ ok: true, value: undefined })
      await f.provider.close('shutdown')
      await f.close()
    }
  })
})
