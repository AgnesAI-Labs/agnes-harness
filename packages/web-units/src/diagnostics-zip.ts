/**
 * A minimal, dependency-free ZIP writer that runs in the browser (and in
 * tests, under Node). No ZIP64: the diagnostics export this backs stays well
 * under the 4 GiB limit by construction (see spec §5).
 */
export type ZipEntry = { path: string; data: Uint8Array }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // Blob's typings want a plain ArrayBuffer, not the wider ArrayBufferLike a
  // Uint8Array view carries; slice() copies out exactly the bytes we need.
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function checkPath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((s) => s === '..' || s === '')
  )
    throw new Error(`unsafe zip path: ${JSON.stringify(path)}`)
}

// DOS timestamps carry no zone; unzip tools read them as local wall-clock time.
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22
const FLAG_UTF8_NAME = 0x0800
const VERSION = 20

type CentralRecord = {
  name: Uint8Array
  method: number
  time: number
  date: number
  crc: number
  csize: number
  usize: number
  offset: number
}

/** Builds a ZIP archive in memory. Each entry is deflated; entries that don't shrink are stored. */
export async function buildZip(entries: readonly ZipEntry[], now = new Date()): Promise<Uint8Array> {
  const seen = new Set<string>()
  for (const entry of entries) {
    checkPath(entry.path)
    if (seen.has(entry.path)) throw new Error(`duplicate zip path: ${JSON.stringify(entry.path)}`)
    seen.add(entry.path)
  }

  const { time, date } = dosTime(now)
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: CentralRecord[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const compressed = await deflateRaw(entry.data)
    const store = compressed.length >= entry.data.length
    const method = store ? 0 : 8
    const payload = store ? entry.data : compressed
    const crc = crc32(entry.data)

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_SIZE))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, VERSION, true)
    local.setUint16(6, FLAG_UTF8_NAME, true)
    local.setUint16(8, method, true)
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, payload.length, true)
    local.setUint32(22, entry.data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)

    central.push({ name, method, time, date, crc, csize: payload.length, usize: entry.data.length, offset })
    chunks.push(new Uint8Array(local.buffer), name, payload)
    offset += LOCAL_HEADER_SIZE + name.length + payload.length
  }

  const cdOffset = offset
  for (const record of central) {
    const header = new DataView(new ArrayBuffer(CENTRAL_HEADER_SIZE))
    header.setUint32(0, 0x02014b50, true)
    header.setUint16(4, VERSION, true)
    header.setUint16(6, VERSION, true)
    header.setUint16(8, FLAG_UTF8_NAME, true)
    header.setUint16(10, record.method, true)
    header.setUint16(12, record.time, true)
    header.setUint16(14, record.date, true)
    header.setUint32(16, record.crc, true)
    header.setUint32(20, record.csize, true)
    header.setUint32(24, record.usize, true)
    header.setUint16(28, record.name.length, true)
    header.setUint16(30, 0, true)
    header.setUint16(32, 0, true)
    header.setUint16(34, 0, true)
    header.setUint16(36, 0, true)
    header.setUint32(38, 0, true)
    header.setUint32(42, record.offset, true)
    chunks.push(new Uint8Array(header.buffer), record.name)
    offset += CENTRAL_HEADER_SIZE + record.name.length
  }
  const cdSize = offset - cdOffset

  const eocd = new DataView(new ArrayBuffer(EOCD_SIZE))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, central.length, true)
  eocd.setUint16(10, central.length, true)
  eocd.setUint32(12, cdSize, true)
  eocd.setUint32(16, cdOffset, true)
  eocd.setUint16(20, 0, true)
  chunks.push(new Uint8Array(eocd.buffer))

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  return out
}
