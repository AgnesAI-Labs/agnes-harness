import { createHash, randomUUID } from 'node:crypto'
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

export const sha256 = (bytes: Uint8Array): Wire.Digest => createHash('sha256').update(bytes).digest('hex')

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
    session TEXT NOT NULL, result TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id TEXT NOT NULL, at INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (upload_id, at))`,
  `CREATE TABLE IF NOT EXISTS blobs (
    blob_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL UNIQUE, staged TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS roots (
    pin_id TEXT PRIMARY KEY, target TEXT NOT NULL, target_id TEXT NOT NULL, owner TEXT, owner_key TEXT,
    retention_until INTEGER, revision INTEGER NOT NULL, active INTEGER NOT NULL, blob TEXT)`,
  'CREATE INDEX IF NOT EXISTS roots_target ON roots (target, target_id, active)',
]

export type BlobStore = {
  readonly db: DatabaseSync
  readonly dataDir: string
  readonly authorityId: Wire.Id
  readonly now: () => number
  /** Uploads with an open writer in this process. A restarted process has none, so old writers are stopped. */
  readonly writers: Set<Wire.Id>
  transaction<T>(body: () => T): T
}

export function openBlobStore(options: {
  dataDir: string
  authorityId: Wire.Id
  now?: () => number
}): BlobStore {
  const db = openPrivateArtifactDatabase(options.dataDir, 'blob-service.db', 'blob service store')
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    syncCheckpointsToMedium(db)
    for (const statement of DDL) db.exec(statement)
  } catch (error) {
    db.close()
    throw error
  }
  return {
    db,
    dataDir: options.dataDir,
    authorityId: options.authorityId,
    now: options.now ?? (() => Date.now()),
    writers: new Set(),
    transaction(body) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = body()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
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
  return store.transaction(() => {
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
  return store.transaction(() => {
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
  const bytes = storedBytes(store, uploadId, 0, session.expectedBytes)
  const digest = sha256(bytes)
  if (session.expectedDigest !== null && session.expectedDigest !== digest)
    refuse('integrity', 'upload bytes do not match the expected digest')
  // ponytail: the whole upload is held in memory for the private CAS writer; a streaming writer is
  // needed before uploads near the 1 GiB limit are routine.
  await createPrivateArtifactStore(store.dataDir, createPlatform().os).put(digest, bytes)
  return store.transaction(() => {
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
      .prepare('UPDATE uploads SET session = ?, result = ? WHERE upload_id = ?')
      .run(JSON.stringify(sealed), JSON.stringify(result), uploadId)
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
