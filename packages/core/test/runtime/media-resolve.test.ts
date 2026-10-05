import type { CallContext } from '@agnes/extension-api/runtime'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../../src/request/hash.js'
import { manifestRef } from '../../src/runtime/media/identity.js'
import { type MediaByteReader, resolveMediaParts, toModelWireMedia } from '../../src/runtime/media/resolve.js'
import { verifyPreparedMedia } from '../../src/runtime/media/verify.js'
import { convertedBuilt, LIMITS, legacyImage, must, nativeBuilt } from './media-fixture.js'

const context = {} as CallContext
const reader = (bytesByDigest: Map<string, Uint8Array>): MediaByteReader => ({
  async read(blob) {
    const bytes = bytesByDigest.get(blob.digest)
    return bytes
      ? { ok: true, value: bytes }
      : {
          ok: false,
          error: {
            code: 'denied',
            detailCode: 'x',
            message: '',
            diagnosticId: 'd',
            retryAdvice: { kind: 'never' },
          },
        }
  },
})
const store = () => new Map([legacyImage(1, 0, 1), legacyImage(2, 0, 2)].map((i) => [i.blob.digest, i.bytes]))

describe('resolveMediaParts', () => {
  it('rebuilds native image parts with their untrusted labels and the legacy hash', async () => {
    const c = nativeBuilt()
    const verified = verifyPreparedMedia(c.plan, c.media, c.evidence)
    if (!verified.ok) throw new Error('verify')
    const resolved = await resolveMediaParts(verified.value, reader(store()), LIMITS, context)
    if (!resolved.ok) throw new Error(resolved.error.detailCode)
    expect(resolved.value.parts.map((p) => p.kind)).toEqual(['text', 'image', 'text', 'image'])
    expect(resolved.value.parts[0]).toMatchObject({ kind: 'text' })
    expect((resolved.value.parts[0] as { text: string }).text).toContain('untrusted tool image')
    const wire = toModelWireMedia(resolved.value)
    expect(wire.parts.filter((p) => p.kind === 'image').map((p) => p.sha256)).toEqual(
      c.plan.sourceRefs.map((s) => (s.kind === 'blob' ? s.value.digest : '')),
    )
  })

  it('refuses re-read bytes that differ from the retained digest', async () => {
    const c = nativeBuilt()
    const verified = verifyPreparedMedia(c.plan, c.media, c.evidence)
    if (!verified.ok) throw new Error('verify')
    const swapped = store()
    const first = [...swapped.keys()][0]!
    swapped.set(first, legacyImage(1, 0, 99).bytes)
    const resolved = await resolveMediaParts(verified.value, reader(swapped), LIMITS, context)
    expect(!resolved.ok && resolved.error.detailCode).toBe('media_source_drift')
  })

  it('refuses a source the reader no longer grants', async () => {
    const c = nativeBuilt()
    const verified = verifyPreparedMedia(c.plan, c.media, c.evidence)
    if (!verified.ok) throw new Error('verify')
    const resolved = await resolveMediaParts(verified.value, reader(new Map()), LIMITS, context)
    expect(!resolved.ok && resolved.error.code).toBe('denied')
  })

  it('anchors the converted text at the last selected source', async () => {
    const c = convertedBuilt()
    const verified = verifyPreparedMedia(c.plan, c.media, c.evidence)
    if (!verified.ok) throw new Error('verify')
    const resolved = await resolveMediaParts(verified.value, reader(new Map()), LIMITS, context)
    if (!resolved.ok) throw new Error('resolve')
    expect(resolved.value.parts).toHaveLength(1)
    expect(resolved.value.parts[0]).toMatchObject({ kind: 'text', anchor: c.manifest.conversion!.anchor })
    expect(toModelWireMedia(resolved.value).parts[0]!.sha256).toBe(
      sha256Hex((resolved.value.parts[0] as { text: string }).text),
    )
  })
  it('adds no untrusted label to images that came from the user', async () => {
    const c = nativeBuilt()
    const verified = verifyPreparedMedia(c.plan, { ...c.media, trust: 'user' }, c.evidence)
    if (!verified.ok) throw new Error('verify')
    const resolved = await resolveMediaParts(verified.value, reader(store()), LIMITS, context)
    if (!resolved.ok) throw new Error(resolved.error.detailCode)
    expect(resolved.value.parts.map((p) => p.kind)).toEqual(['image', 'image'])
  })
  it('refuses a manifest whose retained media hash does not match the rebuilt selection', async () => {
    const c = nativeBuilt()
    const manifest = { ...c.manifest, mediaHash: 'f'.repeat(64) }
    const media = { ...c.media, contentRefs: [must(manifestRef(manifest)), ...c.media.contentRefs.slice(1)] }
    const verified = verifyPreparedMedia(c.plan, media, c.evidence)
    if (!verified.ok) throw new Error('verify')
    const resolved = await resolveMediaParts(verified.value, reader(store()), LIMITS, context)
    expect(!resolved.ok && resolved.error.detailCode).toBe('media_source_drift')
  })
})
