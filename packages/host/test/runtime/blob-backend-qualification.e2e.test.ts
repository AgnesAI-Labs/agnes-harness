import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Wire from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type Child,
  type Content,
  MIB,
  pattern,
  patternDigest,
  sha256,
  startChild,
} from './fixtures/artifact-world.js'
import type { ReadPlan } from './fixtures/blob-backend-child.js'

const content = (uploadId: string, bytes: number, salt: number): Content => ({
  uploadId,
  bytes,
  salt,
  mediaType: 'application/octet-stream',
  chunkBytes: MIB,
  digest: patternDigest(0, bytes, salt),
})

const COMMITTED = content('object-a', 3 * MIB + 517, 0xa1)

/**
 * Both backends persist to their own files. Each later write is killed inside a named commit that
 * would have produced either a readable reference (rebuilt from the halted statement's leading
 * arguments, pin id and blob id) or a sealed upload.
 */
const BACKENDS: {
  name: string
  authorityId: string
  interrupted: { halt: string; content: Content; lost: 'ref' | 'upload' }[]
}[] = [
  {
    name: 'default',
    authorityId: 'blob-authority',
    interrupted: [
      { halt: 'seal', content: content('object-b', 2 * MIB + 3, 0xb2), lost: 'upload' },
      { halt: 'pin', content: content('object-c', MIB + 11, 0xc3), lost: 'ref' },
    ],
  },
  {
    name: 'reference',
    authorityId: 'reference-blob',
    interrupted: [{ halt: 'seed', content: content('object-b', 2 * MIB + 3, 0xb2), lost: 'ref' }],
  },
]

const dirs: string[] = []
const children: Child[] = []
afterEach(async () => {
  for (const child of children.splice(0)) await child.kill()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function start(args: string[]): Child {
  const child = startChild('./blob-backend-child.ts', args)
  children.push(child)
  return child
}

const range = (object: Content, offset: number, bytes: number) => {
  const digest = sha256(pattern(offset, bytes, object.salt))
  return { offset, bytes, totalBytes: object.bytes, sha256: digest, digest }
}

const stream = (object: Content, offset: number) => {
  const digest = patternDigest(offset, object.bytes, object.salt)
  return {
    offset,
    largest: expect.any(Number),
    sha256: digest,
    ended: { ok: true, value: { bytes: object.bytes - offset, digest } },
  }
}

type ReadResult = {
  committed: { streams: { largest: number }[] }[]
  absent: unknown[]
  uploads: unknown[]
}

describe.each(BACKENDS)(
  '$name blob backend across killed processes',
  ({ name, authorityId, interrupted }) => {
    it('keeps committed objects byte-exact and never exposes an uncommitted one', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `agh-blob-${name}-`))
      dirs.push(dataDir)

      // Killed right after the commit returned, before anything is closed or checkpointed.
      const writer = start([name, dataDir, 'write', JSON.stringify(COMMITTED)])
      const committed = (await writer.until('paused', 'committed')) as Wire.BlobRef
      await writer.kill()
      expect(committed).toMatchObject({ authorityId, digest: COMMITTED.digest, bytes: COMMITTED.bytes })

      const absent: Wire.BlobRef[] = []
      const uploads: Wire.UploadSession[] = []
      for (const { halt, content: object, lost } of interrupted) {
        const child = start([name, dataDir, 'write', JSON.stringify(object), halt])
        const [pinId, blobId] = (await child.until('paused', halt)) as [string, string]
        await child.kill()
        const { bytes, mediaType } = object
        if (lost === 'ref')
          absent.push({ authorityId, blobId, digest: object.digest ?? '', bytes, mediaType, pinId })
        else uploads.push(child.events.find((item) => item.event === 'staged')?.data as Wire.UploadSession)
      }

      const plan: ReadPlan = { committed: [committed], absent, uploads }
      const reader = start([name, dataDir, 'read', JSON.stringify(plan)])
      const result = (await reader.until('read')) as ReadResult
      await reader.done()

      expect(result).toEqual({
        committed: [
          {
            ranges: [
              range(COMMITTED, 0, MIB),
              range(COMMITTED, MIB - 7, MIB),
              range(COMMITTED, COMMITTED.bytes - 100, 100),
            ],
            streams: [stream(COMMITTED, 0), stream(COMMITTED, MIB + 5)],
            oversized: 'invalid_request',
          },
        ],
        // The commit never happened, so the reference it would have produced reads nothing.
        absent: absent.map(() => ({ range: 'not_found', stream: 'not_found' })),
        // Every byte was acknowledged but the seal did not commit: the upload is not sealed.
        uploads: uploads.map((session) => ({
          status: 'uploading',
          bytes: session.expectedBytes,
          digest: null,
          ownerRefs: [],
        })),
      })
      for (const { largest } of result.committed[0]?.streams ?? []) expect(largest).toBeLessThanOrEqual(MIB)
    }, 120_000)
  },
)
