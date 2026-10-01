import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeErrorDetails, type RuntimeWireTypes, validateRuntime } from '@agnes/protocol/runtime'
import { syncCheckpointsToMedium } from '../../adapters/sqlite-durability.js'
import { openPrivateArtifactDatabase } from '../../private-artifact-store.js'

type Detail = keyof typeof RuntimeErrorDetails

export function artifactsError(detail: Detail, message: string): Wire.RuntimeError {
  return {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'artifacts-service',
  }
}

/** Thrown inside a store body so the whole transaction rolls back and the caller gets the refusal. */
export class ArtifactsRefusal extends Error {
  readonly error: Wire.RuntimeError
  constructor(error: Wire.RuntimeError) {
    super(error.message)
    this.error = error
  }
}

export function refuse(detail: Detail, message: string): never {
  throw new ArtifactsRefusal(artifactsError(detail, message))
}

/** Returns the value of a delegated call or rethrows its own refusal unchanged. */
export function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new ArtifactsRefusal(outcome.error)
  return outcome.value
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

export const digestOf = (value: unknown): Wire.Digest => createHash('sha256').update(jcs(value)).digest('hex')

const SCOPE_KEYS = ['installationId', 'runtimeId', 'workspaceId', 'sessionId', 'runId', 'actionId'] as const

/** True when `inner` names the same scope as `outer` or one nested inside it. */
export function within(inner: Wire.ScopeRef, outer: Wire.ScopeRef): boolean {
  const a = inner as Partial<Record<(typeof SCOPE_KEYS)[number], string>>
  const b = outer as Partial<Record<(typeof SCOPE_KEYS)[number], string>>
  return SCOPE_KEYS.every((key) => b[key] === undefined || a[key] === b[key])
}

const DDL = [
  'CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT PRIMARY KEY, owner TEXT NOT NULL, latest_version INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS reservations (
    publication_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version INTEGER NOT NULL,
    reserve_fingerprint TEXT NOT NULL, publish_fingerprint TEXT, record TEXT NOT NULL, UNIQUE (artifact_id, version))`,
  `CREATE TABLE IF NOT EXISTS grants (
    grant_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS grants_artifact ON grants (artifact_id, version)',
  `CREATE TABLE IF NOT EXISTS requests (
    method TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY (method, request_id))`,
  `CREATE TABLE IF NOT EXISTS tickets (
    ticket_id TEXT PRIMARY KEY, actor TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, nonce_digest TEXT NOT NULL, sealed TEXT NOT NULL, key_version TEXT NOT NULL,
    artifact_id TEXT NOT NULL, version INTEGER NOT NULL, disposition TEXT NOT NULL, grant_id TEXT NOT NULL,
    grant_revision INTEGER NOT NULL, pin_id TEXT NOT NULL, expires_at INTEGER NOT NULL, UNIQUE (actor, request_id))`,
  `CREATE TABLE IF NOT EXISTS outbox (
    event_key TEXT PRIMARY KEY, publication_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
    reason TEXT, delivery TEXT NOT NULL, created_at INTEGER NOT NULL)`,
]

export type ArtifactsStore = {
  readonly db: DatabaseSync
  readonly authorityId: Wire.Id
  readonly now: () => number
  transaction<T>(body: () => T): T
  close(): void
}

/** The publication store is its own file, never shared with the selected blob service. */
export function openArtifactsStore(options: {
  dataDir: string
  authorityId: Wire.Id
  now?: () => number
}): ArtifactsStore {
  const db = openPrivateArtifactDatabase(options.dataDir, 'artifacts-service.db', 'artifacts service store')
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
  let closed = false
  const live = () => {
    if (closed) refuse('blocked', 'artifacts service is closed')
    return db
  }
  return {
    // Every read and transaction goes through `live`, so a call after close is refused with a stable
    // code instead of failing on the closed database.
    get db() {
      return live()
    },
    authorityId: options.authorityId,
    now: options.now ?? (() => Date.now()),
    close() {
      if (closed) return
      closed = true
      db.close()
    },
    transaction(body) {
      live()
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

/** The committed action the Host resolved for this call; a client cannot supply it. */
export type OwnerAction = Wire.ArtifactReservation['ownerAction']

/** The action methods of the selected blob service, carrying the binding the container selected. */
export type SelectedBlobActions = Readonly<{
  binding: Wire.BindingRef
  promote(request: Wire.BlobPromoteRequest, context: CallContext): Promise<Outcome<Wire.StagedBlobRef>>
  pin(request: Wire.BlobPinRequest, context: CallContext): Promise<Outcome<Wire.BlobRef>>
  inspect(request: Wire.BlobInspectRequest, context: CallContext): Promise<Outcome<Wire.BlobInspectResult>>
}>

export type ArtifactEvent = Readonly<{
  eventKey: string
  kind: 'ready' | 'revoked'
  reservation: Wire.ArtifactReservation
}>

type ReservationRow = { reserve_fingerprint: string; publish_fingerprint: string | null; record: string }

const byPublication = (store: ArtifactsStore, publicationId: Wire.Id) =>
  store.db
    .prepare(
      'SELECT reserve_fingerprint, publish_fingerprint, record FROM reservations WHERE publication_id = ?',
    )
    .get(publicationId) as ReservationRow | undefined

export function reservationOf(
  store: ArtifactsStore,
  artifactId: Wire.Id,
  version: number,
): Wire.ArtifactReservation | undefined {
  const row = store.db
    .prepare('SELECT record FROM reservations WHERE artifact_id = ? AND version = ?')
    .get(artifactId, version) as { record: string } | undefined
  return row && (JSON.parse(row.record) as Wire.ArtifactReservation)
}

export function grantsFor(store: ArtifactsStore, artifactId: Wire.Id, version: number) {
  const rows = store.db
    .prepare('SELECT record FROM grants WHERE artifact_id = ? AND version = ? ORDER BY grant_id')
    .all(artifactId, version) as { record: string }[]
  return rows.map((row) => JSON.parse(row.record) as Wire.ArtifactAccessGrantValue)
}

export function grantOf(store: ArtifactsStore, grantId: Wire.Id) {
  const row = store.db.prepare('SELECT record FROM grants WHERE grant_id = ?').get(grantId) as
    | { record: string }
    | undefined
  return row && (JSON.parse(row.record) as Wire.ArtifactAccessGrantValue)
}

function save(store: ArtifactsStore, record: Wire.ArtifactReservation, publishFingerprint?: string) {
  const sql =
    publishFingerprint === undefined
      ? 'UPDATE reservations SET record = ? WHERE publication_id = ?'
      : 'UPDATE reservations SET record = ?, publish_fingerprint = ? WHERE publication_id = ?'
  const args = publishFingerprint === undefined ? [] : [publishFingerprint]
  store.db.prepare(sql).run(JSON.stringify(record), ...args, record.publicationId)
}

function emit(
  store: ArtifactsStore,
  record: Wire.ArtifactReservation,
  kind: ArtifactEvent['kind'],
  reason?: string,
) {
  store.db
    .prepare(
      "INSERT INTO outbox (event_key, publication_id, kind, payload, reason, delivery, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    )
    .run(
      `${record.publicationId}:${kind}`,
      record.publicationId,
      kind,
      JSON.stringify(record),
      reason ?? null,
      store.now(),
    )
}

// ponytail: the right to add versions and grants is approximated by the owning session; switch to the
// Runtime's committed parent/child action edge and a current Policy check once both are available.
const ownerSession = (owner: OwnerAction) => jcs(owner.run.session)

function artifactOwner(store: ArtifactsStore, artifactId: Wire.Id): string | undefined {
  const row = store.db.prepare('SELECT owner FROM artifacts WHERE artifact_id = ?').get(artifactId) as
    | { owner: string }
    | undefined
  return row?.owner
}

const stateRefusal = (record: Wire.ArtifactReservation): never =>
  record.state === 'revoked'
    ? refuse('revoked', 'publication was revoked')
    : refuse('revision_conflict', `publication is ${record.state}`)

/**
 * Admits one publication. The publicationId plus its canonical input, owner action and binding is the
 * identity: a retry returns the original reservation even after its revision moved on. Only a first
 * admission compares expectedLatestVersion, and a version number is never handed out twice.
 */
export function reserve(
  store: ArtifactsStore,
  input: { request: unknown; owner: OwnerAction },
  context: CallContext,
): Wire.ArtifactReservation {
  const request = parse('ArtifactsReserveRequest', input.request)
  const ref = request.ownerActionRef
  if ('existingActionId' in ref && ref.existingActionId !== input.owner.actionId)
    refuse('permission_denied', 'owner action does not match the committed action')
  const fingerprint = digestOf({ request, owner: input.owner, bindingId: context.bindingId })
  return store.transaction(() => {
    const prior = byPublication(store, request.publicationId)
    if (prior) {
      if (prior.reserve_fingerprint === fingerprint)
        return JSON.parse(prior.record) as Wire.ArtifactReservation
      refuse('idempotency_conflict', 'publication id already names another reservation')
    }
    let artifactId = request.artifactId
    let version = 1
    if (artifactId === null) {
      artifactId = randomUUID()
      store.db
        .prepare('INSERT INTO artifacts (artifact_id, owner, latest_version) VALUES (?, ?, 1)')
        .run(artifactId, ownerSession(input.owner))
    } else {
      const row = store.db
        .prepare('SELECT owner, latest_version FROM artifacts WHERE artifact_id = ?')
        .get(artifactId) as { owner: string; latest_version: number } | undefined
      if (!row) refuse('not_found', 'no such artifact')
      if (row.owner !== ownerSession(input.owner))
        refuse('permission_denied', 'artifact belongs to another owner')
      if (row.latest_version !== request.expectedLatestVersion)
        refuse('revision_conflict', 'artifact is not at the expected latest version')
      version = row.latest_version + 1
      store.db
        .prepare('UPDATE artifacts SET latest_version = ? WHERE artifact_id = ?')
        .run(version, artifactId)
    }
    const record = checked('ArtifactReservation', {
      publicationId: request.publicationId,
      artifactId,
      version,
      revision: 1,
      schema: request.schema,
      kind: request.kind,
      title: request.title,
      mediaType: request.mediaType,
      ownerAction: input.owner,
      state: 'reserved',
      source: null,
      pinId: null,
      failureRef: null,
      blob: null,
    })
    store.db
      .prepare(
        'INSERT INTO reservations (publication_id, artifact_id, version, reserve_fingerprint, record) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.publicationId, artifactId, version, fingerprint, JSON.stringify(record))
    return record
  })
}

/**
 * Moves a reservation to ready through the selected blob service: pending-publish is stored first,
 * then promote, then a pin owned by this artifact version, then a check of that pin; ready and its
 * outbox event commit together. Every step repeats safely, so a retry after a crash converges on the
 * same pin and a single ready event.
 */
export async function publish(
  store: ArtifactsStore,
  blob: SelectedBlobActions,
  input: { request: unknown; owner: OwnerAction },
  context: CallContext,
): Promise<Wire.ArtifactReservation> {
  const request = parse('ArtifactsPublishRequest', input.request)
  const fingerprint = digestOf({ request, owner: input.owner })
  const accepted = store.transaction(() => {
    const row = byPublication(store, request.publicationId)
    if (!row) refuse('not_found', 'no such publication')
    const record = JSON.parse(row.record) as Wire.ArtifactReservation
    if (row.publish_fingerprint !== null) {
      if (row.publish_fingerprint !== fingerprint)
        refuse('idempotency_conflict', 'publication already took another input')
      return record
    }
    if (jcs(record.ownerAction) !== jcs(input.owner))
      refuse('permission_denied', 'caller does not own this publication')
    if (record.state !== 'reserved') stateRefusal(record)
    if (record.revision !== request.expectedRevision)
      refuse('revision_conflict', 'publication is not at the expected revision')
    if (
      (record.title !== null && record.title !== request.title) ||
      (record.mediaType !== null && record.mediaType !== request.mediaType)
    )
      refuse('invalid_request', 'publish differs from the reserved title or media type')
    // A pinned BlobRef cannot be pinned again for this publication: pin takes a StagedBlobRef.
    if (request.source.kind !== 'upload')
      refuse('operation_not_supported', 'publishing from a pinned blob is not supported')
    if (request.source.upload.mediaType !== request.mediaType)
      refuse('invalid_request', 'media type differs from the sealed upload')
    const pending = checked('ArtifactReservation', {
      ...record,
      revision: record.revision + 1,
      title: request.title,
      mediaType: request.mediaType,
      state: 'pending-publish',
      source: request.source,
    })
    save(store, pending, fingerprint)
    return pending
  })
  if (accepted.state === 'ready') return accepted
  if (accepted.state !== 'pending-publish' || accepted.source.kind !== 'upload') return stateRefusal(accepted)
  const upload = accepted.source.upload
  const staged = unwrap(await blob.promote({ upload, expectedDigest: upload.digest }, context))
  const ownerRef: Wire.PublicRef = {
    kind: 'artifact',
    value: { artifactId: accepted.artifactId, version: accepted.version },
  }
  const pinned = unwrap(await blob.pin({ stagedBlob: staged, ownerRef, retentionUntil: null }, context))
  const seen = unwrap(await blob.inspect({ ref: { kind: 'blob', value: pinned } }, context))
  if (
    seen.status !== 'pinned' ||
    seen.digest !== upload.digest ||
    seen.bytes !== upload.bytes ||
    pinned.digest !== upload.digest ||
    pinned.bytes !== upload.bytes
  )
    refuse('integrity', 'blob service did not confirm the pin')
  return store.transaction(() => {
    const row = byPublication(store, request.publicationId)
    const record = JSON.parse(row?.record ?? 'null') as Wire.ArtifactReservation
    if (record.state === 'ready') return record
    if (record.state !== 'pending-publish' || record.revision !== accepted.revision) stateRefusal(record)
    const ready = checked('ArtifactReservation', {
      ...record,
      revision: record.revision + 1,
      state: 'ready',
      blob: pinned,
      pinId: pinned.pinId,
    })
    save(store, ready)
    emit(store, ready, 'ready')
    return ready
  })
}

/**
 * Records a definite failure from a committed failed or cancelled receipt of the owner action.
 * An unknown or successful receipt never fails a publication, and ready or revoked never reverts.
 */
export function fail(
  store: ArtifactsStore,
  input: { request: unknown; owner: OwnerAction; receipt: Wire.ReceiptRef },
): Wire.ArtifactReservation {
  const request = parse('ArtifactsFailRequest', input.request)
  const receipt = parse('ReceiptRef', input.receipt)
  return store.transaction(() => {
    const row = byPublication(store, request.publicationId)
    if (!row) refuse('not_found', 'no such publication')
    const record = JSON.parse(row.record) as Wire.ArtifactReservation
    if (jcs(record.ownerAction) !== jcs(input.owner))
      refuse('permission_denied', 'caller does not own this publication')
    if (record.state === 'failed') {
      if (jcs(record.failureRef) === jcs(request.failureRef)) return record
      refuse('idempotency_conflict', 'publication already failed with another receipt')
    }
    if (record.state === 'ready' || record.state === 'revoked') stateRefusal(record)
    if (record.revision !== request.expectedRevision)
      refuse('revision_conflict', 'publication is not at the expected revision')
    if (
      receipt.receiptId !== request.failureRef.receiptId ||
      receipt.actionId !== record.ownerAction.actionId
    )
      refuse('permission_denied', 'receipt does not belong to the publication owner')
    if (receipt.outcome !== 'failed' && receipt.outcome !== 'cancelled')
      refuse('invalid_request', 'only a failed or cancelled receipt fails a publication')
    const failed = checked('ArtifactReservation', {
      ...record,
      revision: record.revision + 1,
      state: 'failed',
      failureRef: request.failureRef,
      pinId: record.blob?.pinId ?? null,
    })
    save(store, failed)
    return failed
  })
}

/** Revokes one exact artifact version; other versions stay readable. */
export function revoke(store: ArtifactsStore, request: unknown): Wire.ArtifactReservation {
  const { artifactRef, reason } = parse('ArtifactsRevokeRequest', request)
  return store.transaction(() => {
    const record = reservationOf(store, artifactRef.artifactId, artifactRef.version)
    if (!record) refuse('not_found', 'no such artifact version')
    if (record.state === 'revoked') return record
    const revoked = checked('ArtifactReservation', {
      ...record,
      revision: record.revision + 1,
      state: 'revoked',
    })
    save(store, revoked)
    emit(store, revoked, 'revoked', reason)
    return revoked
  })
}

function replay(store: ArtifactsStore, method: string, requestId: Wire.Id, fingerprint: string) {
  const row = store.db
    .prepare('SELECT fingerprint, result FROM requests WHERE method = ? AND request_id = ?')
    .get(method, requestId) as { fingerprint: string; result: string } | undefined
  if (!row) return undefined
  if (row.fingerprint !== fingerprint)
    refuse('idempotency_conflict', 'request id already names another request')
  return grantOf(store, row.result) ?? refuse('internal_error', 'stored grant is missing')
}

function remember(
  store: ArtifactsStore,
  method: string,
  requestId: Wire.Id,
  fingerprint: string,
  result: string,
) {
  store.db
    .prepare('INSERT INTO requests (method, request_id, fingerprint, result) VALUES (?, ?, ?, ?)')
    .run(method, requestId, fingerprint, result)
}

/**
 * Grants read or download on one artifact version. The Host has already checked the creator's
 * delegation and names it by sourceAuthorizationRef; the grant scope can only narrow the caller's.
 */
export function grant(
  store: ArtifactsStore,
  input: { request: unknown; owner: OwnerAction; sourceAuthorizationRef: Wire.Id },
  context: CallContext,
): Wire.ArtifactAccessGrantValue {
  const request = parse('ArtifactsGrantRequest', input.request)
  const fingerprint = digestOf({ request, owner: input.owner, source: input.sourceAuthorizationRef })
  return store.transaction(() => {
    const prior = replay(store, 'grant', request.requestId, fingerprint)
    if (prior) return prior
    if (!within(request.scope, context.scope))
      refuse('permission_denied', 'grant scope is wider than the caller scope')
    if (request.expiresAt !== null && Date.parse(request.expiresAt) <= store.now())
      refuse('invalid_request', 'grant already expired')
    const { artifactId, version } = request.artifactRef
    const record = reservationOf(store, artifactId, version)
    if (!record) refuse('not_found', 'no such artifact version')
    if (artifactOwner(store, artifactId) !== ownerSession(input.owner))
      refuse('permission_denied', 'caller may not delegate this artifact')
    if (record.state === 'revoked') refuse('revoked', 'artifact version was revoked')
    const value = checked('ArtifactAccessGrantValue', {
      grantId: randomUUID(),
      artifact: request.artifactRef,
      granteePrincipalRef: request.granteePrincipalRef,
      scope: request.scope,
      permissions: request.permissions,
      expiresAt: request.expiresAt,
      revision: 1,
      status: 'active',
      sourceAuthorizationRef: input.sourceAuthorizationRef,
    })
    store.db
      .prepare('INSERT INTO grants (grant_id, artifact_id, version, record) VALUES (?, ?, ?, ?)')
      .run(value.grantId, artifactId, version, JSON.stringify(value))
    remember(store, 'grant', request.requestId, fingerprint, value.grantId)
    return value
  })
}

/** Revokes this one grant; tickets issued under it stop working at their next check. */
export function revokeGrant(
  store: ArtifactsStore,
  input: { request: unknown; owner: OwnerAction },
): Wire.ArtifactAccessGrantValue {
  const request = parse('ArtifactsRevokeGrantRequest', input.request)
  const fingerprint = digestOf({ request, owner: input.owner })
  return store.transaction(() => {
    const prior = replay(store, 'revokeGrant', request.requestId, fingerprint)
    if (prior) return prior
    const current = grantOf(store, request.grantId)
    if (!current) refuse('not_found', 'no such grant')
    if (artifactOwner(store, current.artifact.artifactId) !== ownerSession(input.owner))
      refuse('permission_denied', 'caller may not delegate this artifact')
    if (current.status !== 'active' || current.revision !== request.expectedRevision)
      refuse('revision_conflict', 'grant is not at the expected revision')
    const revoked = checked('ArtifactAccessGrantValue', {
      ...current,
      revision: current.revision + 1,
      status: 'revoked',
    })
    store.db
      .prepare('UPDATE grants SET record = ? WHERE grant_id = ?')
      .run(JSON.stringify(revoked), revoked.grantId)
    remember(store, 'revokeGrant', request.requestId, fingerprint, revoked.grantId)
    return revoked
  })
}

/** Events committed with their state change and not yet delivered. Delivery is wired elsewhere. */
export function pendingEvents(store: ArtifactsStore): readonly ArtifactEvent[] {
  const rows = store.db
    .prepare(
      "SELECT event_key, kind, payload FROM outbox WHERE delivery = 'pending' ORDER BY created_at, event_key",
    )
    .all() as { event_key: string; kind: ArtifactEvent['kind']; payload: string }[]
  return rows.map((row) => ({
    eventKey: row.event_key,
    kind: row.kind,
    reservation: checked('ArtifactReservation', JSON.parse(row.payload)),
  }))
}

export function viewOf(record: Wire.ArtifactReservation): Wire.ArtifactViewRef {
  const source = record.source
  const size =
    record.blob?.bytes ??
    (source === null ? null : source.kind === 'upload' ? source.upload.bytes : source.blob.bytes)
  return checked('ArtifactViewRef', {
    artifactId: record.artifactId,
    version: record.version,
    title: record.title,
    mime: record.mediaType,
    size: record.state === 'reserved' ? null : size,
    status: record.state,
  })
}
