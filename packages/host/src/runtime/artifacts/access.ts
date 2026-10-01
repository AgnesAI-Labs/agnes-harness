import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
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
  /** Key for sealing ticket nonces. Without one, openDownload and redeemDownload are blocked. */
  ticketKey?: Readonly<{ version: string; key: Uint8Array }>
}>

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
function guarded(inner: ByteReadStream, recheck: () => void): ByteReadStream {
  let refusal: Wire.RuntimeError | undefined
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of inner.chunks) {
      try {
        recheck()
      } catch (caught) {
        refusal = errorOf(caught)
        await inner.cancel(refusal.detailCode)
        return
      }
      yield chunk
    }
  }
  return {
    chunks: chunks(),
    ended: inner.ended.then((outcome) => (refusal ? { ok: false, error: refusal } : outcome)),
    cancel: (reason) => inner.cancel(reason),
    close: () => inner.close(),
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

  const sealNonce = (key: Uint8Array, aad: string, nonce: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad))
    const data = Buffer.concat([cipher.update(nonce, 'utf8'), cipher.final()])
    return JSON.stringify({
      iv: iv.toString('base64url'),
      data: data.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    })
  }

  const openNonce = (key: Uint8Array, aad: string, sealed: string): string => {
    try {
      const box = JSON.parse(sealed) as { iv: string; data: string; tag: string }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'))
      decipher.setAAD(Buffer.from(aad)).setAuthTag(Buffer.from(box.tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64url')), decipher.final()]).toString(
        'utf8',
      )
    } catch {
      return refuse('integrity', 'sealed ticket nonce cannot be opened')
    }
  }

  const aadOf = (ticketId: Wire.Id, context: CallContext, nonceDigest: string) =>
    jcs({ ticketId, tenant: context.scope.installationId, authority: store.authorityId, nonceDigest })

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
      run(context, () => {
        const key = options.ticketKey ?? refuse('blocked', 'no ticket key is configured')
        const { requestId, input: target } = parse('ArtifactOpenDownloadRequest', input)
        const { grant, record } = access(context, target.artifactId, target.version, 'download')
        const blob = readable(record)
        const actor = jcs({ principalRef: context.principalRef, scope: context.scope })
        const fingerprint = hex(jcs(target))
        return store.transaction(() => {
          const prior = store.db
            .prepare('SELECT * FROM tickets WHERE actor = ? AND request_id = ?')
            .get(actor, requestId) as TicketRow | undefined
          if (prior) {
            // The original ticket is rebuilt, never reissued or extended.
            if (prior.fingerprint !== fingerprint)
              refuse('idempotency_conflict', 'request id already names another download')
            if (store.now() >= prior.expires_at) refuse('ticket_expired', 'download ticket expired')
            if (prior.key_version !== key.version) refuse('blocked', 'ticket key version is not available')
            const nonce = openNonce(
              key.key,
              aadOf(prior.ticket_id, context, prior.nonce_digest),
              prior.sealed,
            )
            if (hex(nonce) !== prior.nonce_digest)
              refuse('integrity', 'sealed ticket nonce does not match its digest')
            return ticketOf(prior, nonce)
          }
          const ticketId = randomUUID()
          const nonce = randomBytes(32).toString('base64url')
          const nonceDigest = hex(nonce)
          const row = {
            ticket_id: ticketId,
            artifact_id: target.artifactId,
            version: target.version,
            grant_revision: grant.revision,
            expires_at: store.now() + RuntimeArtifactPolicy.downloadTicketTtlMs,
          }
          const ticket = ticketOf(row, nonce)
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
              sealNonce(key.key, aadOf(ticketId, context, nonceDigest), nonce),
              key.version,
              target.artifactId,
              target.version,
              target.disposition,
              grant.grantId,
              grant.revision,
              blob.pinId,
              row.expires_at,
            )
          return ticket
        })
      }),

    redeemDownload: (request, context) =>
      run(context, async () => {
        if (!options.ticketKey) refuse('blocked', 'no ticket key is configured')
        const { ticketId, nonce, offset } = parse('ArtifactRedeemDownloadRequest', request)
        noNegativeZero(offset)
        const ticket = store.db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId) as
          | TicketRow
          | undefined
        if (
          !ticket ||
          !timingSafeEqual(Buffer.from(hex(nonce), 'hex'), Buffer.from(ticket.nonce_digest, 'hex'))
        )
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
        const { record, blob } = check()
        if (offset > blob.bytes) refuse('range_not_satisfiable', 'download starts past the end')
        const stream = unwrap(await blobRead.openRead({ ref: blob, offset }, context))
        const metadata = checked('ArtifactDownloadPresentation', {
          artifact: viewOf(record),
          disposition: ticket.disposition,
          expiresAt: iso(ticket.expires_at),
          grantRevision: ticket.grant_revision,
        })
        return { metadata, stream: guarded(stream, check) }
      }),
  }
}
