import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type { ModelRecord } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  buildWireRequest,
  type ModelCapture,
  modelInputDigest,
  modelInputPreimage,
  type WireIdentity,
} from '../../src/runtime/model/wire-request.js'

const model: ModelRecord = {
  id: 'fixture-model',
  name: 'fixture-model',
  api: 'openai-completions',
  route: 'fixed-route',
  baseUrl: 'https://fake.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const capture: ModelCapture = {
  adapterPackageDigest: 'package-1',
  route: { route: 'fixed-route', api: 'openai-completions', baseUrl: 'https://fake.invalid' },
  model,
}
const wire: WireIdentity = { sessionKey: 'session-1', slot: 'primary', contractId: null }

function preparedFixture(): Wire.PreparedModelRequest {
  return {
    preparedId: 'prepared',
    ownerBinding: {
      bindingId: 'model-gateway',
      providerId: 'gateway',
      contract: 'agh.model',
      logicalName: 'default',
    },
    target: {
      routeId: 'fixed-route',
      routeRevision: 1,
      adapter: {
        bindingId: 'adapter',
        providerId: 'agh.default/model-adapter',
        contract: 'agh.model-adapter',
        logicalName: 'default',
      },
      model: 'fixture-model',
      endpointRef: 'fixture-endpoint',
      catalogRevision: 1,
      features: { input: ['text'], output: ['text'], tools: false, structuredOutput: false, streaming: true },
      priceVersion: 'fixture-price-1',
      credentialAudience: 'fixture-endpoint',
      credentialBinding: {
        consumer: 'model',
        secretId: 'fixture-secret',
        accountRef: null,
        serverRef: 'fixture-endpoint',
        audience: 'fixture-endpoint',
        purpose: 'model-inference',
      },
    },
    view: {
      viewId: 'view',
      format: 'fixture-text',
      schema: runtimeAuthorSchemas.StandardToolOutput.ref,
      baseRevision: 1,
      items: [],
      tokenEstimate: 1,
      protectedRefs: [],
      inputDigest: 'a'.repeat(64),
      digest: 'b'.repeat(64),
      runtimeInstructionRefs: [],
    },
    inputDigest: 'a'.repeat(64),
    outputSchema: null,
    toolCatalog: null,
    generation: { maxOutputTokens: 32, thinking: null },
    mediaPlans: [],
    estimatedUnits: [],
    hookResults: null,
    sessionParameterRef: {
      authorityId: 'fixture-config',
      recordId: 'parameters',
      recordRevision: 1,
      schema: runtimeAuthorSchemas.StandardToolOutput.ref,
      digest: canonicalJsonDigest({}),
    },
    legacyRequestOverrides: null,
    credentialRef: {
      handleId: 'fixture-handle',
      secretId: 'fixture-secret',
      version: 'fixed-v1',
      audience: 'fixture-endpoint',
      expiresAt: '2026-10-05T10:00:00Z',
    },
  }
}
const prepared = preparedFixture()

describe('model input digest', () => {
  it('ignores the fields it excludes and is independent of key order', () => {
    const base = modelInputDigest(prepared, capture, wire)
    expect(modelInputDigest({ ...prepared, preparedId: 'other' }, capture, wire)).toBe(base)
    expect(
      modelInputDigest({ ...prepared, estimatedUnits: [{ unit: 'tokens', quantity: '1' }] as never }, capture, wire),
    ).toBe(base)
    expect(modelInputDigest({ ...prepared, inputDigest: 'c'.repeat(64) }, capture, wire)).toBe(base)
    const reordered = Object.fromEntries(Object.entries(prepared).reverse()) as Wire.PreparedModelRequest
    expect(modelInputDigest(reordered, capture, wire)).toBe(base)
  })

  it.each([
    ['target.priceVersion', { ...prepared, target: { ...prepared.target, priceVersion: 'fixture-price-2' } }, capture, wire],
    ['target.routeRevision', { ...prepared, target: { ...prepared.target, routeRevision: 2 } }, capture, wire],
    [
      'generation.maxOutputTokens',
      { ...prepared, generation: { ...prepared.generation, maxOutputTokens: 33 } },
      capture,
      wire,
    ],
    [
      'credentialRef.version',
      { ...prepared, credentialRef: { ...(prepared.credentialRef as object), version: 'fixed-v2' } as never },
      capture,
      wire,
    ],
    ['view', { ...prepared, view: { ...prepared.view, tokenEstimate: 2 } }, capture, wire],
    ['capture.model.cost', prepared, { ...capture, model: { ...model, cost: { ...model.cost, output: 3 } } }, wire],
    ['capture.adapterPackageDigest', prepared, { ...capture, adapterPackageDigest: 'package-2' }, wire],
    ['capture.route.baseUrl', prepared, { ...capture, route: { ...capture.route, baseUrl: 'https://other.invalid' } }, wire],
    ['wire.slot', prepared, capture, { ...wire, slot: 'fast' as const }],
    ['wire.sessionKey', prepared, capture, { ...wire, sessionKey: 'session-2' }],
    ['wire.contractId', prepared, capture, { ...wire, contractId: 'contract-1' }],
  ] as const)('changes when %s changes', (_name, changed, changedCapture, changedWire) => {
    expect(
      modelInputDigest(
        changed as Wire.PreparedModelRequest,
        changedCapture as ModelCapture,
        changedWire as WireIdentity,
      ),
    ).not.toBe(modelInputDigest(prepared, capture, wire))
  })

  it('names exactly the frozen preimage fields', () => {
    const preimage = modelInputPreimage(prepared, capture, wire) as Record<string, unknown>
    expect(Object.keys(preimage).sort()).toEqual(
      [
        'capture',
        'credentialRef',
        'generation',
        'hookResults',
        'kind',
        'legacyRequestOverrides',
        'mediaPlans',
        'outputSchema',
        'ownerBinding',
        'sessionParameterRef',
        'target',
        'toolCatalog',
        'view',
        'wire',
      ].sort(),
    )
    expect(preimage.kind).toBe('agh.model/input@1')
    expect(canonicalJsonDigest(preimage as Wire.JsonValue)).toBe(modelInputDigest(prepared, capture, wire))
  })
})

function item(kind: Wire.ContextItem['kind'], trust: Wire.ContextItem['trust'], body: string): Wire.ContextItem {
  return {
    id: `item-${kind}-${trust}-${body}`,
    kind,
    body: {
      kind: 'inline',
      schema: prepared.view.schema,
      value: body,
      digest: canonicalJsonDigest(body),
      bytes: new TextEncoder().encode(JSON.stringify(body)).length,
    },
    sourceRefs: [],
    provenance: { sourceRefs: ['s'], producer: prepared.ownerBinding, trustLabels: [] },
    trust,
    tokenEstimate: 1,
    protected: false,
    toolPairRef: null,
    sourceRanges: [],
  } as Wire.ContextItem
}

const withItems = (items: Wire.ContextItem[]) => ({ ...prepared, view: { ...prepared.view, items } })

describe('wire request', () => {
  it('builds system and user text with the identity from the wire and a derivedHash equal to the recomputed digest', () => {
    const input = withItems([item('message', 'system', 'be brief'), item('message', 'user', 'hello')])
    const identity: WireIdentity = { ...wire, slot: 'fast', contractId: 'contract-1' }
    const request = buildWireRequest(input, capture, identity)
    if (!request.ok) throw new Error(request.error.detailCode)
    expect(request.value).toMatchObject({
      kind: 'inference',
      sessionKey: 'session-1',
      slot: 'fast',
      route: 'fixed-route',
      model: 'fixture-model',
      contractId: 'contract-1',
      system: 'be brief',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      sampling: { maxTokens: 32 },
    })
    expect(request.value.derivedHash).toBe(modelInputDigest(input, capture, identity))
  })

  it('carries a non-null thinking level and temperature into sampling', () => {
    const input = {
      ...withItems([item('message', 'user', 'hi')]),
      generation: { maxOutputTokens: 8, temperature: 0.5, thinking: 'low' as const },
    }
    const request = buildWireRequest(input, capture, wire)
    if (!request.ok) throw new Error(request.error.detailCode)
    expect(request.value.sampling).toEqual({ maxTokens: 8, temperature: 0.5, thinking: 'low' })
  })

  it.each([
    ['no user message', withItems([item('message', 'system', 'only system')]), 'model_wire_empty'],
    ['no items', withItems([]), 'model_wire_empty'],
    ['assistant-like text', withItems([item('message', 'user', 'q'), item('message', 'derived', 'a')]), 'model_wire_item'],
    ['external text', withItems([item('message', 'external', 'x')]), 'model_wire_item'],
    ['tool call', withItems([item('message', 'user', 'q'), item('tool-call', 'derived', 'call')]), 'model_wire_item'],
    [
      'non-text body',
      withItems([
        {
          ...item('message', 'user', 'q'),
          body: {
            kind: 'inline',
            schema: prepared.view.schema,
            value: { a: 1 },
            digest: canonicalJsonDigest({ a: 1 }),
            bytes: 7,
          },
        } as Wire.ContextItem,
      ]),
      'model_wire_item',
    ],
    [
      'tool catalog',
      { ...withItems([item('message', 'user', 'q')]), toolCatalog: { revision: 1, digest: 'c'.repeat(64), tools: [] } },
      'model_wire_tools',
    ],
    ['media plan', { ...withItems([item('message', 'user', 'q')]), mediaPlans: [{ key: 'm' } as never] }, 'model_wire_media'],
    [
      'legacy overrides',
      { ...withItems([item('message', 'user', 'q')]), legacyRequestOverrides: { maxTokens: 4 } },
      'model_wire_overrides',
    ],
    [
      'seed',
      { ...withItems([item('message', 'user', 'q')]), generation: { maxOutputTokens: 8, seed: 1, thinking: null } },
      'model_wire_seed',
    ],
  ] as const)('refuses %s with incompatible/%s', (_name, input, detail) => {
    expect(buildWireRequest(input as Wire.PreparedModelRequest, capture, wire)).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: detail },
    })
  })
})
