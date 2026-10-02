import { createHash, createHmac, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactAccessPort,
  BlobReadPort,
  ByteReadStream,
  CallContext,
  Outcome,
  ScopedDependencies,
  ServiceRequirement,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeArtifactPolicy,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  RuntimeErrorDetails,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const ARTIFACTS_PROVIDER = { id: 'reference.artifacts', contract: 'agh.artifacts' } as const

/** The agh.blob service this provider reads every byte through; it keeps no copy of its own. */
export const BLOB_DEPENDENCY: ServiceRequirement = {
  contract: 'agh.blob',
  major: 1,
  logicalName: 'content',
  features: ['blob-read.v1'],
  scope: 'runtime',
  optional: false,
}

type Detail = keyof typeof RuntimeErrorDetails
type Permission = Wire.ArtifactAccessGrantValue['permissions'][number]

class Refusal extends Error {
  readonly error: Wire.RuntimeError
  constructor(error: Wire.RuntimeError) {
    super(error.message)
    this.error = error
  }
}

const failure = (detail: Detail, message: string): Wire.RuntimeError => ({
  code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
  detailCode: detail,
  message,
  retryAdvice: { kind: 'never' },
  diagnosticId: 'reference-artifacts',
})

function refuse(detail: Detail, message: string): never {
  throw new Refusal(failure(detail, message))
}

const errorOf = (caught: unknown): Wire.RuntimeError =>
  caught instanceof Refusal ? caught.error : failure('internal_error', 'artifacts store failed')

/** A delegated call's value, or its refusal passed on unchanged. */
function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Refusal(outcome.error)
  return outcome.value
}

function parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) refuse('invalid_request', `${name} does not match its schema`)
  return result.value
}

function own<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) throw new Error(`${name} failed its own schema`)
  return result.value
}

async function attempt<T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: failure('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (caught) {
    return { ok: false, error: errorOf(caught) }
  }
}

/** Every scope field the grant names must match the caller's; fields it leaves out are open. */
const inside = (caller: Wire.ScopeRef, granted: Wire.ScopeRef) =>
  Object.entries(granted).every(
    ([key, value]) => key === 'kind' || (caller as Record<string, unknown>)[key] === value,
  )

export type ArtifactsStoreOptions = Readonly<{
  /** Resolves the selected agh.blob service. */
  dependencies: ScopedDependencies
  /** The Host's current check of a caller holding a grant. Without one every access is refused as blocked. */
  authorize?: (context: CallContext, grant: Wire.ArtifactAccessGrantValue) => boolean
  /** Secret that ticket nonces are derived from. Without one, openDownload is refused as blocked. */
  ticketKey?: Uint8Array
  /** A profile's ticket lifetime. The contract's own lifetime still caps it. */
  ticketTtlMs?: number
  now?: () => number
}>

/**
 * Versions point at a BlobRef of the selected blob service. Grants are stored whole. A ticket row keeps
 * no nonce: the nonce is an HMAC of the ticket id, so a repeated request rebuilds the same URL.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
CREATE TABLE IF NOT EXISTS access_grants (
  grant_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS download_tickets (
  actor TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  ticket_id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  grant_revision INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (actor, request_id)
);`

type VersionRow = {
  artifact_id: string
  version: number
  revoked: number
  title: string
  media_type: string
  blob: string
}

type TicketRow = {
  fingerprint: string
  ticket_id: string
  artifact_id: string
  version: number
  grant_revision: number
  expires_ms: number
}

/** Opens the store over the blob service the container selects; a selection without a read port is refused. */
export function openArtifactsStore(path: string, options: ArtifactsStoreOptions) {
  const selected = options.dependencies.get(BLOB_DEPENDENCY)
  if (!selected.ok) throw new Error(`no blob service is selected: ${selected.error.detailCode}`)
  const blobRead: BlobReadPort | undefined = selected.value.blobRead
  if (!blobRead) throw new Error('the selected blob service has no read port')
  const now = options.now ?? (() => Date.now())
  const lifetime = Math.min(RuntimeArtifactPolicy.downloadTicketTtlMs, options.ticketTtlMs ?? Infinity)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(TABLES)
  let open = true

  const live = () => {
    if (!open) refuse('blocked', 'artifacts store is closed')
  }
  function atomically<T>(body: () => T): T {
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
  }
  const versionOf = (artifactId: Wire.Id, version: number) =>
    db
      .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(artifactId, version) as VersionRow | undefined
  const grantOf = (grantId: Wire.Id) => {
    const row = db.prepare('SELECT value FROM access_grants WHERE grant_id = ?').get(grantId) as
      | { value: string }
      | undefined
    return row && (JSON.parse(row.value) as Wire.ArtifactAccessGrantValue)
  }

  const allows = (grant: Wire.ArtifactAccessGrantValue, context: CallContext, permission: Permission) =>
    grant.status === 'active' &&
    grant.granteePrincipalRef === context.principalRef &&
    grant.permissions.includes(permission) &&
    (grant.expiresAt === null || Date.parse(grant.expiresAt) > now()) &&
    inside(context.scope, grant.scope) &&
    options.authorize?.(context, grant) === true

  /** Authorization comes before existence, so a stranger learns nothing about the artifact. */
  function access(context: CallContext, artifactId: Wire.Id, version: number, permission: Permission) {
    live()
    if (!options.authorize) refuse('blocked', 'no Host authorization is configured')
    const rows = db
      .prepare('SELECT value FROM access_grants WHERE artifact_id = ? AND version = ?')
      .all(artifactId, version) as { value: string }[]
    const grant = rows
      .map((row) => JSON.parse(row.value) as Wire.ArtifactAccessGrantValue)
      .find((item) => allows(item, context, permission))
    if (!grant) refuse('permission_denied', 'caller may not access this artifact version')
    const row = versionOf(artifactId, version)
    if (!row) refuse('not_found', 'no such artifact version')
    return { grant, row }
  }

  const contentOf = (row: VersionRow): Wire.BlobRef => {
    if (row.revoked) refuse('revoked', 'artifact version was revoked')
    return JSON.parse(row.blob) as Wire.BlobRef
  }

  const viewOf = (row: VersionRow): Wire.ArtifactViewRef =>
    own('ArtifactViewRef', {
      artifactId: row.artifact_id,
      version: row.version,
      title: row.title,
      mime: row.media_type,
      size: (JSON.parse(row.blob) as Wire.BlobRef).bytes,
      status: row.revoked ? 'revoked' : 'ready',
    })

  /** Rechecks access before pulling each chunk from the blob stream; a refusal becomes the stream's end. */
  function guarded(inner: ByteReadStream, recheck: () => void): ByteReadStream {
    let refusal: Wire.RuntimeError | undefined
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const iterator = inner.chunks[Symbol.asyncIterator]()
      while (true) {
        try {
          recheck()
        } catch (caught) {
          refusal = errorOf(caught)
          await inner.cancel(refusal.detailCode)
          return
        }
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    }
    return {
      chunks: chunks(),
      ended: inner.ended.then((outcome) => (refusal ? { ok: false, error: refusal } : outcome)),
      cancel: (reason) => inner.cancel(reason),
      close: () => inner.close(),
    }
  }

  const nonceOf = (key: Uint8Array, ticketId: string) =>
    createHmac('sha256', key).update(ticketId).digest('base64url')

  const ticketOf = (key: Uint8Array, row: TicketRow): Wire.ArtifactDownloadTicket =>
    own('ArtifactDownloadTicket', {
      url: `${RuntimeClientTransportWire.routes.download.path.replace('{ticketId}', encodeURIComponent(row.ticket_id))}?nonce=${nonceOf(key, row.ticket_id)}`,
      expiresAt: new Date(row.expires_ms).toISOString(),
      artifactId: row.artifact_id,
      version: row.version,
      grantRevision: row.grant_revision,
    })

  const artifactAccess: ArtifactAccessPort = {
    describe: (input, context) =>
      attempt(context, () => {
        const { artifactId, version } = parse('ArtifactDescribeInput', input)
        return viewOf(access(context, artifactId, version, 'read').row)
      }),

    readRange: (input, context) =>
      attempt(context, async () => {
        const { artifactId, version, offset, length } = parse('ArtifactClientReadRangeRequest', input)
        if (length < 1) refuse('invalid_request', 'range length must be positive')
        if (length > RuntimeClientTransportPolicy.maxRangeBytes) refuse('range_bytes', 'range is over 1 MiB')
        if (!Number.isSafeInteger(offset + length)) refuse('invalid_request', 'range end overflows')
        const blob = contentOf(access(context, artifactId, version, 'read').row)
        if (offset >= blob.bytes) refuse('range_not_satisfiable', 'range starts at or past the end')
        return unwrap(await blobRead.readRange({ ref: blob, offset, length }, context))
      }),

    openStream: (input, context) =>
      attempt(context, async () => {
        const { artifactId, version, offset = 0 } = parse('ArtifactClientOpenStreamRequest', input)
        const blob = contentOf(access(context, artifactId, version, 'read').row)
        if (offset > blob.bytes) refuse('range_not_satisfiable', 'stream starts past the end')
        const stream = unwrap(await blobRead.openRead({ ref: blob, offset }, context))
        return guarded(stream, () => {
          if (contentOf(access(context, artifactId, version, 'read').row).pinId !== blob.pinId)
            refuse('revoked', 'artifact content changed')
        })
      }),

    openDownload: (input, context) =>
      attempt(context, () => {
        const key = options.ticketKey ?? refuse('blocked', 'no ticket key is configured')
        const { requestId, input: target } = parse('ArtifactOpenDownloadRequest', input)
        const { grant, row } = access(context, target.artifactId, target.version, 'download')
        contentOf(row)
        const actor = jcs({ principalRef: context.principalRef, scope: context.scope })
        const fingerprint = createHash('sha256').update(jcs(target)).digest('hex')
        return atomically(() => {
          const prior = db
            .prepare('SELECT * FROM download_tickets WHERE actor = ? AND request_id = ?')
            .get(actor, requestId) as TicketRow | undefined
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              refuse('idempotency_conflict', 'request id already names another download')
            if (now() >= prior.expires_ms) refuse('ticket_expired', 'download ticket expired')
            return ticketOf(key, prior)
          }
          const issued: TicketRow = {
            fingerprint,
            ticket_id: randomUUID(),
            artifact_id: target.artifactId,
            version: target.version,
            grant_revision: grant.revision,
            expires_ms: now() + lifetime,
          }
          db.prepare(
            `INSERT INTO download_tickets
               (actor, request_id, fingerprint, ticket_id, artifact_id, version, grant_revision, expires_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            actor,
            requestId,
            issued.fingerprint,
            issued.ticket_id,
            issued.artifact_id,
            issued.version,
            issued.grant_revision,
            issued.expires_ms,
          )
          return ticketOf(key, issued)
        })
      }),

    // ponytail: tickets are issued but not redeemed here; the download route belongs to another provider.
    redeemDownload: (_request, context) =>
      attempt(context, () => refuse('operation_not_supported', 'this provider does not redeem tickets')),
  }

  return {
    artifactAccess,

    /**
     * Test entry for the publication side: records a ready version over a blob the selected service
     * already pinned. It stands in for reserve and publish, whose upload source is not frozen yet.
     */
    publishPinned(input: {
      artifactId: Wire.Id | null
      blob: Wire.BlobRef
      title: string
      mediaType: string
    }): Wire.ArtifactRef {
      return atomically(() => {
        const artifactId = input.artifactId ?? randomUUID()
        const { latest } = db
          .prepare('SELECT COALESCE(MAX(version), 0) AS latest FROM artifact_versions WHERE artifact_id = ?')
          .get(artifactId) as { latest: number }
        if (input.artifactId !== null && latest === 0) throw new Error('no such artifact')
        const ref = own('ArtifactRef', { artifactId, version: latest + 1 })
        db.prepare(
          'INSERT INTO artifact_versions (artifact_id, version, title, media_type, blob) VALUES (?, ?, ?, ?, ?)',
        ).run(ref.artifactId, ref.version, input.title, input.mediaType, JSON.stringify(input.blob))
        return ref
      })
    },

    /** Grants read or download on one exact version that has not been revoked. */
    grant(input: {
      artifact: Wire.ArtifactRef
      granteePrincipalRef: Wire.Id
      scope: Wire.ScopeRef
      permissions: readonly Permission[]
      sourceAuthorizationRef: Wire.Id
    }): Wire.ArtifactAccessGrantValue {
      return atomically(() => {
        const row = versionOf(input.artifact.artifactId, input.artifact.version)
        if (!row || row.revoked) throw new Error('artifact version is missing or revoked')
        const value = own('ArtifactAccessGrantValue', {
          ...input,
          permissions: [...input.permissions],
          grantId: randomUUID(),
          expiresAt: null,
          revision: 1,
          status: 'active',
        })
        db.prepare(
          'INSERT INTO access_grants (grant_id, artifact_id, version, value) VALUES (?, ?, ?, ?)',
        ).run(value.grantId, row.artifact_id, row.version, JSON.stringify(value))
        return value
      })
    },

    /** Revokes one grant; its revision moves on and every later check refuses it. */
    revokeGrant(grantId: Wire.Id): Wire.ArtifactAccessGrantValue {
      return atomically(() => {
        const current = grantOf(grantId)
        if (!current) throw new Error('no such grant')
        if (current.status === 'revoked') return current
        const revoked = own('ArtifactAccessGrantValue', {
          ...current,
          revision: current.revision + 1,
          status: 'revoked',
        })
        db.prepare('UPDATE access_grants SET value = ? WHERE grant_id = ?').run(
          JSON.stringify(revoked),
          grantId,
        )
        return revoked
      })
    },

    /** Revokes one exact version; other versions stay readable. */
    revoke(ref: Wire.ArtifactRef): void {
      atomically(() => {
        if (!versionOf(ref.artifactId, ref.version)) throw new Error('no such artifact version')
        db.prepare('UPDATE artifact_versions SET revoked = 1 WHERE artifact_id = ? AND version = ?').run(
          ref.artifactId,
          ref.version,
        )
      })
    },

    close() {
      if (!open) return
      open = false
      db.close()
    },
  }
}

export type ArtifactsStore = ReturnType<typeof openArtifactsStore>
