import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeArtifactPolicy,
  RuntimeClientTransportPolicy,
  RuntimeErrorDetails,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createPlatform } from '../../adapters/platform.js'
import { syncCheckpointsToMedium } from '../../adapters/sqlite-durability.js'
import { createPrivateArtifactStore, openPrivateArtifactDatabase } from '../../private-artifact-store.js'
import type { AuthorityCopy } from '../authority-copy.js'
import { type Authority, openAuthority, type TransferMaintenance } from '../authority-transfer.js'
import type { IndexStorage } from '../migration/export-index.js'

type Detail = keyof typeof RuntimeErrorDetails

/** Upload chunk ceiling from the conformance limits; a range or download chunk stays at 1 MiB. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

export function blobError(detail: Detail, message: string): Wire.RuntimeError {
  return {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'blob-service',
  }
}

/** Thrown inside a store body so the whole transaction rolls back and the caller gets the refusal. */
export class BlobRefusal extends Error {
  readonly error: Wire.RuntimeError
  constructor(error: Wire.RuntimeError) {
    super(error.message)
    this.error = error
  }
}

export function refuse(detail: Detail, message: string): never {
  throw new BlobRefusal(blobError(detail, message))
}

export function parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) refuse('invalid_request', `${name} does not match its schema`)
  return result.value
}

/** Every stored record passes the frozen schema, so a construction slip is never persisted. */
export function checked<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) refuse('internal_error', `${name} failed its own schema`)
  return result.value
}

const SCOPE_KEYS = ['installationId', 'runtimeId', 'workspaceId', 'sessionId', 'runId', 'actionId'] as const

/** True when `inner` names the same scope as `outer` or one nested inside it. */
export function within(inner: Wire.ScopeRef, outer: Wire.ScopeRef): boolean {
  const a = inner as Partial<Record<(typeof SCOPE_KEYS)[number], string>>
  const b = outer as Partial<Record<(typeof SCOPE_KEYS)[number], string>>
  return SCOPE_KEYS.every((key) => b[key] === undefined || a[key] === b[key])
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS uploads (
    upload_id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL,
    session TEXT NOT NULL, result TEXT, digest TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id TEXT NOT NULL, at INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (upload_id, at))`,
  `CREATE TABLE IF NOT EXISTS blobs (
    blob_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL UNIQUE, staged TEXT NOT NULL, digest TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS roots (
    pin_id TEXT PRIMARY KEY, target TEXT NOT NULL, target_id TEXT NOT NULL, owner TEXT, owner_key TEXT,
    retention_until INTEGER, revision INTEGER NOT NULL, active INTEGER NOT NULL, blob TEXT)`,
  'CREATE INDEX IF NOT EXISTS roots_target ON roots (target, target_id, active)',
  // The deletion log: every collect and released pin, and both phases of a content unlink.
  `CREATE TABLE IF NOT EXISTS deletions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, digest TEXT, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS deletions_kind ON deletions (kind, digest, seq)',
  'CREATE INDEX IF NOT EXISTS blobs_digest ON blobs (digest, deleted)',
  'CREATE INDEX IF NOT EXISTS uploads_digest ON uploads (digest)',
  // Maintenance, never part of a checkpoint: the bytes of one asset being copied from a source.
  'CREATE TABLE IF NOT EXISTS maintenance_asset_chunks (at INTEGER PRIMARY KEY, bytes BLOB NOT NULL)',
]

/** The business tables a checkpoint covers, in key order. */
const TABLES = {
  uploads: 'upload_id',
  upload_chunks: 'upload_id, at',
  blobs: 'blob_id',
  roots: 'pin_id',
  deletions: 'seq',
}

/** Every business write goes through `write`, the authority's gate. */
export type BlobStore = Authority & {
  readonly db: DatabaseSync
  readonly dataDir: string
  readonly authorityId: Wire.Id
  readonly now: () => number
  /** Uploads with an open writer in this process. A restarted process has none, so old writers are stopped. */
  readonly writers: Set<Wire.Id>
  /** Where this store's transfer keeps its export chunks and index pages, and how it moves content. */
  readonly copy: AuthorityCopy
}

export function openBlobStore(options: {
  dataDir: string
  authorityId: Wire.Id
  now?: () => number
  maintenance?: TransferMaintenance
  /** Opens a new store as a transfer target; an existing store keeps its role. */
  transferTarget?: boolean
}): BlobStore {
  const db = openPrivateArtifactDatabase(options.dataDir, 'blob-service.db', 'blob service store')
  const now = options.now ?? (() => Date.now())
  const copy = contentCopy(db, options.dataDir, options.authorityId)
  let authority: Authority
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    syncCheckpointsToMedium(db)
    for (const statement of DDL) db.exec(statement)
    authority = openAuthority(db, {
      authorityId: options.authorityId,
      tables: TABLES,
      log: 'deletions',
      bridges: () => [],
      error: blobError,
      Refusal: BlobRefusal,
      ...(options.maintenance ? { maintenance: options.maintenance } : {}),
      target: options.transferTarget === true,
      now,
      copy,
    })
  } catch (error) {
    db.close()
    throw error
  }
  return {
    ...authority,
    db,
    dataDir: options.dataDir,
    authorityId: options.authorityId,
    now,
    writers: new Set(),
    copy,
  }
}

/** The content file of one digest in this store's content-addressed directory. */
export const contentPath = (store: Pick<BlobStore, 'dataDir'>, digest: Wire.Digest) =>
  join(store.dataDir, 'artifacts', 'sha256', digest.slice(0, 2), digest)

const CONTENT_TYPE = 'agh.host.blob/content@1'

/** Export chunks, index pages and assets live in the content store; the transfer holds each one. */
const transferRef = (
  authorityId: Wire.Id,
  upgradeId: Wire.Id,
  digest: Wire.Digest,
  bytes: number,
  mediaType: string,
): Wire.BlobRef => ({
  authorityId,
  blobId: `content-${digest}`,
  digest,
  bytes,
  mediaType,
  pinId: `transfer-${upgradeId}`,
})

/** Whether the content file of a digest holds exactly the referenced bytes. */
async function holds(dataDir: string, ref: Wire.BlobRef): Promise<boolean> {
  const path = contentPath({ dataDir }, ref.digest)
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size !== ref.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === ref.digest
  } catch {
    return false
  }
}

/**
 * How this store's rows and content move to another location. The assets are the digests
 * `contentInUse` in retention keeps: an undeleted staged blob, or a sealed upload never promoted.
 */
function contentCopy(db: DatabaseSync, dataDir: string, authorityId: Wire.Id): AuthorityCopy {
  const content = () => createPrivateArtifactStore(dataDir, createPlatform().os)
  const storage = (upgradeId: Wire.Id): IndexStorage => ({
    async put(bytes, typeId) {
      const digest = createHash('sha256').update(bytes).digest('hex')
      await content().put(digest, bytes)
      return {
        kind: 'blob',
        schema: { typeId, revision: 1, digest: createHash('sha256').update(typeId).digest('hex') },
        blob: transferRef(authorityId, upgradeId, digest, bytes.byteLength, 'application/json'),
      }
    },
    read: (ref) => createReadStream(contentPath({ dataDir }, ref.digest)),
  })
  function* list(upgradeId: Wire.Id): Generator<Wire.DataRef> {
    const rows = db
      .prepare(
        `SELECT digest, MAX(bytes) AS bytes, MIN(media_type) AS media_type FROM (
           SELECT digest, json_extract(staged, '$.bytes') AS bytes,
             json_extract(staged, '$.mediaType') AS media_type FROM blobs WHERE deleted = 0
           UNION ALL SELECT u.digest, json_extract(u.result, '$.upload.bytes'),
             json_extract(u.result, '$.upload.mediaType') FROM uploads u
           WHERE u.digest IS NOT NULL AND u.deleted = 0
             AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.upload_id = u.upload_id))
         GROUP BY digest`,
      )
      .iterate() as Iterable<{ digest: Wire.Digest; bytes: number; media_type: string }>
    const schema = {
      typeId: CONTENT_TYPE,
      revision: 1,
      digest: createHash('sha256').update(CONTENT_TYPE).digest('hex'),
    }
    for (const row of rows)
      yield {
        kind: 'blob',
        schema,
        blob: transferRef(authorityId, upgradeId, row.digest, row.bytes, row.media_type),
      }
  }
  function* staged(): Generator<Uint8Array> {
    const rows = db.prepare('SELECT bytes FROM maintenance_asset_chunks ORDER BY at').iterate() as Iterable<{
      bytes: Uint8Array
    }>
    for (const row of rows) yield row.bytes
  }
  return {
    collection: 'blob',
    storage,
    assets: {
      list,
      present: (ref) => holds(dataDir, ref),
      // The bytes stream through a staging table, as an upload's chunks do, so no asset is held in memory.
      async copy(ref, read) {
        if (await holds(dataDir, ref)) return
        db.exec('DELETE FROM maintenance_asset_chunks')
        const stage = db.prepare('INSERT INTO maintenance_asset_chunks (at, bytes) VALUES (?, ?)')
        const hash = createHash('sha256')
        let at = 0
        for await (const chunk of read(ref)) {
          if (at + chunk.byteLength > ref.bytes) refuse('integrity', 'asset bytes run past their size')
          hash.update(chunk)
          stage.run(at, chunk)
          at += chunk.byteLength
        }
        if (at !== ref.bytes || hash.digest('hex') !== ref.digest)
          refuse('integrity', 'asset bytes do not match their digest')
        await content().putChunks(ref.digest, ref.bytes, staged())
        db.exec('DELETE FROM maintenance_asset_chunks')
      },
    },
  }
}

type UploadRow = {
  owner: string
  scope: string
  expires_at: number
  session: string
  result: string | null
  deleted: number
}

export function loadUpload(store: BlobStore, uploadId: Wire.Id): UploadRow | undefined {
  return store.db
    .prepare('SELECT owner, scope, expires_at, session, result, deleted FROM uploads WHERE upload_id = ?')
    .get(uploadId) as UploadRow | undefined
}

const ownerOf = (context: CallContext) => jcs({ principalRef: context.principalRef, scope: context.scope })

export function stage(store: BlobStore, request: unknown, context: CallContext): Wire.UploadSession {
  const input = parse('BlobStageRequest', request)
  if (input.size > RuntimeClientTransportPolicy.maxArtifactBytes)
    refuse('artifact_bytes', 'upload is larger than the artifact limit')
  const owner = ownerOf(context)
  return store.write(() => {
    const row = loadUpload(store, input.uploadId)
    if (row) {
      const prior = JSON.parse(row.session) as Wire.UploadSession
      if (
        row.owner === owner &&
        prior.expectedBytes === input.size &&
        prior.expectedDigest === input.expectedDigest &&
        prior.mediaType === input.mediaType
      )
        return prior
      refuse('idempotency_conflict', 'upload id already names another upload')
    }
    const session = checked('UploadSession', {
      authorityId: store.authorityId,
      uploadId: input.uploadId,
      reservationId: randomUUID(),
      expectedBytes: input.size,
      receivedBytes: 0,
      expectedDigest: input.expectedDigest,
      mediaType: input.mediaType,
      status: 'uploading',
      revision: 1,
    })
    store.db
      .prepare('INSERT INTO uploads (upload_id, owner, scope, expires_at, session) VALUES (?, ?, ?, ?, ?)')
      .run(
        input.uploadId,
        owner,
        jcs(context.scope),
        store.now() + RuntimeArtifactPolicy.uploadReservationTtlMs,
        JSON.stringify(session),
      )
    return session
  })
}

function storedBytes(store: BlobStore, uploadId: Wire.Id, start: number, end: number): Uint8Array {
  const rows = store.db
    .prepare('SELECT at, bytes FROM upload_chunks WHERE upload_id = ? AND at < ? ORDER BY at')
    .all(uploadId, end) as { at: number; bytes: Uint8Array }[]
  const out = new Uint8Array(end - start)
  for (const row of rows) {
    const from = Math.max(start, row.at)
    const to = Math.min(end, row.at + row.bytes.byteLength)
    if (from < to) out.set(row.bytes.subarray(from - row.at, to - row.at), from - start)
  }
  return out
}

function* uploadChunks(store: BlobStore, uploadId: Wire.Id): Generator<Uint8Array> {
  const rows = store.db
    .prepare('SELECT bytes FROM upload_chunks WHERE upload_id = ? ORDER BY at')
    .iterate(uploadId) as Iterable<{ bytes: Uint8Array }>
  for (const row of rows) yield row.bytes
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0
}

function uploading(row: UploadRow | undefined): { row: UploadRow; session: Wire.UploadSession } {
  if (!row) refuse('not_found', 'no such upload')
  const session = JSON.parse(row.session) as Wire.UploadSession
  if (row.deleted || session.status !== 'uploading')
    refuse('revision_conflict', 'upload is not accepting bytes')
  return { row, session }
}

/**
 * The module-internal byte path. EffectPorts.upload does not yet carry an offset or seal payload,
 * so tests and the default store write through this writer until that payload is frozen.
 */
export type UploadWriter = Readonly<{
  write(offset: number, bytes: Uint8Array): Outcome<Wire.UploadSession>
  seal(): Promise<Outcome<Wire.UploadResult>>
  close(): void
}>

function attempt<T>(body: () => T): Outcome<T> {
  try {
    return { ok: true, value: body() }
  } catch (caught) {
    if (caught instanceof BlobRefusal) return { ok: false, error: caught.error }
    return { ok: false, error: blobError('internal_error', 'blob store failed') }
  }
}

function writeChunk(store: BlobStore, uploadId: Wire.Id, offset: number, bytes: Uint8Array) {
  if (!Number.isSafeInteger(offset) || offset < 0) refuse('invalid_request', 'chunk offset is not valid')
  if (bytes.byteLength === 0 || bytes.byteLength > UPLOAD_CHUNK_BYTES)
    refuse('invalid_request', 'chunk size is not valid')
  return store.write(() => {
    const { session } = uploading(loadUpload(store, uploadId))
    const end = offset + bytes.byteLength
    if (end > session.expectedBytes) refuse('invalid_request', 'chunk runs past the declared size')
    if (offset < session.receivedBytes) {
      // A resent chunk must repeat the acknowledged prefix exactly; it never overwrites it.
      if (end > session.receivedBytes) refuse('invalid_request', 'chunk overlaps the acknowledged prefix')
      if (!equalBytes(storedBytes(store, uploadId, offset, end), bytes))
        refuse('idempotency_conflict', 'chunk differs from the acknowledged prefix')
      return session
    }
    if (offset > session.receivedBytes) refuse('invalid_request', 'chunk leaves a gap')
    const next = checked('UploadSession', { ...session, receivedBytes: end, revision: session.revision + 1 })
    store.db
      .prepare('INSERT INTO upload_chunks (upload_id, at, bytes) VALUES (?, ?, ?)')
      .run(uploadId, offset, bytes)
    store.db.prepare('UPDATE uploads SET session = ? WHERE upload_id = ?').run(JSON.stringify(next), uploadId)
    return next
  })
}

async function seal(store: BlobStore, uploadId: Wire.Id): Promise<Wire.UploadResult> {
  const row = loadUpload(store, uploadId)
  if (row?.result) return JSON.parse(row.result) as Wire.UploadResult
  const { session } = uploading(row)
  if (session.receivedBytes !== session.expectedBytes) refuse('invalid_request', 'upload is incomplete')
  // Chunks are disjoint and gap-free (writeChunk refuses both), so in offset order they are the upload.
  // One pass hashes and a second writes, so at most one chunk is in memory at a time.
  const hash = createHash('sha256')
  let total = 0
  for (const chunk of uploadChunks(store, uploadId)) {
    hash.update(chunk)
    total += chunk.byteLength
  }
  if (total !== session.expectedBytes) refuse('integrity', 'upload chunks do not add up to its size')
  const digest = hash.digest('hex')
  if (session.expectedDigest !== null && session.expectedDigest !== digest)
    refuse('integrity', 'upload bytes do not match the expected digest')
  await createPrivateArtifactStore(store.dataDir, createPlatform().os).putChunks(
    digest,
    session.expectedBytes,
    uploadChunks(store, uploadId),
  )
  return store.write(() => {
    const current = loadUpload(store, uploadId)
    if (current?.result) return JSON.parse(current.result) as Wire.UploadResult
    const { session: open } = uploading(current)
    const pinId = randomUUID()
    const sealed = checked('UploadSession', { ...open, status: 'sealed', revision: open.revision + 1 })
    const result = checked('UploadResult', {
      upload: {
        authorityId: store.authorityId,
        uploadId,
        reservationId: open.reservationId,
        digest,
        bytes: open.expectedBytes,
        mediaType: open.mediaType,
        status: 'sealed',
      },
      retention: {
        kind: 'domain-record',
        authorityId: store.authorityId,
        resourceId: uploadId,
        version: '1',
        digest,
        pinId,
      },
    })
    // The sealed upload keeps a domain-record root until its owner releases it with unpin.
    store.db
      .prepare(
        "INSERT INTO roots (pin_id, target, target_id, revision, active) VALUES (?, 'upload', ?, 1, 1)",
      )
      .run(pinId, uploadId)
    store.db
      .prepare('UPDATE uploads SET session = ?, result = ?, digest = ? WHERE upload_id = ?')
      .run(JSON.stringify(sealed), JSON.stringify(result), digest, uploadId)
    store.db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId)
    return result
  })
}

/** Opens the single writer of one upload. Only its owner may write, and only while it is uploading. */
export function openUploadWriter(
  store: BlobStore,
  uploadId: Wire.Id,
  context: CallContext,
): Outcome<UploadWriter> {
  return attempt(() => {
    const { row } = uploading(loadUpload(store, uploadId))
    if (row.owner !== ownerOf(context)) refuse('permission_denied', 'caller does not own this upload')
    if (store.writers.has(uploadId)) refuse('revision_conflict', 'upload already has a writer')
    store.writers.add(uploadId)
    let closed = false
    const live = () => {
      if (closed) refuse('revision_conflict', 'upload writer is closed')
    }
    return Object.freeze({
      write: (offset: number, bytes: Uint8Array) =>
        attempt(() => {
          live()
          return writeChunk(store, uploadId, offset, bytes)
        }),
      async seal() {
        try {
          live()
          return { ok: true as const, value: await seal(store, uploadId) }
        } catch (caught) {
          if (caught instanceof BlobRefusal) return { ok: false as const, error: caught.error }
          return { ok: false as const, error: blobError('internal_error', 'blob store failed') }
        }
      },
      close() {
        closed = true
        store.writers.delete(uploadId)
      },
    })
  })
}
