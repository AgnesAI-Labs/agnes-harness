import type { CallContext, MaintenanceStore, Outcome, RuntimeError } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  BindingRef,
  DataRef,
  JsonValue,
  MaintenanceEnvelopeJsonValue,
  MaintenanceMutation,
  ReleasePlan,
  ReleaseSet,
  RuntimeWireTypes,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  validateRuntime,
} from '@agnes/protocol/runtime'

export interface ReferenceMaintenancePorts {
  qualification: 'persistent-fixture'
  store: MaintenanceStore
  authority: StateAuthorityRef
  target: BindingRef
  credential: { principalRef: string; directoryId: string; credentialDigest: string }
  writerEpoch: number
  headRecordId: string
  now(): string
  authorize(context: CallContext, plan: ReleasePlan | null): Promise<boolean>
}
export class JournalFault extends Error {
  constructor(
    readonly detail: string,
    readonly wireError?: RuntimeError,
  ) {
    super(detail)
  }
}
export function assertJournal(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new JournalFault(detail)
}
export function journalWire<K extends keyof RuntimeWireTypes>(key: K, input: unknown): RuntimeWireTypes[K] {
  const checked = validateRuntime(key, input)
  assertJournal(checked.ok, 'schema_invalid')
  return checked.value
}
function referenceJson(input: unknown): JsonValue {
  const { maxCanonicalJsonBytes, maxDepth, maxMembers } = RuntimeAuthorCodecPolicy.payload
  const snapshot = boundedCanonicalJson(input, { maxDepth, maxMembers, maxBytes: maxCanonicalJsonBytes })
  assertJournal(snapshot.ok, 'schema_invalid')
  return snapshot.value.json
}
export const journalHash = (input: unknown) => canonicalJsonDigest(referenceJson(input))
export const journalSame = (a: unknown, b: unknown) => jcs(a) === jcs(b)
export function referenceObject(raw: unknown, keys?: string[]): Record<string, unknown> {
  assertJournal(raw && !Array.isArray(raw) && typeof raw === 'object', 'schema_invalid')
  const row = raw as Record<string, unknown>
  if (keys) assertJournal(Object.keys(row).sort().join() === [...keys].sort().join(), 'schema_invalid')
  return row
}
export async function referenceResult<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    const fault = error instanceof JournalFault ? error : new JournalFault('maintenance_unavailable')
    return {
      ok: false,
      error: fault.wireError ?? {
        code:
          fault.detail === 'schema_invalid'
            ? 'invalid_input'
            : fault.detail.includes('unimplemented')
              ? 'incompatible'
              : 'conflict',
        detailCode: fault.detail,
        message: 'Maintenance operation refused',
        diagnosticId: 'assembly-release-set',
        retryAdvice: { kind: 'never' },
      },
    }
  }
}
export async function referenceAuthorized(
  ports: ReferenceMaintenancePorts,
  call: CallContext,
  plan: ReleasePlan | null,
): Promise<void> {
  assertJournal(ports.qualification === 'persistent-fixture', 'production_inputs_unavailable')
  journalWire('StateAuthorityRef', ports.authority)
  journalWire('BindingRef', ports.target)
  journalWire('UInt53', ports.writerEpoch)
  assertJournal(
    ports.writerEpoch > 0 &&
      call.principalRef === ports.credential.principalRef &&
      (await ports.authorize(call, plan)),
    'maintenance_denied',
  )
  if (
    call.signal.aborted ||
    Date.parse(journalWire('Timestamp', call.deadline)) <= Date.parse(journalWire('Timestamp', ports.now()))
  )
    throw new JournalFault('maintenance_cancelled', {
      code: 'cancelled',
      detailCode: 'maintenance_cancelled',
      message: 'Maintenance operation refused',
      diagnosticId: 'assembly-release-set',
      retryAdvice: { kind: 'never' },
    })
}
export function referenceRef(input: unknown, category: string): DataRef {
  const value = referenceJson(input)
  const typeId = ['agh.assembly/', category, '@1'].join('')
  const ref: DataRef = {
    value,
    kind: 'inline',
    bytes: Buffer.byteLength(jcs(value)),
    digest: canonicalJsonDigest(value),
    schema: journalWire('SchemaRef', {
      digest: journalHash({ schemaStatus: 'provisional-awaiting-protocol-owner-confirmation', typeId }),
      revision: 1,
      typeId,
    }),
  }
  const stack: unknown[] = [ref]
  while (stack.length) {
    const item = stack.pop()
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      stack.push(...Object.values(item))
      Object.freeze(item)
    }
  }
  return ref
}
export function referenceBody(row: MaintenanceEnvelopeJsonValue, category: string): Record<string, unknown> {
  const payload = referenceObject(row.payload, ['kind', 'data', 'schemaStatus'])
  assertJournal(
    payload.kind === category &&
      payload.schemaStatus === 'provisional-awaiting-protocol-owner-confirmation' &&
      row.fingerprint === canonicalJsonDigest(row.payload) &&
      journalSame(row.schema, referenceRef(null, category).schema),
    'maintenance_record_mismatch',
  )
  return referenceObject(payload.data)
}
export function referenceSnapshot(release: ReleaseSet) {
  const value = referenceJson(release)
  return { contentDigest: canonicalJsonDigest(value), canonicalJson: jcs(value) }
}
export function referenceRelease(record: MaintenanceEnvelopeJsonValue): ReleaseSet {
  const body = referenceObject(referenceBody(record, 'release-snapshot'), ['contentDigest', 'canonicalJson'])
  assertJournal(typeof body.canonicalJson === 'string', 'schema_invalid')
  let content: unknown
  try {
    content = JSON.parse(body.canonicalJson)
  } catch {
    throw new JournalFault('schema_invalid')
  }
  const decoded = journalWire('ReleaseSet', content)
  assertJournal(
    record.recordId === ['release:', decoded.releaseSetId].join('') &&
      journalSame(body, referenceSnapshot(decoded)),
    'release_digest_mismatch',
  )
  return decoded
}
export function referenceWrite(
  ports: ReferenceMaintenancePorts,
  id: string,
  category: string,
  body: unknown,
  prior: MaintenanceEnvelopeJsonValue | null,
  time: string,
): MaintenanceMutation {
  const payload = referenceJson({
    data: body,
    kind: category,
    schemaStatus: 'provisional-awaiting-protocol-owner-confirmation',
  })
  // The aggregate is decoded in referenceCommit; payload already crossed its bounded JSON decoder.
  return {
    expectedRevision: prior ? prior.revision : null,
    recordId: id,
    next: {
      payload,
      fingerprint: canonicalJsonDigest(payload),
      schema: referenceRef(null, category).schema,
      recordId: id,
      revision: 1 + (prior ? prior.revision : 0),
      writerEpoch: ports.writerEpoch,
      updatedAt: time,
      createdAt: prior ? prior.createdAt : time,
    },
  }
}
export async function referenceRead(
  ports: ReferenceMaintenancePorts,
  call: CallContext,
  wanted?: string[],
): Promise<MaintenanceEnvelopeJsonValue[]> {
  const fetch = async (ids: string[] | null) => {
    const outcome = await ports.store.query(
      {
        method: 'assembly.records',
        target: ports.target,
        input: referenceRef({ recordIds: ids }, 'journal-query'),
      },
      call,
    )
    if (!outcome.ok) throw new JournalFault(outcome.error.detailCode, outcome.error)
    const reply = journalWire('QueryReply', outcome.value)
    assertJournal(reply.kind === 'value', 'maintenance_query_unavailable')
    assertJournal(reply.output.kind === 'inline', 'content_unavailable')
    assertJournal(
      reply.output.digest === canonicalJsonDigest(reply.output.value) &&
        reply.output.bytes === Buffer.byteLength(jcs(reply.output.value)),
      'content_identity_mismatch',
    )
    return referenceObject(reply.output.value, [ids === null ? 'recordIds' : 'records'])
  }
  const keys: string[] = []
  if (wanted) keys.push(...wanted.map((id) => journalWire('Id', id)))
  else {
    const index = await fetch(null)
    assertJournal(Array.isArray(index.recordIds), 'schema_invalid')
    keys.push(...index.recordIds.map((id) => journalWire('Id', id)))
  }
  assertJournal(new Set(keys).size === keys.length, 'maintenance_record_mismatch')
  const envelopes: MaintenanceEnvelopeJsonValue[] = []
  for (const key of keys) {
    const data = await fetch([key])
    assertJournal(Array.isArray(data.records), 'schema_invalid')
    const matching = data.records.map((row) => journalWire('MaintenanceEnvelopeJsonValue', row))
    assertJournal(
      matching.length <= 1 && matching.every((row) => row.recordId === key),
      'maintenance_record_mismatch',
    )
    envelopes.push(...matching)
  }
  return envelopes
}

export async function referenceCommit(
  ports: ReferenceMaintenancePorts,
  id: string,
  changes: MaintenanceMutation[],
  events: RuntimeWireTypes['OutboxRecord'][],
  call: CallContext,
): Promise<void> {
  await referenceAuthorized(ports, call, null)
  const result = await ports.store.commit(
    journalWire('MaintenanceStoreCommitRequest', {
      mutations: changes,
      outbox: events,
      transactionId: id,
      authority: ports.authority,
      expectedWriterEpoch: ports.writerEpoch,
    }),
    call,
  )
  if (!result.ok) throw new JournalFault(result.error.detailCode, result.error)
  const committed = journalWire('MaintenanceStoreCommitResult', result.value)
  const received = new Map(committed.revisions.map((row) => [row.recordId, row.revision]))
  assertJournal(
    committed.transactionId === id &&
      committed.revisions.length === changes.length &&
      changes.every((entry) => received.get(entry.recordId) === entry.next.revision),
    'maintenance_commit_mismatch',
  )
}
export function referenceDigests(release: RuntimeWireTypes['ReleaseSet']): string[] {
  const digests: string[] = []
  for (const pkg of release.packages) {
    digests.push(pkg.digest)
    for (const member of Object.values(pkg.entries)) digests.push(member.digest)
  }
  return digests.sort().filter((value, index, sorted) => value !== sorted[index - 1])
}
