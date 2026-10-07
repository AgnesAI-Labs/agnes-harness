import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { PackageError } from './errors.js'
import type { ExecFn } from './sources.js'

const MAX_BYTES = 256 * 1024 * 1024
function invalid(): never {
  throw new PackageError(
    'E_DEP_MISSING',
    'Archive is unsafe or unsupported; use agh plugins pack. See docs/guide/packages.md#sharing',
  )
}
function safePath(value: string): string {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '')
  if (
    !path ||
    path.startsWith('/') ||
    /[\\:\u0000-\u001f]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    invalid()
  return path
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Read the central directory first, refusing links, encryption, ZIP64 and oversized payloads. */
function unzip(archive: string, into: string): void {
  const bytes = readFileSync(archive)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i
      break
    }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) invalid()
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16)
  if (count > 10000 || count !== bytes.readUInt16LE(end + 8) || offset + bytes.readUInt32LE(end + 12) !== end)
    invalid()
  let cursor = offset,
    total = 0
  const seen = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid()
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10)
    const compressed = bytes.readUInt32LE(cursor + 20),
      size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30)
    const comment = bytes.readUInt16LE(cursor + 32),
      attrs = bytes.readUInt32LE(cursor + 38)
    const local = bytes.readUInt32LE(cursor + 42)
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      cursor + 46 + nameLength + extra + comment > end ||
      size === 0xffffffff ||
      compressed === 0xffffffff ||
      local === 0xffffffff
    )
      invalid()
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const path = safePath(name),
      directory = name.endsWith('/'),
      mode = (attrs >>> 16) & 0xf000
    if (
      (mode && mode !== 0x8000 && mode !== 0x4000) ||
      (mode === 0x4000 && !directory) ||
      (directory && size) ||
      seen.has(path)
    )
      invalid()
    seen.add(path)
    total += size
    if (total > MAX_BYTES || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) invalid()
    const localName = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    if (
      bytes.subarray(local + 30, local + 30 + localName).toString('utf8') !== name ||
      start + compressed > offset ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 6) !== flags
    )
      invalid()
    const destination = join(into, path)
    if (directory) mkdirSync(destination, { recursive: true })
    else {
      const raw = bytes.subarray(start, start + compressed)
      const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }) : raw
      if (data.length !== size || crc32(data) !== bytes.readUInt32LE(cursor + 16)) invalid()
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, data, { flag: 'wx', mode: 0o644 })
    }
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== end) invalid()
}

/** Supports a package at archive root or inside one enclosing directory, including npm's package/. */
export async function extractPluginArchive(
  archive: string,
  into: string,
  exec: ExecFn,
  signal?: AbortSignal,
): Promise<void> {
  if (statSync(archive).size > MAX_BYTES) invalid()
  const temp = into + '.archive'
  mkdirSync(temp, { recursive: true })
  try {
    if (readFileSync(archive).readUInt32LE(0) === 0x04034b50) unzip(archive, temp)
    else {
      const opts = { cwd: dirname(archive), ...(signal ? { signal } : {}) }
      const names = (await exec('tar', ['-tf', archive], opts)).stdout.split('\n').filter(Boolean)
      if (!names.length || names.length > 10000) invalid()
      for (const name of names) if (name !== './') safePath(name)
      const listing = (await exec('tar', ['-tvf', archive], opts)).stdout.split('\n').filter(Boolean)
      let size = 0
      for (const line of listing) {
        if (line[0] !== '-' && line[0] !== 'd') invalid()
        const fields = line.trim().split(/\s+/)
        // GNU tar has owner/group in one column; bsdtar has separate link/owner/group columns.
        const value = Number(fields[1]?.includes('/') ? fields[2] : fields[4])
        if (!Number.isFinite(value) || value < 0) invalid()
        size += value
      }
      if (size > MAX_BYTES) invalid()
      await exec('tar', ['-xf', archive, '-C', temp, '--no-same-owner', '--no-same-permissions'], opts)
    }
    const entries = readdirSync(temp)
    let root = temp
    if (!entries.includes('package.json')) {
      if (entries.length !== 1 || !statSync(join(temp, entries[0]!)).isDirectory()) invalid()
      root = join(temp, entries[0]!)
    }
    if (!statSync(join(root, 'package.json')).isFile()) invalid()
    renameSync(root, into)
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof PackageError) throw error
    invalid()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
