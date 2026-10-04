import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  ArtifactAccessPort,
  BlobReadPort,
  ByteReadStream,
  CallContext,
  Outcome,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeArtifactPolicy,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
} from '@agnes/protocol/runtime'
import type { ArtifactTicketKeyPort, ArtifactTicketSecretBinding } from '../artifact-ticket-key.js'
import {
  ArtifactsRefusal,
  type ArtifactsStore,
  artifactsError,
  checked,
  grantOf,
  grantsFor,
  parse,
  refuse,
  reservationOf,
  unwrap,
  viewOf,
  within,
} from './publication.js'

export type ArtifactAccessOptions = Readonly<{
  /**
   * The Host's current authorization check for a caller holding a grant. Production assembly does not
   * provide one yet, so without it every access is refused as blocked.
   */
  authorize?: (context: CallContext, grant: Wire.ArtifactAccessGrantValue) => boolean
  /**
   * The Host-private ticket key broker, which holds every key version, and the installation it serves.
   * The Host supplies it only with a broker that verifies the current identity and delegation; without
   * it, openDownload and redeemDownload are blocked.
   */
  ticketKeys?: Readonly<{
    port: ArtifactTicketKeyPort
    binding: ArtifactTicketSecretBinding
    tenantId: Wire.Id
    /** The selected blob authority the broker installation names. */
    authorityId: Wire.Id
    /**
     * The installed artifacts owner's call for one client call, issued by the trusted Host assembly with
     * that call's signal. This module never builds an owner identity itself.
     */
    delegate: (context: CallContext) => CallContext
  }>
}>

type TicketKeys = NonNullable<ArtifactAccessOptions['ticketKeys']>

type Permission = Wire.ArtifactAccessGrantValue['permissions'][number]

type TicketRow = {
  ticket_id: string
  principal: string
  fingerprint: string
  nonce_digest: string
  sealed: string
  key_version: string
  artifact_id: string
  version: number
  disposition: Wire.ArtifactClientOpenDownloadRequest['disposition']
  grant_id: string
  grant_revision: number
  pin_id: string
  expires_at: number
}

const hex = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const iso = (ms: number) => new Date(ms).toISOString()

const errorOf = (caught: unknown): Wire.RuntimeError =>
  caught instanceof ArtifactsRefusal
    ? caught.error
    : artifactsError('internal_error', 'artifact access failed')

async function run<T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: artifactsError('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (caught) {
    return { ok: false, error: errorOf(caught) }
  }
}

function noNegativeZero(...values: number[]) {
  if (values.some((value) => Object.is(value, -0)))
    refuse('invalid_request', 'offset or length is negative zero')
}

/** Rechecks access before every chunk; a refusal cancels the blob stream and becomes the stream's end. */
function guarded(inner: ByteReadStream, recheck: () => unknown): ByteReadStream {
  let refusal: Wire.RuntimeError | undefined
  // A consumer that cancels or closes while a check runs gets no further chunk and keeps its own end.
  let stopped = false
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of inner.chunks) {
      try {
        await recheck()
      } catch (caught) {
        if (stopped) return
        refusal = errorOf(caught)
        await inner.cancel(refusal.detailCode)
        return
      }
      if (stopped) return
      yield chunk
    }
  }
  return {
    chunks: chunks(),
    ended: inner.ended.then((outcome) => (refusal ? { ok: false, error: refusal } : outcome)),
    cancel: (reason) => {
      stopped = true
      return inner.cancel(reason)
    },
    close: () => {
      stopped = true
      return inner.close()
    },
  }
}

/**
 * The artifact read port. Every byte comes from the selected blob service's read port; this module
 * never opens a local store. Access needs a current grant of this exact version to the calling
 * principal and the Host's check of that grant, every range and every chunk again.
 */
export function createArtifactAccess(
  store: ArtifactsStore,
  blobRead: BlobReadPort,
  options: ArtifactAccessOptions,
): ArtifactAccessPort {
  const allows = (grant: Wire.ArtifactAccessGrantValue, context: CallContext, permission: Permission) =>
    grant.status === 'active' &&
    grant.granteePrincipalRef === context.principalRef &&
    grant.permissions.includes(permission) &&
    (grant.expiresAt === null || Date.parse(grant.expiresAt) > store.now()) &&
    within(context.scope, grant.scope) &&
    options.authorize?.(context, grant) === true

  // Authorization comes first so an unauthorized caller learns nothing about existence.
  const access = (context: CallContext, artifactId: Wire.Id, version: number, permission: Permission) => {
    if (!options.authorize) refuse('blocked', 'no trusted Host authorization is configured')
    const grant = grantsFor(store, artifactId, version).find((item) => allows(item, context, permission))
    if (!grant) refuse('permission_denied', 'caller may not access this artifact version')
    const record = reservationOf(store, artifactId, version)
    if (!record) refuse('not_found', 'no such artifact version')
    return { grant, record }
  }

  const readable = (record: Wire.ArtifactReservation): Wire.BlobRef => {
    if (record.state === 'revoked') refuse('revoked', 'artifact version was revoked')
    if (record.state !== 'ready') refuse('not_found', 'artifact version has no ready content')
    return record.blob
  }

  const aadOf = (keys: TicketKeys, ticketId: Wire.Id, nonceDigest: Wire.Digest) => ({
    ticketId,
    tenantId: keys.tenantId,
    authorityId: keys.authorityId,
    nonceDigest,
  })

  /** Opens a stored nonce through the broker, which refuses a revoked key or a withdrawn delegation. */
  const opened = async (keys: TicketKeys, row: TicketRow, context: CallContext) => {
    // Stored as iv, ciphertext and tag in one base64url text; the broker refuses any other layout.
    const sealed = new Uint8Array(Buffer.from(row.sealed, 'base64url'))
    const envelope = {
      keyVersion: row.key_version,
      iv: sealed.subarray(0, 12),
      ciphertext: sealed.subarray(12, -16),
      tag: sealed.subarray(-16),
    }
    const aad = aadOf(keys, row.ticket_id, row.nonce_digest)
    return unwrap(await keys.port.openNonce({ binding: keys.binding, aad, envelope }, keys.delegate(context)))
  }

  const ticketOf = (
    row: Pick<TicketRow, 'ticket_id' | 'artifact_id' | 'version' | 'grant_revision' | 'expires_at'>,
    nonce: string,
  ) =>
    checked('ArtifactDownloadTicket', {
      url: `${RuntimeClientTransportWire.routes.download.path.replace('{ticketId}', encodeURIComponent(row.ticket_id))}?nonce=${nonce}`,
      expiresAt: iso(row.expires_at),
      artifactId: row.artifact_id,
      version: row.version,
      grantRevision: row.grant_revision,
    })

  return {
    describe: (input, context) =>
      run(context, () => {
        const { artifactId, version } = parse('ArtifactDescribeInput', input)
        return viewOf(access(context, artifactId, version, 'read').record)
      }),

    readRange: (input, context) =>
      run(context, async () => {
        const { artifactId, version, offset, length } = parse('ArtifactClientReadRangeRequest', input)
        noNegativeZero(offset, length)
        if (length < 1) refuse('invalid_request', 'range length must be positive')
        if (length > RuntimeClientTransportPolicy.maxRangeBytes)
          refuse('range_bytes', 'range is larger than 1 MiB')
        if (!Number.isSafeInteger(offset + length)) refuse('invalid_request', 'range end overflows')
        const blob = readable(access(context, artifactId, version, 'read').record)
        if (offset >= blob.bytes) refuse('range_not_satisfiable', 'range starts at or past the end')
        return unwrap(await blobRead.readRange({ ref: blob, offset, length }, context))
      }),

    openStream: (input, context) =>
      run(context, async () => {
        const { artifactId, version, offset = 0 } = parse('ArtifactClientOpenStreamRequest', input)
        noNegativeZero(offset)
        const blob = readable(access(context, artifactId, version, 'read').record)
        if (offset > blob.bytes) refuse('range_not_satisfiable', 'stream starts past the end')
        const stream = unwrap(await blobRead.openRead({ ref: blob, offset }, context))
        return guarded(stream, () => {
          if (readable(access(context, artifactId, version, 'read').record).pinId !== blob.pinId)
            refuse('revoked', 'artifact content changed')
        })
      }),

    openDownload: (input, context) =>
      run(context, async () => {
        const keys = options.ticketKeys ?? refuse('blocked', 'no ticket key broker is configured')
        const { requestId, input: target } = parse('ArtifactOpenDownloadRequest', input)
        const current = () => {
          const { grant, record } = access(context, target.artifactId, target.version, 'download')
          return { grant, blob: readable(record) }
        }
        current()
        const actor = jcs({ principalRef: context.principalRef, scope: context.scope })
        const fingerprint = hex(jcs(target))
        const prior = () =>
          store.db
            .prepare('SELECT * FROM tickets WHERE actor = ? AND request_id = ?')
            .get(actor, requestId) as TicketRow | undefined
        // The original ticket is rebuilt, never reissued or extended, and checked again after the broker.
        const replay = async (row: TicketRow) => {
          if (row.fingerprint !== fingerprint)
            refuse('idempotency_conflict', 'request id already names another download')
          if (store.now() >= row.expires_at) refuse('ticket_expired', 'download ticket expired')
          const nonce = await opened(keys, row, context)
          current()
          if (store.now() >= row.expires_at) refuse('ticket_expired', 'download ticket expired')
          return ticketOf(row, Buffer.from(nonce).toString('base64url'))
        }
        const existing = prior()
        if (existing) return replay(existing)
        const ticketId = randomUUID()
        const nonce = randomBytes(32)
        const nonceDigest = hex(nonce)
        const expiresAt = store.now() + RuntimeArtifactPolicy.downloadTicketTtlMs
        const envelope = unwrap(
          await keys.port.sealNonce(
            { binding: keys.binding, aad: aadOf(keys, ticketId, nonceDigest), nonce },
            keys.delegate(context),
          ),
        )
        const { grant, blob } = current()
        // A concurrent request with the same id may have stored its ticket first; that one is returned,
        // and the broker collects the material sealed here when it expires.
        const stored = store.write(() => {
          if (!prior())
            store.db
              .prepare(
                `INSERT INTO tickets (ticket_id, actor, principal, request_id, fingerprint, nonce_digest, sealed, key_version,
                  artifact_id, version, disposition, grant_id, grant_revision, pin_id, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                ticketId,
                actor,
                context.principalRef,
                requestId,
                fingerprint,
                nonceDigest,
                Buffer.concat([envelope.iv, envelope.ciphertext, envelope.tag]).toString('base64url'),
                envelope.keyVersion,
                target.artifactId,
                target.version,
                target.disposition,
                grant.grantId,
                grant.revision,
                blob.pinId,
                expiresAt,
              )
          return prior() as TicketRow
        })
        return stored.ticket_id === ticketId ? ticketOf(stored, nonce.toString('base64url')) : replay(stored)
      }),

    redeemDownload: (request, context) =>
      run(context, async () => {
        const keys = options.ticketKeys ?? refuse('blocked', 'no ticket key broker is configured')
        const { ticketId, nonce, offset } = parse('ArtifactRedeemDownloadRequest', request)
        noNegativeZero(offset)
        // The wire schema admits only the base64url text of exactly 32 nonce bytes.
        const digest = createHash('sha256').update(Buffer.from(nonce, 'base64url')).digest()
        const ticket = store.db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId) as
          | TicketRow
          | undefined
        if (!ticket || !timingSafeEqual(digest, Buffer.from(ticket.nonce_digest, 'hex')))
          refuse('permission_denied', 'download ticket is not valid')
        const check = () => {
          if (store.now() >= ticket.expires_at) refuse('ticket_expired', 'download ticket expired')
          if (ticket.principal !== context.principalRef)
            refuse('permission_denied', 'ticket belongs to another actor')
          if (!options.authorize) refuse('blocked', 'no trusted Host authorization is configured')
          const grant = grantOf(store, ticket.grant_id)
          if (grant?.status !== 'active' || grant.revision !== ticket.grant_revision)
            refuse('revoked', 'download grant changed')
          if (!allows(grant, context, 'download'))
            refuse('permission_denied', 'caller may not download this artifact')
          const record = reservationOf(store, ticket.artifact_id, ticket.version)
          if (!record) refuse('not_found', 'no such artifact version')
          const blob = readable(record)
          if (blob.pinId !== ticket.pin_id) refuse('revoked', 'artifact content changed')
          return { record, blob }
        }
        // The broker refuses a revoked key or a withdrawn delegation, so possession alone is not enough;
        // the whole check runs again before every chunk.
        const authorized = async () => {
          check()
          await opened(keys, ticket, context)
          return check()
        }
        const { record, blob } = await authorized()
        if (offset > blob.bytes) refuse('range_not_satisfiable', 'download starts past the end')
        const stream = unwrap(await blobRead.openRead({ ref: blob, offset }, context))
        const metadata = checked('ArtifactDownloadPresentation', {
          artifact: viewOf(record),
          disposition: ticket.disposition,
          expiresAt: iso(ticket.expires_at),
          grantRevision: ticket.grant_revision,
        })
        return { metadata, stream: guarded(stream, authorized) }
      }),
  }
}
