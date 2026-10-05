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
  RuntimeAuthorityTransferAPI,
  RuntimeClientTransportPolicy,
  RuntimeErrorDetails,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { openTransfer, type TransferMaintenance } from './blob-transfer.js'

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
  /**
   * The maintenance assembly. With it the store declares authority transfer; without it every transfer
   * call is refused as unsupported.
   */
  maintenance?: TransferMaintenance
  /** Creates a new store as an import target, which serves nothing until a transfer activates it. */
  candidate?: boolean
  /** The most records and encoded bytes one exported part holds. */
  exportPart?: Readonly<{ records: number; bytes: number }>
}>

/**
 * Objects live in SQLite as 1 MiB pieces, each with the SHA-256 it had when written, so a damaged or
 * missing piece is found at the read that needs it. A pin names the object a reference may read, the
 * owner it was taken for and the principal that took it; a sealed upload names the object it promotes
 * to. An object records the principal that wrote it, and only that principal may promote or pin it;
 * only the principal a pin records may release it. A row that records no principal is no caller's. A
 * collected object keeps its row as a tombstone and loses its pieces. Every released pin and collected
 * object appends one row to the deletion log, whose seq only grows. The authority row says whether the
 * store serves: a fenced store keeps serving reads but refuses business writes, and a transfer
 * candidate serves neither until it is activated.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS objects (
  blob_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  principal TEXT
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
  owner TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  principal TEXT
);
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  blob_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deletions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  digest TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS authority (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  role TEXT NOT NULL CHECK (role IN ('serving', 'fenced', 'candidate')),
  epoch INTEGER NOT NULL
);`

/** The business tables a checkpoint covers, each with the SQL that gives a record its key. */
const RECORDS = {
  deletions: "printf('%016d', seq)",
  objects: 'blob_id',
  pieces: "blob_id || '/' || printf('%016d', seq)",
  pins: 'pin_id',
  uploads: 'upload_id',
}

type ObjectRow = { digest: string; size: number; media_type: string }
type PinRow = ObjectRow & {
  blob_id: string
  deleted: number
  active: number
  revision: number
  principal: string | null
}
type Described = Readonly<{ authorityId: Wire.Id; digest: string; bytes: number; mediaType: string }>

/** One deletion log row: `pin-released` for an unpin, `blob-deleted` for an object gc collected. */
export type DeletionRow = Readonly<{
  seq: number
  kind: 'pin-released' | 'blob-deleted'
  ref: Wire.PublicRef
  digest: string
  at: number
}>

/** True when `inner` names the same scope as `outer` or one nested inside it. */
const within = (inner: Wire.ScopeRef, outer: Wire.ScopeRef) =>
  Object.entries(outer).every(
    ([key, value]) => key === 'kind' || (inner as Record<string, unknown>)[key] === value,
  )

/** Whether an object or pin is not the caller's; one that records no principal is no caller's. */
const foreign = (principal: string | null, context: CallContext) => principal !== context.principalRef

export function openBlobStore(path: string, options: BlobStoreOptions = {}) {
  const authorityId = options.authorityId ?? 'reference-blob'
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(TABLES)
  // Objects and pins record a principal; rows from before the column record none, so no caller holds them.
  const recorded = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      ({ name }) => name === 'principal',
    )
  for (const table of ['objects', 'pins'])
    if (!recorded(table))
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN principal TEXT`)
      } catch (error) {
        if (!recorded(table)) throw error // otherwise another process added it first
      }
  db.prepare('INSERT OR IGNORE INTO authority (id, role, epoch) VALUES (1, ?, ?)').run(
    ...(options.candidate ? ['candidate', 0] : ['serving', 1]),
  )
  let open = true

  const live = () => {
    if (!open) refuse('blocked', 'blob store is closed')
  }

  const role = () => (db.prepare('SELECT role FROM authority WHERE id = 1').get() as { role: string }).role

  /** One transaction. A business write is gated: refused as blocked unless the store serves. */
  function atomically<T>(body: () => T, gated = true): T {
    live()
    db.exec('BEGIN IMMEDIATE')
    try {
      if (gated && role() !== 'serving') refuse('blocked', 'store is fenced or a transfer candidate')
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** Whether a reference describes exactly this stored object of this store. */
  const describes = <R extends ObjectRow>(row: R | undefined, ref: Described): row is R =>
    row !== undefined &&
    ref.authorityId === authorityId &&
    row.digest === ref.digest &&
    row.size === ref.bytes &&
    row.media_type === ref.mediaType

  const pinRow = (pinId: Wire.Id) =>
    db
      .prepare(
        'SELECT p.blob_id, p.revision, p.active, p.principal, o.digest, o.size, o.media_type, o.deleted FROM pins p JOIN objects o ON o.blob_id = p.blob_id WHERE p.pin_id = ?',
      )
      .get(pinId) as PinRow | undefined

  /** The pin a reference names, whether or not it still grants reads. */
  function pinOf(ref: Wire.BlobRef): PinRow {
    const row = pinRow(ref.pinId)
    if (row?.blob_id !== ref.blobId || !describes(row, ref)) refuse('not_found', 'no such pinned blob')
    return row
  }

  /** The object a reference names through a live pin of exactly that object. */
  function pinned(ref: Wire.BlobRef): ObjectRow {
    const row = pinOf(ref)
    if (row.deleted) refuse('artifact_deleted', 'blob was collected')
    if (!row.active) refuse('revoked', 'pin was released')
    return row
  }

  const logDeletion = (kind: DeletionRow['kind'], ref: Wire.PublicRef, digest: string) =>
    db
      .prepare('INSERT INTO deletions (kind, ref, digest, at) VALUES (?, ?, ?, ?)')
      .run(kind, jcs(ref), digest, Date.now())

  /** The reference must name a live pin of exactly this object, and every stored byte must be there. */
  function authorize(context: CallContext, ref: Wire.BlobRef) {
    live()
    if (!options.authorizeRead) refuse('blocked', 'no read authorization is configured')
    if (!options.authorizeRead(context, ref)) refuse('permission_denied', 'caller may not read this blob')
    if (role() === 'candidate') refuse('blocked', 'a transfer candidate serves nothing until activated')
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

  /** Stores bytes as one object written by `principal` and runs `link` to name it, in one transaction. */
  function store(
    blobId: Wire.Id,
    reservationId: Wire.Id,
    bytes: Uint8Array,
    mediaType: string,
    principal: string | null,
    link: () => void,
  ) {
    atomically(() => {
      db.prepare(
        'INSERT INTO objects (blob_id, digest, size, media_type, reservation_id, principal) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(blobId, sha256(bytes), bytes.byteLength, mediaType, reservationId, principal)
      const insert = db.prepare('INSERT INTO pieces (blob_id, seq, data, sha) VALUES (?, ?, ?, ?)')
      for (let seq = 0; seq * PIECE_BYTES < bytes.byteLength; seq++) {
        const data = bytes.subarray(seq * PIECE_BYTES, (seq + 1) * PIECE_BYTES)
        insert.run(blobId, seq, data, sha256(data))
      }
      link()
    })
  }

  const transfer = openTransfer({
    db,
    authorityId,
    name: 'blob',
    tables: RECORDS,
    log: 'deletions',
    maintenance: options.maintenance,
    part: options.exportPart ?? { records: 1000, bytes: 8 * PIECE_BYTES },
    live,
    transaction: (body) => atomically(body, false),
    refuse,
    attempt,
  })

  return {
    blobRead,
    /** Authority transfer: declared, and its operations offered, only with a maintenance assembly. */
    transfer: transfer.control,
    readExport: transfer.readExport,
    features: options.maintenance ? ['blob-read.v1', RuntimeAuthorityTransferAPI.feature] : ['blob-read.v1'],

    /**
     * Test write entry: stores bytes and pins them as `principal`; without one, nobody may pin, promote
     * or release them. The upload chain of agh.blob is not frozen yet, so this stands in for stage,
     * seal, promote and pin; it is not that chain.
     */
    seed(bytes: Uint8Array, mediaType = 'application/octet-stream', principal?: string): Wire.BlobRef {
      live()
      const ref = parse('BlobRef', {
        authorityId,
        blobId: randomUUID(),
        digest: sha256(bytes),
        bytes: bytes.byteLength,
        mediaType,
        pinId: randomUUID(),
      })
      store(ref.blobId, randomUUID(), bytes, mediaType, principal ?? null, () =>
        db
          .prepare('INSERT INTO pins (pin_id, blob_id, principal) VALUES (?, ?, ?)')
          .run(ref.pinId, ref.blobId, principal ?? null),
      )
      return ref
    },

    /**
     * Test write entry: stores bytes as a sealed upload staged by `principal`, standing in for stage,
     * write and seal. Without a principal nobody may promote it.
     */
    upload(bytes: Uint8Array, mediaType = 'application/octet-stream', principal?: string): Wire.UploadRef {
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
      store(blobId, upload.reservationId, bytes, mediaType, principal ?? null, () =>
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
            'SELECT u.blob_id, o.digest, o.size, o.media_type, o.principal FROM uploads u JOIN objects o ON o.blob_id = u.blob_id WHERE u.upload_id = ? AND u.reservation_id = ?',
          )
          .get(upload.uploadId, upload.reservationId) as
          | (ObjectRow & { blob_id: string; principal: string | null })
          | undefined
        if (!describes(row, upload)) refuse('not_found', 'no such sealed upload')
        if (foreign(row.principal, context)) refuse('permission_denied', 'caller did not stage this upload')
        if (expectedDigest !== row.digest) refuse('integrity', 'upload digest differs from the expected one')
        const { reservationId, digest, bytes, mediaType } = upload
        return { authorityId, blobId: row.blob_id, digest, bytes, mediaType, reservationId }
      }),

    /** Pins a staged object for one owner, as the caller; while that pin is live, the owner gets it back. */
    pin: (request: unknown, context: CallContext) =>
      attempt(context, (): Wire.BlobRef => {
        const { stagedBlob, ownerRef } = parse('BlobPinRequest', request)
        return atomically(() => {
          const row = db
            .prepare('SELECT digest, size, media_type, deleted, principal FROM objects WHERE blob_id = ?')
            .get(stagedBlob.blobId) as (ObjectRow & { deleted: number; principal: string | null }) | undefined
          if (!describes(row, stagedBlob)) refuse('not_found', 'no such staged blob')
          if (foreign(row.principal, context)) refuse('permission_denied', 'caller did not stage this blob')
          if (row.deleted) refuse('artifact_deleted', 'staged blob was collected')
          const owner = jcs(ownerRef)
          const held = db
            .prepare('SELECT pin_id FROM pins WHERE blob_id = ? AND owner = ? AND active = 1')
            .get(stagedBlob.blobId, owner) as { pin_id: string } | undefined
          const pinId = held?.pin_id ?? randomUUID()
          if (!held)
            db.prepare('INSERT INTO pins (pin_id, blob_id, owner, principal) VALUES (?, ?, ?, ?)').run(
              pinId,
              stagedBlob.blobId,
              owner,
              context.principalRef,
            )
          const { blobId, digest, bytes, mediaType } = stagedBlob
          return { authorityId, blobId, digest, bytes, mediaType, pinId }
        })
      }),

    /** Releases the caller's pin and logs it. Releasing a released pin changes nothing, reporting false. */
    unpin: (request: unknown, context: CallContext) =>
      attempt(context, (): Wire.BlobUnpinResult => {
        const { pinId, expectedRevision } = parse('BlobUnpinRequest', request)
        return atomically(() => {
          const row = pinRow(pinId)
          if (!row) refuse('not_found', 'no such pin')
          if (foreign(row.principal, context)) refuse('permission_denied', 'caller does not hold this pin')
          if (!row.active) return { released: false }
          if (row.revision !== expectedRevision)
            refuse('revision_conflict', 'pin is not at the expected revision')
          db.prepare('UPDATE pins SET active = 0, revision = ? WHERE pin_id = ?').run(row.revision + 1, pinId)
          const { blob_id: blobId, digest, size: bytes, media_type: mediaType } = row
          const value = { authorityId, blobId, digest, bytes, mediaType, pinId }
          logDeletion('pin-released', { kind: 'blob', value }, digest)
          return { released: true }
        })
      }),

    /**
     * Collects objects that no live pin and no sealed upload holds: the row stays as a tombstone, the
     * pieces go, and the deletion log gains a row, all in one transaction. A sealed upload holds its
     * object as the default service's upload root does; stage and seal are not here, so nothing hands
     * out a pin that could release that hold. The test write entries record no owner scope, so every
     * object counts as inside the request scope, which itself must be inside the caller's.
     */
    gc: (request: unknown, context: CallContext) =>
      attempt(context, (): Wire.BlobGcResult => {
        const { scopeRef, dryRun, cursor, limit } = parse('BlobGcRequest', request)
        if (limit < 1 || limit > 10_000) refuse('invalid_request', 'gc limit must be 1 to 10000')
        if (!within(scopeRef, context.scope))
          refuse('permission_denied', 'gc scope is outside the caller scope')
        return atomically(() => {
          // ponytail: lists every remaining object per call; page in SQL once stores hold many objects.
          const rows = db
            .prepare(
              `SELECT o.blob_id, o.digest, o.size, o.media_type, o.reservation_id,
                 EXISTS (SELECT 1 FROM pins p WHERE p.blob_id = o.blob_id AND p.active = 1)
                 OR EXISTS (SELECT 1 FROM uploads u WHERE u.blob_id = o.blob_id) AS held
               FROM objects o WHERE o.deleted = 0 AND o.blob_id > ? ORDER BY o.blob_id`,
            )
            .all(cursor ?? '') as (ObjectRow & { blob_id: string; reservation_id: string; held: number })[]
          const eligibleRefs: Wire.PublicRef[] = []
          const deletedRefs: Wire.PublicRef[] = []
          let last: string | null = null
          for (const row of rows) {
            if (eligibleRefs.length === limit) break
            last = row.blob_id
            if (row.held) continue
            const ref: Wire.PublicRef = {
              kind: 'staged-blob',
              value: {
                authorityId,
                blobId: row.blob_id,
                digest: row.digest,
                bytes: row.size,
                mediaType: row.media_type,
                reservationId: row.reservation_id,
              },
            }
            eligibleRefs.push(ref)
            if (dryRun) continue
            db.prepare('UPDATE objects SET deleted = 1 WHERE blob_id = ?').run(row.blob_id)
            db.prepare('DELETE FROM pieces WHERE blob_id = ?').run(row.blob_id)
            logDeletion('blob-deleted', ref, row.digest)
            deletedRefs.push(ref)
          }
          const more = last !== null && rows[rows.length - 1]?.blob_id !== last
          return { eligibleRefs, deletedRefs, nextCursor: more ? last : null }
        })
      }),

    /**
     * Reports one pin reference: deleted once its object was collected, staged once the pin was
     * released, with the owners of the object's live pins. Nothing else is inspected.
     */
    inspect: (request: unknown, context: CallContext) =>
      attempt(context, (): Wire.BlobInspectResult => {
        const { ref } = parse('BlobInspectRequest', request)
        live()
        if (ref.kind !== 'blob') refuse('operation_not_supported', 'only pinned blobs are inspected')
        const row = pinOf(ref.value)
        const owners = row.deleted
          ? []
          : (db
              .prepare(
                'SELECT owner FROM pins WHERE blob_id = ? AND active = 1 AND owner IS NOT NULL ORDER BY owner',
              )
              .all(ref.value.blobId) as { owner: string }[])
        const ownerRefs = owners.map((item) => JSON.parse(item.owner) as Wire.PublicRef)
        const status = row.deleted ? 'deleted' : row.active ? 'pinned' : 'staged'
        return { status, bytes: row.size, digest: row.digest, ownerRefs }
      }),

    /**
     * Whether this store holds the object a reference names with every piece intact, whatever its pins
     * and role: the transfer entry another reference store checks the blobs its records name against.
     */
    holds(ref: Wire.BlobRef): boolean {
      live()
      const row = db
        .prepare('SELECT digest, size, media_type, deleted FROM objects WHERE blob_id = ?')
        .get(ref.blobId) as (ObjectRow & { deleted: number }) | undefined
      if (!describes(row, ref) || row.deleted) return false
      const hash = createHash('sha256')
      try {
        for (let seq = 0; seq * PIECE_BYTES < ref.bytes; seq++) hash.update(piece(ref, seq))
      } catch (caught) {
        if (caught instanceof Refusal) return false
        throw caught
      }
      return hash.digest('hex') === ref.digest
    },

    /** The deletion log in seq order. Internal: no agh.blob method reports it. */
    deletions(): DeletionRow[] {
      live()
      const rows = db.prepare('SELECT seq, kind, ref, digest, at FROM deletions ORDER BY seq').all() as (Omit<
        DeletionRow,
        'ref'
      > & { ref: string })[]
      return rows.map((row) => ({ ...row, ref: JSON.parse(row.ref) as Wire.PublicRef }))
    },

    /** The newest deletion log seq, 0 before any row; a checkpoint records it as its watermark. */
    deletionWatermark(): number {
      live()
      return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM deletions').get() as { seq: number }).seq
    },

    close() {
      if (!open) return
      open = false
      db.close()
    },
  }
}

export type BlobStore = ReturnType<typeof openBlobStore>
