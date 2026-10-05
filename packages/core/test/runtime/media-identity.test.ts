import { describe, expect, it } from 'vitest'
import {
  leastTrusted,
  MEDIA_IMAGE_TO_TEXT_SCHEMA,
  mediaCacheKey,
  mediaSourceDigest,
  packParameters,
  parseParameters,
  retentionOf,
} from '../../src/runtime/media/identity.js'
import { VISION_MAX_EDGE } from '../../src/runtime/media/legacy-bridge.js'
import { digestOf, must, parametersOf, planOf, png, publicBlob, routeSnapshot } from './media-fixture.js'

const retention = () => ({
  route: retentionOf(routeSnapshot()),
  promptDigest: digestOf({ p: 1 }),
  parserVersion: '1',
})

describe('media parameters', () => {
  it('round-trips and rejects out-of-range or mismatched fields', () => {
    const packed = packParameters(parametersOf([1, 1, 2]))
    if (!packed.ok) throw new Error('pack')
    const parsed = parseParameters(packed.value, 3)
    expect(parsed.ok && parsed.value.nodes).toEqual([1, 1, 2])
    expect(parseParameters(packed.value, 2).ok).toBe(false) // nodes length must equal the source count
    const bad = [
      parametersOf([1], { maxEdge: VISION_MAX_EDGE + 1 }),
      parametersOf([1], { maxOutputTokens: 0 }),
      parametersOf([2, 1]),
      parametersOf([1], { limits: { ...parametersOf([1]).limits, maxSelectedBytes: 0 } }),
    ]
    for (const parameters of bad) {
      const ref = packParameters(parameters)
      expect(ref.ok && parseParameters(ref.value, parameters.nodes.length).ok).toBe(false)
    }
  })
})

describe('cache key', () => {
  const plan = planOf([{ marker: 1, node: 1 }], 'convert')
  const base = mediaCacheKey(plan, retention())
  it('ignores the plan key and anything about the caller', () => {
    expect(mediaCacheKey({ ...plan, key: 'media:other' }, retention())).toBe(base)
  })
  it.each([
    ['sourceDigest', { ...plan, sourceDigest: 'e'.repeat(64) }, retention()],
    ['provider', { ...plan, provider: { ...plan.provider, providerId: 'other' } }, retention()],
    [
      'parameters',
      { ...plan, parameters: must(packParameters(parametersOf([1], { maxOutputTokens: 7 }))) },
      retention(),
    ],
    ['routeRevision', plan, { ...retention(), route: { ...retention().route, routeRevision: 2 } }],
    ['catalogRevision', plan, { ...retention(), route: { ...retention().route, catalogRevision: 2 } }],
    ['priceVersion', plan, { ...retention(), route: { ...retention().route, priceVersion: 'p2' } }],
    ['prompt', plan, { ...retention(), promptDigest: digestOf({ p: 2 }) }],
    ['parser', plan, { ...retention(), parserVersion: '2' }],
  ] as const)('changes when %s changes', (_name, changedPlan, changedRetention) => {
    expect(mediaCacheKey(changedPlan, changedRetention)).not.toBe(base)
  })
  it('uses the conversion schema identity', () => {
    expect(plan.transformSchema).toEqual(MEDIA_IMAGE_TO_TEXT_SCHEMA)
  })
})

describe('source digest and trust', () => {
  it('only digests blob sources, in order', () => {
    const a = publicBlob(png(8, 8, 1)),
      b = publicBlob(png(8, 8, 2))
    const ab = mediaSourceDigest([a, b]),
      ba = mediaSourceDigest([b, a])
    expect(ab.ok && ba.ok && ab.value !== ba.value).toBe(true)
    const artifact = mediaSourceDigest([
      { kind: 'artifact', value: { artifactId: 'a', version: 1 } } as never,
    ])
    expect(!artifact.ok && artifact.error.detailCode).toBe('media_source_kind')
  })
  it('takes the least trusted source', () => {
    expect(leastTrusted(['user', 'external'])).toBe('external')
    expect(leastTrusted(['user', 'derived'])).toBe('derived')
    expect(leastTrusted(['system', 'user'])).toBe('user')
  })
})
