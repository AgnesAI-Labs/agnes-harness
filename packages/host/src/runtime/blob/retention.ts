import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { type BlobStore, checked, contentPath, loadUpload, parse, refuse, within } from './uploads.js'

type BlobRow = { blob_id: string; upload_id: string; staged: string; digest: string; deleted: number }
type RootRow = {
  pin_id: string
  target: 'upload' | 'blob'
  target_id: string
  owner: string | null
  retention_until: number | null
  revision: number
  active: number
  blob: string | null
}

const loadBlob = (store: BlobStore, blobId: Wire.Id) =>
  store.db.prepare('SELECT * FROM blobs WHERE blob_id = ?').get(blobId) as BlobRow | undefined

const loadRoot = (store: BlobStore, pinId: Wire.Id) =>
  store.db.prepare('SELECT * FROM roots WHERE pin_id = ?').get(pinId) as RootRow | undefined

const isLive = (store: BlobStore, root: RootRow) =>
  root.active === 1 && (root.retention_until === null || root.retention_until > store.now())

function liveRoots(store: BlobStore, target: RootRow['target'], targetId: Wire.Id): RootRow[] {
  const rows = store.db
    .prepare('SELECT * FROM roots WHERE target = ? AND target_id = ? AND active = 1 ORDER BY pin_id')
    .all(target, targetId) as RootRow[]
  return rows.filter((root) => isLive(store, root))
}

const ownersOf = (roots: readonly RootRow[]) => roots.map((root) => JSON.parse(root.owner ?? 'null'))

type DeletionKind =
  | 'upload-aborted'
  | 'upload-deleted'
  | 'blob-deleted'
  | 'pin-released'
  | 'content-unlink-pending'
  | 'content-unlinked'
  | 'content-retained'

/** Appends to the deletion log inside the caller's transaction; its last seq is the watermark. */
function logDeletion(store: BlobStore, kind: DeletionKind, ref: string, digest: Wire.Digest | null = null) {
  store.db
    .prepare('INSERT INTO deletions (kind, ref, digest, at) VALUES (?, ?, ?, ?)')
    .run(kind, ref, digest, store.now())
}

/**
 * Content stays while an undeleted staged blob, or a sealed upload that can still be promoted, names
 * its digest. A promoted upload counts through its blob row, which gc may have deleted.
 */
const contentInUse = (store: BlobStore, digest: Wire.Digest) =>
  store.db
    .prepare(
      `SELECT 1 FROM blobs WHERE digest = ? AND deleted = 0
       UNION ALL SELECT 1 FROM uploads u WHERE u.digest = ? AND u.deleted = 0
         AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.upload_id = u.upload_id)
       LIMIT 1`,
    )
    .get(digest, digest) !== undefined

/**
 * The second phase of a content deletion, after the collect committed. Each digest still pending is
 * unlinked, or retained when an upload sealed the same content again since; a missing file counts as
 * unlinked. Unlink and record share one gated transaction, so a failed record only leaves the digest
 * pending and the next gc completes it.
 * ponytail: a seal commits in the same macrotask its content file lands, so an in-process gc cannot
 * unlink content between the two; a seal that awaits I/O there needs a content check in its commit.
 */
function finishUnlinks(store: BlobStore) {
  const pending = store.db
    .prepare(
      `SELECT DISTINCT p.digest FROM deletions p WHERE p.kind = 'content-unlink-pending' AND NOT EXISTS (
         SELECT 1 FROM deletions d WHERE d.kind IN ('content-unlinked', 'content-retained')
           AND d.digest = p.digest AND d.seq > p.seq)`,
    )
    .all() as { digest: Wire.Digest }[]
  for (const { digest } of pending) {
    try {
      store.write(() => {
        if (contentInUse(store, digest)) return logDeletion(store, 'content-retained', digest, digest)
        rmSync(contentPath(store, digest), { force: true })
        logDeletion(store, 'content-unlinked', digest, digest)
      })
    } catch {
      // Still pending: the next gc completes it.
    }
  }
}

/** A sealed upload becomes one staged content object; repeating the promote returns the same object. */
export function promote(store: BlobStore, request: unknown): Wire.StagedBlobRef {
  const { upload, expectedDigest } = parse('BlobPromoteRequest', request)
  if (upload.authorityId !== store.authorityId) refuse('not_found', 'upload belongs to another authority')
  if (expectedDigest !== upload.digest) refuse('integrity', 'expected digest differs from the sealed upload')
  return store.write(() => {
    const row = loadUpload(store, upload.uploadId)
    if (!row?.result) refuse('not_found', 'no such sealed upload')
    const sealed = JSON.parse(row.result) as Wire.UploadResult
    if (jcs(sealed.upload) !== jcs(upload)) refuse('not_found', 'upload reference does not match')
    const prior = store.db.prepare('SELECT * FROM blobs WHERE upload_id = ?').get(upload.uploadId) as
      | BlobRow
      | undefined
    if (prior?.deleted) refuse('artifact_deleted', 'staged blob was collected')
    if (prior) return JSON.parse(prior.staged) as Wire.StagedBlobRef
    const staged = checked('StagedBlobRef', {
      authorityId: store.authorityId,
      blobId: randomUUID(),
      digest: upload.digest,
      bytes: upload.bytes,
      mediaType: upload.mediaType,
      reservationId: randomUUID(),
    })
    store.db
      .prepare('INSERT INTO blobs (blob_id, upload_id, staged, digest) VALUES (?, ?, ?, ?)')
      .run(staged.blobId, upload.uploadId, jcs(staged), staged.digest)
    return staged
  })
}

/** One live pin per content object and owner; a retry with the same owner returns that pin. */
export function pin(store: BlobStore, request: unknown): Wire.BlobRef {
  const { stagedBlob, ownerRef, retentionUntil } = parse('BlobPinRequest', request)
  const until = retentionUntil === null ? null : Date.parse(retentionUntil)
  if (until !== null && until <= store.now()) refuse('invalid_request', 'retention already ended')
  return store.write(() => {
    const blob = loadBlob(store, stagedBlob.blobId)
    if (!blob || blob.staged !== jcs(stagedBlob)) refuse('not_found', 'no such staged blob')
    if (blob.deleted) refuse('artifact_deleted', 'staged blob was collected')
    const ownerKey = jcs(ownerRef)
    const prior = liveRoots(store, 'blob', blob.blob_id).find((root) => root.owner === ownerKey)
    if (prior) {
      if (prior.retention_until !== until) refuse('idempotency_conflict', 'owner already pins this blob')
      return JSON.parse(prior.blob ?? 'null') as Wire.BlobRef
    }
    const ref = checked('BlobRef', {
      authorityId: store.authorityId,
      blobId: blob.blob_id,
      digest: stagedBlob.digest,
      bytes: stagedBlob.bytes,
      mediaType: stagedBlob.mediaType,
      pinId: randomUUID(),
    })
    store.db
      .prepare(
        `INSERT INTO roots (pin_id, target, target_id, owner, owner_key, retention_until, revision, active, blob)
         VALUES (?, 'blob', ?, ?, ?, ?, 1, 1, ?)`,
      )
      .run(ref.pinId, blob.blob_id, ownerKey, ownerKey, until, jcs(ref))
    return ref
  })
}

/** Releases one pin or sealed-upload root. Releasing a released root changes nothing. */
export function unpin(store: BlobStore, request: unknown): Wire.BlobUnpinResult {
  const { pinId, expectedRevision } = parse('BlobUnpinRequest', request)
  return store.write(() => {
    const root = loadRoot(store, pinId)
    if (!root) refuse('not_found', 'no such pin')
    if (root.active === 0) return { released: false }
    if (root.revision !== expectedRevision) refuse('revision_conflict', 'pin is not at the expected revision')
    store.db
      .prepare('UPDATE roots SET active = 0, revision = ? WHERE pin_id = ?')
      .run(root.revision + 1, pinId)
    logDeletion(store, 'pin-released', pinId)
    return { released: true }
  })
}

/**
 * Resolves the exact pin a read names. A released or expired pin no longer grants reads, even when
 * other owners still pin the same content.
 */
export function resolvePin(store: BlobStore, ref: Wire.BlobRef): void {
  const root = loadRoot(store, ref.pinId)
  if (root?.target !== 'blob' || root.blob !== jcs(ref)) refuse('not_found', 'no such pinned blob')
  if (loadBlob(store, root.target_id)?.deleted) refuse('artifact_deleted', 'blob was collected')
  if (!isLive(store, root)) refuse('revoked', 'pin was released')
}

export function inspect(store: BlobStore, request: unknown): Wire.BlobInspectResult {
  const { ref } = parse('BlobInspectRequest', request)
  if (ref.value.authorityId !== store.authorityId)
    refuse('not_found', 'reference belongs to another authority')
  if (ref.kind === 'upload') {
    const row = loadUpload(store, ref.value.uploadId)
    const session = row ? (JSON.parse(row.session) as Wire.UploadSession) : undefined
    if (!row || session?.reservationId !== ref.value.reservationId) refuse('not_found', 'no such upload')
    const status = row.deleted ? 'deleted' : session.status
    const digest =
      status === 'sealed' ? (JSON.parse(row.result ?? 'null') as Wire.UploadResult).upload.digest : null
    return checked('BlobInspectResult', { status, bytes: session.receivedBytes, digest, ownerRefs: [] })
  }
  let blob: BlobRow | undefined
  let pinned: boolean
  if (ref.kind === 'staged-blob') {
    blob = loadBlob(store, ref.value.blobId)
    if (!blob || blob.staged !== jcs(ref.value)) refuse('not_found', 'no such staged blob')
    pinned = liveRoots(store, 'blob', blob.blob_id).length > 0
  } else {
    const root = loadRoot(store, ref.value.pinId)
    if (root?.target !== 'blob' || root.blob !== jcs(ref.value)) refuse('not_found', 'no such pin')
    blob = loadBlob(store, root.target_id)
    pinned = isLive(store, root)
  }
  if (!blob) refuse('not_found', 'no such blob')
  const staged = JSON.parse(blob.staged) as Wire.StagedBlobRef
  const owners = blob.deleted ? [] : ownersOf(liveRoots(store, 'blob', blob.blob_id))
  return checked('BlobInspectResult', {
    status: blob.deleted ? 'deleted' : pinned ? 'pinned' : 'staged',
    bytes: staged.bytes,
    digest: staged.digest,
    ownerRefs: owners,
  })
}

type Candidate = {
  key: string
  eligible: boolean
  ref: Wire.PublicRef
  collect(): { ref?: Wire.PublicRef; deleted: boolean }
}

/**
 * Trusted cleanup. An uploading reservation turns aborted only after its owner scope is inside the
 * request scope, its TTL has passed, no writer is open and it has no root; a later pass deletes the
 * aborted bytes. A staged blob is tombstoned once no pin and no sealed-upload root holds it. Every
 * collect is logged in its transaction. The content directory belongs to this store alone
 * (runtimeServiceDataDir gives each service its own data directory), so its rows prove a digest
 * unreferenced: the collect marks the file pending in its transaction and gc unlinks it after commit.
 */
export function gc(store: BlobStore, request: unknown, context: CallContext): Wire.BlobGcResult {
  const input = parse('BlobGcRequest', request)
  if (input.limit < 1 || input.limit > 10_000) refuse('invalid_request', 'gc limit must be 1 to 10000')
  if (!within(input.scopeRef, context.scope))
    refuse('permission_denied', 'gc scope is outside the caller scope')
  const inScope = (scope: string) => within(JSON.parse(scope) as Wire.ScopeRef, input.scopeRef)
  const result = store.write(() => {
    const now = store.now()
    const candidates: Candidate[] = []
    const uploads = store.db
      .prepare(
        'SELECT upload_id, scope, expires_at, session FROM uploads WHERE deleted = 0 AND result IS NULL',
      )
      .all() as { upload_id: string; scope: string; expires_at: number; session: string }[]
    for (const row of uploads) {
      const session = JSON.parse(row.session) as Wire.UploadSession
      const free = inScope(row.scope) && liveRoots(store, 'upload', row.upload_id).length === 0
      if (session.status === 'uploading')
        candidates.push({
          key: `upload:${row.upload_id}`,
          eligible: free && now >= row.expires_at && !store.writers.has(row.upload_id),
          ref: { kind: 'upload', value: session },
          collect() {
            const aborted = checked('UploadSession', {
              ...session,
              status: 'aborted',
              revision: session.revision + 1,
            })
            store.db
              .prepare('UPDATE uploads SET session = ? WHERE upload_id = ?')
              .run(JSON.stringify(aborted), row.upload_id)
            logDeletion(store, 'upload-aborted', row.upload_id)
            return { ref: { kind: 'upload', value: aborted }, deleted: false }
          },
        })
      else
        candidates.push({
          key: `upload:${row.upload_id}`,
          eligible: free,
          ref: { kind: 'upload', value: session },
          collect() {
            store.db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(row.upload_id)
            store.db.prepare('UPDATE uploads SET deleted = 1 WHERE upload_id = ?').run(row.upload_id)
            logDeletion(store, 'upload-deleted', row.upload_id)
            return { deleted: true }
          },
        })
    }
    const blobs = store.db
      .prepare(
        'SELECT b.blob_id, b.upload_id, b.staged, b.digest, u.scope FROM blobs b JOIN uploads u USING (upload_id) WHERE b.deleted = 0',
      )
      .all() as { blob_id: string; upload_id: string; staged: string; digest: string; scope: string }[]
    for (const row of blobs)
      candidates.push({
        key: `blob:${row.blob_id}`,
        eligible:
          inScope(row.scope) &&
          liveRoots(store, 'blob', row.blob_id).length === 0 &&
          liveRoots(store, 'upload', row.upload_id).length === 0,
        ref: { kind: 'staged-blob', value: JSON.parse(row.staged) },
        collect() {
          store.db.prepare('UPDATE blobs SET deleted = 1 WHERE blob_id = ?').run(row.blob_id)
          logDeletion(store, 'blob-deleted', row.blob_id, row.digest)
          if (!contentInUse(store, row.digest))
            logDeletion(store, 'content-unlink-pending', row.digest, row.digest)
          return { deleted: true }
        },
      })
    // ponytail: candidates are listed in memory per call; page in SQL once stores hold many uploads.
    candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const pending = candidates.filter((item) => input.cursor === null || item.key > input.cursor)
    const eligibleRefs: Wire.PublicRef[] = []
    const deletedRefs: Wire.PublicRef[] = []
    let last: string | null = null
    for (const item of pending) {
      if (eligibleRefs.length === input.limit) break
      last = item.key
      if (!item.eligible) continue
      if (input.dryRun) {
        eligibleRefs.push(item.ref)
        continue
      }
      const done = item.collect()
      const ref = done.ref ?? item.ref
      eligibleRefs.push(ref)
      if (done.deleted) deletedRefs.push(ref)
    }
    const more = last !== null && pending[pending.length - 1]?.key !== last
    return checked('BlobGcResult', { eligibleRefs, deletedRefs, nextCursor: more ? last : null })
  })
  if (!input.dryRun) finishUnlinks(store)
  return result
}
