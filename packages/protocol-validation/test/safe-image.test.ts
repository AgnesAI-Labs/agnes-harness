import { constants, deflateSync, inflateSync } from 'node:zlib'
import {
  decodeSafeImage,
  decodeSafeImages,
  SafeImageError,
  type SafeImageLimits,
} from '@agnes/protocol-validation'
import { describe, expect, it } from 'vitest'

const limits: SafeImageLimits = {
  maxBytesPerImage: 1024,
  maxPixelsPerImage: 2_000_000,
  maxAggregateBytes: 2048,
  maxAggregatePixels: 4_000_000,
}

const base64 = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('base64')
const u32 = (value: number) => [value >>> 24, value >>> 16, value >>> 8, value].map((byte) => byte & 0xff)
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10]

function bits(...groups: readonly (readonly number[])[]): Uint8Array {
  const stream = groups.flat()
  const bytes = new Uint8Array(Math.ceil(stream.length / 8))
  for (let index = 0; index < stream.length; index += 1)
    bytes[index >>> 3] = (bytes[index >>> 3] as number) | ((stream[index] as number) << (index & 7))
  return bytes
}

function fixedCode(value: number, length: number): number[] {
  return Array.from({ length }, (_, index) => (value >>> (length - index - 1)) & 1)
}

function zlib(deflate: Uint8Array, cmf = 0x78): Uint8Array {
  const flags = Array.from({ length: 256 }, (_, value) => value).find(
    (value) => (value & 32) === 0 && ((cmf << 8) | value) % 31 === 0,
  )
  if (flags === undefined) throw new Error('no valid zlib flags')
  return Uint8Array.from([cmf, flags, ...deflate, 0, 0, 0, 0])
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}

function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: readonly number[]): number[] {
  const typeBytes = [...Buffer.from(type, 'ascii')]
  return [...u32(data.length), ...typeBytes, ...data, ...u32(crc32([...typeBytes, ...data]))]
}

function pngParts(
  width: number,
  height: number,
  compressed?: Uint8Array,
): Readonly<{ header: number[]; data: number[]; end: number[] }> {
  const rowBytes = Math.ceil(width / 8)
  const raw = Buffer.alloc(Math.max(0, height * (rowBytes + 1)))
  const payload = compressed ?? deflateSync(raw)
  return {
    header: chunk('IHDR', [...u32(width), ...u32(height), 1, 0, 0, 0, 0]),
    data: chunk('IDAT', [...payload]),
    end: chunk('IEND', []),
  }
}

function png(width: number, height: number, compressed?: Uint8Array): number[] {
  const parts = pngParts(width, height, compressed)
  return [...PNG_MAGIC, ...parts.header, ...parts.data, ...parts.end]
}

function jpeg(width: number, height: number): number[] {
  return [
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >>> 8,
    height & 0xff,
    width >>> 8,
    width & 0xff,
    1,
    1,
    0x11,
    0,
    0xff,
    0xda,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    1,
    2,
    3,
    0xff,
    0xd9,
  ]
}

describe('safe image decoder', () => {
  it('is available through the package root and accepts complete PNG and JPEG data', () => {
    expect(decodeSafeImage({ data: base64(png(1456, 800)), mimeType: 'image/png' }, limits)).toMatchObject({
      mime: 'image/png',
      width: 1456,
      height: 800,
      pixels: 1_164_800,
    })
    expect(
      decodeSafeImage(
        { data: base64(jpeg(640, 480)), mimeType: 'image/jpeg' },
        { ...limits, maxPixelsPerImage: 2_000_000 },
      ),
    ).toMatchObject({ mime: 'image/jpeg', width: 640, height: 480, pixels: 307_200 })
  })

  it.each([
    ['whitespace', `${base64(png(1, 1))}\n`],
    ['URL alphabet', '____'],
    ['missing padding', base64(png(1, 1)).replace(/=+$/, '')],
    ['non-canonical unused bits', '/x=='],
  ])('rejects %s instead of accepting lenient base64', (_name, data) => {
    expect(() => decodeSafeImage({ data, mimeType: 'image/png' }, limits)).toThrow(/base64/)
  })

  it('cross-checks declared MIME with magic bytes', () => {
    expect(() => decodeSafeImage({ data: base64(jpeg(10, 10)), mimeType: 'image/png' }, limits)).toThrow(
      /MIME/,
    )
    expect(() => decodeSafeImage({ data: base64(png(10, 10)), mimeType: 'image/jpeg' }, limits)).toThrow(
      /MIME/,
    )
  })

  it('validates every PNG CRC and rejects truncated image data', () => {
    const corrupt = png(10, 10)
    corrupt[29] = (corrupt[29] as number) ^ 1
    expect(() => decodeSafeImage({ data: base64(corrupt), mimeType: 'image/png' }, limits)).toThrow(/CRC/)
    expect(() =>
      decodeSafeImage({ data: base64(png(10, 10).slice(0, -3)), mimeType: 'image/png' }, limits),
    ).toThrow(/PNG/)
    expect(() =>
      decodeSafeImage({ data: base64(jpeg(10, 10).slice(0, -2)), mimeType: 'image/jpeg' }, limits),
    ).toThrow(/JPEG/)
  })

  it('requires critical PNG chunks in safe order and rejects compressed ancillary data', () => {
    const parts = pngParts(1, 1)
    const text = chunk('zTXt', [...Buffer.from('key\0\0compressed', 'ascii')])
    const plainText = chunk('tEXt', [...Buffer.from('key\0plain', 'ascii')])
    expect(() =>
      decodeSafeImage(
        {
          data: base64([
            ...PNG_MAGIC,
            ...parts.header,
            ...parts.data,
            ...plainText,
            ...parts.data,
            ...parts.end,
          ]),
          mimeType: 'image/png',
        },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/consecutive/)
    expect(() =>
      decodeSafeImage(
        {
          data: base64([...PNG_MAGIC, ...parts.header, ...text, ...parts.data, ...parts.end]),
          mimeType: 'image/png',
        },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/compressed ancillary/)
    expect(() =>
      decodeSafeImage(
        {
          data: base64([...PNG_MAGIC, ...parts.header, ...chunk('ABCD', []), ...parts.data, ...parts.end]),
          mimeType: 'image/png',
        },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/critical chunk/)

    const indexedHeader = chunk('IHDR', [...u32(1), ...u32(1), 1, 3, 0, 0, 0])
    const oversizedPalette = chunk('PLTE', [0, 0, 0, 127, 127, 127, 255, 255, 255])
    expect(() =>
      decodeSafeImage(
        {
          data: base64([
            ...PNG_MAGIC,
            ...indexedHeader,
            ...oversizedPalette,
            ...chunk('IDAT', [...deflateSync(Uint8Array.of(0, 0))]),
            ...parts.end,
          ]),
          mimeType: 'image/png',
        },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/palette/)
  })

  it('rejects APNG frames instead of counting only the static canvas', () => {
    const parts = pngParts(1, 1)
    const animationControl = chunk('acTL', [...u32(2), ...u32(0)])
    const frameControl = chunk('fcTL', [
      ...u32(0),
      ...u32(1),
      ...u32(1),
      ...u32(0),
      ...u32(0),
      0,
      1,
      0,
      30,
      0,
      0,
    ])
    const frameData = chunk('fdAT', [...u32(1), ...deflateSync(Uint8Array.of(0, 0))])
    expect(() =>
      decodeSafeImage(
        {
          data: base64([
            ...PNG_MAGIC,
            ...parts.header,
            ...animationControl,
            ...frameControl,
            ...parts.data,
            ...frameData,
            ...parts.end,
          ]),
          mimeType: 'image/png',
        },
        { ...limits, maxBytesPerImage: 4096, maxPixelsPerImage: 1, maxAggregatePixels: 1 },
      ),
    ).toThrow(/animated PNG/)
  })

  it('rejects a 1x1 PNG whose IDAT expands to 10 MiB', () => {
    const bomb = png(1, 1, deflateSync(Buffer.alloc(10 * 1024 * 1024)))
    expect(bomb.length).toBeLessThan(16 * 1024)
    expect(() =>
      decodeSafeImage(
        { data: base64(bomb), mimeType: 'image/png' },
        { ...limits, maxBytesPerImage: 16 * 1024 },
      ),
    ).toThrow(/scanline bound/)
  })

  it('rejects invalid PNG scanline filters and zlib checksums', () => {
    expect(() =>
      decodeSafeImage(
        { data: base64(png(1, 1, deflateSync(Uint8Array.of(5, 0)))), mimeType: 'image/png' },
        limits,
      ),
    ).toThrow(/filter/)
    const compressed = deflateSync(Uint8Array.of(0, 0))
    compressed[compressed.length - 1] = (compressed[compressed.length - 1] as number) ^ 1
    expect(() =>
      decodeSafeImage({ data: base64(png(1, 1, compressed)), mimeType: 'image/png' }, limits),
    ).toThrow(/checksum/)
  })

  it.each([
    ['stored', 1, deflateSync(Uint8Array.of(0, 0), { level: 0 })],
    ['fixed Huffman', 1, deflateSync(Uint8Array.of(0, 0), { strategy: constants.Z_FIXED })],
    ['dynamic Huffman', 32768, deflateSync(Buffer.alloc(4097))],
  ])('accepts bounded %s DEFLATE streams', (_kind, width, compressed) => {
    const image = png(width, 1, compressed)
    expect(
      decodeSafeImage(
        { data: base64(image), mimeType: 'image/png' },
        { ...limits, maxBytesPerImage: 16 * 1024 },
      ),
    ).toMatchObject({ mime: 'image/png' })
  })

  it('rejects incomplete dynamic Huffman trees that platform zlib rejects', () => {
    // This stream expands to the valid 1x1 scanline [filter=0, pixel=0], but describes literal 0
    // and EOB as two length-2 codes, leaving half the alphabet unused. Earlier admission accepted
    // it while the downstream platform decoder rejected it as "invalid literal/lengths set".
    const incomplete = Buffer.from('78010580810800000080f6a73e1000020001', 'hex')
    expect(() => inflateSync(incomplete)).toThrow()
    expect(() =>
      decodeSafeImage(
        { data: base64(png(1, 1, incomplete)), mimeType: 'image/png' },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/incomplete/)
  })

  it('rejects reserved dynamic literal counts and distance symbols', () => {
    const reservedLiteralCount = zlib(bits([1, 0, 1], [0, 1, 1, 1, 1]))
    expect(() =>
      decodeSafeImage(
        { data: base64(png(1, 1, reservedLiteralCount)), mimeType: 'image/png' },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/literal count is reserved/)

    const reservedDistance = zlib(
      bits([1, 1, 0], fixedCode(48, 8), fixedCode(48, 8), fixedCode(1, 7), fixedCode(30, 5)),
    )
    expect(() =>
      decodeSafeImage(
        { data: base64(png(1, 1, reservedDistance)), mimeType: 'image/png' },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/invalid distance/)
  })

  it('accepts exact Adam7 scanlines and the full 32 KiB history window', () => {
    const adam7Header = chunk('IHDR', [...u32(8), ...u32(8), 1, 0, 0, 0, 1])
    const adam7 = [
      ...PNG_MAGIC,
      ...adam7Header,
      ...chunk('IDAT', [...deflateSync(Buffer.alloc(30))]),
      ...chunk('IEND', []),
    ]
    expect(decodeSafeImage({ data: base64(adam7), mimeType: 'image/png' }, limits)).toMatchObject({
      width: 8,
      height: 8,
    })

    const wrapped = png(320_000, 1, deflateSync(Buffer.alloc(40_001)))
    expect(
      decodeSafeImage(
        { data: base64(wrapped), mimeType: 'image/png' },
        { ...limits, maxBytesPerImage: 64 * 1024 },
      ),
    ).toMatchObject({ width: 320_000, height: 1 })
  })

  it('enforces the history window declared by the zlib header', () => {
    const seed = Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 73 + index * index) & 0xff))
    const raw = Buffer.concat([Buffer.from([0]), seed, seed])
    const compressed = deflateSync(raw)
    compressed[0] = 0x08
    compressed[1] = Array.from({ length: 256 }, (_, value) => value).find(
      (value) => (value & 32) === 0 && (((compressed[0] as number) << 8) | value) % 31 === 0,
    ) as number
    expect(() =>
      decodeSafeImage(
        { data: base64(png(4800, 1, compressed)), mimeType: 'image/png' },
        { ...limits, maxBytesPerImage: 4096 },
      ),
    ).toThrow(/invalid distance/)
  })

  it('accepts JPEG fill bytes before the terminal marker', () => {
    const bytes = jpeg(10, 10)
    bytes.splice(bytes.length - 2, 0, 0xff)
    expect(decodeSafeImage({ data: base64(bytes), mimeType: 'image/jpeg' }, limits)).toMatchObject({
      width: 10,
      height: 10,
    })
  })

  it('fails closed on zero dimensions and compact dimension bombs', () => {
    expect(() => decodeSafeImage({ data: base64(png(0, 10)), mimeType: 'image/png' }, limits)).toThrow(
      /dimensions/,
    )
    const hugeHeader = pngParts(100_000, 100_000, deflateSync(Uint8Array.of(0)))
    expect(() =>
      decodeSafeImage(
        {
          data: base64([...PNG_MAGIC, ...hugeHeader.header, ...hugeHeader.data, ...hugeHeader.end]),
          mimeType: 'image/png',
        },
        limits,
      ),
    ).toThrow(/pixel limit/)
    expect(() => decodeSafeImage({ data: base64(jpeg(2000, 2000)), mimeType: 'image/jpeg' }, limits)).toThrow(
      /pixel limit/,
    )
  })

  it('enforces decoded per-image byte limits before allocation', () => {
    const data = base64(png(1, 1))
    expect(() =>
      decodeSafeImage({ data, mimeType: 'image/png' }, { ...limits, maxBytesPerImage: 8 }),
    ).toThrow(/byte limit/)
  })

  it('applies remaining aggregate caps before decoding the next image', () => {
    const input = { data: base64(png(10, 10)), mimeType: 'image/png' as const }
    const one = decodeSafeImage(input, limits)
    try {
      decodeSafeImages([input, input], { ...limits, maxAggregateBytes: one.bytes.length + 8 })
      throw new Error('expected aggregate byte limit')
    } catch (error) {
      expect(error).toBeInstanceOf(SafeImageError)
      expect((error as SafeImageError).code).toBe('BYTE_LIMIT')
      expect(error).toHaveProperty('message', 'encoded image exceeds byte limit')
    }
    expect(() => decodeSafeImages([input, input], { ...limits, maxAggregatePixels: 199 })).toThrow(
      /pixel limit/,
    )
    expect(decodeSafeImages([input, input], limits)).toHaveLength(2)
  })
})
