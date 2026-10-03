import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { JsonValue, RuntimeError, ScopeRef, SecretConsumerBinding } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  hasPrivateDaclSync,
  syncDirectorySync,
} from '@agnes/system-node'

type Consumer = Omit<SecretConsumerBinding, 'consumer'> & { readonly consumer: 'artifact-ticket' }
type Associated = { ticketId: string; tenantId: string; authorityId: string; nonceDigest: string }
type Packet = { keyVersion: string; iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }
type Installation = {
  readonly binding: Consumer
  readonly ownerId: string
  readonly principalRef: string
  readonly bindingId: string
  readonly scope: ScopeRef
  readonly authorityId: string
}
export interface ReferenceTicketDeployment {
  readonly installation: Installation
  readonly diagnosticRetentionMs: number
  readonly authorize?: (
    call: CallContext,
    installed: Installation,
    version: string,
    operation: 'seal' | 'open',
    signal: AbortSignal,
  ) => Promise<boolean>
}
export interface ReferenceTicketOptions extends ReferenceTicketDeployment {
  readonly directory: string
  readonly tenantId: string
  readonly now?: () => number
  readonly current: () => { version: string; revoked: boolean }
  readonly identity: (call: CallContext, signal: AbortSignal) => Promise<boolean>
  readonly reference: (version: string) => string | undefined
  readonly resolve: (pointer: string) => string
}
type Proof = {
  ticket: string
  version: string
  pointer: string
  associated: string
  packet: string
  validUntil: number
  keepUntil: number
}
type Document = { owner: string; proofs: Proof[] }
class Refusal {
  constructor(
    readonly detail: string,
    readonly code: RuntimeError['code'] = 'denied',
  ) {}
}
function failure(detailCode: string, code: RuntimeError['code'] = 'denied'): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Ticket material request refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'reference-artifact-ticket-key',
    },
  }
}
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
function canonical(value: unknown): string {
  const checked = validateRuntime('JsonValue', value)
  if (!checked.ok) throw new Refusal('ticket_schema', 'invalid_input')
  return jcs(checked.value)
}
const hashObject = (value: unknown) => canonicalJsonDigest(JSON.parse(canonical(value)) as JsonValue)
function packetHash(packet: Packet) {
  return hashObject({
    tag: Buffer.from(packet.tag).toString('hex'),
    ciphertext: Buffer.from(packet.ciphertext).toString('hex'),
    iv: Buffer.from(packet.iv).toString('hex'),
    keyVersion: packet.keyVersion,
  })
}

/** Independent cabinet: atomic JSON retention proofs and non-exportable WebCrypto keys. */
export function createReferenceArtifactTicketKeyPort(settings: ReferenceTicketOptions) {
  const target = structuredClone(settings.installation)
  const retention = settings.diagnosticRetentionMs
  if (
    Object.keys(target.binding).sort().join('/') !==
      'accountRef/audience/consumer/purpose/secretId/serverRef' ||
    ![
      target.ownerId,
      target.principalRef,
      target.bindingId,
      target.authorityId,
      settings.tenantId,
      target.binding.secretId,
      target.binding.serverRef,
    ].every((item) => validateRuntime('Id', item).ok) ||
    !(target.binding.accountRef === null || validateRuntime('Id', target.binding.accountRef).ok) ||
    !validateRuntime('ScopeRef', target.scope).ok ||
    typeof target.binding.audience !== 'string' ||
    target.binding.audience === '' ||
    !Number.isSafeInteger(retention) ||
    retention < 0 ||
    target.binding.consumer !== 'artifact-ticket' ||
    target.binding.purpose !== 'artifact-download-ticket-nonce-envelope'
  )
    throw new Error('Invalid ticket material installation')
  const time = settings.now ?? Date.now
  const owner = hashObject({ installed: target, tenant: settings.tenantId, retention })
  const cabinet = join(settings.directory, 'ticket-cabinet.json')
  if (!existsSync(settings.directory)) createPrivateDirectorySync(settings.directory)
  if (!hasPrivateDaclSync(settings.directory)) throw new Error('Private ticket storage required')
  const records = join(settings.directory, 'ticket-records')
  if (!existsSync(records)) createPrivateDirectorySync(records)
  if (!hasPrivateDaclSync(records)) throw new Error('Private ticket storage required')
  function commit(file: string, value: unknown, ownerRecord = false) {
    const stage = join(settings.directory, `ticket-stage-${randomUUID()}`)
    const descriptor = createPrivateFileSync(stage)
    try {
      writeFileSync(descriptor, JSON.stringify(value))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    try {
      try {
        linkSync(stage, file)
      } catch (problem) {
        if ((problem as NodeJS.ErrnoException).code !== 'EEXIST') throw problem
        if (!ownerRecord) throw new Refusal('ticket_exists', 'conflict')
      }
      syncDirectorySync(ownerRecord ? settings.directory : records)
    } finally {
      unlinkSync(stage)
      syncDirectorySync(settings.directory)
    }
  }
  function read(): Document {
    if (!hasPrivateDaclSync(cabinet)) throw new Error('Private ticket storage required')
    const document = JSON.parse(readFileSync(cabinet, 'utf8')) as Document
    if (document.owner !== owner || !Array.isArray(document.proofs))
      throw new Error('Ticket broker ownership mismatch')
    document.proofs = readdirSync(records).map((name) => {
      const path = join(records, name)
      if (!/^[a-f0-9]{64}\.json$/u.test(name) || !hasPrivateDaclSync(path))
        throw new Error('Invalid ticket proof storage')
      const record = JSON.parse(readFileSync(path, 'utf8')) as { owner: string; proof: Proof }
      if (record.owner !== owner || name !== `${hashObject(record.proof.ticket)}.json`)
        throw new Error('Ticket proof ownership mismatch')
      return record.proof
    })
    return document
  }
  if (!existsSync(cabinet)) commit(cabinet, { owner, proofs: [] }, true)
  read()
  const ending = new AbortController()
  let closed = false
  function live(signal: AbortSignal) {
    if (signal.aborted) throw new Refusal('ticket_cancelled', 'cancelled')
  }
  function collect(): Document {
    const document = read()
    for (const proof of document.proofs)
      if (proof.keepUntil <= time()) {
        try {
          unlinkSync(join(records, `${hashObject(proof.ticket)}.json`))
        } catch (problem) {
          if ((problem as NodeJS.ErrnoException).code !== 'ENOENT') throw problem
        }
      }
    syncDirectorySync(records)
    return { owner, proofs: document.proofs.filter((proof) => proof.keepUntil > time()) }
  }
  function associated(consumer: Consumer, aad: Associated): Uint8Array<ArrayBuffer> {
    const fields = Object.keys(aad).sort()
    if (
      fields.length !== 4 ||
      fields.join('/') !== 'authorityId/nonceDigest/tenantId/ticketId' ||
      !['ticketId', 'tenantId', 'authorityId'].every(
        (field) => validateRuntime('Id', aad[field as keyof Associated]).ok,
      ) ||
      !validateRuntime('Digest', aad.nonceDigest).ok
    )
      throw new Refusal('ticket_schema', 'invalid_input')
    if (
      canonical(consumer) !== canonical(target.binding) ||
      aad.authorityId !== target.authorityId ||
      aad.tenantId !== settings.tenantId
    )
      throw new Refusal('ticket_binding')
    return new TextEncoder().encode(canonical(aad))
  }
  function restrict<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
    let stop!: () => void
    const rejected = new Promise<never>((_, reject) => {
      stop = () => reject(new Refusal('ticket_cancelled', 'cancelled'))
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
    })
    return Promise.race([work, rejected]).finally(() => signal.removeEventListener('abort', stop))
  }
  async function permission(
    call: CallContext,
    version: string,
    operation: 'seal' | 'open',
    signal: AbortSignal,
  ) {
    if (
      call.bindingId !== target.bindingId ||
      call.principalRef !== target.principalRef ||
      canonical(call.scope) !== canonical(target.scope)
    )
      throw new Refusal('ticket_binding')
    const identified = await restrict(signal, settings.identity(call, signal))
    if (
      !identified ||
      settings.authorize === undefined ||
      !(await restrict(signal, settings.authorize(call, structuredClone(target), version, operation, signal)))
    )
      throw new Refusal('ticket_delegation')
    if (
      call.bindingId !== target.bindingId ||
      call.principalRef !== target.principalRef ||
      canonical(call.scope) !== canonical(target.scope)
    )
      throw new Refusal('ticket_binding')
    live(signal)
    const state = settings.current()
    if (state.revoked) throw new Refusal('ticket_revoked')
    if (operation === 'seal' && state.version !== version) throw new Refusal('ticket_version')
  }
  async function cryptographicKey(version: string, pointer?: string) {
    const selected = pointer === undefined ? settings.reference(version) : pointer
    if (selected === undefined) throw new Refusal('ticket_version')
    const text = settings.resolve(selected)
    if (text.length !== 64 || !/^[a-f0-9]+$/u.test(text)) throw new Refusal('ticket_material')
    const raw = Uint8Array.from(Buffer.from(text, 'hex'))
    try {
      return await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    } finally {
      raw.fill(0)
    }
  }
  async function execute<T>(
    call: CallContext,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<Outcome<T>> {
    if (closed) return failure('ticket_closed')
    const until = Date.parse(call.deadline)
    if (call.signal.aborted || !Number.isFinite(until) || until <= time())
      return failure('ticket_cancelled', 'cancelled')
    const timeout = new AbortController()
    const clock = setTimeout(() => timeout.abort(), Math.max(1, Math.min(30000, until - time())))
    const cancel = AbortSignal.any([call.signal, ending.signal, timeout.signal])
    let remove = () => {}
    const stopped = new Promise<never>((_, reject) => {
      const listener = () => reject(new Refusal('ticket_cancelled', 'cancelled'))
      cancel.addEventListener('abort', listener, { once: true })
      remove = () => cancel.removeEventListener('abort', listener)
      if (cancel.aborted) listener()
    })
    try {
      return { ok: true, value: await Promise.race([operation(cancel), stopped]) }
    } catch (problem) {
      return problem instanceof Refusal
        ? failure(problem.detail, problem.code)
        : failure('ticket_unavailable')
    } finally {
      clearTimeout(clock)
      remove()
    }
  }
  return {
    sealNonce(
      query: { binding: Consumer; aad: Associated; nonce: Uint8Array },
      call: CallContext,
    ): Promise<Outcome<Packet>> {
      return execute(call, async (signal) => {
        const consumer = structuredClone(query.binding)
        const aad = structuredClone(query.aad)
        const extra = associated(consumer, aad)
        if (!(query.nonce instanceof Uint8Array) || query.nonce.length !== 32)
          throw new Refusal('ticket_schema', 'invalid_input')
        const clear = Uint8Array.from(query.nonce)
        try {
          if (sha(clear) !== aad.nonceDigest) throw new Refusal('ticket_digest')
          const version = settings.current().version
          await permission(call, version, 'seal', signal)
          live(signal)
          if (collect().proofs.some((item) => item.ticket === aad.ticketId))
            throw new Refusal('ticket_exists', 'conflict')
          const pointer = settings.reference(version)
          if (!pointer) throw new Refusal('ticket_version')
          const key = await cryptographicKey(version, pointer)
          live(signal)
          const iv = Uint8Array.from(randomBytes(12))
          const encrypted = new Uint8Array(
            await webcrypto.subtle.encrypt(
              { name: 'AES-GCM', iv, additionalData: extra, tagLength: 128 },
              key,
              clear,
            ),
          )
          await permission(call, version, 'seal', signal)
          live(signal)
          const output: Packet = {
            keyVersion: version,
            iv,
            ciphertext: encrypted.slice(0, 32),
            tag: encrypted.slice(32),
          }
          const document = collect()
          if (document.proofs.some((item) => item.ticket === aad.ticketId))
            throw new Refusal('ticket_exists', 'conflict')
          const validUntil = time() + 300000
          const proof: Proof = {
            ticket: aad.ticketId,
            version,
            pointer,
            associated: hashObject(aad),
            packet: packetHash(output),
            validUntil,
            keepUntil: validUntil + retention,
          }
          commit(join(records, `${hashObject(proof.ticket)}.json`), { owner, proof })
          return output
        } finally {
          clear.fill(0)
        }
      })
    },
    openNonce(
      query: { binding: Consumer; aad: Associated; envelope: Packet },
      call: CallContext,
    ): Promise<Outcome<Uint8Array>> {
      return execute(call, async (signal) => {
        const consumer = structuredClone(query.binding)
        const aad = structuredClone(query.aad)
        const extra = associated(consumer, aad)
        const packet = structuredClone(query.envelope)
        if (
          Object.keys(packet).sort().join('/') !== 'ciphertext/iv/keyVersion/tag' ||
          typeof packet.keyVersion !== 'string' ||
          packet.keyVersion.length === 0 ||
          !(packet.iv instanceof Uint8Array) ||
          packet.iv.length !== 12 ||
          !(packet.ciphertext instanceof Uint8Array) ||
          packet.ciphertext.length !== 32 ||
          !(packet.tag instanceof Uint8Array) ||
          packet.tag.length !== 16
        )
          throw new Refusal('ticket_schema', 'invalid_input')
        await permission(call, packet.keyVersion, 'open', signal)
        live(signal)
        const record = collect().proofs.find((item) => item.ticket === aad.ticketId)
        if (record === undefined || record.version !== packet.keyVersion) throw new Refusal('ticket_version')
        if (record.validUntil <= time()) throw new Refusal('ticket_expired')
        if (record.associated !== hashObject(aad) || record.packet !== packetHash(packet))
          throw new Refusal('ticket_envelope')
        const key = await cryptographicKey(packet.keyVersion, record.pointer)
        live(signal)
        const combined = new Uint8Array(48)
        combined.set(packet.ciphertext)
        combined.set(packet.tag, 32)
        const plaintext = new Uint8Array(
          await webcrypto.subtle.decrypt(
            { name: 'AES-GCM', iv: Uint8Array.from(packet.iv), additionalData: extra, tagLength: 128 },
            key,
            combined,
          ),
        )
        try {
          await permission(call, packet.keyVersion, 'open', signal)
          live(signal)
          if (plaintext.length !== 32 || sha(plaintext) !== aad.nonceDigest)
            throw new Refusal('ticket_digest')
          if (record.validUntil <= time()) throw new Refusal('ticket_expired')
          return plaintext.slice()
        } finally {
          plaintext.fill(0)
        }
      })
    },
    async close(): Promise<void> {
      closed = true
      ending.abort()
    },
  }
}
