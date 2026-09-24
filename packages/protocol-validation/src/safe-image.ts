export type SafeImageMime = 'image/png' | 'image/jpeg'

export type SafeImageLimits = Readonly<{
  maxBytesPerImage: number
  maxPixelsPerImage: number
  maxAggregateBytes: number
  maxAggregatePixels: number
}>

export type SafeImageInput = Readonly<{ data: string; mimeType: string }>
export type SafeImageBytesInput = Readonly<{ bytes: Uint8Array; mimeType: string }>

export type SafeImage = Readonly<{
  bytes: Uint8Array
  mime: SafeImageMime
  width: number
  height: number
  pixels: number
}>

export class SafeImageError extends Error {
  readonly code:
    | 'BASE64_INVALID'
    | 'BYTE_LIMIT'
    | 'DIMENSIONS_INVALID'
    | 'FORMAT_INVALID'
    | 'MIME_MISMATCH'
    | 'PIXEL_LIMIT'

  constructor(code: SafeImageError['code'], message: string) {
    super(message)
    this.name = 'SafeImageError'
    this.code = code
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUE = new Int16Array(128).fill(-1)
for (let i = 0; i < BASE64.length; i += 1) BASE64_VALUE[BASE64.charCodeAt(i)] = i
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function checkedLimits(input: SafeImageLimits): SafeImageLimits {
  return {
    maxBytesPerImage: positiveLimit(input.maxBytesPerImage, 'maxBytesPerImage'),
    maxPixelsPerImage: positiveLimit(input.maxPixelsPerImage, 'maxPixelsPerImage'),
    maxAggregateBytes: positiveLimit(input.maxAggregateBytes, 'maxAggregateBytes'),
    maxAggregatePixels: positiveLimit(input.maxAggregatePixels, 'maxAggregatePixels'),
  }
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0)
    throw new SafeImageError('BASE64_INVALID', 'image data is not padded standard base64')
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4
  if (value.length > maxEncodedLength)
    throw new SafeImageError('BYTE_LIMIT', 'encoded image exceeds byte limit')

  let padding = 0
  if (value.endsWith('==')) padding = 2
  else if (value.endsWith('=')) padding = 1
  const byteLength = (value.length / 4) * 3 - padding
  if (byteLength > maxBytes) throw new SafeImageError('BYTE_LIMIT', 'decoded image exceeds byte limit')
  const bytes = new Uint8Array(byteLength)
  let out = 0
  for (let offset = 0; offset < value.length; offset += 4) {
    const last = offset + 4 === value.length
    const a = value.charCodeAt(offset)
    const b = value.charCodeAt(offset + 1)
    const c = value.charCodeAt(offset + 2)
    const d = value.charCodeAt(offset + 3)
    const va = a < 128 ? (BASE64_VALUE[a] ?? -1) : -1
    const vb = b < 128 ? (BASE64_VALUE[b] ?? -1) : -1
    if (va < 0 || vb < 0)
      throw new SafeImageError('BASE64_INVALID', 'image data contains invalid base64 characters')
    const cPad = c === 61
    const dPad = d === 61
    const vc = cPad ? 0 : c < 128 ? (BASE64_VALUE[c] ?? -1) : -1
    const vd = dPad ? 0 : d < 128 ? (BASE64_VALUE[d] ?? -1) : -1
    if ((!last && (cPad || dPad)) || (cPad && !dPad) || vc < 0 || vd < 0)
      throw new SafeImageError('BASE64_INVALID', 'image data has invalid base64 padding')
    // RFC 4648 canonical form requires unused bits in the final quantum to be zero.
    if ((cPad && (vb & 15) !== 0) || (dPad && !cPad && (vc & 3) !== 0))
      throw new SafeImageError('BASE64_INVALID', 'image data is non-canonical base64')
    if (out < byteLength) bytes[out++] = (va << 2) | (vb >> 4)
    if (out < byteLength) bytes[out++] = ((vb & 15) << 4) | (vc >> 2)
    if (out < byteLength) bytes[out++] = ((vc & 3) << 6) | vd
  }
  return bytes
}

function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number)
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) * 0x1000000 +
    ((bytes[offset + 1] as number) << 16) +
    ((bytes[offset + 2] as number) << 8) +
    (bytes[offset + 3] as number)
  )
}

function dimensions(
  width: number,
  height: number,
  maxPixels: number,
): Readonly<{ width: number; height: number; pixels: number }> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new SafeImageError('DIMENSIONS_INVALID', 'image dimensions must be positive integers')
  if (width > Math.floor(maxPixels / height))
    throw new SafeImageError('PIXEL_LIMIT', 'image dimensions exceed pixel limit')
  return { width, height, pixels: width * height }
}

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10] as const

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC32_TABLE[index] = value >>> 0
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let offset = start; offset < end; offset += 1)
    crc = (CRC32_TABLE[(crc ^ (bytes[offset] as number)) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

class BitReader {
  readonly bytes: Uint8Array
  bitOffset = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  read(count: number): number {
    if (count < 0 || count > 24 || this.bitOffset + count > this.bytes.length * 8)
      throw new SafeImageError('FORMAT_INVALID', 'truncated PNG deflate stream')
    let value = 0
    for (let bit = 0; bit < count; bit += 1) {
      const offset = this.bitOffset + bit
      value |= (((this.bytes[offset >>> 3] as number) >>> (offset & 7)) & 1) << bit
    }
    this.bitOffset += count
    return value
  }

  align(): void {
    this.bitOffset = (this.bitOffset + 7) & ~7
  }
}

type Huffman = Readonly<{ byLength: readonly ReadonlyMap<number, number>[]; maxLength: number }>

function reverseBits(value: number, length: number): number {
  let reversed = 0
  for (let bit = 0; bit < length; bit += 1) reversed = (reversed << 1) | ((value >>> bit) & 1)
  return reversed
}

function huffman(
  lengths: readonly number[],
  options: Readonly<{ allowEmpty?: boolean; allowSingleIncomplete?: boolean }> = {},
): Huffman | undefined {
  const counts = new Uint16Array(16)
  let maxLength = 0
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 0 || length > 15)
      throw new SafeImageError('FORMAT_INVALID', 'PNG deflate tree has an invalid code length')
    if (length > 0) {
      counts[length] = (counts[length] as number) + 1
      maxLength = Math.max(maxLength, length)
    }
  }
  if (maxLength === 0) {
    if (options.allowEmpty) return undefined
    throw new SafeImageError('FORMAT_INVALID', 'PNG deflate tree is empty')
  }
  let available = 1
  for (let length = 1; length <= 15; length += 1) {
    available = available * 2 - (counts[length] as number)
    if (available < 0) throw new SafeImageError('FORMAT_INVALID', 'PNG deflate tree is oversubscribed')
  }
  // RFC 1951 permits an incomplete literal/distance alphabet only for the single-symbol,
  // one-bit special case. Code-length alphabets must be complete. Accepting wider incomplete
  // trees creates a parser differential: this guard would accept bytes that zlib and image
  // decoders reject after the same image passed admission.
  if (available > 0 && !(options.allowSingleIncomplete && maxLength === 1 && (counts[1] as number) === 1))
    throw new SafeImageError('FORMAT_INVALID', 'PNG deflate tree is incomplete')
  const next = new Uint16Array(16)
  let code = 0
  for (let length = 1; length <= 15; length += 1) {
    code = (code + (counts[length - 1] as number)) << 1
    next[length] = code
  }
  const byLength: Map<number, number>[] = Array.from({ length: maxLength + 1 }, () => new Map())
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol] as number
    if (length === 0) continue
    const canonical = next[length] as number
    next[length] = canonical + 1
    byLength[length]?.set(reverseBits(canonical, length), symbol)
  }
  return { byLength, maxLength }
}

function decodeSymbol(reader: BitReader, tree: Huffman | undefined): number {
  if (!tree) throw new SafeImageError('FORMAT_INVALID', 'PNG deflate distance tree is missing')
  let code = 0
  for (let length = 1; length <= tree.maxLength; length += 1) {
    code |= reader.read(1) << (length - 1)
    const symbol = tree.byLength[length]?.get(code)
    if (symbol !== undefined) return symbol
  }
  throw new SafeImageError('FORMAT_INVALID', 'PNG deflate stream uses an invalid Huffman code')
}

const FIXED_LITERAL_LENGTHS = Array.from({ length: 288 }, (_, symbol) =>
  symbol <= 143 ? 8 : symbol <= 255 ? 9 : symbol <= 279 ? 7 : 8,
)
const FIXED_DISTANCE_LENGTHS = Array.from({ length: 32 }, () => 5)
const FIXED_LITERAL_TREE = huffman(FIXED_LITERAL_LENGTHS) as Huffman
const FIXED_DISTANCE_TREE = huffman(FIXED_DISTANCE_LENGTHS) as Huffman
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195,
  227, 258,
] as const
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
  6145, 8193, 12289, 16385, 24577,
] as const
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const

function dynamicTrees(reader: BitReader): readonly [Huffman, Huffman | undefined] {
  const literalCount = reader.read(5) + 257
  if (literalCount > 286) throw new SafeImageError('FORMAT_INVALID', 'PNG deflate literal count is reserved')
  const distanceCount = reader.read(5) + 1
  const codeLengthCount = reader.read(4) + 4
  const codeLengths = new Array<number>(19).fill(0)
  for (let index = 0; index < codeLengthCount; index += 1)
    codeLengths[CODE_LENGTH_ORDER[index] as number] = reader.read(3)
  const codeLengthTree = huffman(codeLengths) as Huffman
  const lengths: number[] = []
  while (lengths.length < literalCount + distanceCount) {
    const symbol = decodeSymbol(reader, codeLengthTree)
    if (symbol <= 15) {
      lengths.push(symbol)
      continue
    }
    let repeat: number
    let value: number
    if (symbol === 16) {
      if (lengths.length === 0)
        throw new SafeImageError('FORMAT_INVALID', 'PNG deflate repeats a missing code length')
      repeat = reader.read(2) + 3
      value = lengths[lengths.length - 1] as number
    } else if (symbol === 17) {
      repeat = reader.read(3) + 3
      value = 0
    } else if (symbol === 18) {
      repeat = reader.read(7) + 11
      value = 0
    } else throw new SafeImageError('FORMAT_INVALID', 'PNG deflate code-length symbol is invalid')
    if (lengths.length + repeat > literalCount + distanceCount)
      throw new SafeImageError('FORMAT_INVALID', 'PNG deflate code lengths overflow their trees')
    for (let count = 0; count < repeat; count += 1) lengths.push(value)
  }
  if ((lengths[256] as number) === 0)
    throw new SafeImageError('FORMAT_INVALID', 'PNG deflate literal tree has no end marker')
  return [
    huffman(lengths.slice(0, literalCount), { allowSingleIncomplete: true }) as Huffman,
    huffman(lengths.slice(literalCount), { allowEmpty: true, allowSingleIncomplete: true }),
  ]
}

type InflateSink = Readonly<{
  expected: number
  rowLengths: readonly number[]
  write: (value: number) => void
  finish: () => void
  adler: () => number
  produced: () => number
  prior: (distance: number) => number
}>

function inflateSink(expected: number, rowLengths: readonly number[], maxDistance: number): InflateSink {
  const window = new Uint8Array(32768)
  let output = 0
  let row = 0
  let withinRow = 0
  let adlerA = 1
  let adlerB = 0
  const write = (value: number) => {
    if (output >= expected)
      throw new SafeImageError('PIXEL_LIMIT', 'PNG decompressed data exceeds its scanline bound')
    if (withinRow === 0 && value > 4)
      throw new SafeImageError('FORMAT_INVALID', 'PNG scanline uses an invalid filter')
    window[output & 0x7fff] = value
    output += 1
    withinRow += 1
    adlerA = (adlerA + value) % 65521
    adlerB = (adlerB + adlerA) % 65521
    if (withinRow === rowLengths[row]) {
      row += 1
      withinRow = 0
    }
  }
  return {
    expected,
    rowLengths,
    write,
    finish: () => {
      if (output !== expected || row !== rowLengths.length || withinRow !== 0)
        throw new SafeImageError('FORMAT_INVALID', 'PNG decompressed data does not match its scanlines')
    },
    adler: () => ((adlerB << 16) | adlerA) >>> 0,
    produced: () => output,
    prior: (distance) => {
      if (distance < 1 || distance > Math.min(output, maxDistance))
        throw new SafeImageError('FORMAT_INVALID', 'PNG deflate stream uses an invalid distance')
      return window[(output - distance) & 0x7fff] as number
    },
  }
}

function inflateCodes(
  reader: BitReader,
  literalTree: Huffman,
  distanceTree: Huffman | undefined,
  sink: InflateSink,
) {
  for (;;) {
    const symbol = decodeSymbol(reader, literalTree)
    if (symbol < 256) {
      sink.write(symbol)
      continue
    }
    if (symbol === 256) return
    if (symbol < 257 || symbol > 285)
      throw new SafeImageError('FORMAT_INVALID', 'PNG deflate stream uses an invalid length')
    const lengthIndex = symbol - 257
    const length = (LENGTH_BASE[lengthIndex] as number) + reader.read(LENGTH_EXTRA[lengthIndex] as number)
    const distanceSymbol = decodeSymbol(reader, distanceTree)
    if (distanceSymbol > 29)
      throw new SafeImageError('FORMAT_INVALID', 'PNG deflate stream uses an invalid distance')
    const distance =
      (DISTANCE_BASE[distanceSymbol] as number) + reader.read(DISTANCE_EXTRA[distanceSymbol] as number)
    for (let copied = 0; copied < length; copied += 1) sink.write(sink.prior(distance))
  }
}

function inflateZlib(compressed: Uint8Array, expected: number, rowLengths: readonly number[]): void {
  if (compressed.length < 6) throw new SafeImageError('FORMAT_INVALID', 'PNG zlib stream is truncated')
  const cmf = compressed[0] as number
  const flags = compressed[1] as number
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || ((cmf << 8) | flags) % 31 !== 0 || (flags & 32) !== 0)
    throw new SafeImageError('FORMAT_INVALID', 'PNG zlib header is invalid or unsupported')
  const deflate = compressed.subarray(2, compressed.length - 4)
  const reader = new BitReader(deflate)
  const sink = inflateSink(expected, rowLengths, 1 << ((cmf >>> 4) + 8))
  let final = false
  while (!final) {
    final = reader.read(1) === 1
    const blockType = reader.read(2)
    if (blockType === 0) {
      reader.align()
      const length = reader.read(16)
      const inverse = reader.read(16)
      if ((length ^ 0xffff) !== inverse)
        throw new SafeImageError('FORMAT_INVALID', 'PNG deflate stored block length is invalid')
      for (let index = 0; index < length; index += 1) sink.write(reader.read(8))
    } else if (blockType === 1) inflateCodes(reader, FIXED_LITERAL_TREE, FIXED_DISTANCE_TREE, sink)
    else if (blockType === 2) {
      const [literalTree, distanceTree] = dynamicTrees(reader)
      inflateCodes(reader, literalTree, distanceTree, sink)
    } else throw new SafeImageError('FORMAT_INVALID', 'PNG deflate block type is reserved')
  }
  sink.finish()
  if (Math.ceil(reader.bitOffset / 8) !== deflate.length)
    throw new SafeImageError('FORMAT_INVALID', 'PNG zlib stream has trailing compressed data')
  const expectedAdler = u32(compressed, compressed.length - 4)
  if (sink.adler() !== expectedAdler)
    throw new SafeImageError('FORMAT_INVALID', 'PNG zlib checksum does not match')
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const

function pngScanlines(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
): readonly number[] {
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4
  const bitsPerPixel = channels * bitDepth
  const rows: number[] = []
  const passes: readonly (readonly [number, number, number, number])[] =
    interlace === 0 ? [[0, 0, 1, 1]] : ADAM7
  for (const [xStart, yStart, xStep, yStep] of passes) {
    const passWidth = width <= xStart ? 0 : Math.ceil((width - xStart) / xStep)
    const passHeight = height <= yStart ? 0 : Math.ceil((height - yStart) / yStep)
    if (passWidth === 0 || passHeight === 0) continue
    const rowLength = 1 + Math.ceil((passWidth * bitsPerPixel) / 8)
    if (!Number.isSafeInteger(rowLength) || !Number.isSafeInteger(rowLength * passHeight))
      throw new SafeImageError('PIXEL_LIMIT', 'PNG scanline size is unsafe')
    for (let row = 0; row < passHeight; row += 1) rows.push(rowLength)
  }
  return rows
}

function rejectCompressedAncillary(type: string, data: Uint8Array): void {
  // The contract is one static screenshot. APNG carries additional compressed frames outside IDAT;
  // accepting it while counting only the canvas would bypass both decoded-pixel and bomb limits.
  if (type === 'acTL' || type === 'fcTL' || type === 'fdAT')
    throw new SafeImageError('FORMAT_INVALID', 'animated PNG chunks are not accepted')
  if (type === 'zTXt' || type === 'iCCP')
    throw new SafeImageError('FORMAT_INVALID', 'PNG compressed ancillary chunks are not accepted')
  if (type !== 'iTXt') return
  const keywordEnd = data.indexOf(0)
  if (
    keywordEnd < 1 ||
    keywordEnd > 79 ||
    keywordEnd + 2 >= data.length ||
    (data[keywordEnd + 1] !== 0 && data[keywordEnd + 1] !== 1) ||
    data[keywordEnd + 2] !== 0
  )
    throw new SafeImageError('FORMAT_INVALID', 'PNG iTXt compression fields are invalid')
  if (data[keywordEnd + 1] === 1)
    throw new SafeImageError('FORMAT_INVALID', 'PNG compressed ancillary chunks are not accepted')
}

function pngDimensions(bytes: Uint8Array, maxPixels: number) {
  if (bytes.length < 33 || !PNG_MAGIC.every((value, index) => bytes[index] === value))
    throw new SafeImageError('FORMAT_INVALID', 'invalid PNG signature or header')
  let offset: number = PNG_MAGIC.length
  let size: ReturnType<typeof dimensions> | undefined
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let sawData = false
  let endedData = false
  let sawPalette = false
  const dataChunks: Uint8Array[] = []
  let compressedLength = 0
  for (;;) {
    if (offset + 12 > bytes.length) throw new SafeImageError('FORMAT_INVALID', 'truncated PNG chunk')
    const length = u32(bytes, offset)
    const dataOffset = offset + 8
    const end = dataOffset + length + 4
    if (!Number.isSafeInteger(end) || end > bytes.length)
      throw new SafeImageError('FORMAT_INVALID', 'truncated PNG chunk data')
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    )
    if (!/^[A-Za-z]{4}$/.test(type) || ((bytes[offset + 6] as number) & 0x20) !== 0)
      throw new SafeImageError('FORMAT_INVALID', 'PNG chunk type is invalid')
    if (crc32(bytes, offset + 4, dataOffset + length) !== u32(bytes, dataOffset + length))
      throw new SafeImageError('FORMAT_INVALID', `PNG ${type} CRC does not match`)
    if (!size) {
      if (type !== 'IHDR' || length !== 13)
        throw new SafeImageError('FORMAT_INVALID', 'PNG must begin with a complete IHDR')
      bitDepth = bytes[dataOffset + 8] as number
      colorType = bytes[dataOffset + 9] as number
      interlace = bytes[dataOffset + 12] as number
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth))
      if (!validDepth || bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0 || interlace > 1)
        throw new SafeImageError(
          'FORMAT_INVALID',
          'PNG IHDR uses unsupported compression, filter, or interlace',
        )
      size = dimensions(u32(bytes, dataOffset), u32(bytes, dataOffset + 4), maxPixels)
    } else if (type === 'IHDR')
      throw new SafeImageError('FORMAT_INVALID', 'PNG contains multiple IHDR chunks')
    else if (type === 'PLTE') {
      if (
        sawPalette ||
        sawData ||
        colorType === 0 ||
        colorType === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        (colorType === 3 && length / 3 > 2 ** bitDepth)
      )
        throw new SafeImageError('FORMAT_INVALID', 'PNG palette is misplaced or invalid')
      sawPalette = true
    } else if (type === 'IDAT') {
      if (endedData) throw new SafeImageError('FORMAT_INVALID', 'PNG IDAT chunks must be consecutive')
      sawData = true
      compressedLength += length
      dataChunks.push(bytes.subarray(dataOffset, dataOffset + length))
    } else if (sawData && type !== 'IEND') endedData = true
    rejectCompressedAncillary(type, bytes.subarray(dataOffset, dataOffset + length))
    if (((bytes[offset + 4] as number) & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))
      throw new SafeImageError('FORMAT_INVALID', `PNG critical chunk ${type} is unsupported`)
    if (type === 'IEND') {
      if (length !== 0 || !sawData || end !== bytes.length || (colorType === 3 && !sawPalette))
        throw new SafeImageError('FORMAT_INVALID', 'PNG has an invalid or non-terminal IEND')
      const compressed = new Uint8Array(compressedLength)
      let writeOffset = 0
      for (const chunk of dataChunks) {
        compressed.set(chunk, writeOffset)
        writeOffset += chunk.length
      }
      const rows = pngScanlines(size.width, size.height, bitDepth, colorType, interlace)
      const expected = rows.reduce((sum, rowLength) => sum + rowLength, 0)
      if (!Number.isSafeInteger(expected))
        throw new SafeImageError('PIXEL_LIMIT', 'PNG decompressed scanline size is unsafe')
      inflateZlib(compressed, expected, rows)
      return size
    }
    offset = end
  }
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
}

function jpegDimensions(bytes: Uint8Array, maxPixels: number) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new SafeImageError('FORMAT_INVALID', 'invalid JPEG signature')
  let offset = 2
  let size: ReturnType<typeof dimensions> | undefined
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new SafeImageError('FORMAT_INVALID', 'JPEG marker prefix is missing')
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) throw new SafeImageError('FORMAT_INVALID', 'truncated JPEG marker')
    const marker = bytes[offset++] as number
    if (marker === 0x00)
      throw new SafeImageError('FORMAT_INVALID', 'unexpected stuffed byte outside JPEG scan')
    if (marker === 0xd9) {
      if (!size || !sawScan || offset !== bytes.length)
        throw new SafeImageError('FORMAT_INVALID', 'JPEG ended before image data or has trailing bytes')
      return size
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) throw new SafeImageError('FORMAT_INVALID', 'truncated JPEG segment length')
    const length = u16(bytes, offset)
    if (length < 2 || offset + length > bytes.length)
      throw new SafeImageError('FORMAT_INVALID', 'truncated JPEG segment')
    if (isStartOfFrame(marker)) {
      if (length < 8) throw new SafeImageError('FORMAT_INVALID', 'JPEG frame header is too short')
      const found = dimensions(u16(bytes, offset + 5), u16(bytes, offset + 3), maxPixels)
      if (size && (size.width !== found.width || size.height !== found.height))
        throw new SafeImageError('FORMAT_INVALID', 'JPEG frame dimensions disagree')
      size = found
    }
    offset += length
    if (marker !== 0xda) continue
    if (!size) throw new SafeImageError('FORMAT_INVALID', 'JPEG scan precedes its frame header')
    sawScan = true
    // Entropy-coded data ends at the next unstuffed, non-restart marker. Leave offset at that marker
    // so the ordinary segment loop validates the rest of the file and the terminal EOI.
    for (;;) {
      if (offset >= bytes.length) throw new SafeImageError('FORMAT_INVALID', 'truncated JPEG scan data')
      if (bytes[offset++] !== 0xff) continue
      if (offset >= bytes.length) throw new SafeImageError('FORMAT_INVALID', 'truncated JPEG scan marker')
      const markerOffset = offset - 1
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.length) throw new SafeImageError('FORMAT_INVALID', 'truncated JPEG scan marker')
      const next = bytes[offset] as number
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        offset += 1
        continue
      }
      offset = markerOffset
      break
    }
  }
  throw new SafeImageError('FORMAT_INVALID', 'JPEG is missing EOI')
}

function detectedMime(bytes: Uint8Array): SafeImageMime {
  if (PNG_MAGIC.every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  throw new SafeImageError('FORMAT_INVALID', 'image magic is neither PNG nor JPEG')
}

function inspectSafeImage(bytes: Uint8Array, mimeType: string, limits: SafeImageLimits): SafeImage {
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg')
    throw new SafeImageError('MIME_MISMATCH', 'declared image MIME is unsupported')
  const mime = detectedMime(bytes)
  if (mime !== mimeType)
    throw new SafeImageError('MIME_MISMATCH', 'declared image MIME does not match image magic')
  const size =
    mime === 'image/png'
      ? pngDimensions(bytes, limits.maxPixelsPerImage)
      : jpegDimensions(bytes, limits.maxPixelsPerImage)
  return Object.freeze({ bytes, mime, ...size })
}

export function decodeSafeImageBytes(input: SafeImageBytesInput, limitsInput: SafeImageLimits): SafeImage {
  const limits = checkedLimits(limitsInput)
  if (!(input.bytes instanceof Uint8Array) || !typedArrayByteLength)
    throw new SafeImageError('FORMAT_INVALID', 'image bytes must be a Uint8Array')
  const byteLength = typedArrayByteLength.call(input.bytes) as number
  if (byteLength > limits.maxBytesPerImage)
    throw new SafeImageError('BYTE_LIMIT', 'decoded image exceeds byte limit')
  // Own one stable snapshot before hashing, parsing or encoding. This also prevents a shared buffer or
  // TypedArray subclass from changing different stages of the admission decision independently.
  const bytes = new Uint8Array(byteLength)
  Uint8Array.prototype.set.call(bytes, input.bytes)
  return inspectSafeImage(bytes, input.mimeType, limits)
}

export function decodeSafeImage(input: SafeImageInput, limitsInput: SafeImageLimits): SafeImage {
  const limits = checkedLimits(limitsInput)
  const bytes = decodeBase64(input.data, limits.maxBytesPerImage)
  return inspectSafeImage(bytes, input.mimeType, limits)
}

export function decodeSafeImages(
  inputs: readonly SafeImageInput[],
  limitsInput: SafeImageLimits,
): readonly SafeImage[] {
  const limits = checkedLimits(limitsInput)
  const decoded: SafeImage[] = []
  let bytes = 0
  let pixels = 0
  for (const input of inputs) {
    const remainingBytes = limits.maxAggregateBytes - bytes
    const remainingPixels = limits.maxAggregatePixels - pixels
    if (remainingBytes < 1) throw new SafeImageError('BYTE_LIMIT', 'images exceed aggregate byte limit')
    if (remainingPixels < 1) throw new SafeImageError('PIXEL_LIMIT', 'images exceed aggregate pixel limit')
    const image = decodeSafeImage(input, {
      ...limits,
      maxBytesPerImage: Math.min(limits.maxBytesPerImage, remainingBytes),
      maxPixelsPerImage: Math.min(limits.maxPixelsPerImage, remainingPixels),
    })
    bytes += image.bytes.length
    pixels += image.pixels
    decoded.push(image)
  }
  return Object.freeze(decoded)
}
