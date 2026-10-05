import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeArtifactPolicy } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import type { BlobService } from '../../src/runtime/providers/blob.js'
import {
  type Child,
  PUBLICATION_CONTENT as CONTENT,
  ctx,
  grantRead,
  MIB,
  ok,
  openServices,
  owner,
  PUBLICATION,
  pattern,
  publishRequest,
  refused,
  reserveRequest,
  SCOPE,
  startChild,
} from './fixtures/artifact-world.js'

const dirs: string[] = []
const children: Child[] = []
afterEach(async () => {
  for (const child of children.splice(0)) await child.kill()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function start(dataDir: string, pauseAt?: string): Child {
  const child = startChild('./publication-child.ts', pauseAt === undefined ? [dataDir] : [dataDir, pauseAt])
  children.push(child)
  return child
}

function reported<T>(child: Child, event: string): T | undefined {
  return child.events.find((item) => item.event === event)?.data as T | undefined
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`)
  return value
}

const collectable = async (blob: BlobService) =>
  ok(await blob.gc({ scopeRef: SCOPE, limit: 100, cursor: null, dryRun: true }, ctx())).eligibleRefs.map(
    (ref) => ref.kind,
  )

const readyEvent = (reservation: Wire.ArtifactReservation) => ({
  eventKey: `${PUBLICATION}:ready`,
  kind: 'ready',
  reservation,
})

/**
 * Each point is where the first process is killed, with what a fresh process must then see: the
 * publication state, the upload state and its acknowledged bytes, and which records a dry-run cleanup
 * could collect. With `pause`, the publication process is killed there and a blob process resumes its
 * upload and is killed inside the commit the point names.
 */
const POINTS: {
  point: string
  pause?: string
  state: Wire.ArtifactReservation['state']
  upload: ['uploading' | 'sealed', number] | null
  collectable: string[]
}[] = [
  { point: 'reserved', state: 'reserved', upload: null, collectable: [] },
  // An expired, writer-less upload reservation holds nothing and is only a cleanup candidate.
  { point: 'uploading', state: 'reserved', upload: ['uploading', MIB], collectable: ['upload'] },
  // Every byte was acknowledged and the content written, but the seal never committed.
  {
    point: 'seal',
    pause: 'uploading',
    state: 'reserved',
    upload: ['uploading', CONTENT.bytes],
    collectable: ['upload'],
  },
  { point: 'pending-publish', state: 'pending-publish', upload: ['sealed', CONTENT.bytes], collectable: [] },
  { point: 'promoted', state: 'pending-publish', upload: ['sealed', CONTENT.bytes], collectable: [] },
  { point: 'pinned', state: 'pending-publish', upload: ['sealed', CONTENT.bytes], collectable: [] },
  // Killed after the ready record was written but before its event and the commit.
  {
    point: 'ready-transaction',
    state: 'pending-publish',
    upload: ['sealed', CONTENT.bytes],
    collectable: [],
  },
  { point: 'ready', state: 'ready', upload: ['sealed', CONTENT.bytes], collectable: [] },
]

describe('artifact publication recovery across a killed process', () => {
  it.each(POINTS)(
    'converges on one ready publication after a kill at $point',
    async ({ point, pause, state, upload, collectable: expected }) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'agh-publication-'))
      dirs.push(dataDir)
      const first = start(dataDir, pause ?? point)
      const paused = await first.until('paused', pause ?? point)
      await first.kill()
      if (pause !== undefined) {
        const halted = startChild('./blob-backend-child.ts', [
          'default',
          dataDir,
          'write',
          JSON.stringify(CONTENT),
          point,
        ])
        children.push(halted)
        await halted.until('paused', point)
        await halted.kill()
      }
      const reserved = need(reported<Wire.ArtifactReservation>(first, 'reserved'), 'reservation')
      const artifactRef = { artifactId: reserved.artifactId, version: 1 }

      // A fresh process sees what committed before the kill and nothing after it. Its clock is past
      // the upload reservation TTL.
      const later = Date.now() + RuntimeArtifactPolicy.uploadReservationTtlMs + 60_000
      const seen = openServices(dataDir, { now: () => later })
      try {
        const record = ok(
          await seen.artifacts.reserve({ request: reserveRequest(PUBLICATION), owner: owner() }, ctx()),
        )
        expect(record).toMatchObject({ publicationId: PUBLICATION, ...artifactRef, state })
        // Ready and its event commit together: both are visible or neither is.
        expect(seen.artifacts.pendingEvents()).toEqual(state === 'ready' ? [readyEvent(record)] : [])
        const session = reported<Wire.UploadSession>(first, 'staged')
        if (session === undefined) expect(upload).toBeNull()
        else {
          const [status, bytes] = need(upload, 'upload state')
          expect(
            ok(await seen.blob.inspect({ ref: { kind: 'upload', value: session } }, ctx())),
          ).toMatchObject({ status, bytes })
          // A restarted publisher stages again and rebuilds a sealed reference only from a sealed
          // session. An open session is never reported sealed, and a sealed reference built from it
          // anyway names no sealed upload.
          const { uploadId, mediaType } = CONTENT
          const digest = need(CONTENT.digest, 'declared digest')
          const restaged = ok(
            await seen.blob.stage(
              { uploadId, size: CONTENT.bytes, mediaType, expectedDigest: digest },
              ctx(),
            ),
          )
          expect(restaged).toMatchObject({ status, receivedBytes: bytes })
          if (status === 'uploading') {
            const { authorityId, reservationId } = restaged
            const early: Wire.UploadRef = {
              authorityId,
              uploadId,
              reservationId,
              digest,
              bytes: CONTENT.bytes,
              mediaType,
              status: 'sealed',
            }
            expect(refused(await seen.blob.promote({ upload: early, expectedDigest: digest }, ctx()))).toBe(
              'not_found',
            )
          }
        }
        if (point === 'promoted') {
          // The sealed upload's retention root holds the staged blob but is not a pin of it.
          const staged = paused as Wire.StagedBlobRef
          expect(
            ok(await seen.blob.inspect({ ref: { kind: 'staged-blob', value: staged } }, ctx())),
          ).toMatchObject({
            status: 'staged',
            ownerRefs: [],
          })
        }
        if (point === 'pinned') {
          const pinned = paused as Wire.BlobRef
          expect(ok(await seen.blob.inspect({ ref: { kind: 'blob', value: pinned } }, ctx()))).toMatchObject({
            status: 'pinned',
            ownerRefs: [{ kind: 'artifact', value: artifactRef }],
          })
        }
        expect(await collectable(seen.blob)).toEqual(expected)
      } finally {
        seen.close()
      }

      // A restarted process repeats every step with the same identities.
      const second = start(dataDir)
      const done = (await second.until('done')) as Wire.ArtifactReservation
      await second.done()
      const sealed = need(
        reported<Wire.UploadResult>(first, 'sealed') ?? reported<Wire.UploadResult>(second, 'sealed'),
        'sealed upload',
      )
      const retention = sealed.retention
      if (retention.kind !== 'domain-record') throw new Error(`unexpected retention ${retention.kind}`)
      expect(retention.resourceId).toBe(CONTENT.uploadId)

      const after = openServices(dataDir)
      try {
        const record = ok(
          await after.artifacts.reserve({ request: reserveRequest(PUBLICATION), owner: owner() }, ctx()),
        )
        expect(record).toEqual(done)
        expect(record).toMatchObject({ ...artifactRef, revision: 3, state: 'ready' })
        const pinned = need(record.blob, 'pinned blob')
        expect(record.pinId).toBe(pinned.pinId)
        if (point === 'promoted') expect(pinned.blobId).toBe((paused as Wire.StagedBlobRef).blobId)
        if (point === 'pinned') expect(pinned).toEqual(paused)
        if (point === 'ready') expect(record).toEqual(paused)
        expect(after.artifacts.pendingEvents()).toEqual([readyEvent(record)])

        const source = need(record.source?.kind === 'upload' ? record.source.upload : null, 'upload source')
        expect(source).toEqual(sealed.upload)
        const staged = ok(await after.blob.promote({ upload: source, expectedDigest: source.digest }, ctx()))
        expect(staged.blobId).toBe(pinned.blobId)
        // One live pin, owned by this artifact version; no orphan pin was left by an earlier attempt.
        expect(ok(await after.blob.inspect({ ref: { kind: 'staged-blob', value: staged } }, ctx()))).toEqual({
          status: 'pinned',
          bytes: CONTENT.bytes,
          digest: CONTENT.digest,
          ownerRefs: [{ kind: 'artifact', value: artifactRef }],
        })

        await grantRead(after.artifacts, artifactRef)
        const stream = ok(await after.artifacts.artifactAccess.openStream(artifactRef, ctx()))
        const hash = createHash('sha256')
        for await (const chunk of stream.chunks) hash.update(chunk)
        expect(hash.digest('hex')).toBe(CONTENT.digest)
        expect(await stream.ended).toEqual({
          ok: true,
          value: { bytes: CONTENT.bytes, digest: CONTENT.digest },
        })

        // Another owner action can neither publish nor fail this publication.
        const intruder = owner('action-2')
        expect(
          refused(
            await after.artifacts.publish(
              { request: publishRequest(PUBLICATION, source), owner: intruder },
              ctx(),
            ),
          ),
        ).toBe('idempotency_conflict')
        const failureRef = { authorityId: 'state-1', receiptId: 'receipt-1', digest: 'a'.repeat(64) }
        expect(
          refused(
            await after.artifacts.fail(
              {
                request: { publicationId: PUBLICATION, expectedRevision: 3, failureRef },
                owner: intruder,
                receipt: { actionId: 'action-2', receiptId: 'receipt-1', outcome: 'failed' },
              },
              ctx(),
            ),
          ),
        ).toBe('permission_denied')
        // A read must name this exact pin: neither the upload's retention root nor another blob.
        const readWith = (ref: Wire.BlobRef) =>
          after.blob.blobRead.readRange({ ref, offset: 0, length: 1 }, ctx())
        expect(refused(await readWith({ ...pinned, pinId: retention.pinId }))).toBe('not_found')
        expect(refused(await readWith({ ...pinned, blobId: randomUUID() }))).toBe('not_found')
        // An upload reference that differs from the sealed record is not promoted.
        const forged = { ...source, reservationId: randomUUID() }
        expect(
          refused(await after.blob.promote({ upload: forged, expectedDigest: forged.digest }, ctx())),
        ).toBe('not_found')

        // Releasing the upload's retention root leaves the artifact pin as the only holder of the blob:
        // nothing becomes collectable and the artifact stays readable.
        expect(ok(await after.blob.unpin({ pinId: retention.pinId, expectedRevision: 1 }, ctx()))).toEqual({
          released: true,
        })
        expect(await collectable(after.blob)).toEqual([])
        const range = ok(
          await after.artifacts.artifactAccess.readRange(
            { ...artifactRef, offset: MIB - 7, length: MIB },
            ctx(),
          ),
        )
        expect(range.bytes).toEqual(pattern(MIB - 7, MIB, CONTENT.salt))

        // Exactly one version was allocated, and a publication naming a forged upload never gets ready.
        const next = ok(
          await after.artifacts.reserve(
            {
              request: reserveRequest('publication-2', {
                artifactId: reserved.artifactId,
                expectedLatestVersion: 1,
              }),
              owner: owner(),
            },
            ctx(),
          ),
        )
        expect(next.version).toBe(2)
        expect(
          refused(
            await after.artifacts.publish(
              { request: publishRequest('publication-2', forged), owner: owner() },
              ctx(),
            ),
          ),
        ).toBe('not_found')
        expect(after.artifacts.pendingEvents()).toEqual([readyEvent(record)])
      } finally {
        after.close()
      }
    },
    120_000,
  )
})
