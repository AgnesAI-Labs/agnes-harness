import { describe, expect, it } from 'vitest'
import {
  REQUEST_IMAGE_ENCODER,
  requestImageTransform,
  requestVersionId,
} from '../src/request/request-version.js'

const source = 'a'.repeat(64)
const base = requestImageTransform({
  maxWidth: 1456,
  maxHeight: 1456,
  maxPixels: 2_119_936,
  maxBytes: 4 * 1024 * 1024,
})

describe('request version id', () => {
  it('is stable and 64 lowercase hex', () => {
    expect(requestVersionId(source, base)).toMatch(/^[0-9a-f]{64}$/)
    expect(requestVersionId(source, base)).toBe(requestVersionId(source, { ...base }))
    expect(base.encoder).toEqual(REQUEST_IMAGE_ENCODER)
  })

  it('changes with every field that shapes the output', () => {
    const id = requestVersionId(source, base)
    const variants = [
      requestVersionId('b'.repeat(64), base),
      requestVersionId(source, { ...base, transform: 'agh-thumb-v1' }),
      requestVersionId(source, { ...base, maxWidth: 1455 }),
      requestVersionId(source, { ...base, maxHeight: 1455 }),
      requestVersionId(source, { ...base, maxPixels: 2_119_935 }),
      requestVersionId(source, { ...base, maxBytes: 4 * 1024 * 1024 - 1 }),
      requestVersionId(source, { ...base, encoder: { formats: ['jpeg'], jpegQualities: [85, 80, 75] } }),
      requestVersionId(source, { ...base, encoder: { formats: ['png', 'jpeg'], jpegQualities: [85, 80] } }),
    ]
    expect(new Set([id, ...variants]).size).toBe(variants.length + 1)
  })
})
