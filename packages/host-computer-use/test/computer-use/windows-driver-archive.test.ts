import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import lockValue from '../../src/computer-use/computer-use-driver-lock.json' with { type: 'json' }
import {
  type ComputerUseDriverLock,
  inspectComputerUseDriverLock,
} from '../../src/computer-use/driver-lock.js'
import { validateLockedWindowsComputerUseDriverArchive } from '../../src/computer-use/windows-driver-archive.js'

const expectedFiles = [
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
  'cua_driver_sdk.dll',
  'cua-cursor-theme.exe',
  'cua-driver-uia.exe',
  'cua-driver.exe',
]
const inspected = inspectComputerUseDriverLock(lockValue)
if (!inspected.ok) throw new Error('fixture lock is invalid')
const baseLock = inspected.lock

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of bytes) crc = (crcTable[(crc ^ value) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zip(names: readonly string[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const name of names) {
    const nameBytes = Buffer.from(name)
    const body = Buffer.from(`body:${name}`)
    const crc = crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(body.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(localOffset, 42)
    central.push(entry, nameBytes)
    localOffset += local.length + nameBytes.length + body.length
  }
  const localBytes = Buffer.concat(locals)
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localBytes.length, 16)
  return Buffer.concat([localBytes, centralBytes, end])
}

function fixture(names = expectedFiles): { bytes: Buffer; lock: ComputerUseDriverLock } {
  const architecture = process.arch === 'x64' ? 'x86_64' : process.arch
  const prefix = `cua-driver-rs-0.28.1-windows-${architecture}`
  const bytes = zip(names.map((name) => `${prefix}/${name}`))
  const lock = structuredClone(baseLock) as ComputerUseDriverLock
  const artifact = lock.artifacts.find(
    (candidate) => candidate.platform === 'win32' && candidate.architectures.includes(architecture as never),
  ) as { size: number; sha256: string } | undefined
  if (!artifact) throw new Error('fixture lock has no current Windows artifact')
  artifact.size = bytes.length
  artifact.sha256 = createHash('sha256').update(bytes).digest('hex')
  return { bytes, lock }
}

describe('locked Windows Computer Use ZIP validation', () => {
  it('accepts only the six exact release paths and verifies every CRC', () => {
    const value = fixture()
    const files = validateLockedWindowsComputerUseDriverArchive({
      archiveBytes: value.bytes,
      lock: value.lock,
    })
    expect(files.map((file) => file.name)).toEqual(expectedFiles)
    expect(Buffer.from(files[0]?.bytes ?? []).toString()).toContain('cua_driver_abi.h')
  })

  it('rejects extra and path-traversing entries even when the archive digest is relocked', () => {
    const extra = fixture([...expectedFiles, 'payload.dll'])
    expect(() =>
      validateLockedWindowsComputerUseDriverArchive({ archiveBytes: extra.bytes, lock: extra.lock }),
    ).toThrow('file count differs')

    const traversal = fixture([...expectedFiles.slice(0, -1), '../cua-driver.exe'])
    expect(() =>
      validateLockedWindowsComputerUseDriverArchive({
        archiveBytes: traversal.bytes,
        lock: traversal.lock,
      }),
    ).toThrow('unexpected or duplicate path')
  })

  it('rejects a digest mismatch before ZIP parsing', () => {
    const value = fixture()
    value.bytes[0] = (value.bytes[0] ?? 0) ^ 1
    expect(() =>
      validateLockedWindowsComputerUseDriverArchive({
        archiveBytes: value.bytes,
        lock: value.lock,
      }),
    ).toThrow('digest differs')
  })
})
