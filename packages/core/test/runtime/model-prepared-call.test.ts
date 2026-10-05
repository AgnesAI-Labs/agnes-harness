import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  adapterInvokeInput,
  assemblePrepared,
  checkCredential,
  externalKeyOf,
  INFER_CHILD_KEY,
  modelCaptureOf,
  type PrepareParts,
  preparedIdOf,
  selectionDigest,
} from '../../src/runtime/model/prepared-call.js'
import { modelInputDigest } from '../../src/runtime/model/wire-request.js'
import {
  fixtureAdapter,
  fixtureOwner,
  fixturePick,
  fixtureWire,
  prepareRequest,
  textItem,
} from './model-fixture.js'

const pick = fixturePick()
const capture = modelCaptureOf('package-1', pick)
const parts = (over: Partial<PrepareParts> = {}): PrepareParts => {
  const { hookResults: _h, ...request } = prepareRequest()
  return { owner: fixtureOwner, request, capture, wire: fixtureWire, estimatedUnits: [], ...over }
}
const assembled = (over: Partial<PrepareParts> = {}) => {
  const result = assemblePrepared(parts(over))
  if (!result.ok) throw new Error(result.error.detailCode)
  return result.value
}

describe('modelCaptureOf', () => {
  it('maps the picked route and model, keeping optional compat and keyless only when present', () => {
    expect(capture).toEqual({
      adapterPackageDigest: 'package-1',
      route: { route: 'fixed-route', api: 'openai-completions', baseUrl: 'https://fake.invalid' },
      model: pick.model,
    })
    const withOptions = modelCaptureOf('p', {
      ...pick,
      route: { ...pick.route, compat: { a: 1 }, keyless: true },
    })
    expect(withOptions.route).toMatchObject({ compat: { a: 1 }, keyless: true })
  })
  it('selectionDigest ignores the adapter package and other models of the route but follows the route and the model', () => {
    const base = selectionDigest(pick)
    expect(
      selectionDigest({ ...pick, model: { ...pick.model, cost: { ...pick.model.cost, output: 9 } } }),
    ).not.toBe(base)
    expect(selectionDigest({ ...pick, route: { ...pick.route, baseUrl: 'https://other.invalid' } })).not.toBe(
      base,
    )
    expect(selectionDigest({ ...pick, route: { ...pick.route, models: [] } as never })).toBe(base)
  })
})

describe('assemblePrepared', () => {
  it('builds a schema-valid prepared request whose inputDigest is the shared digest and whose id follows it', () => {
    const { prepared, ref } = assembled()
    expect(validateRuntime('PreparedModelRequest', prepared).ok).toBe(true)
    expect(prepared.inputDigest).toBe(modelInputDigest(prepared, capture, fixtureWire))
    expect(prepared.preparedId).toBe(preparedIdOf(prepared.inputDigest))
    expect(prepared).toMatchObject({
      mediaPlans: [],
      hookResults: null,
      legacyRequestOverrides: null,
      ownerBinding: fixtureOwner,
    })
    expect(ref.schema).toEqual(RuntimeSchemaRefs.PreparedModelRequest)
    expect(ref.digest).toBe(canonicalJsonDigest(prepared as never))
  })
  it('is byte-identical when run again, so a replay after a crash yields the same reference', () => {
    expect(assembled().ref).toEqual(assembled().ref)
  })
  it.each([
    ['the wire slot', { wire: { ...fixtureWire, slot: 'fast' as const } }],
    [
      'the captured model cost',
      {
        capture: modelCaptureOf('package-1', {
          ...pick,
          model: { ...pick.model, cost: { ...pick.model.cost, output: 9 } },
        }),
      },
    ],
    ['the adapter package', { capture: modelCaptureOf('package-2', pick) }],
  ])('changes the reference when %s changes', (_name, over) => {
    expect(assembled(over).ref.digest).not.toBe(assembled().ref.digest)
  })
  it('passes the first-slice wire refusals through by name', () => {
    const tools = parts({
      request: { ...parts().request, toolCatalog: { revision: 1, digest: 'c'.repeat(64), tools: [] } },
    })
    expect(assemblePrepared(tools)).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_wire_tools' },
    })
    const noUser = parts({
      request: { ...parts().request, view: { ...parts().request.view, items: [textItem('system', 's')] } },
    })
    expect(assemblePrepared(noUser)).toMatchObject({ ok: false, error: { detailCode: 'model_wire_empty' } })
  })
  it('refuses a request that no longer fits inline', () => {
    const big = textItem('user', 'x'.repeat(70_000))
    const request = { ...parts().request, view: { ...parts().request.view, items: [big] } }
    expect(assemblePrepared(parts({ request }))).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'model_prepared_too_large' },
    })
  })
})

describe('checkCredential', () => {
  const binding: W.SecretConsumerBinding = {
    consumer: 'model',
    secretId: 's',
    accountRef: null,
    serverRef: 'e',
    audience: 'aud',
    purpose: 'model-inference',
  }
  const route = (credentialBinding: W.SecretConsumerBinding | null) => ({
    ...prepareRequest().route,
    credentialAudience: 'aud',
    credentialBinding,
  })
  const handle = (over: Partial<W.SecretHandle> = {}): W.SecretHandle => ({
    handleId: 'h',
    secretId: 's',
    version: 'v1',
    audience: 'aud',
    expiresAt: '2099-01-01T00:00:00Z',
    ...over,
  })
  const now = Date.parse('2026-10-05T00:00:00Z')
  it.each([
    ['no binding and no handle', route(null), null, true, ''],
    ['no binding but a handle', route(null), handle(), false, 'model_credential_binding'],
    ['a binding but no handle', route(binding), null, false, 'model_credential_binding'],
    ['a matching handle', route(binding), handle(), true, ''],
    ['another secret', route(binding), handle({ secretId: 'other' }), false, 'model_credential_binding'],
    ['another audience', route(binding), handle({ audience: 'other' }), false, 'model_credential_binding'],
    [
      'a binding audience that differs from the handle',
      route({ ...binding, audience: 'other' }),
      handle(),
      false,
      'model_credential_binding',
    ],
    [
      'an expired handle',
      route(binding),
      handle({ expiresAt: '2020-01-01T00:00:00Z' }),
      false,
      'model_credential_expired',
    ],
    [
      'a non-model consumer',
      route({ ...binding, consumer: 'mcp' }),
      handle(),
      false,
      'model_credential_binding',
    ],
  ] as const)('%s', (_name, r, h, ok, detail) => {
    const result = checkCredential(r as W.ModelRouteSnapshot, h as W.SecretHandle | null, now)
    expect(result.ok).toBe(ok)
    if (!result.ok) expect(result.error.detailCode).toBe(detail)
  })
})

describe('child input', () => {
  const { ref } = assembled()
  it('derives one external key per run and parent, independent of attempts', () => {
    expect(externalKeyOf('run-1', 'parent-1')).toBe(externalKeyOf('run-1', 'parent-1'))
    expect(externalKeyOf('run-1', 'parent-1')).not.toBe(externalKeyOf('run-1', 'parent-2'))
    expect(externalKeyOf('run-1', 'parent-1')).not.toBe(externalKeyOf('run-2', 'parent-1'))
    expect(INFER_CHILD_KEY).toBe('adapter-invoke')
  })
  it('does not let time change the external key', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const first = externalKeyOf('run-1', 'parent-1')
      vi.setSystemTime(2_000_000)
      expect(externalKeyOf('run-1', 'parent-1')).toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })
  it('wraps the original prepared reference unchanged with the external key', () => {
    const input = adapterInvokeInput(ref, externalKeyOf('run-1', 'parent-1'))
    if (!input.ok) throw new Error(input.error.detailCode)
    expect(validateRuntime('ModelAdapterInvokeRequest', input.value.value).ok).toBe(true)
    expect((input.value.value as { preparedCallRef: unknown }).preparedCallRef).toEqual(ref)
    expect(fixtureAdapter.contract).toBe('agh.model-adapter')
  })
})
