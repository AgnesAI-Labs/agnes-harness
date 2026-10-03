import {
  type CipherGCM,
  createCipheriv,
  createDecipheriv,
  type DecipherGCM,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { closeSync, existsSync, fsyncSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActionContext, CallContext, Outcome, TrustedIngressContext } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  hasPrivateDaclSync,
  syncDirectorySync,
} from '@agnes/system-node'
import { parseSecretRef, type SecretResolver } from '../../adapters/secrets.js'
import {
  type ArtifactTicketDeployment,
  type ArtifactTicketKeyPort,
  createArtifactTicketKeyPort,
} from '../artifact-ticket-key.js'

export const SECRETS_CONTRACT = 'agh.secrets'
export const DEFAULT_SECRETS_PROVIDER_ID = 'agh.default/secrets'
export interface SecretEntry {
  readonly secretId: string
  readonly versions: readonly { readonly version: string; readonly ref: string }[]
  /** Null is a provisionable catalogue entry with no credential installed yet. */
  readonly initialVersion?: string | null
}
export interface SecretGrant {
  readonly principalRef: string
  readonly scope: Wire.ScopeRef
  readonly binding: Wire.SecretConsumerBinding
}
export interface SecretFlow {
  readonly flowId: string
  readonly stateDigest: string
  readonly redirectUri: string
  readonly expiresAt: string
  readonly grant: SecretGrant
}
export interface SecretRenewal {
  readonly state: 'ready' | 'unknown' | 'needs-reconnect'
  readonly newVersionRef?: string
}
export interface SecretsOptions {
  readonly artifactTickets?: ArtifactTicketDeployment
  readonly directory: string
  readonly tenantId: string
  readonly entries: readonly SecretEntry[]
  readonly grants: readonly SecretGrant[]
  readonly source: Pick<SecretResolver, 'resolve'>
  readonly identity: {
    resolve(
      request: Wire.IdentityResolveRequest,
      context: CallContext,
    ): Promise<Outcome<Wire.AuthenticatedIdentity>>
  }
  readonly maintenance: (context: CallContext) => boolean
  readonly now?: () => number
  readonly handleMs?: number
  readonly drainMs?: number
  /** Deployment-owned restricted effect; material must stay in its credential store. */
  readonly refresh?: (
    request: Wire.CredentialRefreshRequest,
    context: ActionContext,
    signal: AbortSignal,
  ) => Promise<SecretRenewal>
  readonly exchange?: (
    request: Wire.CredentialExchangeRequest,
    code: Uint8Array,
    context: ActionContext,
    signal: AbortSignal,
  ) => Promise<SecretRenewal>
  readonly flows?: readonly SecretFlow[]
  readonly trustedIngress?: (context: TrustedIngressContext, flow: SecretFlow) => boolean
}
export interface SecretsService {
  /** Host-local companion; excluded from the public service descriptor and method map. */
  readonly artifactTicketKeyPort?: ArtifactTicketKeyPort
  readonly binding: Wire.BindingRef
  readonly providerDigest: string
  readonly features: readonly string[]
  resolve(request: unknown, context: CallContext): Promise<Outcome<Wire.SecretHandle>>
  use(
    handle: unknown,
    consumer: Wire.SecretConsumerBinding,
    context: CallContext,
    consume: (material: string, signal: AbortSignal) => Promise<void> | void,
  ): Promise<Outcome<void>>
  rotate(request: unknown, context: CallContext): Promise<Outcome<Wire.SecretsRotateResult>>
  revoke(request: unknown, context: CallContext): Promise<Outcome<Wire.SecretsRevokeResult>>
  refresh(request: unknown, context: ActionContext): Promise<Outcome<Wire.CredentialRefreshResult>>
  exchange(request: unknown, context: ActionContext): Promise<Outcome<Wire.CredentialRefreshResult>>
  acceptCallback(
    request: unknown,
    context: TrustedIngressContext,
  ): Promise<Outcome<Wire.SecretsAcceptCallbackResult>>
  close(): Promise<void>
}
class SecretFault extends Error {
  constructor(
    readonly code: Wire.RuntimeError['code'],
    readonly detail: string,
  ) {
    super('Secret request refused')
  }
}
function rejected(code: Wire.RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Secret request refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'secret-broker',
    },
  }
}
function decode<N extends keyof Wire.RuntimeWireTypes>(name: N, value: unknown): Wire.RuntimeWireTypes[N] {
  const result = validateRuntime(name, value)
  if (!result.ok) throw new SecretFault('invalid_input', 'secret_schema')
  return result.value
}
async function interruptible<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
  let cancel!: () => void
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new SecretFault('cancelled', 'secret_cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
type RecordRow = { ref: string; version: string; revision: number; revoked: number }

export function createSecretsService(options: SecretsOptions): SecretsService {
  // Only references and closed public metadata are persisted here.
  const entries = JSON.parse(JSON.stringify(options.entries)) as SecretEntry[]
  const grants = JSON.parse(JSON.stringify(options.grants)) as SecretGrant[]
  const ticketSecretId = options.artifactTickets?.installation.binding.secretId
  const flows = JSON.parse(JSON.stringify(options.flows ?? [])) as SecretFlow[]
  if (options.artifactTickets) {
    const ticket = entries.filter((entry) => entry.secretId === ticketSecretId)
    if (
      ticket.length !== 1 ||
      entries.some(
        (entry) =>
          entry.secretId !== ticketSecretId &&
          entry.versions.some((version) => ticket[0]?.versions.some((key) => key.ref === version.ref)),
      )
    )
      throw new Error('Ticket key catalogue must be isolated')
  }
  for (const entry of entries) {
    if (
      !entry.versions.length ||
      new Set(entry.versions.map((item) => item.version)).size !== entry.versions.length
    )
      throw new Error('Invalid secret reference catalogue')
    for (const item of entry.versions) parseSecretRef(item.ref)
    if (
      entry.initialVersion !== undefined &&
      entry.initialVersion !== null &&
      !entry.versions.some((item) => item.version === entry.initialVersion)
    )
      throw new Error('Invalid initial credential version')
  }
  if (!existsSync(options.directory)) createPrivateDirectorySync(options.directory)
  const file = join(options.directory, 'broker.sqlite')
  if (!existsSync(file)) closeSync(createPrivateFileSync(file))
  if (!hasPrivateDaclSync(options.directory) || !hasPrivateDaclSync(file))
    throw new Error('Private broker storage required')
  const db = new DatabaseSync(file)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ' +
      'CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, ref TEXT NOT NULL, version TEXT NOT NULL, revision INTEGER NOT NULL, revoked INTEGER NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS broker_owner (id INTEGER PRIMARY KEY CHECK(id = 1), tenant TEXT NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS handles (id TEXT PRIMARY KEY, locator TEXT NOT NULL, grant_digest TEXT NOT NULL, revision INTEGER NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS renewals (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT); ' +
      'CREATE TABLE IF NOT EXISTS credential_locks (secret_id TEXT PRIMARY KEY, request_id TEXT NOT NULL); ' +
      'CREATE TABLE IF NOT EXISTS escrow (flow_id TEXT PRIMARY KEY, id TEXT NOT NULL, cipher BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, binding_digest TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0)',
  )
  db.prepare('INSERT OR IGNORE INTO broker_owner VALUES (1, ?)').run(options.tenantId)
  if (db.prepare('SELECT tenant FROM broker_owner WHERE id = 1').get()?.tenant !== options.tenantId) {
    db.close()
    throw new Error('Broker ownership mismatch')
  }
  for (const entry of entries) {
    const first =
      entry.initialVersion === null
        ? { ref: '', version: '' }
        : entry.initialVersion === undefined
          ? entry.versions[0]
          : entry.versions.find((item) => item.version === entry.initialVersion)
    if (first)
      db.prepare('INSERT OR IGNORE INTO secrets VALUES (?, ?, ?, 1, 0)').run(
        entry.secretId,
        first.ref,
        first.version,
      )
  }
  const now = options.now ?? Date.now
  function keyPath(flowId: string) {
    return join(options.directory, `escrow-${canonicalJsonDigest(flowId)}.key`)
  }
  function eraseEscrow(flowId: string) {
    db.prepare(
      "UPDATE escrow SET consumed = 1, cipher = X'', iv = X'', tag = X'' WHERE flow_id = ? AND (consumed = 0 OR length(cipher) > 0)",
    ).run(flowId)
    const path = keyPath(flowId)
    if (existsSync(path)) unlinkSync(path)
  }
  function expireEscrow() {
    for (const row of db.prepare('SELECT flow_id, expires_at, consumed FROM escrow').all())
      if (
        typeof row.flow_id === 'string' &&
        (row.consumed !== 0 || Date.parse(String(row.expires_at)) <= now())
      )
        eraseEscrow(row.flow_id)
  }
  expireEscrow()
  const escrowTimer = setInterval(expireEscrow, 1000)
  escrowTimer.unref()
  const lifetime = new AbortController()
  const work = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  const binding: Wire.BindingRef = {
    bindingId: `${DEFAULT_SECRETS_PROVIDER_ID}/binding`,
    contract: SECRETS_CONTRACT,
    logicalName: 'secrets',
    providerId: DEFAULT_SECRETS_PROVIDER_ID,
  }
  const providerDigest = canonicalJsonDigest({
    contract: SECRETS_CONTRACT,
    recipe: 'sqlite-reference-broker',
  })

  async function run<T>(
    context: { signal: AbortSignal; deadline: string },
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<Outcome<T>> {
    if (lifetime.signal.aborted) return rejected('denied', 'secret_closed')
    if (
      context.signal.aborted ||
      !Number.isFinite(Date.parse(context.deadline)) ||
      Date.parse(context.deadline) <= now()
    )
      return rejected('cancelled', 'secret_cancelled')
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(),
      Math.min(30_000, Math.max(1, Date.parse(context.deadline) - now())),
    )
    const signal = AbortSignal.any([context.signal, lifetime.signal, timeout.signal])
    const pending = body(signal)
    work.add(pending)
    try {
      const value = await pending
      if (signal.aborted) return rejected('cancelled', 'secret_cancelled')
      return { ok: true, value }
    } catch (error) {
      return error instanceof SecretFault
        ? rejected(error.code, error.detail)
        : rejected('denied', 'secret_unavailable')
    } finally {
      clearTimeout(timer)
      work.delete(pending)
    }
  }
  async function identity(context: CallContext, signal: AbortSignal): Promise<void> {
    const checked = await interruptible(
      signal,
      options.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !checked.ok ||
      !validateRuntime('AuthenticatedIdentity', checked.value).ok ||
      checked.value.principalRef !== context.principalRef ||
      checked.value.tenantRef !== options.tenantId ||
      Date.parse(checked.value.expiresAt) <= now() ||
      lifetime.signal.aborted ||
      context.signal.aborted ||
      Date.parse(context.deadline) <= now()
    )
      throw new SecretFault('denied', 'secret_denied')
  }
  function record(id: string): RecordRow {
    const row = db.prepare('SELECT ref, version, revision, revoked FROM secrets WHERE id = ?').get(id)
    if (
      !row ||
      typeof row.ref !== 'string' ||
      typeof row.version !== 'string' ||
      typeof row.revision !== 'number' ||
      typeof row.revoked !== 'number'
    )
      throw new SecretFault('denied', 'secret_denied')
    if (row.revoked !== 0) throw new SecretFault('denied', 'secret_revoked')
    const catalogue = entries.find((entry) => entry.secretId === id)
    if (
      !(catalogue?.initialVersion === null && row.ref === '' && row.version === '') &&
      !entries
        .find((entry) => entry.secretId === id)
        ?.versions.some((item) => item.ref === row.ref && item.version === row.version)
    )
      throw new SecretFault('denied', 'secret_catalogue')
    return row as RecordRow
  }
  async function grant(
    secretId: string,
    audience: string,
    purpose: string,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<SecretGrant> {
    await identity(context, signal)
    if (secretId === ticketSecretId) throw new SecretFault('denied', 'secret_ticket_only')
    const allowed = grants.find(
      (item) =>
        item.principalRef === context.principalRef &&
        canonicalJsonDigest(item.scope) === canonicalJsonDigest(context.scope) &&
        item.binding.secretId === secretId &&
        item.binding.audience === audience &&
        item.binding.purpose === purpose,
    )
    if (!allowed) throw new SecretFault('denied', 'secret_denied')
    record(secretId)
    return allowed
  }
  function issue(allowed: SecretGrant, row: RecordRow, renewed = false): Wire.SecretHandle {
    if (!row.version) throw new SecretFault('denied', 'secret_not_provisioned')
    if (
      !renewed &&
      db.prepare('SELECT request_id FROM credential_locks WHERE secret_id = ?').get(allowed.binding.secretId)
    )
      throw new SecretFault('denied', 'secret_refresh_pending')
    const locator: Wire.SecretHandle = {
      handleId: randomUUID(),
      secretId: allowed.binding.secretId,
      version: row.version,
      audience: allowed.binding.audience,
      expiresAt: new Date(now() + (options.handleMs ?? 60_000)).toISOString(),
    }
    db.prepare('INSERT INTO handles VALUES (?, ?, ?, ?)').run(
      locator.handleId,
      JSON.stringify(locator),
      canonicalJsonDigest({ ...allowed }),
      row.revision,
    )
    return locator
  }
  function changed(
    secretId: string,
    newVersionRef: string,
    expected?: string,
    expectedRevision?: number,
  ): RecordRow {
    const current = record(secretId)
    if (
      (expected !== undefined && expected !== current.version) ||
      (expectedRevision !== undefined && expectedRevision !== current.revision)
    )
      throw new SecretFault('conflict', 'secret_version')
    const next = entries
      .find((entry) => entry.secretId === secretId)
      ?.versions.find((item) => item.ref === newVersionRef)
    if (!next || next.version === current.version) throw new SecretFault('invalid_input', 'secret_version')
    const result = db
      .prepare(
        'UPDATE secrets SET ref = ?, version = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND revoked = 0',
      )
      .run(next.ref, next.version, secretId, current.revision)
    if (result.changes !== 1) throw new SecretFault('conflict', 'secret_version')
    return record(secretId)
  }
  function escrowKey(flowId: string): Uint8Array {
    const path = keyPath(flowId)
    if (!existsSync(path)) {
      const fd = createPrivateFileSync(path)
      try {
        writeFileSync(fd, randomBytes(32))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      syncDirectorySync(options.directory)
    }
    if (!hasPrivateDaclSync(path)) throw new SecretFault('denied', 'secret_escrow')
    const bytes = readFileSync(path)
    if (bytes.length !== 32) throw new SecretFault('denied', 'secret_escrow')
    return bytes
  }
  async function renewal(
    request: Wire.CredentialRefreshRequest | Wire.CredentialExchangeRequest,
    allowed: SecretGrant,
    context: ActionContext,
    signal: AbortSignal,
    invoke: () => Promise<SecretRenewal>,
  ): Promise<Wire.CredentialRefreshResult> {
    const digest = canonicalJsonDigest({
      request,
      principal: context.call.principalRef,
      scope: context.call.scope,
    })
    const prior = db.prepare('SELECT * FROM renewals WHERE id = ?').get(request.requestId)
    if (prior) {
      if (prior.digest !== digest) throw new SecretFault('conflict', 'secret_request_identity')
      if (prior.result) return decode('CredentialRefreshResult', JSON.parse(String(prior.result)))
      return {
        requestId: request.requestId,
        state: 'unknown',
        handle: null,
        revision: record(allowed.binding.secretId).revision,
        diagnosticId: 'secret-renewal-unknown',
      }
    }
    const row = record(allowed.binding.secretId)
    if (request.expectedVersion !== (row.version || null)) throw new SecretFault('conflict', 'secret_version')
    if (
      db.prepare('SELECT request_id FROM credential_locks WHERE secret_id = ?').get(allowed.binding.secretId)
    )
      throw new SecretFault('conflict', 'secret_refresh_pending')
    signal.throwIfAborted()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO credential_locks VALUES (?, ?)').run(
        allowed.binding.secretId,
        request.requestId,
      )
      db.prepare('INSERT INTO renewals VALUES (?, ?, NULL)').run(request.requestId, digest)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    let result: SecretRenewal
    try {
      result = await invoke()
      if (signal.aborted) result = { state: 'unknown' }
    } catch {
      result = { state: 'unknown' }
    }
    // Once dispatched, missing or uncertain evidence is never treated as safe to resend.
    await grant(
      allowed.binding.secretId,
      allowed.binding.audience,
      allowed.binding.purpose,
      context.call,
      signal,
    )
    let output: Wire.CredentialRefreshResult
    if (result.state === 'ready' && result.newVersionRef) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const next = changed(allowed.binding.secretId, result.newVersionRef, row.version, row.revision)
        output = {
          requestId: request.requestId,
          state: 'ready',
          handle: issue(allowed, next, true),
          revision: next.revision,
          diagnosticId: null,
        }
        db.prepare('UPDATE renewals SET result = ? WHERE id = ?').run(
          JSON.stringify(output),
          request.requestId,
        )
        db.prepare('DELETE FROM credential_locks WHERE secret_id = ?').run(allowed.binding.secretId)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } else {
      output = {
        requestId: request.requestId,
        state: result.state === 'needs-reconnect' ? 'needs-reconnect' : 'unknown',
        handle: null,
        revision: row.revision,
        diagnosticId: 'secret-renewal-unresolved',
      }
      db.prepare('UPDATE renewals SET result = ? WHERE id = ?').run(JSON.stringify(output), request.requestId)
      if (output.state === 'needs-reconnect')
        db.prepare('DELETE FROM credential_locks WHERE secret_id = ?').run(allowed.binding.secretId)
    }
    return output
  }

  let ticketPort: ReturnType<typeof createArtifactTicketKeyPort> | undefined
  try {
    if (options.artifactTickets)
      ticketPort = createArtifactTicketKeyPort({
        ...options.artifactTickets,
        directory: join(options.directory, 'artifact-ticket-keys'),
        tenantId: options.tenantId,
        now,
        current() {
          if (ticketSecretId === undefined) throw new Error('Missing ticket installation')
          const row = db.prepare('SELECT version, revoked FROM secrets WHERE id = ?').get(ticketSecretId)
          if (!row) throw new Error('Missing ticket secret')
          return { version: String(row.version), revoked: row.revoked !== 0 }
        },
        async identity(context, signal) {
          try {
            await identity(context, signal)
            return true
          } catch {
            return false
          }
        },
        reference: (version) =>
          entries
            .find((entry) => entry.secretId === ticketSecretId)
            ?.versions.find((item) => item.version === version)?.ref,
        resolve: (ref) => options.source.resolve(ref),
      })
  } catch (error) {
    clearInterval(escrowTimer)
    db.close()
    throw error
  }
  return {
    ...(ticketPort
      ? {
          artifactTicketKeyPort: Object.freeze({
            sealNonce: ticketPort.sealNonce,
            openNonce: ticketPort.openNonce,
          }),
        }
      : {}),
    binding,
    providerDigest,
    features: [
      'resolve',
      'rotate',
      'revoke',
      'scope-bound-handles',
      'durable-revocation',
      ...(options.refresh ? ['refresh'] : []),
      ...(options.exchange && options.trustedIngress ? ['exchange', 'acceptCallback'] : []),
    ],
    resolve(request, context) {
      return run(context, async (signal) => {
        const input = decode('SecretsResolveRequest', request)
        const allowed = await grant(input.secretId, input.audience, input.purpose, context, signal)
        return issue(allowed, record(input.secretId))
      })
    },
    use(handle, consumer, context, consume) {
      return run(context, async (signal) => {
        const locator = decode('SecretHandle', handle)
        const allowed = await grant(locator.secretId, locator.audience, consumer.purpose, context, signal)
        if (canonicalJsonDigest(consumer) !== canonicalJsonDigest(allowed.binding))
          throw new SecretFault('denied', 'secret_consumer')
        const held = db.prepare('SELECT * FROM handles WHERE id = ?').get(locator.handleId)
        const row = record(locator.secretId)
        if (db.prepare('SELECT request_id FROM credential_locks WHERE secret_id = ?').get(locator.secretId))
          throw new SecretFault('denied', 'secret_refresh_pending')
        if (
          !held ||
          canonicalJsonDigest(decode('SecretHandle', JSON.parse(String(held.locator)))) !==
            canonicalJsonDigest(locator) ||
          held.grant_digest !== canonicalJsonDigest({ ...allowed }) ||
          held.revision !== row.revision ||
          locator.version !== row.version ||
          Date.parse(locator.expiresAt) <= now()
        )
          throw new SecretFault('denied', 'secret_handle')
        const material = options.source.resolve(row.ref)
        // Resolving legacy storage does not grant permission. Recheck before exposing any material.
        await grant(locator.secretId, locator.audience, consumer.purpose, context, signal)
        if (record(locator.secretId).revision !== row.revision)
          throw new SecretFault('denied', 'secret_revoked')
        signal.throwIfAborted()
        await consume(material, signal)
      })
    },
    rotate(request, context) {
      return run(context, async (signal) => {
        await identity(context, signal)
        if (!options.maintenance(context)) throw new SecretFault('denied', 'secret_maintenance')
        const input = decode('SecretsRotateRequest', request)
        return { revision: changed(input.secretId, input.newVersionRef).revision }
      })
    },
    revoke(request, context) {
      return run(context, async (signal) => {
        await identity(context, signal)
        if (!options.maintenance(context)) throw new SecretFault('denied', 'secret_maintenance')
        const input = decode('SecretsRevokeRequest', request)
        const row = db.prepare('SELECT revision, revoked FROM secrets WHERE id = ?').get(input.secretId)
        if (!row) throw new SecretFault('denied', 'secret_denied')
        if (row.revoked === 0)
          db.prepare('UPDATE secrets SET revoked = 1, revision = revision + 1 WHERE id = ?').run(
            input.secretId,
          )
        return { revision: Number(row.revision) + (row.revoked === 0 ? 1 : 0) }
      })
    },
    refresh(request, context) {
      return run(context.call, async (signal) => {
        const input = decode('CredentialRefreshRequest', request)
        const allowed = await grant(input.secretId, input.audience, input.purpose, context.call, signal)
        if (input.accountRef !== allowed.binding.accountRef || input.serverRef !== allowed.binding.serverRef)
          throw new SecretFault('denied', 'secret_consumer')
        const effect = options.refresh
        if (!effect) throw new SecretFault('incompatible', 'secret_refresh_unsupported')
        return renewal(input, allowed, context, signal, () => effect(input, context, signal))
      })
    },
    exchange(request, context) {
      return run(context.call, async (signal) => {
        const input = decode('CredentialExchangeRequest', request)
        const flow = flows.find((item) => item.flowId === input.flowId)
        if (!flow || Date.parse(flow.expiresAt) <= now()) throw new SecretFault('denied', 'secret_flow')
        const allowed = await grant(
          flow.grant.binding.secretId,
          input.audience,
          flow.grant.binding.purpose,
          context.call,
          signal,
        )
        if (
          canonicalJsonDigest({ ...allowed }) !== canonicalJsonDigest({ ...flow.grant }) ||
          input.accountRef !== allowed.binding.accountRef ||
          input.serverRef !== allowed.binding.serverRef
        )
          throw new SecretFault('denied', 'secret_consumer')
        const effect = options.exchange
        if (!effect) throw new SecretFault('incompatible', 'secret_exchange_unsupported')
        const saved = db
          .prepare('SELECT * FROM escrow WHERE flow_id = ? AND id = ?')
          .get(input.flowId, input.escrowId)
        if (!saved) throw new SecretFault('denied', 'secret_escrow')
        if (
          saved.binding_digest !==
            canonicalJsonDigest({ ...flow, grant: { ...flow.grant }, tenant: options.tenantId }) ||
          Date.parse(String(saved.expires_at)) <= now()
        )
          throw new SecretFault('denied', 'secret_flow')
        const prior = db.prepare('SELECT id FROM renewals WHERE id = ?').get(input.requestId)
        if (saved.consumed !== 0 && !prior) throw new SecretFault('denied', 'secret_escrow')
        return renewal(input, allowed, context, signal, async () => {
          db.prepare('UPDATE escrow SET consumed = 1 WHERE flow_id = ?').run(input.flowId)
          try {
            const key = escrowKey(flow.flowId)
            let decipher: DecipherGCM
            try {
              decipher = createDecipheriv('aes-256-gcm', key, saved.iv as Uint8Array)
            } finally {
              key.fill(0)
            }
            decipher.setAuthTag(saved.tag as Uint8Array)
            decipher.setAAD(Buffer.from(flow.flowId))
            const bytes = Buffer.concat([decipher.update(saved.cipher as Uint8Array), decipher.final()])
            try {
              return await effect(input, bytes, context, signal)
            } finally {
              bytes.fill(0)
            }
          } finally {
            eraseEscrow(input.flowId)
          }
        })
      })
    },
    acceptCallback(request, context) {
      return run(context, async () => {
        const input = decode('CredentialCallbackRequest', request)
        const flow = flows.find((item) => item.flowId === input.flowId)
        if (
          !flow ||
          !options.trustedIngress ||
          !options.exchange ||
          !options.trustedIngress(context, flow) ||
          context.tenantRoute !== options.tenantId ||
          context.installationId !== flow.grant.scope.installationId ||
          (flow.grant.scope.kind !== 'installation' && context.runtimeId !== flow.grant.scope.runtimeId) ||
          Date.parse(flow.expiresAt) <= now() ||
          canonicalJsonDigest(input.state) !== flow.stateDigest ||
          input.redirectUri !== flow.redirectUri
        )
          throw new SecretFault('denied', 'secret_callback')
        if (db.prepare('SELECT flow_id FROM escrow WHERE flow_id = ?').get(flow.flowId))
          throw new SecretFault('denied', 'secret_callback_replay')
        const iv = randomBytes(12)
        const key = escrowKey(flow.flowId)
        let cipher: CipherGCM
        try {
          cipher = createCipheriv('aes-256-gcm', key, iv)
        } finally {
          key.fill(0)
        }
        cipher.setAAD(Buffer.from(flow.flowId))
        const code = Buffer.from(input.authorizationCode)
        let sealed: Buffer
        try {
          sealed = Buffer.concat([cipher.update(code), cipher.final()])
        } finally {
          code.fill(0)
        }
        const escrowId = randomUUID()
        db.prepare(
          'INSERT INTO escrow (flow_id, id, cipher, iv, tag, binding_digest, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          flow.flowId,
          escrowId,
          sealed,
          iv,
          cipher.getAuthTag(),
          canonicalJsonDigest({ ...flow, grant: { ...flow.grant }, tenant: options.tenantId }),
          flow.expiresAt,
        )
        return { flowId: flow.flowId, escrowId }
      })
    },
    close() {
      if (!closing) {
        lifetime.abort()
        clearInterval(escrowTimer)
        const drained = Promise.allSettled([...work, ticketPort?.close()]).then(() => {
          db.close()
        })
        let timer: ReturnType<typeof setTimeout>
        const limit = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Secret broker did not drain')),
            Math.min(5000, Math.max(1, options.drainMs ?? 5000)),
          )
        })
        closing = Promise.race([drained, limit]).finally(() => clearTimeout(timer))
      }
      return closing
    },
  }
}
