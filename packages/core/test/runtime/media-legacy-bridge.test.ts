import { describe, expect, it } from 'vitest'
import { prepareRequestMedia } from '../../src/orchestrator/request-media.js'
import {
  candidatesFrom,
  checkEdge,
  mediaHash,
  parseHeader,
  preflight,
  restore,
} from '../../src/runtime/media/legacy-bridge.js'
import { LIMITS, legacyImage } from './media-fixture.js'

const images = [legacyImage(1, 0, 1), legacyImage(2, 0, 2)]
const candidates = () => {
  const built = candidatesFrom(images, LIMITS)
  if (!built.ok) throw new Error(built.error.detailCode)
  return built.value
}

describe('legacy request-media bridge', () => {
  it('derives the native header and hash exactly as the legacy engine does', () => {
    const bridged = preflight(candidates(), 'native', LIMITS)
    const direct = prepareRequestMedia({
      candidates: candidates(),
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
      limits: LIMITS,
    })
    expect(bridged.ok && bridged.value.header).toEqual(direct.header)
    expect(bridged.ok && mediaHash(bridged.value)).toBe(mediaHash(direct))
    expect(direct.header.route).toBe('native-image')
  })

  it('routes a text-only target with an eligible image to auxiliary vision', () => {
    const bridged = preflight(candidates(), 'convert', LIMITS)
    expect(bridged.ok && bridged.value.header.route).toBe('auxiliary-vision')
  })

  it('restores the persisted header from re-read bytes to the same hash', () => {
    const first = preflight(candidates(), 'native', LIMITS)
    if (!first.ok) throw new Error('preflight')
    const restored = restore(
      first.value.header,
      first.value.header.selectionOrder.map((manifestIndex) => ({
        manifestIndex,
        blockIndex: 0,
        bytes: images[manifestIndex]!.bytes,
        sourceTool: 'computer_use',
      })),
      LIMITS,
    )
    expect(restored.ok && mediaHash(restored.value)).toBe(mediaHash(first.value))
  })

  it('maps a changed byte to media_source_drift and a corrupt image to media_image_invalid', () => {
    const tampered = candidatesFrom(
      [{ ...images[0]!, blob: { ...images[0]!.blob, digest: 'f'.repeat(64) } }],
      LIMITS,
    )
    expect(!tampered.ok && tampered.error.detailCode).toBe('media_source_drift')
    const corrupt = candidatesFrom([{ ...images[0]!, bytes: new Uint8Array([1, 2, 3]) }], LIMITS)
    expect(!corrupt.ok && corrupt.error.detailCode).toBe('media_image_invalid')
  })

  it('maps limit failures to media_image_limit', () => {
    const big = candidatesFrom([legacyImage(1, 0, 1)], { ...LIMITS, maxBytesPerImage: 8 })
    expect(!big.ok && big.error.detailCode).toBe('media_image_limit')
  })

  it('refuses a selected image wider than the edge limit', () => {
    const prepared = preflight(candidates(), 'native', LIMITS)
    if (!prepared.ok) throw new Error('preflight')
    expect(checkEdge(prepared.value, 8).ok).toBe(true) // the fixture images are 8x8
    const refused = checkEdge(prepared.value, 7)
    expect(!refused.ok && refused.error.detailCode).toBe('media_image_resize_required')
  })

  it('rejects a header that does not validate', () => {
    const bad = parseHeader({ version: 1, route: 'native-image', selectionOrder: [3], manifest: [] })
    expect(!bad.ok && bad.error.detailCode).toBe('media_continuation_conflict')
  })
  it('restores the persisted selection without re-running the window', () => {
    const four = [1, 2, 3, 4].map((node) => legacyImage(node, 0, node))
    const built = candidatesFrom(four, LIMITS)
    if (!built.ok) throw new Error('candidates')
    const first = preflight(built.value, 'native', LIMITS)
    if (!first.ok) throw new Error('preflight')
    expect(first.value.header.selectionOrder).toHaveLength(3)
    const restored = restore(
      first.value.header,
      first.value.header.selectionOrder.map((manifestIndex) => ({
        manifestIndex,
        blockIndex: 0,
        bytes: four[manifestIndex]!.bytes,
        sourceTool: 'computer_use',
      })),
      LIMITS,
    )
    expect(restored.ok && restored.value.header).toEqual(first.value.header)
    expect(restored.ok && mediaHash(restored.value)).toBe(mediaHash(first.value))
  })

  it('keeps an image whose edge equals the limit', () => {
    const prepared = preflight(candidates(), 'native', LIMITS)
    if (!prepared.ok) throw new Error('preflight')
    expect(checkEdge(prepared.value, 8).ok).toBe(true)
  })
  it('maps restored bytes that differ from the persisted header to media_source_drift', () => {
    const first = preflight(candidates(), 'native', LIMITS)
    if (!first.ok) throw new Error('preflight')
    const other = legacyImage(1, 0, 99)
    const restored = restore(
      first.value.header,
      first.value.header.selectionOrder.map((manifestIndex) => ({
        manifestIndex,
        blockIndex: 0,
        bytes: other.bytes,
        sourceTool: 'computer_use',
      })),
      LIMITS,
    )
    expect(!restored.ok && restored.error.detailCode).toBe('media_source_drift')
  })
})
