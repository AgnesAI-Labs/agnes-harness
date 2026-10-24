import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { link, lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createPlatform } from '@agnes/host'
import type { ArtifactReadResult, ArtifactRef, EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

const FORMAT = 'agnes-native/v1'
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Original = { lane: string; ref: ArtifactRef }
type Manifest = {
  format: typeof FORMAT
  lastSeq: number
  size: number
  sha256: string
  originals: Original[]
}

/** References remain scoped to their ledger lane; one lane cannot authorize another's bytes. */
export function bundleOriginals(events: readonly { lane?: string; data: unknown }[]): Original[] {
  const found = new Map<string, Original>()
  const uris = new Set<string>()
  const walk = (value: unknown, lane: string, depth = 0): void => {
    if (depth > 32) throw new Error('native bundle reference nesting exceeds limit')
    if (typeof value === 'string' && /^artifact:\/\/[a-f0-9]{64}$/.test(value))
      uris.add(`${lane}\0${value.slice(11)}`)
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, lane, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    if (typeof record.sha256 === 'string' && record.size !== undefined && record.mime !== undefined) {
      if (
        !/^[a-f0-9]{64}$/.test(record.sha256) ||
        !Number.isSafeInteger(record.size) ||
        (record.size as number) < 0 ||
        (record.size as number) > MAX_ARTIFACT_BYTES ||
        typeof record.mime !== 'string' ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(record.mime)
      )
        throw new Error('native bundle artifact identity is invalid')
      const ref = { sha256: record.sha256, size: record.size as number, mime: record.mime }
      const key = `${lane}\0${ref.sha256}\0${ref.mime}`
      const previous = found.get(key)
      if (previous && JSON.stringify(previous.ref) !== JSON.stringify(ref))
        throw new Error('conflicting artifact identity')
      found.set(key, { lane, ref })
    }
    for (const child of Object.values(record)) walk(child, lane, depth + 1)
  }
  for (const event of events) walk(event.data, event.lane ?? 'main')
  for (const digest of uris)
    if (![...found.values()].some(({ lane, ref }) => `${lane}\0${ref.sha256}` === digest))
      throw new Error('native bundle artifact locator has no complete original identity')
  if ([...found.values()].reduce((size, { ref }) => size + ref.size, 0) > MAX_BUNDLE_BYTES)
    throw new Error('native bundle originals exceed size limit')
  return [...found.values()]
}

async function originalBytes(client: Client, sessionId: string, original: Original): Promise<Uint8Array> {
  const { lane: laneId, ref: artifact } = original
  const chunks: Buffer[] = []
  for (let offset = 0; offset < Math.max(1, artifact.size); offset += 1024 * 1024) {
    const end = Math.min(artifact.size, offset + 1024 * 1024) - 1
    const result = await client.call<ArtifactReadResult>('_agnes/v1/artifact.read', {
      sessionId,
      laneId,
      artifact,
      ...(artifact.size ? { range: `bytes=${offset}-${end}` } : {}),
    })
    if (!result.ok) throw new Error(`native bundle original unavailable: ${result.code}`)
    const chunk = Buffer.from(result.base64, 'base64')
    if (
      result.artifact.sha256 !== artifact.sha256 ||
      result.artifact.size !== artifact.size ||
      result.artifact.mime !== artifact.mime ||
      chunk.length !== (artifact.size ? end - offset + 1 : 0) ||
      result.contentLength !== chunk.length ||
      (artifact.size &&
        (result.status !== 206 || result.contentRange !== `bytes ${offset}-${end}/${artifact.size}`))
    )
      throw new Error('native bundle original range identity mismatch')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256)
    throw new Error('native bundle original digest mismatch')
  return bytes
}

async function privateWrite(path: string, bytes: Uint8Array): Promise<void> {
  const fd = createPrivateFileSync(path)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncDirectory(path: string): void {
  if (createPlatform().os === 'win32') return
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Publish the manifest last. A failed export cannot leave a file that looks like a complete bundle. */
export async function writeNativeBundle(
  path: string,
  events: EventEnvelope[],
  raw: Uint8Array,
  client: Client,
  sessionId: string,
): Promise<void> {
  const originals = bundleOriginals(events)
  const stage = join(dirname(path), `.agnes-export-${randomUUID()}`)
  const sidecar = `${path}.artifacts`
  let published = false
  let manifestPublished = false
  createPrivateDirectorySync(stage)
  try {
    const written = new Set<string>()
    for (const original of originals) {
      // Every lane's declaration is authorized even when two lanes refer to identical bytes.
      const bytes = await originalBytes(client, sessionId, original)
      if (!written.has(original.ref.sha256)) await privateWrite(join(stage, original.ref.sha256), bytes)
      written.add(original.ref.sha256)
    }
    const manifest: Manifest = {
      format: FORMAT,
      lastSeq: events.at(-1)?.seq ?? 0,
      size: raw.length,
      sha256: hash(raw),
      originals,
    }
    const header = Buffer.from(`${JSON.stringify(manifest)}\n`)
    if (header.length > 1024 * 1024) throw new Error('native bundle manifest exceeds size limit')
    const bytes = Buffer.concat([header, raw])
    // Exclusive publication avoids replacing either half of an existing bundle.
    await privateWrite(join(stage, 'manifest'), bytes)
    createPrivateDirectorySync(sidecar)
    published = true
    for (const digest of written) await rename(join(stage, digest), join(sidecar, digest))
    syncDirectory(sidecar)
    await link(join(stage, 'manifest'), path)
    manifestPublished = true
    syncDirectory(dirname(path))
  } catch (error) {
    if (manifestPublished) await rm(path, { force: true })
    if (published) await rm(sidecar, { recursive: true, force: true })
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

/** Verify the whole bundle, including all declared originals, before the importer reserves a target. */
export async function readNativeBundle(
  path: string,
  bytes: Uint8Array,
): Promise<
  { raw: Uint8Array; readOriginal(ref: ArtifactRef): Promise<Uint8Array>; manifest: Manifest } | undefined
> {
  const firstLine = bytes.indexOf(10)
  if (firstLine < 0 || firstLine > 1024 * 1024) return undefined
  let header: unknown
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, firstLine)))
  } catch {
    return undefined
  }
  if ((header as { format?: unknown } | null)?.format !== FORMAT) return undefined
  const manifest = header as Manifest
  const raw = bytes.subarray(firstLine + 1)
  if (
    !Number.isSafeInteger(manifest.lastSeq) ||
    manifest.lastSeq < 1 ||
    raw.length !== manifest.size ||
    hash(raw) !== manifest.sha256 ||
    !Array.isArray(manifest.originals)
  )
    throw new Error('native bundle manifest integrity mismatch')
  const expected = bundleOriginals(manifest.originals.map(({ lane, ref }) => ({ lane, data: ref })))
  if (JSON.stringify(expected) !== JSON.stringify(manifest.originals))
    throw new Error('native bundle original declarations are invalid')
  const sidecar = resolve(`${path}.artifacts`)
  const directory = await lstat(sidecar)
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('native bundle sidecar is not a directory')
  const readOriginal = async (ref: ArtifactRef): Promise<Uint8Array> => {
    if (
      !expected.some(
        (original) =>
          original.ref.sha256 === ref.sha256 &&
          original.ref.size === ref.size &&
          original.ref.mime === ref.mime,
      )
    )
      throw new Error('native bundle original was not declared')
    const target = join(sidecar, ref.sha256)
    const before = await lstat(target)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== ref.size)
      throw new Error('native bundle original file identity mismatch')
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.ino !== stat.ino ||
        before.dev !== stat.dev ||
        stat.size !== ref.size
      )
        throw new Error('native bundle original file identity mismatch')
      const original = await file.readFile()
      if (original.length !== ref.size || hash(original) !== ref.sha256)
        throw new Error('native bundle original digest mismatch')
      return original
    } finally {
      await file.close()
    }
  }
  for (const { ref } of expected) await readOriginal(ref)
  return { raw, readOriginal, manifest }
}
