import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  BlobReadPort,
  ByteRangeResult,
  ByteReadStream,
  CallContext,
  Outcome,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeClientTransportPolicy,
  RuntimeErrorDetails,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const BLOB_PROVIDER = { id: 'reference.blob', contract: 'agh.blob' } as const

/** Stored pieces and stream chunks are both 1 MiB, so a range touches at most two pieces. */
export const PIECE_BYTES = RuntimeClientTransportPolicy.maxRangeBytes

type Detail = keyof typeof RuntimeErrorDetails

class Refusal extends Error {
  readonly error: Wire.RuntimeError
  constructor(detail: Detail, message: string) {
    super(message)
    this.error = {
      code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
      detailCode: detail,
      message,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'reference-blob',
    }
  }
}

function refuse(detail: Detail, message: string): never {
  throw new Refusal(detail, message)
}

const errorOf = (caught: unknown): Wire.RuntimeError =>
  caught instanceof Refusal ? caught.error : new Refusal('internal_error', 'blob store failed').error

function parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) refuse('invalid_request', `${name} does not match its schema`)
  return result.value
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function attempt<T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted)
    return { ok: false, error: new Refusal('cancelled', 'call was cancelled').error }
  try {
    return { ok: true, value: await body() }
  } catch (caught) {
    return { ok: false, error: errorOf(caught) }
  }
}

export type BlobStoreOptions = Readonly<{
  authorityId?: Wire.Id
  /** The Host's check that a call may read this blob. Without one every read is refused as blocked. */
  authorizeRead?: (context: CallContext, ref: Wire.BlobRef) => boolean
}>

/**
 * Objects live in SQLite as 1 MiB pieces, each with the SHA-256 it had when written, so a damaged or
 * missing piece is found at the read that needs it. A pin names the object a reference may read and
 * the owner it was taken for; a sealed upload names the object it promotes to.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS objects (
  blob_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pieces (
  blob_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (blob_id, seq)
);
CREATE TABLE IF NOT EXISTS pins (
  pin_id TEXT PRIMARY KEY,
  blob_id TEXT NOT NULL,
  owner TEXT
);
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  blob_id TEXT NOT NULL
);`

type ObjectRow = { digest: string; size: number; media_type: string }
type Described = Readonly<{ authorityId: Wire.Id; digest: string; bytes: number; mediaType: string }>

export function openBlobStore(path: string, options: BlobStoreOptions = {}) {
  const authorityId = options.authorityId ?? 'reference-blob'
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(TABLES)
  let open = true

  const live = () => {
    if (!open) refuse('blocked', 'blob store is closed')
  }

  /** Whether a reference describes exactly this stored object of this store. */
  const describes = (row: ObjectRow | undefined, ref: Described): row is ObjectRow =>
    row !== undefined &&
    ref.authorityId === authorityId &&
    row.digest === ref.digest &&
    row.size === ref.bytes &&
    row.media_type === ref.mediaType

  /** The object a reference names through a live pin of exactly that object. */
  function pinned(ref: Wire.BlobRef): ObjectRow {
    const row = db
      .prepare(
        'SELECT o.digest, o.size, o.media_type FROM pins p JOIN objects o ON o.blob_id = p.blob_id WHERE p.pin_id = ? AND p.blob_id = ?',
      )
      .get(ref.pinId, ref.blobId) as ObjectRow | undefined
    if (!describes(row, ref)) refuse('not_found', 'no such pinned blob')
    return row
  }

  /** The reference must name a live pin of exactly this object, and every stored byte must be there. */
  function authorize(context: CallContext, ref: Wire.BlobRef) {
    live()
    if (!options.authorizeRead) refuse('blocked', 'no read authorization is configured')
    if (!options.authorizeRead(context, ref)) refuse('permission_denied', 'caller may not read this blob')
    pinned(ref)
    const stored = db
      .prepare('SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM pieces WHERE blob_id = ?')
      .get(ref.blobId) as { bytes: number }
    if (stored.bytes !== ref.bytes) refuse('integrity', 'stored bytes differ from the recorded size')
  }

  /** One stored piece, checked against its length and the digest it was written with. */
  function piece(ref: Wire.BlobRef, seq: number): Uint8Array {
    live()
    const row = db
      .prepare('SELECT data, sha FROM pieces WHERE blob_id = ? AND seq = ?')
      .get(ref.blobId, seq) as { data: Uint8Array; sha: string } | undefined
    if (row?.data.byteLength !== Math.min(PIECE_BYTES, ref.bytes - seq * PIECE_BYTES))
      refuse('integrity', 'blob bytes ended early')
    if (sha256(row.data) !== row.sha) refuse('integrity', 'blob piece does not match its digest')
    return row.data
  }

  function slice(ref: Wire.BlobRef, start: number, end: number): Uint8Array {
    const out = new Uint8Array(end - start)
    for (let seq = Math.floor(start / PIECE_BYTES); seq * PIECE_BYTES < end; seq++) {
      const base = seq * PIECE_BYTES
      const data = piece(ref, seq)
      const from = Math.max(start, base)
      out.set(data.subarray(from - base, Math.min(end, base + data.byteLength) - base), from - start)
    }
    return out
  }

  /** Pull based: a piece is read only when the consumer asks for the next chunk, after a fresh check. */
  function pieceStream(ref: Wire.BlobRef, offset: number, recheck: () => void): ByteReadStream {
    let settle: (outcome: Outcome<Wire.ArtifactReadStreamEndResult>) => void = () => undefined
    const ended = new Promise<Outcome<Wire.ArtifactReadStreamEndResult>>((resolve) => {
      settle = resolve
    })
    let done = false
    const finish = (outcome: Outcome<Wire.ArtifactReadStreamEndResult>) => {
      if (done) return
      done = true
      settle(outcome)
    }
    const stop = async () =>
      finish({ ok: false, error: new Refusal('cancelled', 'stream was cancelled').error })
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const hash = createHash('sha256')
      let at = offset
      try {
        while (!done && at < ref.bytes) {
          recheck()
          const seq = Math.floor(at / PIECE_BYTES)
          const chunk = piece(ref, seq).subarray(at - seq * PIECE_BYTES)
          hash.update(chunk)
          at += chunk.byteLength
          yield chunk
        }
        if (done) return
        const digest = hash.digest('hex')
        if (offset === 0 && digest !== ref.digest) refuse('integrity', 'blob bytes do not match their digest')
        finish({ ok: true, value: { bytes: ref.bytes - offset, digest } })
      } catch (caught) {
        finish({ ok: false, error: errorOf(caught) })
      }
    }
    return { chunks: chunks(), ended, cancel: stop, close: stop }
  }

  const blobRead: BlobReadPort = {
    readRange: (request, context) =>
      attempt(context, (): ByteRangeResult => {
        const { ref, offset, length } = parse('BlobReadRangeRequest', request)
        authorize(context, ref)
        if (offset >= ref.bytes) refuse('range_not_satisfiable', 'range starts at or past the end')
        const bytes = slice(ref, offset, Math.min(ref.bytes, offset + length))
        return { bytes, offset, totalBytes: ref.bytes, digest: sha256(bytes) }
      }),
    openRead: (request, context) =>
      attempt(context, () => {
        const { ref, offset } = parse('BlobOpenReadRequest', request)
        authorize(context, ref)
        if (offset > ref.bytes) refuse('range_not_satisfiable', 'stream starts past the end')
        return pieceStream(ref, offset, () => authorize(context, ref))
      }),
  }

  /** Stores bytes as one object and runs `link` to name it, in one transaction. */
  function store(blobId: Wire.Id, bytes: Uint8Array, mediaType: string, link: () => void) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO objects (blob_id, digest, size, media_type) VALUES (?, ?, ?, ?)').run(
        blobId,
        sha256(bytes),
        bytes.byteLength,
        mediaType,
      )
      const insert = db.prepare('INSERT INTO pieces (blob_id, seq, data, sha) VALUES (?, ?, ?, ?)')
      for (let seq = 0; seq * PIECE_BYTES < bytes.byteLength; seq++) {
        const data = bytes.subarray(seq * PIECE_BYTES, (seq + 1) * PIECE_BYTES)
        insert.run(blobId, seq, data, sha256(data))
      }
      link()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    blobRead,

    /**
     * Test write entry: stores bytes and pins them. The upload chain of agh.blob is not frozen yet, so
     * this stands in for stage, seal, promote and pin; it is not that chain.
     */
    seed(bytes: Uint8Array, mediaType = 'application/octet-stream'): Wire.BlobRef {
      live()
      const ref = parse('BlobRef', {
        authorityId,
        blobId: randomUUID(),
        digest: sha256(bytes),
        bytes: bytes.byteLength,
        mediaType,
        pinId: randomUUID(),
      })
      store(ref.blobId, bytes, mediaType, () =>
        db.prepare('INSERT INTO pins (pin_id, blob_id) VALUES (?, ?)').run(ref.pinId, ref.blobId),
      )
      return ref
    },

    /** Test write entry: stores bytes as a sealed upload, standing in for stage, write and seal. */
    upload(bytes: Uint8Array, mediaType = 'application/octet-stream'): Wire.UploadRef {
      live()
      const upload = parse('UploadRef', {
        authorityId,
        uploadId: randomUUID(),
        reservationId: randomUUID(),
        digest: sha256(bytes),
        bytes: bytes.byteLength,
        mediaType,
        status: 'sealed',
      })
      const blobId = randomUUID()
      store(blobId, bytes, mediaType, () =>
        db
          .prepare('INSERT INTO uploads (upload_id, reservation_id, blob_id) VALUES (?, ?, ?)')
          .run(upload.uploadId, upload.reservationId, blobId),
      )
      return upload
    },

    /** Promotes a sealed upload to the object it stored; promoting it again returns the same reference. */
    promote: (request: unknown, context: CallContext) =>
      attempt(context, (): Wire.StagedBlobRef => {
        const { upload, expectedDigest } = parse('BlobPromoteRequest', request)
        live()
        const row = db
          .prepare(
            'SELECT u.blob_id, o.digest, o.size, o.media_type FROM uploads u JOIN objects o ON o.blob_id = u.blob_id WHERE u.upload_id = ? AND u.reservation_id = ?',
          )
          .get(upload.uploadId, upload.reservationId) as (ObjectRow & { blob_id: string }) | undefined
        if (!describes(row, upload)) refuse('not_found', 'no such sealed upload')
        if (expectedDigest !== row.digest) refuse('integrity', 'upload digest differs from the expected one')
        const { reservationId, digest, bytes, mediaType } = upload
        return { authorityId, blobId: row.blob_id, digest, bytes, mediaType, reservationId }
      }),

    /** Pins a staged object for one owner; the same owner gets the same pin back. */
    pin: (request: unknown, context: CallContext) =>
      attempt(context, (): Wire.BlobRef => {
        const { stagedBlob, ownerRef } = parse('BlobPinRequest', request)
        live()
        const row = db
          .prepare('SELECT digest, size, media_type FROM objects WHERE blob_id = ?')
          .get(stagedBlob.blobId) as ObjectRow | undefined
        if (!describes(row, stagedBlob)) refuse('not_found', 'no such staged blob')
        const owner = jcs(ownerRef)
        const held = db
          .prepare('SELECT pin_id FROM pins WHERE blob_id = ? AND owner = ?')
          .get(stagedBlob.blobId, owner) as { pin_id: string } | undefined
        const pinId = held?.pin_id ?? randomUUID()
        if (!held)
          db.prepare('INSERT INTO pins (pin_id, blob_id, owner) VALUES (?, ?, ?)').run(
            pinId,
            stagedBlob.blobId,
            owner,
          )
        const { blobId, digest, bytes, mediaType } = stagedBlob
        return { authorityId, blobId, digest, bytes, mediaType, pinId }
      }),

    /** Reports a pinned reference with the owners of every pin on its object; nothing else is inspected. */
    inspect: (request: unknown, context: CallContext) =>
      attempt(context, (): Wire.BlobInspectResult => {
        const { ref } = parse('BlobInspectRequest', request)
        live()
        if (ref.kind !== 'blob') refuse('operation_not_supported', 'only pinned blobs are inspected')
        const row = pinned(ref.value)
        const owners = db
          .prepare('SELECT owner FROM pins WHERE blob_id = ? AND owner IS NOT NULL ORDER BY owner')
          .all(ref.value.blobId) as { owner: string }[]
        const ownerRefs = owners.map((item) => JSON.parse(item.owner) as Wire.PublicRef)
        return { status: 'pinned', bytes: row.size, digest: row.digest, ownerRefs }
      }),

    close() {
      if (!open) return
      open = false
      db.close()
    },
  }
}

export type BlobStore = ReturnType<typeof openBlobStore>
