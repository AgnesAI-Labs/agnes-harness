import { type LoopReadPorts, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { modelCaptureOf } from '../../src/runtime/model/prepared-call.js'
import { modelInputDigest } from '../../src/runtime/model/wire-request.js'
import type { ModelDeployment } from '../../src/runtime/providers/model.js'
import { actionFrame, inlineRef, openModel } from './model-deployment-fixture.js'
import {
  callContext,
  fixtureAdapter,
  fixtureCatalog,
  fixtureOwner,
  fixturePick,
  fixtureWire,
  prepareRequest,
  runScope,
} from './model-fixture.js'

const refs = RuntimeMethodSchemaRefs['agh.model']
const open = async (over: Partial<ModelDeployment> = {}) => {
  const model = await openModel(over)
  const prepare = (request: W.ModelPrepareRequest, call = callContext()) =>
    model.provider.compute?.(
      { target: fixtureOwner, method: 'prepare', input: inlineRef(refs.prepare.input, request) },
      call,
    ) ?? Promise.reject(new Error('compute missing'))
  return { ...model, prepare }
}
const failure = (detailCode: string, code: W.RuntimeError['code']) => ({
  ok: false as const,
  error: { code, detailCode, message: 'm', retryAdvice: { kind: 'never' as const }, diagnosticId: 'd' },
})
const hookResults = (): W.HookResultSet => ({
  stageId: 'stage',
  event: 'before_request',
  registrationDigest: 'd'.repeat(64),
  inputDigest: 'e'.repeat(64),
  entries: [],
  output: inlineRef(runtimeAuthorSchemas.StandardToolOutput.ref, {}),
  digest: 'f'.repeat(64),
  sourceActionId: null,
})
type Row = [string, Partial<ModelDeployment>, W.ModelPrepareRequest, W.RuntimeError['code'], string]
const detail = (r: { ok: boolean; error?: W.RuntimeError }) => r.error?.detailCode

describe('model prepare', () => {
  it('returns a reference the shared digest agrees with, and records exactly that one issuance', async () => {
    const { prepare, counters } = await open()
    const result = await prepare(prepareRequest())
    if (!result.ok || result.value.kind !== 'inline') throw new Error('prepare failed')
    const out = validateRuntime('ModelPrepareResult', result.value.value)
    if (!out.ok) throw new Error('bad result')
    const ref = out.value.preparedRef
    if (ref.kind !== 'inline') throw new Error('not inline')
    const prepared = validateRuntime('PreparedModelRequest', ref.value)
    if (!prepared.ok) throw new Error('bad prepared')
    expect(prepared.value.inputDigest).toBe(
      modelInputDigest(prepared.value, modelCaptureOf('package-1', fixturePick()), fixtureWire),
    )
    expect(out.value).toMatchObject({
      inputDigest: prepared.value.inputDigest,
      targetSnapshot: prepareRequest().route,
      estimatedUnits: [],
      mediaPlanRefs: [],
    })
    expect(counters.recorded).toEqual([
      {
        preparedDigest: ref.digest,
        inputDigest: prepared.value.inputDigest,
        captureDigest: fixtureCatalog().digest,
        wire: fixtureWire,
        scope: { sessionId: 'session-1', runId: 'run-1' },
        ownerBindingId: fixtureOwner.bindingId,
      },
    ])
    expect(counters.revisions).toHaveLength(1)
    expect(counters.network).toBe(0)
  })

  it('returns the same reference when the same request is prepared again (a replay after a crash)', async () => {
    const { prepare } = await open()
    const a = await prepare(prepareRequest())
    const b = await prepare(prepareRequest())
    expect(
      a.ok && b.ok && canonicalJsonDigest(a.value as never) === canonicalJsonDigest(b.value as never),
    ).toBe(true)
  })

  const refusals: Row[] = [
    [
      'hooks are supplied',
      {},
      prepareRequest({ hookResults: hookResults() }),
      'incompatible',
      'model_hooks_unsupported',
    ],
    [
      'the route features lack tools but a catalog is given',
      {},
      prepareRequest({ toolCatalog: { revision: 1, digest: 'c'.repeat(64), tools: [] } }),
      'incompatible',
      'model_feature_mismatch',
    ],
    [
      'the adapter is not the selected one',
      { adapters: { select: () => null } },
      prepareRequest(),
      'denied',
      'model_adapter_unavailable',
    ],
    [
      'the selected adapter differs from the route',
      {
        adapters: {
          select: () => ({ binding: { ...fixtureAdapter, bindingId: 'other' }, packageDigest: 'p' }),
        },
      },
      prepareRequest(),
      'denied',
      'model_adapter_unavailable',
    ],
    [
      'the route is not in the current catalog',
      {
        catalog: {
          capture: () => ({ ok: true as const, value: { digest: 'e'.repeat(64), select: () => undefined } }),
        },
      },
      prepareRequest(),
      'denied',
      'model_catalog_missing',
    ],
    [
      'no trusted price source exists',
      { prices: { version: () => null } },
      prepareRequest(),
      'internal',
      'model_not_ready',
    ],
    [
      'the price version differs',
      { prices: { version: () => 'fixture-price-2' } },
      prepareRequest(),
      'denied',
      'model_price_mismatch',
    ],
    [
      'the trusted wire port refuses to name a slot',
      { wire: { resolve: async () => failure('model_slot_ambiguous', 'incompatible') } },
      prepareRequest(),
      'incompatible',
      'model_slot_ambiguous',
    ],
    [
      'the issuance cannot be written',
      {
        issuance: {
          record: () => failure('model_issuance_write', 'internal'),
          read: () => undefined,
          bindRevision: () => ({ ok: true as const, value: undefined }),
        },
      },
      prepareRequest(),
      'internal',
      'model_issuance_write',
    ],
  ]
  it.each(refusals)(
    'refuses when %s, and returns no reference',
    async (_name, over, request, code, detailCode) => {
      const { prepare } = await open(over)
      const result = await prepare(request)
      expect(result).toMatchObject({ ok: false, error: { code, detailCode } })
    },
  )

  it('refuses once the system is no longer current', async () => {
    let current = true
    const { prepare, counters } = await open({ current: () => current })
    current = false
    expect(await prepare(prepareRequest())).toMatchObject({
      ok: false,
      error: { detailCode: 'model_binding_denied' },
    })
    expect(counters.recorded).toHaveLength(0)
  })

  it('refuses a scope without a run', async () => {
    const { prepare } = await open()
    const call = callContext({ scope: { ...runScope(), kind: 'session' } as never })
    expect(detail(await prepare(prepareRequest(), call))).toBe('model_scope')
  })

  it('writes no issuance and no revision when any check refuses', async () => {
    const { prepare, counters } = await open({ prices: { version: () => 'fixture-price-2' } })
    await prepare(prepareRequest())
    expect(counters.recorded).toHaveLength(0)
    expect(counters.revisions).toHaveLength(0)
  })

  it('refuses a wire-unsupported request at preparation, so nothing unsendable is issued', async () => {
    const { prepare, counters } = await open()
    const route = { ...prepareRequest().route, features: { ...prepareRequest().route.features, tools: true } }
    const toolCatalog = { revision: 1, digest: 'c'.repeat(64), tools: [] }
    const result = await prepare(prepareRequest({ route, toolCatalog }))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_wire_tools' },
    })
    expect(counters.recorded).toHaveLength(0)
  })

  it('refuses a revision whose captured selection changed after a restart', async () => {
    const first = await open()
    expect((await first.prepare(prepareRequest())).ok).toBe(true)
    const changed = await open({
      catalog: { capture: () => ({ ok: true as const, value: fixtureCatalog(9) }) },
      issuance: { ...first.deployment.issuance },
    })
    expect(await changed.prepare(prepareRequest())).toMatchObject({
      ok: false,
      error: { code: 'conflict', detailCode: 'model_revision_conflict' },
    })
  })

  it('is cancelled before anything is read or recorded when the call is already aborted', async () => {
    let captures = 0
    const catalog = {
      capture: () => {
        captures++
        return { ok: true as const, value: fixtureCatalog() }
      },
    }
    const { prepare, counters } = await open({ catalog })
    const controller = new AbortController()
    controller.abort()
    const result = await prepare(prepareRequest(), callContext({ signal: controller.signal }))
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(captures).toBe(0)
    expect(counters.recorded).toHaveLength(0)
  })

  it('is cancelled and records nothing when the call is aborted after the request was assembled', async () => {
    const controller = new AbortController()
    const estimate = () => {
      controller.abort()
      return []
    }
    const { prepare, counters } = await open({ estimate })
    const result = await prepare(prepareRequest(), callContext({ signal: controller.signal }))
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(counters.recorded).toHaveLength(0)
    expect(counters.revisions).toHaveLength(0)
  })

  it('is cancelled and records nothing when the call is aborted while the wire identity resolves', async () => {
    const controller = new AbortController()
    const { prepare, counters } = await open({
      wire: {
        resolve: async () => {
          controller.abort()
          return { ok: true, value: fixtureWire }
        },
      },
    })
    const result = await prepare(prepareRequest(), callContext({ signal: controller.signal }))
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(counters.recorded).toHaveLength(0)
    expect(counters.revisions).toHaveLength(0)
  })

  it('is not ready while the parent and child bridge cannot commit', async () => {
    const bridge = { ready: () => failure('model_child_bridge_not_ready', 'internal') }
    await expect(openModel({ bridge })).rejects.toThrow('model_child_bridge_not_ready')
  })

  it('keeps the credential rules: a handle on a keyless route, or a bound route without a verifier, is refused by name', async () => {
    const bound = {
      ...prepareRequest().route,
      credentialBinding: {
        consumer: 'model' as const,
        secretId: 's',
        accountRef: null,
        serverRef: 'e',
        audience: 'fixture-endpoint',
        purpose: 'model-inference',
      },
    }
    const handle = {
      handleId: 'h',
      secretId: 's',
      version: 'v1',
      audience: 'fixture-endpoint',
      expiresAt: '2099-01-01T00:00:00Z',
    }
    const plain = await open()
    expect(detail(await plain.prepare(prepareRequest({ credentialRef: handle })))).toBe(
      'model_credential_binding',
    )
    expect(detail(await plain.prepare(prepareRequest({ route: bound, credentialRef: handle })))).toBe(
      'model_credential_unverified',
    )
    const verified = await open({ credentials: { verifyIssued: () => true } })
    expect((await verified.prepare(prepareRequest({ route: bound, credentialRef: handle }))).ok).toBe(true)
    const denied = await open({ credentials: { verifyIssued: () => false } })
    expect(detail(await denied.prepare(prepareRequest({ route: bound, credentialRef: handle })))).toBe(
      'model_credential_unverified',
    )
  })
})

describe('model prepareRequest', () => {
  const bound = {
    ...prepareRequest().route,
    credentialBinding: {
      consumer: 'model' as const,
      secretId: 's',
      accountRef: null,
      serverRef: 'e',
      audience: 'fixture-endpoint',
      purpose: 'model-inference',
    },
  }
  const handle: W.SecretHandle = {
    handleId: 'h',
    secretId: 's',
    version: 'v1',
    audience: 'fixture-endpoint',
    expiresAt: '2099-01-01T00:00:00Z',
  }
  const secrets: W.BindingRef = {
    bindingId: 'secrets',
    contract: 'agh.secrets',
    logicalName: 'default',
    providerId: 'agh.default/secrets',
  }
  const resolveRefs = RuntimeMethodSchemaRefs['agh.secrets'].resolve
  const unused = async () => {
    throw new Error('unused')
  }
  const resolvePorts = (queries: W.ServiceQuery[], reply: W.SecretHandle | null): LoopReadPorts => ({
    query: async (request) => {
      queries.push(request)
      return reply
        ? { ok: true, value: { kind: 'value', output: inlineRef(resolveRefs.output, reply), snapshot: 's' } }
        : failure('x', 'denied')
    },
    compute: unused,
    resolveData: unused,
    prepare: () => {
      throw new Error('unused')
    },
  })
  const requestInput = (over: Partial<W.ModelPrepareRequestRequest> = {}) => {
    return { ...prepareRequest(), hookResults: null, credentialRefresh: null, ...over }
  }
  async function start(
    deployment: Partial<ModelDeployment>,
    input: W.ModelPrepareRequestRequest,
    ports: LoopReadPorts,
  ) {
    const model = await openModel(deployment)
    const factory = model.provider.actions?.prepareRequest
    if (!factory) throw new Error('prepareRequest missing')
    const action = await factory.create({
      instanceId: 'instance',
      actionId: 'parent-1',
      runId: 'run-1',
      bindingId: fixtureOwner.bindingId,
      scope: runScope(),
      signal: new AbortController().signal,
    })
    if (action.kind !== 'composite') throw new Error('not composite')
    const out = await action.start(
      actionFrame('prepareRequest', inlineRef(refs.prepareRequest.input, input)),
      ports,
    )
    return { out, counters: model.counters }
  }
  it('resolves the exact handle through the secrets query and writes it into the prepared request', async () => {
    const queries: W.ServiceQuery[] = []
    const { out } = await start({ secrets }, requestInput({ route: bound }), resolvePorts(queries, handle))
    if (out.next.kind !== 'complete' || out.next.output.kind !== 'inline') throw new Error('not complete')
    expect(queries).toHaveLength(1)
    const result = validateRuntime('ModelPrepareResult', out.next.output.value)
    if (!result.ok || result.value.preparedRef.kind !== 'inline') throw new Error('bad result')
    const prepared = validateRuntime('PreparedModelRequest', result.value.preparedRef.value)
    expect(prepared.ok && prepared.value.credentialRef).toEqual(handle)
    expect(out.children).toHaveLength(0)
  })
  it.each([
    [
      'a handle the caller supplies that differs from the resolved one',
      { route: bound, credentialRef: { ...handle, version: 'v2' } },
      'model_credential_binding',
    ],
    [
      'a refresh request',
      {
        credentialRefresh: {
          requestId: 'r',
          secretId: 's',
          expectedVersion: 'v1',
          audience: 'a',
          accountRef: 'a',
          serverRef: 's',
          purpose: 'model-subscription' as const,
        },
      },
      'model_refresh_unsupported',
    ],
  ])('fails closed on %s', async (_name, over, detailCode) => {
    const { out } = await start({ secrets }, requestInput(over), resolvePorts([], handle))
    expect(out).toMatchObject({ next: { kind: 'fail', error: { detailCode } } })
  })
  it('fails when the secrets service cannot resolve, and never writes an issuance', async () => {
    const { out, counters } = await start({ secrets }, requestInput({ route: bound }), resolvePorts([], null))
    expect(out).toMatchObject({
      next: { kind: 'fail', error: { detailCode: 'model_credential_unavailable' } },
    })
    expect(counters.recorded).toHaveLength(0)
  })
  it('refuses a bound route when no secrets service is selected', async () => {
    const { out } = await start({ secrets: null }, requestInput({ route: bound }), resolvePorts([], handle))
    expect(out).toMatchObject({
      next: { kind: 'fail', error: { detailCode: 'model_credential_unverified' } },
    })
  })
})
