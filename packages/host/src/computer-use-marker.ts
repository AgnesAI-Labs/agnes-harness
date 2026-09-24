import { constants, lstatSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { windowsEnsurePrivateDirectorySync, windowsReadPrivateFileSync } from '@agnes/system-node'
import { createPlatform } from './adapters/platform.js'

const SHA256 = /^[0-9a-f]{64}$/u
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const MAX_MARKER_BYTES = 4096
export const MAX_COMPUTER_USE_ARTIFACT_BYTES = 4 * 1024 * 1024

/**
 * The per-digest classification marker of a Computer Use screenshot. Version 2 is the tombstone
 * retention writes before it deletes referenced bytes: bytes gone plus a valid v2 marker means the
 * screenshot was reclaimed on purpose, not lost.
 */
export type ComputerUseMarker = Readonly<{
  schemaVersion: 1 | 2
  sha256: string
  size: number
  createdAtMs: number
  collectedAtMs?: number
}>

/** Whether anything sits at `path`; errors other than a missing entry are thrown. */
export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function computerUseMarkerPath(dataDir: string, sha256: string): string {
  return join(dataDir, 'artifacts', 'computer-use-meta', sha256.slice(0, 2), `${sha256}.json`)
}

export function serializeComputerUseTombstone(
  value: Readonly<{ sha256: string; size: number; createdAtMs: number; collectedAtMs: number }>,
): Uint8Array {
  const { sha256, size, createdAtMs, collectedAtMs } = value
  return new TextEncoder().encode(
    `${JSON.stringify({ schemaVersion: 2, sha256, size, createdAtMs, collectedAtMs }, null, 2)}\n`,
  )
}

const count = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum

/** Parses a marker's exact text for `sha256`; anything else throws. A v2 marker has one key order. */
export function parseComputerUseMarker(bytes: Uint8Array, sha256: string): ComputerUseMarker {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(text) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Computer Use artifact GC metadata is invalid')
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  const v1 = row.schemaVersion === 1 && keys.length === 4
  const v2 = row.schemaVersion === 2 && keys.length === 5 && count(row.collectedAtMs, 0)
  if (
    !(v1 || v2) ||
    !['createdAtMs', 'schemaVersion', 'sha256', 'size'].every((key) => Object.hasOwn(row, key)) ||
    row.sha256 !== sha256 ||
    !SHA256.test(sha256) ||
    !count(row.size, 1, MAX_COMPUTER_USE_ARTIFACT_BYTES) ||
    !count(row.createdAtMs, 0)
  )
    throw new Error('Computer Use artifact GC metadata is invalid')
  const canonical = v2
    ? serializeComputerUseTombstone(row as never)
    : new TextEncoder().encode(`${JSON.stringify(row, null, 2)}\n`)
  if (new TextDecoder().decode(canonical) !== text)
    throw new Error('Computer Use artifact GC metadata identity is inconsistent')
  return Object.freeze({ ...(row as unknown as ComputerUseMarker) })
}

export function validatePrivateMarkerDirectory(path: string): void {
  const platform = createPlatform().os
  if (platform === 'win32') {
    windowsEnsurePrivateDirectorySync(path)
    return
  }
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error('Computer Use artifact GC metadata authority is unavailable on this platform')
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('Computer Use artifact GC metadata directory is not private')
}

export async function readPrivateMarker(path: string): Promise<Uint8Array> {
  if (createPlatform().os === 'win32') return windowsReadPrivateFileSync(path, MAX_MARKER_BYTES)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > MAX_MARKER_BYTES
    )
      throw new Error('Computer Use artifact GC metadata file is not private')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** A valid tombstone for `sha256`, or undefined when there is none or it cannot be trusted. */
export async function readComputerUseTombstone(
  dataDir: string,
  sha256: string,
): Promise<ComputerUseMarker | undefined> {
  try {
    if (!SHA256.test(sha256)) return undefined
    const path = computerUseMarkerPath(dataDir, sha256)
    // Checked first so a read never creates or re-protects marker directories.
    if (!pathEntryExists(path)) return undefined
    validatePrivateMarkerDirectory(join(dataDir, 'artifacts', 'computer-use-meta'))
    validatePrivateMarkerDirectory(join(dataDir, 'artifacts', 'computer-use-meta', sha256.slice(0, 2)))
    const marker = parseComputerUseMarker(await readPrivateMarker(path), sha256)
    return marker.schemaVersion === 2 ? marker : undefined
  } catch {
    return undefined
  }
}

/** The temporary names a private marker write uses (POSIX and Windows) before its rename. */
export function isMarkerWriteTemporary(name: string, shard: string): boolean {
  return (
    new RegExp(`^\\.${UUID}\\.tmp$`, 'u').test(name) ||
    new RegExp(`^${shard}[0-9a-f]{62}\\.json\\.${UUID}\\.tmp$`, 'u').test(name)
  )
}

/**
 * Removes a temporary a crashed marker write left behind. Callers hold the screenshot mutation
 * lock, which every marker writer also holds, so no write can be in flight for it.
 */
export function removeMarkerWriteTemporary(path: string): void {
  const stat = lstatSync(path)
  const posix = createPlatform().os !== 'win32'
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (posix && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600))
  )
    throw new Error('Computer Use artifact GC metadata tree contains an unsafe temporary entry')
  rmSync(path)
}
