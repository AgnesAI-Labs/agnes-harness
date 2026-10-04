import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
  RuntimeAuthorityTransferAPI,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  RuntimeErrorDetails,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { createReferenceArtifactTicketKeyPort } from './artifact-ticket-key.js'
import { openTransfer, type TransferMaintenance } from './blob-transfer.js'

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
/** The reference ticket key broker as its consumer sees it: seal and open, never the key material. */
type TicketKeyPort = Pick<ReturnType<typeof createReferenceArtifactTicketKeyPort>, 'sealNonce' | 'openNonce'>
type Envelope = Parameters<TicketKeyPort['openNonce']>[0]['envelope']

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
  /**
   * The ticket key broker, which holds every key version, and the installation it serves. Supplied only
   * by a trusted assembly whose broker verifies the delegated identity; without it, openDownload is
   * refused as blocked.
   */
  ticketKeys?: Readonly<{
    port: TicketKeyPort
    binding: Parameters<TicketKeyPort['sealNonce']>[0]['binding']
    tenantId: Wire.Id
    /** The selected blob authority the broker installation names. */
    authorityId: Wire.Id
    /**
     * The installed artifacts owner's call for one client call, issued by the trusted assembly with that
     * call's signal. This store never builds an owner identity itself.
     */
    delegate: (context: CallContext) => CallContext
  }>
  /** A profile's ticket lifetime. The contract's own lifetime still caps it. */
  ticketTtlMs?: number
  now?: () => number
  authorityId?: Wire.Id
  /** The maintenance assembly. Without it, or without `blobTransfer`, every transfer call is refused. */
  maintenance?: TransferMaintenance
  /**
   * The transfer entry of the selected blob service: whether it holds a blob intact. That service's own
   * transfer moves the bytes the records name; this store only checks that they arrived.
   */
  blobTransfer?: Readonly<{ binding: Wire.BindingRef; holds(ref: Wire.BlobRef): boolean }>
  /** Creates a new store as an import target, which takes no business write until a transfer activates it. */
  candidate?: boolean
  /** The most records and encoded bytes one exported part holds. */
  exportPart?: Readonly<{ records: number; bytes: number }>
}>

/**
 * Versions point at a BlobRef of the selected blob service. Grants are stored whole. A ticket row keeps
 * its nonce only as the broker's envelope under the key version that sealed it, with the digest of the
 * nonce bytes, so a repeated request rebuilds the same URL through the broker. Every revoke and
 * revokeGrant that changes something appends one row to the revocation log, whose seq only grows. The
 * authority row says whether the store takes business writes: only while it serves.
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
CREATE TABLE IF NOT EXISTS sealed_tickets (
  actor TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  ticket_id TEXT NOT NULL UNIQUE,
  nonce_digest TEXT NOT NULL,
  key_version TEXT NOT NULL,
  iv BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  grant_revision INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (actor, request_id)
);
CREATE TABLE IF NOT EXISTS revocations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  request_id TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS authority (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  role TEXT NOT NULL CHECK (role IN ('serving', 'fenced', 'candidate')),
  epoch INTEGER NOT NULL
);`

/**
 * The business tables a checkpoint covers, each with the SQL that gives a record its key; the
 * revocation log is the watermark. Tickets stay out, as the default service leaves them out.
 */
const RECORDS = {
  access_grants: 'grant_id',
  artifact_versions: "artifact_id || '/' || printf('%016d', version)",
  revocations: "printf('%016d', seq)",
}

/** One revocation log row; `ref` is the revoked version, or `{ grantId }` for a revoked grant. */
export type RevocationRow = Readonly<
  | { seq: number; kind: 'revoke'; ref: Wire.ArtifactRef; requestId: null; at: number }
  | { seq: number; kind: 'revokeGrant'; ref: { grantId: Wire.Id }; requestId: Wire.Id | null; at: number }
>

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
  nonce_digest: string
  key_version: string
  iv: Uint8Array
  ciphertext: Uint8Array
  tag: Uint8Array
  artifact_id: string
  version: number
  grant_revision: number
  expires_ms: number
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/** Opens the store over the blob service the container selects; a selection without a read port is refused. */
export function openArtifactsStore(path: string, options: ArtifactsStoreOptions) {
  const selected = options.dependencies.get(BLOB_DEPENDENCY)
  if (!selected.ok) throw new Error(`no blob service is selected: ${selected.error.detailCode}`)
  const blobRead: BlobReadPort | undefined = selected.value.blobRead
  if (!blobRead) throw new Error('the selected blob service has no read port')
  const { blobTransfer, maintenance } = options
  if (blobTransfer && jcs(blobTransfer.binding) !== jcs(selected.value.binding))
    throw new Error('the blob transfer entry belongs to another blob service')
  const now = options.now ?? (() => Date.now())
  const lifetime = Math.min(RuntimeArtifactPolicy.downloadTicketTtlMs, options.ticketTtlMs ?? Infinity)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(TABLES)
  db.prepare('INSERT OR IGNORE INTO authority (id, role, epoch) VALUES (1, ?, ?)').run(
    ...(options.candidate ? ['candidate', 0] : ['serving', 1]),
  )
  let open = true

  const live = () => {
    if (!open) refuse('blocked', 'artifacts store is closed')
  }
  const serving = () => {
    const { role } = db.prepare('SELECT role FROM authority WHERE id = 1').get() as { role: string }
    if (role !== 'serving') refuse('blocked', 'store is fenced or a transfer candidate')
  }
  /** One transaction. A business write is gated: refused as blocked unless the store serves. */
  function atomically<T>(body: () => T, gated = true): T {
    live()
    db.exec('BEGIN IMMEDIATE')
    try {
      if (gated) serving()
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

  const logRevocation = (kind: RevocationRow['kind'], ref: RevocationRow['ref'], requestId: Wire.Id | null) =>
    db
      .prepare('INSERT INTO revocations (kind, ref, request_id, at) VALUES (?, ?, ?, ?)')
      .run(kind, jcs(ref), requestId, now())

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

  const ticketOf = (row: TicketRow, nonce: Uint8Array): Wire.ArtifactDownloadTicket =>
    own('ArtifactDownloadTicket', {
      url: `${RuntimeClientTransportWire.routes.download.path.replace('{ticketId}', encodeURIComponent(row.ticket_id))}?nonce=${Buffer.from(nonce).toString('base64url')}`,
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
      attempt(context, async () => {
        const keys = options.ticketKeys ?? refuse('blocked', 'no ticket key broker is configured')
        const { requestId, input: target } = parse('ArtifactOpenDownloadRequest', input)
        // Checked before and after every broker call. A fenced store or a candidate neither issues a
        // ticket nor rebuilds one, so it asks no broker either.
        const permitted = () => {
          const { grant, row } = access(context, target.artifactId, target.version, 'download')
          contentOf(row)
          serving()
          return grant
        }
        permitted()
        const actor = jcs({ principalRef: context.principalRef, scope: context.scope })
        const fingerprint = sha256(jcs(target))
        const stored = () =>
          db
            .prepare('SELECT * FROM sealed_tickets WHERE actor = ? AND request_id = ?')
            .get(actor, requestId) as TicketRow | undefined
        const aadOf = (ticketId: Wire.Id, nonceDigest: string) => ({
          ticketId,
          tenantId: keys.tenantId,
          authorityId: keys.authorityId,
          nonceDigest,
        })
        /** The stored ticket, opened under its own key version: rebuilt, never reissued or extended. */
        const rebuilt = async (row: TicketRow) => {
          if (row.fingerprint !== fingerprint)
            refuse('idempotency_conflict', 'request id already names another download')
          if (now() >= row.expires_ms) refuse('ticket_expired', 'download ticket expired')
          const envelope: Envelope = {
            keyVersion: row.key_version,
            iv: row.iv,
            ciphertext: row.ciphertext,
            tag: row.tag,
          }
          const nonce = unwrap(
            await keys.port.openNonce(
              { binding: keys.binding, aad: aadOf(row.ticket_id, row.nonce_digest), envelope },
              keys.delegate(context),
            ),
          )
          permitted()
          if (now() >= row.expires_ms) refuse('ticket_expired', 'download ticket expired')
          return ticketOf(row, nonce)
        }
        const prior = stored()
        if (prior) return rebuilt(prior)
        const nonce = randomBytes(32)
        const ticketId = randomUUID()
        const nonceDigest = sha256(nonce)
        const expires = now() + lifetime
        // Sealed outside any transaction; the broker answers under its current key version.
        const sealed = unwrap(
          await keys.port.sealNonce(
            { binding: keys.binding, aad: aadOf(ticketId, nonceDigest), nonce },
            keys.delegate(context),
          ),
        )
        const grant = permitted()
        // A concurrent request with the same id may have stored its ticket first; that one is rebuilt.
        const row = atomically(() => {
          if (!stored())
            db.prepare(
              `INSERT INTO sealed_tickets (actor, request_id, fingerprint, ticket_id, nonce_digest, key_version,
                 iv, ciphertext, tag, artifact_id, version, grant_revision, expires_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              actor,
              requestId,
              fingerprint,
              ticketId,
              nonceDigest,
              sealed.keyVersion,
              sealed.iv,
              sealed.ciphertext,
              sealed.tag,
              target.artifactId,
              target.version,
              grant.revision,
              expires,
            )
          return stored() as TicketRow
        })
        return row.ticket_id === ticketId ? ticketOf(row, nonce) : rebuilt(row)
      }),

    // ponytail: tickets are issued but not redeemed here; the download route belongs to another provider.
    // artifact-ticket.v1, which names redeemDownload, is therefore never declared, broker or not.
    redeemDownload: (_request, context) =>
      attempt(context, () => refuse('operation_not_supported', 'this provider does not redeem tickets')),
  }

  const transferable = maintenance !== undefined && blobTransfer !== undefined
  const transfer = openTransfer({
    db,
    authorityId: options.authorityId ?? 'reference-artifacts',
    name: 'artifacts',
    tables: RECORDS,
    log: 'revocations',
    assets: {
      // Every version's blob, revoked ones too, as the default service lists every record's blob.
      *list() {
        const rows = db.prepare('SELECT blob FROM artifact_versions').iterate() as Iterable<{ blob: string }>
        for (const { blob } of rows) yield JSON.parse(blob) as Wire.BlobRef
      },
      present: (ref) => blobTransfer?.holds(ref) === true,
    },
    maintenance: transferable ? maintenance : undefined,
    part: options.exportPart ?? { records: 1000, bytes: 8 * 1024 * 1024 },
    live,
    transaction: (body) => atomically(body, false),
    refuse,
    attempt,
  })

  return {
    artifactAccess,
    /** Authority transfer: declared only with the maintenance assembly and the blob transfer entry. */
    transfer: transfer.control,
    readExport: transfer.readExport,
    features: transferable
      ? ['artifact-access.v1', RuntimeAuthorityTransferAPI.feature]
      : ['artifact-access.v1'],

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

    /**
     * Revokes one grant; its revision moves on and every later check refuses it. `requestId` is the
     * caller's request, recorded in the revocation log.
     */
    revokeGrant(grantId: Wire.Id, requestId: Wire.Id | null = null): Wire.ArtifactAccessGrantValue {
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
        logRevocation('revokeGrant', { grantId }, requestId)
        return revoked
      })
    },

    /** Revokes one exact version; other versions stay readable. Revoking it again changes nothing. */
    revoke(ref: Wire.ArtifactRef): void {
      atomically(() => {
        const row = versionOf(ref.artifactId, ref.version)
        if (!row) throw new Error('no such artifact version')
        if (row.revoked) return
        db.prepare('UPDATE artifact_versions SET revoked = 1 WHERE artifact_id = ? AND version = ?').run(
          ref.artifactId,
          ref.version,
        )
        // The wire revoke request carries no request id.
        logRevocation('revoke', { artifactId: row.artifact_id, version: row.version }, null)
      })
    },

    /** The revocation log in seq order. Internal: no agh.artifacts method reports it. */
    revocations(): RevocationRow[] {
      live()
      const rows = db
        .prepare('SELECT seq, kind, ref, request_id, at FROM revocations ORDER BY seq')
        .all() as { seq: number; kind: string; ref: string; request_id: string | null; at: number }[]
      return rows.map(
        (row) =>
          ({
            seq: row.seq,
            kind: row.kind,
            ref: JSON.parse(row.ref),
            requestId: row.request_id,
            at: row.at,
          }) as RevocationRow,
      )
    },

    close() {
      if (!open) return
      open = false
      db.close()
    },
  }
}

export type ArtifactsStore = ReturnType<typeof openArtifactsStore>
