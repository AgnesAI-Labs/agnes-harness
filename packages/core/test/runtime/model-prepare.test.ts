import { type LoopReadPorts, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { modelCaptureOf } from '../../src/runtime/model/prepared-call.js'
import { modelInputDigest } from '../../src/runtime/model/wire-request.js'
import type { ModelDeployment } from '../../src/runtime/providers/model.js'
import { actionFrame, entryOf, inlineRef, openModel } from './model-deployment-fixture.js'
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
import { resolverOf, standardTool, toolCatalogOf, toolRoute } from './model-tools-fixture.js'

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
  it('returns a reference the shared digest agrees with, and changes nothing durable', async () => {
    const { prepare, counters, deployment } = await open()
    const result = await prepare(prepareRequest())
    if (!result.ok || result.value.kind !== 'inline') throw new Error('prepare failed')
    const out = validateRuntime('ModelPrepareResult', result.value.value)
    if (!out.ok) throw new Error('bad result')
    const ref = out.value.preparedRef
    if (ref.kind !== 'inline') throw new Error('not inline')
    const handle = validateRuntime('PreparedModelHandle', ref.value)
    if (!handle.ok) throw new Error('bad handle')
    const { prepared } = entryOf(deployment, ref)
    expect(prepared.inputDigest).toBe(
      modelInputDigest(prepared, modelCaptureOf('package-1', fixturePick()), fixtureWire),
    )
    expect(handle.value).toMatchObject({ inputDigest: prepared.inputDigest, ownerBinding: fixtureOwner })
    expect(ref.schema).toEqual(RuntimeSchemaRefs.PreparedModelHandle)
    expect(JSON.stringify(ref.value)).not.toContain('"view"')
    expect(out.value).toMatchObject({
      inputDigest: prepared.inputDigest,
      targetSnapshot: prepareRequest().route,
      estimatedUnits: [],
      mediaPlanRefs: [],
    })
    expect(counters.network).toBe(0)
  })

  it('takes the slot only from the trusted wire port and passes the route to it unchanged', async () => {
    const seen: W.ModelRouteSnapshot[] = []
    const wire = {
      resolve: async (request: { route: W.ModelRouteSnapshot }) => {
        seen.push(request.route)
        return { ok: true as const, value: { ...fixtureWire, slot: 'fast' as const } }
      },
    }
    const { prepare, deployment } = await open({ wire })
    const result = await prepare(prepareRequest())
    if (!result.ok || result.value.kind !== 'inline') throw new Error('prepare failed')
    const out = validateRuntime('ModelPrepareResult', result.value.value)
    if (!out.ok || out.value.preparedRef.kind !== 'inline') throw new Error('bad result')
    const { prepared } = entryOf(deployment, out.value.preparedRef)
    const capture = modelCaptureOf('package-1', fixturePick())
    expect(out.value.inputDigest).toBe(modelInputDigest(prepared, capture, { ...fixtureWire, slot: 'fast' }))
    expect(seen).toEqual([prepareRequest().route])
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
    const { prepare } = await open({ current: () => current })
    current = false
    expect(await prepare(prepareRequest())).toMatchObject({
      ok: false,
      error: { detailCode: 'model_binding_denied' },
    })
  })

  it('refuses a scope without a run', async () => {
    const { prepare } = await open()
    const call = callContext({ scope: { ...runScope(), kind: 'session' } as never })
    expect(detail(await prepare(prepareRequest(), call))).toBe('model_scope')
  })

  it('refuses a wire-unsupported request at preparation, so nothing unsendable is prepared', async () => {
    const { prepare } = await open()
    const route = { ...prepareRequest().route, features: { ...prepareRequest().route.features, tools: true } }
    const toolCatalog = { revision: 1, digest: 'c'.repeat(64), tools: [] }
    const result = await prepare(prepareRequest({ route, toolCatalog }))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_wire_tools' },
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
    const { prepare } = await open({ catalog })
    const controller = new AbortController()
    controller.abort()
    const result = await prepare(prepareRequest(), callContext({ signal: controller.signal }))
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(captures).toBe(0)
  })

  it('is cancelled with no reference when the call is aborted after the request was assembled', async () => {
    const controller = new AbortController()
    const estimate = () => {
      controller.abort()
      return []
    }
    const { prepare } = await open({ estimate })
    const result = await prepare(prepareRequest(), callContext({ signal: controller.signal }))
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('is cancelled with no reference when the call is aborted while the wire identity resolves', async () => {
    const controller = new AbortController()
    const { prepare } = await open({
      wire: {
        resolve: async () => {
          controller.abort()
          return { ok: true, value: fixtureWire }
        },
      },
    })
    const result = await prepare(prepareRequest(), callContext({ signal: controller.signal }))
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('is not ready while the parent and child bridge cannot commit', async () => {
    const bridge = { ready: () => failure('model_child_bridge_not_ready', 'internal') }
    await expect(openModel({ bridge })).rejects.toThrow('model_child_bridge_not_ready')
  })

  it('keeps the credential rules: a handle on a keyless route, or a bound route the issuer does not vouch for, is refused by name', async () => {
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
    const plain = await open({ credentials: { verifyIssued: () => false } })
    const keyless = { ...prepareRequest().route, credentialBinding: null }
    expect(detail(await plain.prepare(prepareRequest({ route: keyless, credentialRef: handle })))).toBe(
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
    return { out, deployment: model.deployment }
  }
  it('resolves the exact handle through the secrets query and writes it into the prepared request', async () => {
    const queries: W.ServiceQuery[] = []
    const { out, deployment } = await start(
      { secrets },
      requestInput({ route: bound }),
      resolvePorts(queries, handle),
    )
    if (out.next.kind !== 'complete' || out.next.output.kind !== 'inline') throw new Error('not complete')
    expect(queries).toHaveLength(1)
    const result = validateRuntime('ModelPrepareResult', out.next.output.value)
    if (!result.ok || result.value.preparedRef.kind !== 'inline') throw new Error('bad result')
    expect(entryOf(deployment, result.value.preparedRef).prepared.credentialRef).toEqual(handle)
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
  it('fails when the secrets service cannot resolve', async () => {
    const { out } = await start({ secrets }, requestInput({ route: bound }), resolvePorts([], null))
    expect(out).toMatchObject({
      next: { kind: 'fail', error: { detailCode: 'model_credential_unavailable' } },
    })
  })
  it('refuses a bound route when no secrets service is selected', async () => {
    const { out } = await start({ secrets: null }, requestInput({ route: bound }), resolvePorts([], handle))
    expect(out).toMatchObject({
      next: { kind: 'fail', error: { detailCode: 'model_credential_unverified' } },
    })
  })
})

describe('model prepare with resolved tools', () => {
  const tool = standardTool('text_statistics', 'Count the words of a text')
  const request = (over: Partial<W.ModelPrepareRequest> = {}) =>
    prepareRequest({
      route: toolRoute(prepareRequest().route),
      toolCatalog: toolCatalogOf([tool.definition]),
      ...over,
    })

  it('asks the resolver once with the request catalog and prepares with the resolved tools', async () => {
    const asked: W.ToolCatalog[] = []
    const tools = {
      resolve: async (r: { catalog: W.ToolCatalog }) => {
        asked.push(r.catalog)
        return { ok: true as const, value: [tool.resolved] }
      },
    }
    const { prepare, deployment } = await open({ tools })
    const result = await prepare(request())
    if (!result.ok || result.value.kind !== 'inline') throw new Error('prepare failed')
    const out = validateRuntime('ModelPrepareResult', result.value.value)
    if (!out.ok) throw new Error('bad result')
    expect(asked).toEqual([request().toolCatalog])
    const entry = entryOf(deployment, out.value.preparedRef)
    expect(entry.resolvedTools).toEqual([tool.resolved])
    expect(entry.request.tools).toHaveLength(1)
    expect(entry.request.tools[0]).toMatchObject({
      name: 'text_statistics',
      description: 'Count the words of a text',
    })
    expect(entry.request.derivedHash).toBe(entry.prepared.inputDigest)
    expect(entry.prepared.inputDigest).toBe(
      modelInputDigest(
        entry.prepared,
        modelCaptureOf('package-1', fixturePick()),
        fixtureWire,
        entry.resolvedTools,
      ),
    )
    expect(entry.prepared.inputDigest).not.toBe(
      modelInputDigest(entry.prepared, modelCaptureOf('package-1', fixturePick()), fixtureWire),
    )
  })

  it('does not call the resolver for a request without a catalog, and keeps no tools', async () => {
    let calls = 0
    const tools = {
      resolve: async () => {
        calls++
        return { ok: true as const, value: [tool.resolved] }
      },
    }
    const { prepare, deployment } = await open({ tools })
    const result = await prepare(prepareRequest())
    if (!result.ok || result.value.kind !== 'inline') throw new Error('prepare failed')
    const out = validateRuntime('ModelPrepareResult', result.value.value)
    if (!out.ok) throw new Error('bad result')
    expect(calls).toBe(0)
    expect(entryOf(deployment, out.value.preparedRef).resolvedTools).toBeNull()
  })

  it('changes the input digest when only a description changes', async () => {
    const digestWith = async (description: string) => {
      const { prepare } = await open({
        tools: resolverOf([{ ...tool.resolved, description }]),
      })
      const result = await prepare(request())
      if (!result.ok || result.value.kind !== 'inline') throw new Error('prepare failed')
      return (result.value.value as { inputDigest: string }).inputDigest
    }
    const first = await digestWith('Count the words of a text')
    expect(await digestWith('Count the words of a text')).toBe(first)
    expect(await digestWith('Count the lines of a text')).not.toBe(first)
  })

  it.each([
    ['no resolver is installed', undefined],
    ['the resolver refuses', { resolve: async () => failure('model_tools_unavailable', 'denied') }],
  ])('keeps the refusal model_wire_tools when %s', async (_name, tools) => {
    const { prepare } = await open(tools ? { tools } : {})
    const result = await prepare(request())
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'incompatible',
        detailCode: 'model_wire_tools',
        message: 'Model request refused',
        retryAdvice: { kind: 'never' },
        diagnosticId: 'model-provider',
      },
    })
  })

  it('refuses by name a resolved document that is not the one the catalog binds, and a count mismatch', async () => {
    const other = { ...tool.resolved.document, $defs: { ...tool.resolved.document.$defs, Extra: {} } }
    const wrong = await open({ tools: resolverOf([{ ...tool.resolved, document: other }]) })
    expect(detail(await wrong.prepare(request()))).toBe('model_wire_tool_schema')
    const empty = await open({ tools: resolverOf([]) })
    expect(detail(await empty.prepare(request()))).toBe('model_wire_tools')
  })

  it('reports an unreachable resolver as a retryable dependency fault and an abort as cancelled', async () => {
    const down = await open({
      tools: {
        resolve: async () => {
          throw new Error('down')
        },
      },
    })
    expect(await down.prepare(request())).toMatchObject({
      ok: false,
      error: { code: 'retryable', detailCode: 'model_dependency_unavailable' },
    })
    const controller = new AbortController()
    const aborting = await open({
      tools: {
        resolve: async () => {
          controller.abort()
          return { ok: true as const, value: [tool.resolved] }
        },
      },
    })
    expect(await aborting.prepare(request(), callContext({ signal: controller.signal }))).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})

describe('model prepare refuses modes the adapter cannot serve', () => {
  it('refuses a route without a credential binding, by name, before anything is recorded', async () => {
    const { prepare, counters } = await open()
    const keyless = { ...prepareRequest().route, credentialBinding: null }
    const result = await prepare(prepareRequest({ route: keyless, credentialRef: null }))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_credential_required' },
    })
    expect(counters.network).toBe(0)
  })

  it('keeps the binding mismatch name for a handle on a route without a binding', async () => {
    const { prepare } = await open()
    const keyless = { ...prepareRequest().route, credentialBinding: null }
    expect(detail(await prepare(prepareRequest({ route: keyless })))).toBe('model_credential_binding')
  })

  it('refuses an output schema by name even when the route declares structured output', async () => {
    const { prepare } = await open()
    const route = {
      ...prepareRequest().route,
      features: { ...prepareRequest().route.features, structuredOutput: true },
    }
    const outputSchema = runtimeAuthorSchemas.StandardToolOutput.ref
    expect(await prepare(prepareRequest({ route, outputSchema }))).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_wire_output_schema' },
    })
  })

  it('still names the feature mismatch when the route does not declare structured output', async () => {
    const { prepare } = await open()
    const outputSchema = runtimeAuthorSchemas.StandardToolOutput.ref
    expect(detail(await prepare(prepareRequest({ outputSchema })))).toBe('model_feature_mismatch')
  })
})
