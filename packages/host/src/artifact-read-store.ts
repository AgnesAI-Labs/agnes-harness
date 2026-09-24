import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { types as utilTypes } from 'node:util'
import type { ArtifactRef } from '@agnes/protocol'
import { readComputerUseTombstone } from './computer-use-marker.js'

const HASH = /^[0-9a-f]{64}$/u
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u
/** Internal media reads may be larger than the public 1 MiB JSON-RPC response envelope. */
export const LOCAL_ARTIFACT_READ_MAX_BYTES = 4 * 1024 * 1024

export type LocalArtifactReadStore = Readonly<{
  get(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array>
  inspect(identity: Readonly<{ sha256: string; mime: string }>, signal: AbortSignal): Promise<ArtifactRef>
}>

function fixedFailure(): Error {
  return new Error('artifact bytes unavailable')
}

/**
 * Thrown by `get` for a Computer Use screenshot that retention reclaimed on purpose. Its message is
 * the ordinary failure's; callers that already authorized the read tell it apart by identity.
 */
export const ARTIFACT_RECLAIMED_FAILURE: Error = Object.freeze(new Error('artifact bytes unavailable'))

async function missingOrReclaimed(
  path: string,
  dataDir: string,
  sha256: string,
): Promise<{ kind: 'present'; stat: Stats } | { kind: 'reclaimed'; size: number }> {
  try {
    return { kind: 'present', stat: await lstat(path) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const tombstone = await readComputerUseTombstone(dataDir, sha256)
    if (!tombstone) throw error
    return { kind: 'reclaimed', size: tombstone.size }
  }
}

function snapshotRef(value: unknown, maximum: number): ArtifactRef | undefined {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Reflect.ownKeys(descriptors).length !== 3 ||
      !['sha256', 'size', 'mime'].every(
        (key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key] ?? {}, 'value'),
      )
    )
      return undefined
    const sha256 = descriptors.sha256?.value as unknown
    const size = descriptors.size?.value as unknown
    const mime = descriptors.mime?.value as unknown
    if (
      typeof sha256 !== 'string' ||
      !HASH.test(sha256) ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      (size as number) > maximum ||
      typeof mime !== 'string' ||
      !MIME.test(mime)
    )
      return undefined
    return Object.freeze({ sha256, size: size as number, mime })
  } catch {
    return undefined
  }
}

/**
 * Read-only production adapter for Base's content-addressed artifact layout. It never accepts a
 * path from the caller, refuses a final symlink entry, binds reads to the same opened file identity,
 * and rechecks the complete content identity before returning bytes.
 */
export function createLocalArtifactReadStore(
  input: Readonly<{
    dataDir: string
    maxArtifactBytes: number
  }>,
): LocalArtifactReadStore {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    utilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw fixedFailure()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(descriptors).length !== 2 ||
    !['dataDir', 'maxArtifactBytes'].every(
      (key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key] ?? {}, 'value'),
    )
  )
    throw fixedFailure()
  const rawDataDir = descriptors.dataDir?.value as unknown
  const maximum = descriptors.maxArtifactBytes?.value as unknown
  if (
    typeof rawDataDir !== 'string' ||
    rawDataDir.length === 0 ||
    rawDataDir.includes('\u0000') ||
    !isAbsolute(rawDataDir) ||
    !Number.isSafeInteger(maximum) ||
    (maximum as number) < 0 ||
    (maximum as number) > LOCAL_ARTIFACT_READ_MAX_BYTES
  )
    throw fixedFailure()
  const artifactRoot = resolve(rawDataDir, 'artifacts', 'sha256')
  const maxArtifactBytes = maximum as number
  return Object.freeze({
    async inspect(value: Readonly<{ sha256: string; mime: string }>, signal: AbortSignal) {
      try {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          utilTypes.isProxy(value) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        )
          throw fixedFailure()
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (
          Reflect.ownKeys(descriptors).length !== 2 ||
          !['sha256', 'mime'].every(
            (key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key] ?? {}, 'value'),
          )
        )
          throw fixedFailure()
        const sha256 = descriptors.sha256?.value as unknown
        const mime = descriptors.mime?.value as unknown
        if (typeof sha256 !== 'string' || !HASH.test(sha256) || typeof mime !== 'string' || !MIME.test(mime))
          throw fixedFailure()
        if (!signal || utilTypes.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype)
          throw fixedFailure()
        const path = join(artifactRoot, sha256.slice(0, 2), sha256)
        const reclaimed = async (size?: number) => {
          const known = size ?? (await readComputerUseTombstone(rawDataDir, sha256))?.size
          if (known === undefined || known > maxArtifactBytes || signal.aborted) throw fixedFailure()
          return Object.freeze({ sha256, size: known, mime })
        }
        const found = await missingOrReclaimed(path, rawDataDir, sha256)
        if (found.kind === 'reclaimed') return await reclaimed(found.size)
        const before = found.stat
        if (!before.isFile() || before.size > maxArtifactBytes) throw fixedFailure()
        const ref = Object.freeze({ sha256, size: before.size, mime })
        try {
          await this.get(ref, signal)
        } catch (error) {
          // A collector may reclaim the bytes after they were seen above.
          if (error === ARTIFACT_RECLAIMED_FAILURE) return await reclaimed()
          throw error
        }
        return ref
      } catch {
        throw fixedFailure()
      }
    },
    async get(value: ArtifactRef, signal: AbortSignal): Promise<Uint8Array> {
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        const ref = snapshotRef(value, maxArtifactBytes)
        if (
          !ref ||
          !signal ||
          typeof signal !== 'object' ||
          utilTypes.isProxy(signal) ||
          Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
          signal.aborted
        )
          throw fixedFailure()
        const path = join(artifactRoot, ref.sha256.slice(0, 2), ref.sha256)
        const found = await missingOrReclaimed(path, rawDataDir, ref.sha256)
        if (found.kind === 'reclaimed') throw ARTIFACT_RECLAIMED_FAILURE
        const before = found.stat
        if (!before.isFile()) throw fixedFailure()
        try {
          handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        } catch (error) {
          // Unlinked since the lstat above: reclaimed if a collector left its tombstone.
          if ((await missingOrReclaimed(path, rawDataDir, ref.sha256)).kind === 'reclaimed')
            throw ARTIFACT_RECLAIMED_FAILURE
          throw error
        }
        if (signal.aborted) throw fixedFailure()
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== ref.size ||
          stat.size > maxArtifactBytes
        )
          throw fixedFailure()
        const bytes = await handle.readFile({ signal })
        if (
          signal.aborted ||
          bytes.byteLength !== ref.size ||
          createHash('sha256').update(bytes).digest('hex') !== ref.sha256
        )
          throw fixedFailure()
        return new Uint8Array(bytes)
      } catch (error) {
        if (error === ARTIFACT_RECLAIMED_FAILURE) throw error
        throw fixedFailure()
      } finally {
        await handle?.close().catch(() => undefined)
      }
    },
  })
}
