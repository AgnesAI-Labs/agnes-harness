import type { ModelRecord } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type { ResolvedMedia } from '../../src/runtime/media/resolve.js'
import {
  buildWireRequest,
  type ModelCapture,
  modelInputDigest,
  type WireIdentity,
} from '../../src/runtime/model/wire-request.js'
import {
  digestOf,
  featuresImage,
  featuresText,
  mediaBinding,
  planOf,
  routeSnapshot,
} from './media-fixture.js'

const model: ModelRecord = {
  id: 'text-model',
  name: 'text-model',
  api: 'openai-completions',
  route: 'r',
  baseUrl: 'https://fake.invalid',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const capture: ModelCapture = {
  adapterPackageDigest: 'p',
  route: { route: 'r', api: 'openai-completions', baseUrl: 'https://fake.invalid' },
  model,
}
const wire: WireIdentity = { sessionKey: 's', slot: 'primary', contractId: null }

const plan = planOf(
  [
    { marker: 1, node: 1 },
    { marker: 2, node: 2 },
  ],
  'native',
)
const blobId = (i: number) =>
  plan.sourceRefs[i]!.kind === 'blob' ? (plan.sourceRefs[i] as { value: W.BlobRef }).value.blobId : ''
const item = (
  id: string,
  trust: W.ContextItem['trust'],
  text: string,
  sourceRefs: W.PublicRef[] = [],
): W.ContextItem => ({
  id,
  kind: 'message',
  body: {
    kind: 'inline',
    schema: { typeId: 't', revision: 1, digest: 'a'.repeat(64) },
    value: text,
    digest: 'a'.repeat(64),
    bytes: 1,
  },
  sourceRefs,
  provenance: { sourceRefs: [], producer: mediaBinding, trustLabels: [] },
  trust,
  tokenEstimate: 1,
  protected: false,
  toolPairRef: null,
  sourceRanges: [],
})
const prepared = (
  items: W.ContextItem[],
  over: Partial<W.PreparedModelRequest> = {},
  features = featuresImage,
): W.PreparedModelRequest =>
  ({
    preparedId: 'p',
    ownerBinding: mediaBinding,
    target: { ...routeSnapshot(), model: 'text-model', features },
    view: { items } as W.ContextView,
    inputDigest: 'a'.repeat(64),
    outputSchema: null,
    toolCatalog: null,
    generation: { maxOutputTokens: 32, thinking: null },
    mediaPlans: [plan],
    estimatedUnits: [],
    hookResults: null,
    sessionParameterRef: {} as never,
    legacyRequestOverrides: null,
    credentialRef: null,
    ...over,
  }) as W.PreparedModelRequest
const resolved = (over: Partial<ResolvedMedia> = {}): ResolvedMedia => ({
  planKey: plan.key,
  planDigest: digestOf(plan),
  mediaDigest: 'm'.repeat(64),
  trust: 'external',
  usageIds: [],
  parts: [
    { kind: 'text', text: '[untrusted tool image; one]', anchor: blobId(0) },
    { kind: 'image', data: 'AAAA', mimeType: 'image/png', sha256: 'c'.repeat(64), anchor: blobId(0) },
    { kind: 'text', text: '[untrusted tool image; two]', anchor: blobId(1) },
    { kind: 'image', data: 'BBBB', mimeType: 'image/png', sha256: 'd'.repeat(64), anchor: blobId(1) },
  ],
  ...over,
})
const items = () => [
  item('sys', 'system', 'be brief'),
  item('u1', 'user', 'look', [plan.sourceRefs[0]!]),
  item('u2', 'user', 'and this', [plan.sourceRefs[1]!]),
]
const code = (r: ReturnType<typeof buildWireRequest>) => (r.ok ? 'ok' : r.error.detailCode)

describe('buildWireRequest with verified media', () => {
  it('is byte-identical to the media-less builder when no plan is carried', () => {
    const bare = prepared([item('u', 'user', 'hi')], { mediaPlans: [] })
    expect(buildWireRequest(bare, capture, wire, [])).toEqual(buildWireRequest(bare, capture, wire))
  })

  it('attaches each part to the message that carries its source, in order, without changing the digest', () => {
    const request = prepared(items())
    const built = buildWireRequest(request, capture, wire, [resolved()])
    if (!built.ok) throw new Error(built.error.detailCode)
    expect(built.value.messages).toHaveLength(2)
    expect(built.value.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'text', text: '[untrusted tool image; one]' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    })
    expect(built.value.messages[1]).toMatchObject({
      content: [
        { text: 'and this' },
        { text: '[untrusted tool image; two]' },
        { type: 'image', data: 'BBBB' },
      ],
    })
    expect(built.value.derivedHash).toBe(modelInputDigest(request, capture, wire))
  })

  it('anchors converted text at the source it belongs to and accepts an omitted result with no parts', () => {
    const text = prepared(items(), {}, featuresText)
    const converted = resolved({
      parts: [{ kind: 'text', text: '[untrusted auxiliary vision analysis]\na dialog', anchor: blobId(1) }],
    })
    const built = buildWireRequest(text, capture, wire, [converted])
    expect(built.ok && built.value.messages[1]).toMatchObject({
      content: [{ text: 'and this' }, { text: expect.stringContaining('a dialog') }],
    })
    expect(buildWireRequest(text, capture, wire, [resolved({ parts: [] })]).ok).toBe(true)
  })

  it('refuses by name instead of dropping or guessing', () => {
    const ok = prepared(items())
    expect(code(buildWireRequest(ok, capture, wire, []))).toBe('model_wire_media')
    expect(code(buildWireRequest(ok, capture, wire, [resolved(), resolved()]))).toBe('model_wire_media')
    expect(
      code(
        buildWireRequest(prepared([item('u', 'user', 'hi')], { mediaPlans: [] }), capture, wire, [
          resolved(),
        ]),
      ),
    ).toBe('model_wire_media')
    expect(code(buildWireRequest(ok, capture, wire, [resolved({ planKey: 'other' })]))).toBe(
      'model_wire_media',
    )
    expect(code(buildWireRequest(ok, capture, wire, [resolved({ planDigest: 'f'.repeat(64) })]))).toBe(
      'model_wire_media',
    )
    expect(code(buildWireRequest(prepared([item('u1', 'user', 'look')]), capture, wire, [resolved()]))).toBe(
      'model_wire_media_anchor',
    )
    const shared = [
      item('u1', 'user', 'a', [plan.sourceRefs[0]!, plan.sourceRefs[1]!]),
      item('u2', 'user', 'b', [plan.sourceRefs[0]!]),
    ]
    expect(code(buildWireRequest(prepared(shared), capture, wire, [resolved()]))).toBe(
      'model_wire_media_anchor',
    )
    const system = [item('sys', 'system', 'a', plan.sourceRefs), item('u', 'user', 'b')]
    expect(code(buildWireRequest(prepared(system), capture, wire, [resolved()]))).toBe(
      'model_wire_media_anchor',
    )
    expect(
      code(
        buildWireRequest(
          prepared(items(), { outputSchema: { typeId: 's', revision: 1, digest: 'a'.repeat(64) } }),
          capture,
          wire,
          [resolved()],
        ),
      ),
    ).toBe('model_wire_output_schema')
  })

  it('refuses an image for a model or target that cannot take one', () => {
    const textModel = { ...capture, model: { ...model, input: ['text' as const] } }
    expect(code(buildWireRequest(prepared(items()), textModel, wire, [resolved()]))).toBe(
      'model_wire_media_feature',
    )
    expect(code(buildWireRequest(prepared(items(), {}, featuresText), capture, wire, [resolved()]))).toBe(
      'model_wire_media_feature',
    )
  })
})
