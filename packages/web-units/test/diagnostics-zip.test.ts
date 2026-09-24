import { crc32, inflateRawSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { buildZip } from '../src/diagnostics-zip.js'

// Minimal reader: start from the EOCD, walk the central directory, read each
// entry's local header and data back out.
function readZip(zip: Uint8Array) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out: {
    name: string
    method: number
    crc: number
    data: Uint8Array
    flags: number
    time: number
    date: number
  }[] = []
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50)
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const time = v.getUint16(p + 12, true)
    const date = v.getUint16(p + 14, true)
    const crc = v.getUint32(p + 16, true)
    const csize = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))
    expect(v.getUint32(local, true)).toBe(0x04034b50)
    // The local header carries the same DOS time/date pair as the central directory.
    expect(v.getUint32(local + 10, true)).toBe(v.getUint32(p + 12, true))
    const lName = v.getUint16(local + 26, true)
    const lExtra = v.getUint16(local + 28, true)
    const start = local + 30 + lName + lExtra
    const raw = zip.subarray(start, start + csize)
    out.push({
      name,
      method,
      crc,
      flags,
      time,
      date,
      data: method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw,
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const text = (s: string) => new TextEncoder().encode(s)

describe('buildZip', () => {
  it('round-trips entries with valid CRC and UTF-8 names', async () => {
    const entries = [
      { path: 'index.html', data: text('<p>hi</p>'.repeat(200)) },
      { path: 'logs/浏览器.json', data: text('{"a":1}') },
    ]
    const files = readZip(await buildZip(entries, new Date(Date.UTC(2026, 8, 24, 1, 2, 4))))
    expect(files.map((f) => f.name)).toEqual(['index.html', 'logs/浏览器.json'])
    for (const [i, f] of files.entries()) {
      expect(f.data).toEqual(entries[i]!.data)
      expect(f.crc).toBe(crc32(entries[i]!.data))
      expect(f.flags & 0x0800).toBe(0x0800)
    }
    expect(files[0]!.method).toBe(8)
  })
  it('stamps entries with the local wall-clock time in DOS format', async () => {
    // Pinned to UTC+8 so a UTC-based encoder cannot pass by coincidence on a UTC machine; 00:30 on
    // Jan 1 local is still Dec 31 of the previous year in UTC, so year, month and day all differ.
    vi.stubEnv('TZ', 'Asia/Shanghai')
    try {
      const [f] = readZip(await buildZip([{ path: 'a', data: text('x') }], new Date(2026, 0, 1, 0, 30, 4)))
      expect(f!.time).toBe((0 << 11) | (30 << 5) | 2)
      expect(f!.date).toBe(((2026 - 1980) << 9) | (1 << 5) | 1)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('stores incompressible data', async () => {
    const random = crypto.getRandomValues(new Uint8Array(4096))
    const [f] = readZip(await buildZip([{ path: 'r.bin', data: random }]))
    expect(f!.method).toBe(0)
    expect(f!.data).toEqual(random)
  })
  it('handles empty entries and an empty archive', async () => {
    expect(readZip(await buildZip([{ path: 'e.txt', data: new Uint8Array() }]))[0]!.data.length).toBe(0)
    expect(readZip(await buildZip([]))).toEqual([])
  })
  it.each(['', '/abs', 'a/../b', 'a\\b', '..'])('rejects unsafe path %j', async (path) => {
    await expect(buildZip([{ path, data: text('x') }])).rejects.toThrow()
  })
  it('rejects duplicate paths', async () => {
    await expect(
      buildZip([
        { path: 'a', data: text('1') },
        { path: 'a', data: text('2') },
      ]),
    ).rejects.toThrow(/duplicate/i)
  })
})
