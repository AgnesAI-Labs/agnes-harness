import { crc32, deflateSync } from 'node:zlib'

/** PDFium renders opaque RGBA. Encode an ordinary RGB PNG with bounded scanline allocation. */
export function pagePng({ width, height, data }) {
  const chunk = (type, bytes) => {
    const out = Buffer.alloc(bytes.length + 12)
    out.writeUInt32BE(bytes.length)
    out.write(type, 4, 'ascii')
    out.set(bytes, 8)
    out.writeUInt32BE(crc32(out.subarray(4, bytes.length + 8)), bytes.length + 8)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2 // RGB, no alpha: pages are rendered against white.
  const stride = width * 3 + 1
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4
      const target = y * stride + 1 + x * 3
      rows[target] = data[source]
      rows[target + 1] = data[source + 1]
      rows[target + 2] = data[source + 2]
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
