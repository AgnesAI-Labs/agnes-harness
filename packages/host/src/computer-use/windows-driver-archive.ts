import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import {
  createPrivateFileSync,
  renameWriteThroughSync,
  windowsEnsurePrivateDirectorySync,
} from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseDriverLock } from './driver-lock.js'
import {
  type VerifiedWindowsComputerUseDriver,
  verifyWindowsComputerUseDriver,
} from './windows-driver-verifier.js'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024
const FILES = Object.freeze([
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
  'cua_driver_sdk.dll',
  'cua-cursor-theme.exe',
  'cua-driver-uia.exe',
  'cua-driver.exe',
])
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

type Entry = Readonly<{
  name: string
  method: number
  crc32: number
  compressedSize: number
  size: number
  localOffset: number
}>

export type ExtractedWindowsComputerUseDriver = Readonly<{
  directory: string
  verified: VerifiedWindowsComputerUseDriver
  release(): Promise<void>
}>

export type ValidatedWindowsDriverArchiveFile = Readonly<{
  name: string
  bytes: Uint8Array
}>

function fail(reason: string): never {
  throw new Error(`Computer Use driver archive ${reason}`)
}

function u16(bytes: Uint8Array, offset: number): number {
  const low = bytes[offset]
  const high = bytes[offset + 1]
  if (low === undefined || high === undefined) fail('contains a truncated integer')
  return low | (high << 8)
}

function u32(bytes: Uint8Array, offset: number): number {
  return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0
}

function findEocd(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1)
    if (u32(bytes, offset) === EOCD && offset + 22 + u16(bytes, offset + 20) === bytes.length) return offset
  return fail('has no canonical end record')
}

function decodeName(bytes: Uint8Array): string {
  try {
    return fatalUtf8.decode(bytes)
  } catch {
    return fail('contains a non-UTF-8 path')
  }
}

function entries(bytes: Uint8Array, prefix: string): readonly Entry[] {
  const eocd = findEocd(bytes)
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) fail('spans multiple disks')
  const count = u16(bytes, eocd + 10)
  if (count !== FILES.length || u16(bytes, eocd + 8) !== count) fail('file count differs from the lock')
  const centralSize = u32(bytes, eocd + 12)
  const centralOffset = u32(bytes, eocd + 16)
  if (centralOffset + centralSize !== eocd) fail('central directory bounds are invalid')
  const expected = new Set(FILES.map((name) => `${prefix}/${name}`))
  const found: Entry[] = []
  let expanded = 0
  let offset = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || u32(bytes, offset) !== CENTRAL) fail('central directory is malformed')
    const flags = u16(bytes, offset + 8)
    const method = u16(bytes, offset + 10)
    const compressedSize = u32(bytes, offset + 20)
    const size = u32(bytes, offset + 24)
    const nameLength = u16(bytes, offset + 28)
    const extraLength = u16(bytes, offset + 30)
    const commentLength = u16(bytes, offset + 32)
    const localOffset = u32(bytes, offset + 42)
    if (flags !== 0 || (method !== 0 && method !== 8)) fail('uses unsupported ZIP features')
    if (extraLength !== 0 || commentLength !== 0) fail('contains unreviewed ZIP metadata')
    const end = offset + 46 + nameLength
    if (end > eocd) fail('central path is truncated')
    const name = decodeName(bytes.subarray(offset + 46, end))
    if (!expected.delete(name)) fail('contains an unexpected or duplicate path')
    expanded += size
    if (expanded > MAX_EXPANDED_BYTES) fail('exceeds the expanded size limit')
    found.push({
      name,
      method,
      crc32: u32(bytes, offset + 16),
      compressedSize,
      size,
      localOffset,
    })
    offset = end
  }
  if (offset !== eocd || expected.size !== 0) fail('central directory does not match the lock')
  return found
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of bytes) {
    const next = CRC_TABLE[(crc ^ value) & 0xff]
    if (next === undefined) fail('CRC table lookup failed')
    crc = next ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function content(archive: Uint8Array, entry: Entry, centralOffset: number): Uint8Array {
  const offset = entry.localOffset
  if (offset + 30 > centralOffset || u32(archive, offset) !== LOCAL) fail('local header is malformed')
  if (u16(archive, offset + 6) !== 0 || u16(archive, offset + 8) !== entry.method)
    fail('local header differs from the central directory')
  const nameLength = u16(archive, offset + 26)
  const extraLength = u16(archive, offset + 28)
  if (extraLength !== 0) fail('local header contains unreviewed metadata')
  const nameEnd = offset + 30 + nameLength
  if (nameEnd > centralOffset || decodeName(archive.subarray(offset + 30, nameEnd)) !== entry.name)
    fail('local path differs from the central directory')
  const dataEnd = nameEnd + entry.compressedSize
  if (dataEnd > centralOffset) fail('compressed data escapes the archive body')
  const compressed = archive.subarray(nameEnd, dataEnd)
  let output: Uint8Array
  try {
    output =
      entry.method === 0
        ? Uint8Array.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.size })
  } catch {
    return fail('contains invalid or oversized deflate data')
  }
  if (output.byteLength !== entry.size || crc32(output) !== entry.crc32)
    fail('file content does not match its ZIP identity')
  return output
}

function selectedArtifact(lock: ComputerUseDriverLock) {
  const runtimeArchitecture = createPlatform().snapshot().arch
  const architecture = runtimeArchitecture === 'x64' ? 'x86_64' : runtimeArchitecture
  return lock.artifacts.find(
    (artifact) => artifact.platform === 'win32' && artifact.architectures.includes(architecture as never),
  )
}

/** Strict in-memory validation. The result is still untrusted until every PE signature is checked. */
export function validateLockedWindowsComputerUseDriverArchive(input: {
  archiveBytes: Uint8Array
  lock: ComputerUseDriverLock
}): readonly ValidatedWindowsDriverArchiveFile[] {
  if (!(input.archiveBytes instanceof Uint8Array)) fail('bytes are required')
  const artifact = selectedArtifact(input.lock)
  if (!artifact) fail('has no locked artifact for this platform')
  const archive = Uint8Array.from(input.archiveBytes)
  if (archive.byteLength !== artifact.size) fail('size differs from the lock')
  if (createHash('sha256').update(archive).digest('hex') !== artifact.sha256)
    fail('digest differs from the lock')
  const version = input.lock.source.tag.slice('cua-driver-rs-v'.length)
  const runtimeArchitecture = createPlatform().snapshot().arch
  const architecture = runtimeArchitecture === 'x64' ? 'x86_64' : runtimeArchitecture
  const prefix = `cua-driver-rs-${version}-windows-${architecture}`
  const parsed = entries(archive, prefix)
  const eocd = findEocd(archive)
  const centralOffset = u32(archive, eocd + 16)
  return Object.freeze(
    parsed.map((entry) =>
      Object.freeze({
        name: entry.name.slice(prefix.length + 1),
        bytes: Uint8Array.from(content(archive, entry, centralOffset)),
      }),
    ),
  )
}

/** Digest-checks, strictly parses and privately extracts the exact locked Windows archive. */
export async function extractLockedWindowsComputerUseDriver(input: {
  archiveBytes: Uint8Array
  stagingParent: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
}): Promise<ExtractedWindowsComputerUseDriver> {
  if (createPlatform().os !== 'win32') fail('extraction is unavailable on this platform')
  if (!isAbsolute(input.stagingParent) || resolve(input.stagingParent) !== input.stagingParent)
    fail('requires a canonical absolute staging parent')
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError')
  const version = input.lock.source.tag.slice('cua-driver-rs-v'.length)
  const parsed = validateLockedWindowsComputerUseDriverArchive({
    archiveBytes: input.archiveBytes,
    lock: input.lock,
  })
  windowsEnsurePrivateDirectorySync(input.stagingParent)
  const staging = join(input.stagingParent, `.cua-${version}-${randomUUID()}.tmp`)
  windowsEnsurePrivateDirectorySync(staging)
  let keep = false
  try {
    for (const entry of parsed) {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError')
      const fd = createPrivateFileSync(join(staging, entry.name))
      try {
        writeFileSync(fd, entry.bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    const verified = await verifyWindowsComputerUseDriver(staging, input.lock)
    keep = true
    let released = false
    return Object.freeze({
      directory: staging,
      verified,
      async release() {
        if (released) return
        released = true
        rmSync(staging, { recursive: true, force: true })
      },
    })
  } finally {
    if (!keep) rmSync(staging, { recursive: true, force: true })
  }
}

/** Atomically moves a verified staging directory into an immutable version directory. */
export function activateExtractedWindowsComputerUseDriver(
  extracted: ExtractedWindowsComputerUseDriver,
  versionDirectory: string,
): void {
  if (!isAbsolute(versionDirectory) || resolve(versionDirectory) !== versionDirectory)
    fail('requires a canonical absolute version directory')
  renameWriteThroughSync(extracted.directory, versionDirectory)
}
