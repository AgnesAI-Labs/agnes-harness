import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync, hasPrivateDaclSync } from '@agnes/system-node'

/** Local companion only; never publish this consumer through an unregistered wire schema. */
export const ARTIFACT_TICKET_CONSUMER = 'artifact-ticket'
export const ARTIFACT_TICKET_PURPOSE = 'artifact-download-ticket-nonce-envelope'
export type ArtifactTicketSecretBinding = Omit<Wire.SecretConsumerBinding, 'consumer'> & {
  readonly consumer: typeof ARTIFACT_TICKET_CONSUMER
}
export type TicketNonceAAD = {
  ticketId: Wire.Id
  tenantId: Wire.Id
  authorityId: Wire.Id
  nonceDigest: Wire.Digest
}
export type TicketNonceEnvelope = {
  keyVersion: string
  iv: Uint8Array
  ciphertext: Uint8Array
  tag: Uint8Array
}
export interface ArtifactTicketKeyPort {
  sealNonce(
    request: {
      binding: ArtifactTicketSecretBinding
      aad: TicketNonceAAD
      nonce: Uint8Array
    },
    context: CallContext,
  ): Promise<Outcome<TicketNonceEnvelope>>
  openNonce(
    request: {
      binding: ArtifactTicketSecretBinding
      aad: TicketNonceAAD
      envelope: TicketNonceEnvelope
    },
    context: CallContext,
  ): Promise<Outcome<Uint8Array>>
}
export interface ArtifactTicketInstallation {
  readonly binding: ArtifactTicketSecretBinding
  readonly ownerId: string
  readonly principalRef: string
  readonly bindingId: string
  readonly scope: Wire.ScopeRef
  readonly authorityId: string
}
export interface ArtifactTicketDeployment {
  readonly installation: ArtifactTicketInstallation
  /** Additional retention after the five-minute ticket lifetime; fixed by the trusted deployment. */
  readonly diagnosticRetentionMs: number
  /** Verify the current issuer and delegation to the installed artifact owner and selected blob authority. No fallback. */
  readonly authorize?: (
    context: CallContext,
    installation: ArtifactTicketInstallation,
    keyVersion: string,
    operation: 'seal' | 'open',
    signal: AbortSignal,
  ) => Promise<boolean>
}
export interface ArtifactTicketBrokerOptions extends ArtifactTicketDeployment {
  readonly directory: string
  readonly tenantId: string
  readonly now?: () => number
  /** Trusted broker closures; never install these on a plugin service or export them over wire. */
  readonly current: () => { version: string; revoked: boolean }
  readonly identity: (context: CallContext, signal: AbortSignal) => Promise<boolean>
  readonly reference: (version: string) => string | undefined
  /** Credential store supplies exactly 32 bytes encoded as lowercase hex. */
  readonly resolve: (ref: string) => string
}
class TicketFault extends Error {
  constructor(
    readonly detail: string,
    readonly code: Wire.RuntimeError['code'] = 'denied',
  ) {
    super('Ticket material request refused')
  }
}
function refuse(detailCode: string, code: Wire.RuntimeError['code'] = 'denied'): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Ticket material request refused',
      diagnosticId: 'artifact-ticket-key',
      retryAdvice: { kind: 'never' },
    },
  }
}
const fingerprint = (value: unknown): string => canonicalJsonDigest(validateJson(value))
function validateJson(value: unknown): Wire.JsonValue {
  const decoded = validateRuntime('JsonValue', value)
  if (!decoded.ok) throw new TicketFault('ticket_schema', 'invalid_input')
  return decoded.value
}
function aadBytes(aad: TicketNonceAAD): Buffer {
  if (
    Object.keys(aad).sort().join(',') !== 'authorityId,nonceDigest,tenantId,ticketId' ||
    !validateRuntime('Id', aad.ticketId).ok ||
    !validateRuntime('Id', aad.tenantId).ok ||
    !validateRuntime('Id', aad.authorityId).ok ||
    !validateRuntime('Digest', aad.nonceDigest).ok
  )
    throw new TicketFault('ticket_schema', 'invalid_input')
  return Buffer.from(jcs(aad))
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Called only by the selected Secrets broker. Persists references and retention proofs, never material. */
export function createArtifactTicketKeyPort(options: ArtifactTicketBrokerOptions): ArtifactTicketKeyPort & {
  close(): Promise<void>
} {
  const installed = JSON.parse(JSON.stringify(options.installation)) as ArtifactTicketInstallation
  if (
    Object.keys(installed.binding).sort().join(',') !==
      'accountRef,audience,consumer,purpose,secretId,serverRef' ||
    ![
      installed.binding.secretId,
      installed.binding.serverRef,
      installed.ownerId,
      installed.principalRef,
      installed.bindingId,
      installed.authorityId,
      options.tenantId,
    ].every((value) => validateRuntime('Id', value).ok) ||
    (installed.binding.accountRef !== null && !validateRuntime('Id', installed.binding.accountRef).ok) ||
    typeof installed.binding.audience !== 'string' ||
    installed.binding.audience.length === 0 ||
    !validateRuntime('ScopeRef', installed.scope).ok ||
    installed.binding.consumer !== ARTIFACT_TICKET_CONSUMER ||
    installed.binding.purpose !== ARTIFACT_TICKET_PURPOSE ||
    !Number.isSafeInteger(options.diagnosticRetentionMs) ||
    options.diagnosticRetentionMs < 0
  )
    throw new Error('Invalid ticket material installation')
  const clock = options.now ?? Date.now
  if (!existsSync(options.directory)) createPrivateDirectorySync(options.directory)
  const path = join(options.directory, 'ticket-keys.sqlite')
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  if (!hasPrivateDaclSync(options.directory) || !hasPrivateDaclSync(path))
    throw new Error('Private ticket storage required')
  const db = new DatabaseSync(path)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ' +
      'CREATE TABLE IF NOT EXISTS ticket_owner (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS ticket_material (ticket_id TEXT PRIMARY KEY, version TEXT NOT NULL, ref TEXT NOT NULL, aad TEXT NOT NULL, envelope TEXT NOT NULL, expires INTEGER NOT NULL, retain_until INTEGER NOT NULL)',
  )
  const owner = fingerprint({ installed, tenant: options.tenantId, retention: options.diagnosticRetentionMs })
  db.prepare('INSERT OR IGNORE INTO ticket_owner VALUES (1, ?)').run(owner)
  if (db.prepare('SELECT digest FROM ticket_owner WHERE id=1').get()?.digest !== owner) {
    db.close()
    throw new Error('Ticket broker ownership mismatch')
  }
  const lifetime = new AbortController()
  let closing: Promise<void> | undefined
  function collect() {
    db.prepare('DELETE FROM ticket_material WHERE retain_until <= ?').run(clock())
  }
  collect()
  function bounded<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new TicketFault('ticket_cancelled', 'cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  async function allowed(context: CallContext, version: string, mode: 'seal' | 'open', signal: AbortSignal) {
    if (
      context.principalRef !== installed.principalRef ||
      context.bindingId !== installed.bindingId ||
      fingerprint(context.scope) !== fingerprint(installed.scope)
    )
      throw new TicketFault('ticket_binding')
    if (
      !(await bounded(signal, options.identity(context, signal))) ||
      !options.authorize ||
      !(await bounded(signal, options.authorize(context, structuredClone(installed), version, mode, signal)))
    )
      throw new TicketFault('ticket_delegation')
    if (
      context.principalRef !== installed.principalRef ||
      context.bindingId !== installed.bindingId ||
      fingerprint(context.scope) !== fingerprint(installed.scope)
    )
      throw new TicketFault('ticket_binding')
    if (signal.aborted) throw new TicketFault('ticket_cancelled', 'cancelled')
    const current = options.current()
    if (current.revoked) throw new TicketFault('ticket_revoked')
    if (mode === 'seal' && current.version !== version) throw new TicketFault('ticket_version')
  }
  function bindingCheck(binding: ArtifactTicketSecretBinding, aad: TicketNonceAAD) {
    const bytes = aadBytes(aad)
    if (
      fingerprint(binding) !== fingerprint(installed.binding) ||
      aad.tenantId !== options.tenantId ||
      aad.authorityId !== installed.authorityId
    )
      throw new TicketFault('ticket_binding')
    return bytes
  }
  function material(version: string, retainedRef?: string): Buffer {
    // A retained proof owns its original reference even when the issuance catalogue has advanced.
    const ref = retainedRef ?? options.reference(version)
    if (!ref) throw new TicketFault('ticket_version')
    const raw = options.resolve(ref)
    if (!/^[0-9a-f]{64}$/u.test(raw)) throw new TicketFault('ticket_material')
    return Buffer.from(raw, 'hex')
  }
  function envelopeDigest(envelope: TicketNonceEnvelope): string {
    return fingerprint({
      keyVersion: envelope.keyVersion,
      iv: Buffer.from(envelope.iv).toString('hex'),
      ciphertext: Buffer.from(envelope.ciphertext).toString('hex'),
      tag: Buffer.from(envelope.tag).toString('hex'),
    })
  }
  async function run<T>(
    context: CallContext,
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<Outcome<T>> {
    if (closing) return refuse('ticket_closed')
    if (
      context.signal.aborted ||
      !Number.isFinite(Date.parse(context.deadline)) ||
      Date.parse(context.deadline) <= clock()
    )
      return refuse('ticket_cancelled', 'cancelled')
    const timerAbort = new AbortController()
    const timer = setTimeout(
      () => timerAbort.abort(),
      Math.min(30000, Math.max(1, Date.parse(context.deadline) - clock())),
    )
    const signal = AbortSignal.any([context.signal, lifetime.signal, timerAbort.signal])
    let stop!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => reject(new TicketFault('ticket_cancelled', 'cancelled'))
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
    })
    const task = body(signal)
    try {
      const value = await Promise.race([task, cancelled])
      return { ok: true, value }
    } catch (error) {
      return error instanceof TicketFault ? refuse(error.detail, error.code) : refuse('ticket_unavailable')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
  }
  return {
    sealNonce(request, context) {
      return run(context, async (signal) => {
        // Copy caller-owned bytes before any asynchronous authorization boundary.
        const binding = structuredClone(request.binding)
        const aad = structuredClone(request.aad)
        const bytes = bindingCheck(binding, aad)
        if (!(request.nonce instanceof Uint8Array) || request.nonce.byteLength !== 32)
          throw new TicketFault('ticket_schema', 'invalid_input')
        const nonce = Buffer.from(request.nonce)
        let key: Buffer | undefined
        try {
          if (digest(nonce) !== aad.nonceDigest) throw new TicketFault('ticket_digest')
          const version = options.current().version
          await allowed(context, version, 'seal', signal)
          if (signal.aborted) throw new TicketFault('ticket_cancelled', 'cancelled')
          collect()
          if (db.prepare('SELECT ticket_id FROM ticket_material WHERE ticket_id=?').get(aad.ticketId))
            throw new TicketFault('ticket_exists', 'conflict')
          const ref = options.reference(version)
          if (!ref) throw new TicketFault('ticket_version')
          key = material(version, ref)
          await allowed(context, version, 'seal', signal)
          if (signal.aborted) throw new TicketFault('ticket_cancelled', 'cancelled')
          const iv = randomBytes(12)
          const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
          cipher.setAAD(bytes)
          const envelope = {
            keyVersion: version,
            iv,
            ciphertext: Buffer.concat([cipher.update(nonce), cipher.final()]),
            tag: cipher.getAuthTag(),
          }
          const expires = clock() + 300000
          const saved = db
            .prepare('INSERT OR IGNORE INTO ticket_material VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(
              aad.ticketId,
              version,
              ref,
              fingerprint(aad),
              envelopeDigest(envelope),
              expires,
              expires + options.diagnosticRetentionMs,
            )
          if (saved.changes !== 1) throw new TicketFault('ticket_exists', 'conflict')
          return envelope
        } finally {
          nonce.fill(0)
          key?.fill(0)
        }
      })
    },
    openNonce(request, context) {
      return run(context, async (signal) => {
        const binding = structuredClone(request.binding)
        const aad = structuredClone(request.aad)
        const bytes = bindingCheck(binding, aad)
        const envelope = structuredClone(request.envelope)
        if (
          Object.keys(envelope).sort().join(',') !== 'ciphertext,iv,keyVersion,tag' ||
          typeof envelope.keyVersion !== 'string' ||
          !envelope.keyVersion ||
          !(envelope.iv instanceof Uint8Array) ||
          envelope.iv.length !== 12 ||
          !(envelope.tag instanceof Uint8Array) ||
          envelope.tag.length !== 16 ||
          !(envelope.ciphertext instanceof Uint8Array) ||
          envelope.ciphertext.length !== 32
        )
          throw new TicketFault('ticket_schema', 'invalid_input')
        await allowed(context, envelope.keyVersion, 'open', signal)
        if (signal.aborted) throw new TicketFault('ticket_cancelled', 'cancelled')
        collect()
        const retained = db.prepare('SELECT * FROM ticket_material WHERE ticket_id=?').get(aad.ticketId)
        if (!retained || retained.version !== envelope.keyVersion) throw new TicketFault('ticket_version')
        if (Number(retained.expires) <= clock()) throw new TicketFault('ticket_expired')
        if (retained.aad !== fingerprint(aad) || retained.envelope !== envelopeDigest(envelope))
          throw new TicketFault('ticket_envelope')
        const key = material(envelope.keyVersion, String(retained.ref))
        let nonce: Buffer | undefined
        try {
          await allowed(context, envelope.keyVersion, 'open', signal)
          if (signal.aborted) throw new TicketFault('ticket_cancelled', 'cancelled')
          if (Number(retained.expires) <= clock()) throw new TicketFault('ticket_expired')
          const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv, { authTagLength: 16 })
          decipher.setAAD(bytes)
          decipher.setAuthTag(envelope.tag)
          nonce = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
          if (nonce.length !== 32 || digest(nonce) !== aad.nonceDigest) throw new TicketFault('ticket_digest')
          return Uint8Array.from(nonce)
        } finally {
          key.fill(0)
          nonce?.fill(0)
        }
      })
    },
    close() {
      if (!closing) {
        lifetime.abort()
        closing = Promise.resolve().then(() => {
          db.close()
        })
      }
      return closing
    },
  }
}
