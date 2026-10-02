import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { BlobReadPort, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { createBlobService } from '../../../src/runtime/providers/blob.js'
import {
  BLOB_BINDING,
  type Content,
  ctx,
  haltAtStatement,
  hold,
  MIB,
  ok,
  pattern,
  report,
  upload,
} from './artifact-world.js'

/**
 * Writes or reads objects in one blob backend, `default` (the Host service) or `reference` (the
 * independent example store), each on its own persistent files in the data directory.
 *   write <content json> [halt]  writes one object and holds after it commits; with a halt name it
 *                                blocks inside that commit instead, before the transaction ends.
 *   read <plan json>             reads objects back and reports what each read returned.
 */

type Backend = Readonly<{
  read: BlobReadPort
  write(content: Content): Promise<Wire.BlobRef>
  /** Statements inside the transactions that make an object durable, by name. */
  halts: Readonly<Record<string, (sql: string) => boolean>>
  inspect?(session: Wire.UploadSession): Promise<Outcome<Wire.BlobInspectResult>>
}>

type ReferenceStore = Readonly<{
  blobRead: BlobReadPort
  seed(bytes: Uint8Array, mediaType: string): Wire.BlobRef
}>

export type ReadPlan = Readonly<{
  committed: readonly Wire.BlobRef[]
  absent: readonly Wire.BlobRef[]
  uploads: readonly Wire.UploadSession[]
}>

const [backendName, dataDir, mode, payload, halt] = process.argv.slice(2)
if (dataDir === undefined || payload === undefined)
  throw new Error('usage: <backend> <dataDir> <mode> <json>')

async function open(): Promise<Backend> {
  if (backendName === 'default') {
    const blob = createBlobService({
      dataDir: dataDir as string,
      authorityId: 'blob-authority',
      binding: BLOB_BINDING,
      authorizeRead: () => true,
    })
    return {
      read: blob.blobRead,
      async write(content) {
        const sealed = await upload(blob, content, { staged: (session) => report('staged', session) })
        const staged = ok(await blob.promote({ upload: sealed, expectedDigest: sealed.digest }, ctx()))
        const ownerRef: Wire.PublicRef = {
          kind: 'artifact',
          value: { artifactId: content.uploadId, version: 1 },
        }
        return ok(await blob.pin({ stagedBlob: staged, ownerRef, retentionUntil: null }, ctx()))
      },
      halts: {
        // The seal records the upload's retention root in the transaction that marks it sealed.
        seal: (sql) => sql.startsWith('INSERT INTO roots') && sql.includes("'upload'"),
        // The pin row is the whole pin transaction; its arguments start with the pin and blob ids.
        pin: (sql) => sql.startsWith('INSERT INTO roots') && sql.includes("'blob'"),
      },
      inspect: (session) => blob.inspect({ ref: { kind: 'upload', value: session } }, ctx()),
    }
  }
  // Loaded by URL: the example package is outside this package's build.
  const location = new URL('../../../../../examples/runtime-reference/src/providers/blob.ts', import.meta.url)
  const reference = (await import(location.href)) as {
    openBlobStore(
      path: string,
      options: { authorityId: string; authorizeRead: () => boolean },
    ): ReferenceStore
  }
  const store = reference.openBlobStore(join(dataDir as string, 'reference-blob.db'), {
    authorityId: 'reference-blob',
    authorizeRead: () => true,
  })
  return {
    read: store.blobRead,
    write: async (content) => store.seed(pattern(0, content.bytes, content.salt), content.mediaType),
    // The pin is the last row of the transaction that stores the pieces: (pin id, blob id).
    halts: { seed: (sql) => sql.startsWith('INSERT INTO pins') },
  }
}

const refusal = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.detailCode)

async function readBack(backend: Backend, ref: Wire.BlobRef) {
  const ranges = []
  for (const offset of [0, MIB - 7, ref.bytes - 100]) {
    const range = ok(await backend.read.readRange({ ref, offset, length: MIB }, ctx()))
    ranges.push({
      offset: range.offset,
      bytes: range.bytes.byteLength,
      totalBytes: range.totalBytes,
      sha256: createHash('sha256').update(range.bytes).digest('hex'),
      digest: range.digest,
    })
  }
  const streams = []
  for (const offset of [0, MIB + 5]) {
    const stream = ok(await backend.read.openRead({ ref, offset }, ctx()))
    const hash = createHash('sha256')
    let largest = 0
    for await (const chunk of stream.chunks) {
      largest = Math.max(largest, chunk.byteLength)
      hash.update(chunk)
    }
    streams.push({ offset, largest, sha256: hash.digest('hex'), ended: await stream.ended })
  }
  const oversized = refusal(await backend.read.readRange({ ref, offset: 0, length: MIB + 1 }, ctx()))
  return { ranges, streams, oversized }
}

const backend = await open()
if (mode === 'write') {
  const content = JSON.parse(payload) as Content
  if (halt !== undefined) {
    const matches = backend.halts[halt]
    if (!matches) throw new Error(`no halt ${halt} in ${backendName}`)
    haltAtStatement(halt, matches)
  }
  const ref = await backend.write(content)
  report('committed', ref)
  await hold('committed', ref)
} else if (mode === 'read') {
  const plan = JSON.parse(payload) as ReadPlan
  const committed = []
  for (const ref of plan.committed) committed.push(await readBack(backend, ref))
  const absent = []
  for (const ref of plan.absent)
    absent.push({
      range: refusal(await backend.read.readRange({ ref, offset: 0, length: 1 }, ctx())),
      stream: refusal(await backend.read.openRead({ ref, offset: 0 }, ctx())),
    })
  const uploads = []
  for (const session of plan.uploads) {
    if (!backend.inspect) throw new Error(`${backendName} has no uploads`)
    uploads.push(ok(await backend.inspect(session)))
  }
  report('read', { committed, absent, uploads })
} else {
  throw new Error(`unknown mode ${mode}`)
}
