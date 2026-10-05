import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { MEDIA_MANIFEST_SCHEMA, type MediaManifest, manifestRef } from '../../src/runtime/media/identity.js'
import { isVerifiedPreparedMedia, verifyPreparedMedia } from '../../src/runtime/media/verify.js'
import { convertedBuilt, digestOf, featuresImage, modelBinding, nativeBuilt } from './media-fixture.js'

type Case = ReturnType<typeof convertedBuilt>
const detail = (r: ReturnType<typeof verifyPreparedMedia>) => (r.ok ? 'ok' : r.error.detailCode)
const withManifest = (c: Case, patch: Partial<MediaManifest>): Case => {
  const next = manifestRef({ ...c.manifest, ...patch })
  if (!next.ok) throw new Error('manifest')
  return {
    ...c,
    manifest: { ...c.manifest, ...patch },
    media: { ...c.media, contentRefs: [next.value, ...c.media.contentRefs.slice(1)] },
  }
}
/** A changed plan with a manifest that still names it, so only the intended check can fail. */
const withPlan = (c: Case, patch: Partial<W.MediaPlan>): Case => {
  const plan = { ...c.plan, ...patch }
  return { ...withManifest(c, { planDigest: digestOf(plan) }), plan }
}

describe('verifyPreparedMedia', () => {
  it('accepts a native result and brands it', () => {
    const c = nativeBuilt()
    const verified = verifyPreparedMedia(c.plan, c.media, c.evidence)
    expect(verified.ok && isVerifiedPreparedMedia(verified.value)).toBe(true)
    expect(isVerifiedPreparedMedia({ ...(verified.ok ? verified.value : {}) })).toBe(false)
  })
  it('accepts a converted result', () => {
    const c = convertedBuilt()
    const verified = verifyPreparedMedia(c.plan, c.media, c.evidence)
    expect(verified.ok && verified.value.usageIds).toEqual(['vision-attempt:model'])
  })

  const native: [string, string, (c: Case) => Case][] = [
    [
      'reordered sources',
      'media_verify_sources',
      (c) => ({ ...c, media: { ...c.media, sourceRefs: [...c.media.sourceRefs].reverse() } }),
    ],
    [
      'manifest for another plan',
      'media_verify_manifest',
      (c) => withManifest(c, { planDigest: digestOf({ other: 1 }) }),
    ],
    [
      'usage on a native result',
      'media_verify_usage',
      (c) => ({
        ...c,
        media: { ...c.media, usageRefs: [{ authorityId: 'a', usageId: 'u', digest: 'c'.repeat(64) }] },
      }),
    ],
    [
      'a transform on a native result',
      'media_verify_chain',
      (c) => ({
        ...c,
        media: {
          ...c.media,
          transformChain: [
            {
              actionId: 'x',
              transformSchema: c.plan.transformSchema,
              inputDigest: c.plan.sourceDigest,
              outputDigest: 'd'.repeat(64),
            },
          ],
        },
      }),
    ],
    [
      'a swapped blob',
      'media_verify_chain',
      (c) => {
        const refs = [...c.media.contentRefs]
        refs[1] = { ...(refs[2] as object) } as W.DataRef
        return { ...c, media: { ...c.media, contentRefs: refs } }
      },
    ],
    [
      'a missing blob',
      'media_verify_chain',
      (c) => ({ ...c, media: { ...c.media, contentRefs: c.media.contentRefs.slice(0, -1) } }),
    ],
    [
      'a system-trust result',
      'media_verify_trust',
      (c) => ({ ...c, media: { ...c.media, trust: 'system' } }),
    ],
    [
      'another producer',
      'media_verify_provenance',
      (c) => ({ ...c, media: { ...c.media, provenance: { ...c.media.provenance, producer: modelBinding } } }),
    ],
    [
      'a text-only target',
      'media_verify_features',
      (c) => withPlan(c, { targetFeatures: { ...featuresImage, input: ['text'] } }),
    ],
  ]
  it.each(native)('native: %s fails with %s', (_name, code, tamper) => {
    const c = tamper(nativeBuilt())
    expect(detail(verifyPreparedMedia(c.plan, c.media, c.evidence))).toBe(code)
  })

  const converted: [string, string, (c: Case) => Case][] = [
    [
      'another input digest in the chain',
      'media_verify_chain',
      (c) => ({
        ...c,
        media: {
          ...c.media,
          transformChain: [{ ...c.media.transformChain[0]!, inputDigest: 'e'.repeat(64) }],
        },
      }),
    ],
    ['no chain', 'media_verify_chain', (c) => ({ ...c, media: { ...c.media, transformChain: [] } })],
    [
      'another output digest',
      'media_verify_chain',
      (c) => ({
        ...c,
        media: {
          ...c.media,
          transformChain: [{ ...c.media.transformChain[0]!, outputDigest: 'e'.repeat(64) }],
        },
      }),
    ],
    ['no child evidence', 'media_verify_receipt', (c) => ({ ...c, evidence: { child: null } })],
    [
      'another child binding',
      'media_verify_receipt',
      (c) => ({ ...c, evidence: { child: { ...c.evidence.child!, bindingId: 'someone-else' } } }),
    ],
    [
      'another child input digest',
      'media_verify_receipt',
      (c) => ({ ...c, evidence: { child: { ...c.evidence.child!, inputDigest: 'e'.repeat(64) } } }),
    ],
    [
      'another receipt',
      'media_verify_receipt',
      (c) => ({ ...c, evidence: { child: { ...c.evidence.child!, receiptId: 'other' } } }),
    ],
    [
      'another child action',
      'media_verify_receipt',
      (c) => ({ ...c, evidence: { child: { ...c.evidence.child!, actionId: 'other' } } }),
    ],
    ['usage dropped', 'media_verify_usage', (c) => ({ ...c, media: { ...c.media, usageRefs: [] } })],
    [
      'usage added',
      'media_verify_usage',
      (c) => ({
        ...c,
        media: {
          ...c.media,
          usageRefs: [...c.media.usageRefs, { authorityId: 'a', usageId: 'u', digest: 'c'.repeat(64) }],
        },
      }),
    ],
    [
      'derived text not from the child',
      'media_verify_receipt',
      (c) => ({ ...c, evidence: { child: { ...c.evidence.child!, text: 'something else' } } }),
    ],
    ['user trust', 'media_verify_trust', (c) => ({ ...c, media: { ...c.media, trust: 'user' } })],
    [
      'an image-capable target',
      'media_verify_features',
      (c) => withPlan(c, { targetFeatures: featuresImage }),
    ],
  ]
  it.each(converted)('converted: %s fails with %s', (_name, code, tamper) => {
    const c = tamper(convertedBuilt())
    expect(detail(verifyPreparedMedia(c.plan, c.media, c.evidence))).toBe(code)
  })

  it('refuses a degraded result unless the plan allows degrading', () => {
    const c = withManifest(convertedBuilt(), { kind: 'degraded', conversion: null })
    expect(
      detail(verifyPreparedMedia(c.plan, { ...c.media, transformChain: [], usageRefs: [] }, { child: null })),
    ).toBe('media_verify_manifest')
    expect(MEDIA_MANIFEST_SCHEMA.typeId).toBe('agh.media/manifest@1')
  })
})
