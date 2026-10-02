import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobReadPort, ByteReadStream } from '@agnes/extension-api/runtime'
import { RuntimeClientTransportPolicy } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  type Content,
  ctx,
  grantRead,
  MIB,
  ok,
  openServices,
  owner,
  pattern,
  patternDigest,
  publishRequest,
  refused,
  reserveRequest,
  type Services,
  sha256,
  upload,
} from './fixtures/artifact-world.js'

const SIZE = RuntimeClientTransportPolicy.maxArtifactBytes
const UPLOAD_CHUNK = 8 * MIB
const DECK: Content = {
  uploadId: 'deck-upload',
  bytes: SIZE,
  salt: 0x5e,
  mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  chunkBytes: UPLOAD_CHUNK,
  digest: null,
}

/** Open descriptors of this process, where the platform lists them. */
const openFiles = existsSync('/dev/fd') ? () => readdirSync('/dev/fd').length : null

it('publishes a 1 GiB artifact and serves it in ranges and pull streams of at most 1 MiB', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agh-artifact-capacity-'))
  let services: Services | undefined
  // Chunks the selected blob port has handed out, to show it never reads ahead of the consumer.
  let produced = 0
  const counted = (port: BlobReadPort): BlobReadPort => ({
    readRange: (request, context) => port.readRange(request, context),
    async openRead(request, context) {
      const opened = await port.openRead(request, context)
      if (!opened.ok) return opened
      const inner = opened.value
      async function* chunks() {
        for await (const chunk of inner.chunks) {
          produced += 1
          yield chunk
        }
      }
      const stream: ByteReadStream = { ...inner, chunks: chunks() }
      return { ok: true, value: stream }
    },
  })
  try {
    services = openServices(dataDir, { read: counted })
    const { artifacts, blob } = services
    const access = artifacts.artifactAccess
    const reserved = ok(
      await artifacts.reserve(
        { request: reserveRequest('deck', { title: 'Deck', mediaType: DECK.mediaType }), owner: owner() },
        ctx(),
      ),
    )
    const ref = { artifactId: reserved.artifactId, version: 1 }

    // The artifact limit is exact, and an upload chunk may be at most 8 MiB.
    const stage = (uploadId: string, size: number) =>
      blob.stage({ uploadId, size, mediaType: DECK.mediaType, expectedDigest: null }, ctx())
    expect(refused(await stage('too-large', SIZE + 1))).toBe('artifact_bytes')
    ok(await stage('wide-chunk', 2 * UPLOAD_CHUNK))
    const wide = ok(blob.openWriter('wide-chunk', ctx()))
    expect(refused(wide.write(0, new Uint8Array(UPLOAD_CHUNK + 1)))).toBe('invalid_request')
    wide.close()

    // Generated and hashed one 8 MiB chunk at a time; the test never holds the whole content.
    const peakBefore = process.resourceUsage().maxRSS
    const written = createHash('sha256')
    const source = await upload(blob, DECK, { chunk: (_, bytes) => void written.update(bytes) })
    const digest = written.digest('hex')
    expect(source).toMatchObject({ bytes: SIZE, digest, status: 'sealed' })
    // Seal streams the stored chunks too, so the process peak (in KiB) grows far less than 1 GiB.
    expect((process.resourceUsage().maxRSS - peakBefore) * 1024).toBeLessThan(512 * MIB)
    expect(
      ok(await artifacts.publish({ request: publishRequest('deck', source, 'Deck'), owner: owner() }, ctx())),
    ).toMatchObject({ state: 'ready', blob: { bytes: SIZE, digest } })
    await grantRead(artifacts, ref)
    // No preview limit applies: the whole document is described and readable to its last byte.
    expect(ok(await access.describe(ref, ctx()))).toEqual({
      ...ref,
      title: 'Deck',
      mime: DECK.mediaType,
      size: SIZE,
      status: 'ready',
    })

    const readRange = (offset: number, length: number) => access.readRange({ ...ref, offset, length }, ctx())
    for (const offset of [0, SIZE / 2 + 3, SIZE - MIB]) {
      const range = ok(await readRange(offset, MIB))
      const expected = sha256(pattern(offset, MIB, DECK.salt))
      expect({ ...range, bytes: sha256(range.bytes) }).toEqual({
        bytes: expected,
        offset,
        totalBytes: SIZE,
        digest: expected,
      })
    }
    expect(refused(await readRange(0, MIB + 1))).toBe('range_bytes')
    expect(ok(await readRange(SIZE - 10, MIB)).bytes).toEqual(pattern(SIZE - 10, 10, DECK.salt))

    // The consumer sets the pace: while it holds off after one chunk, nothing more is read and the
    // stream does not end. Draining it then yields every byte in chunks of at most 1 MiB.
    produced = 0
    const full = ok(await access.openStream(ref, ctx()))
    let settled = false
    void full.ended.then(() => {
      settled = true
    })
    const iterator = full.chunks[Symbol.asyncIterator]()
    let next = await iterator.next()
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
    expect({ produced, settled }).toEqual({ produced: 1, settled: false })
    const streamed = createHash('sha256')
    const baseline = process.memoryUsage.rss()
    let peak = baseline
    let consumed = 0
    let total = 0
    let largest = 0
    for (; !next.done; next = await iterator.next()) {
      streamed.update(next.value)
      consumed += 1
      total += next.value.byteLength
      largest = Math.max(largest, next.value.byteLength)
      peak = Math.max(peak, process.memoryUsage.rss())
    }
    expect(streamed.digest('hex')).toBe(digest)
    expect(await full.ended).toEqual({ ok: true, value: { bytes: SIZE, digest } })
    expect({ total, produced }).toEqual({ total: SIZE, produced: consumed })
    expect(largest).toBeLessThanOrEqual(MIB)
    // Loose: a pull stream holds a few chunks, never a sizeable part of the content.
    expect(peak - baseline).toBeLessThan(256 * MIB)

    // Cancelling mid-stream ends it as cancelled and closes the file it was reading.
    const before = openFiles?.()
    produced = 0
    const cancelled = ok(await access.openStream(ref, ctx()))
    const reader = cancelled.chunks[Symbol.asyncIterator]()
    const prefix = createHash('sha256')
    for (let index = 0; index < 3; index++) {
      const chunk = await reader.next()
      if (chunk.done) throw new Error('stream ended early')
      prefix.update(chunk.value)
    }
    if (openFiles && before !== undefined) expect(openFiles()).toBeGreaterThan(before)
    await cancelled.cancel('reader stopped')
    expect(refused(await cancelled.ended)).toBe('cancelled')
    expect((await reader.next()).done).toBe(true)
    expect(produced).toBe(3)
    if (openFiles && before !== undefined) await expect.poll(openFiles).toBe(before)

    // Resuming from the acknowledged offset yields exactly the remaining bytes and their digest.
    const acknowledged = 3 * MIB
    const resumed = ok(await access.openStream({ ...ref, offset: acknowledged }, ctx()))
    const rest = createHash('sha256')
    for await (const chunk of resumed.chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(MIB)
      rest.update(chunk)
      prefix.update(chunk)
    }
    const remaining = patternDigest(acknowledged, SIZE, DECK.salt)
    expect(rest.digest('hex')).toBe(remaining)
    expect(await resumed.ended).toEqual({
      ok: true,
      value: { bytes: SIZE - acknowledged, digest: remaining },
    })
    expect(prefix.digest('hex')).toBe(digest)
  } finally {
    services?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 900_000)
