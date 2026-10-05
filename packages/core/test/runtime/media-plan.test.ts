import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  MEDIA_IMAGE_TO_TEXT_SCHEMA,
  MEDIA_NATIVE_SCHEMA,
  parseParameters,
} from '../../src/runtime/media/identity.js'
import { planMediaForView } from '../../src/runtime/media/plan.js'
import {
  featuresImage,
  featuresText,
  mediaBinding,
  parametersOf,
  png,
  publicBlob,
  routeSnapshot,
} from './media-fixture.js'

const item = (
  id: string,
  trust: W.ContextItem['trust'],
  sourceRefs: W.PublicRef[],
  kind: W.ContextItem['kind'] = 'message',
): W.ContextItem => ({
  id,
  kind,
  body: {
    kind: 'inline',
    schema: { typeId: 't', revision: 1, digest: 'a'.repeat(64) },
    value: id,
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
const view = (items: W.ContextItem[]): W.ContextView => ({
  viewId: 'v',
  format: 'f',
  schema: { typeId: 't', revision: 1, digest: 'a'.repeat(64) },
  baseRevision: 1,
  items,
  tokenEstimate: 1,
  protectedRefs: [],
  inputDigest: 'a'.repeat(64),
  digest: 'b'.repeat(64),
  runtimeInstructionRefs: [],
})
const { kind: _kind, nodes: _nodes, ...base } = parametersOf([1])
const target = (features: W.ModelFeatures): W.ModelRouteSnapshot => ({ ...routeSnapshot(), features })
const plan = (items: W.ContextItem[], features: W.ModelFeatures, extra: Partial<typeof base> = {}) =>
  planMediaForView({
    view: view(items),
    target: target(features),
    provider: mediaBinding,
    parameters: { kind: 'agh.media/parameters@1', ...base, ...extra },
  })

const a = publicBlob(png(8, 8, 1)),
  b = publicBlob(png(8, 8, 2)),
  c = publicBlob(png(8, 8, 3))

describe('planMediaForView', () => {
  it('plans one native plan for an image-capable target, with node ordinals from the view', () => {
    const result = plan([item('m1', 'user', [a, b]), item('m2', 'user', [c])], featuresImage)
    if (!result.ok) throw new Error(result.error.detailCode)
    expect(result.value).toHaveLength(1)
    expect(result.value[0]!.transformSchema).toEqual(MEDIA_NATIVE_SCHEMA)
    expect(result.value[0]!.sourceRefs).toEqual([a, b, c])
    const parsed = parseParameters(result.value[0]!.parameters, 3)
    expect(parsed.ok && parsed.value.nodes).toEqual([1, 1, 2])
    expect(result.value[0]!.targetFeatures).toEqual(featuresImage)
  })

  it('plans exactly one conversion plan for a text-only target and is deterministic', () => {
    const first = plan([item('m1', 'user', [a, b])], featuresText)
    const second = plan([item('m1', 'user', [a, b])], featuresText)
    if (!first.ok || !second.ok) throw new Error('plan')
    expect(first.value).toHaveLength(1)
    expect(first.value[0]!.transformSchema).toEqual(MEDIA_IMAGE_TO_TEXT_SCHEMA)
    expect(second.value).toEqual(first.value)
  })

  it('returns no plan when there is no media', () => {
    const none = plan([item('m1', 'user', [])], featuresText)
    expect(none.ok && none.value).toEqual([])
  })

  it('refuses by name instead of dropping a source', () => {
    const code = (r: ReturnType<typeof plan>) => (r.ok ? 'ok' : r.error.detailCode)
    expect(code(plan([item('m1', 'user', [a])], featuresText, { allowConversion: false }))).toBe(
      'media_no_route',
    )
    expect(code(plan([item('m1', 'external', [a])], featuresImage))).toBe('media_anchor_unsupported')
    expect(code(plan([item('m1', 'system', [a])], featuresImage))).toBe('media_anchor_unsupported')
    expect(code(plan([item('m1', 'user', [a], 'tool-result')], featuresImage))).toBe(
      'media_anchor_unsupported',
    )
    expect(code(plan([item('m1', 'user', [publicBlob(png(), 'audio/wav')])], featuresImage))).toBe(
      'media_kind_unsupported',
    )
    expect(code(plan([item('m1', 'user', [publicBlob(png(), 'image/gif')])], featuresImage))).toBe(
      'media_kind_unsupported',
    )
    expect(code(plan([item('m1', 'user', [a]), item('m2', 'user', [a])], featuresImage))).toBe(
      'media_anchor_unsupported',
    )
  })

  it('ignores non-media blobs as provenance', () => {
    const text = publicBlob(new Uint8Array([1, 2, 3]), 'text/plain')
    const result = plan([item('m1', 'user', [text])], featuresImage)
    expect(result.ok && result.value).toEqual([])
  })
})
