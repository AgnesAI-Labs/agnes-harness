import { describe, expect, it } from 'vitest'
import { decodeSafeImageBytes, imageHeaderDimensions } from '../src/safe-image.js'

const PNG8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
  'base64',
)
const jpegHeader = (width: number, height: number, app = 16) =>
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    app >> 8,
    app & 0xff,
    ...new Array(app - 2).fill(0),
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])

describe('imageHeaderDimensions', () => {
  it('reads the size a PNG or JPEG header states, as the validator does', () => {
    const png = imageHeaderDimensions(PNG8)
    const decoded = decodeSafeImageBytes(
      { bytes: PNG8, mimeType: 'image/png' },
      { maxBytesPerImage: 1024, maxPixelsPerImage: 1024, maxAggregateBytes: 1024, maxAggregatePixels: 1024 },
    )
    expect(png).toEqual({ width: decoded.width, height: decoded.height })
    expect(imageHeaderDimensions(jpegHeader(1500, 600))).toEqual({ width: 1500, height: 600 })
    // Past a large metadata segment, too.
    expect(imageHeaderDimensions(jpegHeader(640, 480, 60_000))).toEqual({ width: 640, height: 480 })
  })

  it('says nothing for bytes that do not state a size', () => {
    expect(imageHeaderDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined()
    expect(imageHeaderDimensions(jpegHeader(1500, 600).subarray(0, 24))).toBeUndefined()
    expect(imageHeaderDimensions(jpegHeader(0, 600))).toBeUndefined()
    expect(imageHeaderDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeUndefined()
  })
})
