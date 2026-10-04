import type { CallContext, MaintenanceStore, Outcome, RuntimeError } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  BindingRef,
  DataRef,
  JsonValue,
  MaintenanceEnvelopeJsonValue,
  MaintenanceMutation,
  OutboxRecord,
  ReleasePlan,
  ReleaseSet,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest, RuntimeAuthorCodecPolicy } from '@agnes/protocol/runtime'
import type { MaintenanceCredential } from '../maintenance/bootstrap-locator.js'
import {
  array,
  digest,
  equal,
  fields,
  freeze,
  ReleaseRefusal,
  readWire,
  releaseError,
  requireRelease,
} from './primitives.js'

/** No production adapter supplies these ports yet. Payload schemas remain provisional. */
export interface AssemblyMaintenancePorts {
  readonly qualification: 'persistent-fixture'
  readonly store: MaintenanceStore
  readonly authority: StateAuthorityRef
  readonly target: BindingRef
  readonly credential: MaintenanceCredential
  readonly writerEpoch: number
  readonly headRecordId: string
  now(): string
  authorize(context: CallContext, plan: ReleasePlan | null): Promise<boolean>
}
export class MaintenanceFailure extends Error {
  constructor(readonly error: RuntimeError) {
    super(error.detailCode)
  }
}
export async function maintenanceOutcome<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof MaintenanceFailure
          ? error.error
          : error instanceof ReleaseRefusal
            ? releaseError(error.detailCode, error.path)
            : releaseError('maintenance_unavailable'),
    }
  }
}
export async function authorizeMaintenance(
  ports: AssemblyMaintenancePorts,
  context: CallContext,
  plan: ReleasePlan | null,
): Promise<void> {
  requireRelease(
    ports.qualification === 'persistent-fixture',
    'production_inputs_unavailable',
    '/maintenance',
  )
  readWire('StateAuthorityRef', ports.authority)
  readWire('BindingRef', ports.target)
  readWire('UInt53', ports.writerEpoch)
  requireRelease(
    ports.writerEpoch > 0 &&
      ports.credential.principalRef === context.principalRef &&
      (await ports.authorize(context, plan)),
    'maintenance_denied',
    '/maintenance/authorization',
  )
  if (
    context.signal.aborted ||
    Date.parse(readWire('Timestamp', context.deadline)) <= Date.parse(readWire('Timestamp', ports.now()))
  )
    throw new MaintenanceFailure({ ...releaseError('maintenance_cancelled'), code: 'cancelled' })
}
function boundedJson(value: unknown): JsonValue {
  const policy = RuntimeAuthorCodecPolicy.payload
  const checked = boundedCanonicalJson(value, {
    maxBytes: policy.maxCanonicalJsonBytes,
    maxDepth: policy.maxDepth,
    maxMembers: policy.maxMembers,
  })
  // The public JSON snapshot enforces the same limits; maxMembers also bounds every array's length.
  requireRelease(checked.ok, 'schema_invalid', '/JsonValue')
  return checked.value.json
}
export function journalRef(value: unknown, kind: string): DataRef {
  const typeId = `agh.assembly/${kind}@1`,
    json = boundedJson(value)
  // Decode the unknown JSON once. The surrounding public request/reply still validates the complete ref.
  return freeze<DataRef>({
    kind: 'inline',
    schema: readWire('SchemaRef', {
      typeId,
      revision: 1,
      digest: digest({ typeId, schemaStatus: 'provisional-awaiting-protocol-owner-confirmation' }),
    }),
    value: json,
    digest: canonicalJsonDigest(json),
    bytes: Buffer.byteLength(jcs(json)),
  })
}
export function journalPayload(kind: string, data: unknown): JsonValue {
  return boundedJson({
    schemaStatus: 'provisional-awaiting-protocol-owner-confirmation',
    kind,
    data,
  })
}
export function journalData(record: MaintenanceEnvelopeJsonValue, kind: string): Record<string, unknown> {
  const body = fields(record.payload, ['schemaStatus', 'kind', 'data'], '/maintenance/payload')
  requireRelease(
    body.schemaStatus === 'provisional-awaiting-protocol-owner-confirmation' &&
      body.kind === kind &&
      equal(record.schema, journalRef(null, kind).schema) &&
      record.fingerprint === canonicalJsonDigest(record.payload),
    'maintenance_record_mismatch',
    '/maintenance/payload',
  )
  requireRelease(
    body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data),
    'maintenance_record_mismatch',
    '/maintenance/data',
  )
  return body.data as Record<string, unknown>
}
export function releaseSnapshot(release: ReleaseSet) {
  const json = boundedJson(release)
  return { canonicalJson: jcs(json), contentDigest: canonicalJsonDigest(json) }
}
export function readReleaseSnapshot(record: MaintenanceEnvelopeJsonValue): ReleaseSet {
  const data = fields(
    journalData(record, 'release-snapshot'),
    ['canonicalJson', 'contentDigest'],
    '/maintenance/release',
  )
  requireRelease(typeof data.canonicalJson === 'string', 'schema_invalid', '/maintenance/release')
  let parsed: unknown
  try {
    parsed = JSON.parse(data.canonicalJson)
  } catch {
    throw new ReleaseRefusal('schema_invalid', '/maintenance/release')
  }
  const release = readWire('ReleaseSet', parsed)
  requireRelease(
    record.recordId === `release:${release.releaseSetId}` && equal(data, releaseSnapshot(release)),
    'release_digest_mismatch',
    '/maintenance/release',
  )
  return release
}
export function journalMutation(
  ports: Pick<AssemblyMaintenancePorts, 'writerEpoch'>,
  recordId: string,
  kind: string,
  data: unknown,
  previous: MaintenanceEnvelopeJsonValue | null,
  now: string,
): MaintenanceMutation {
  const payload = journalPayload(kind, data)
  // journalCommit validates the complete aggregate before crossing MaintenanceStore.commit.
  return {
    recordId,
    expectedRevision: previous?.revision ?? null,
    next: {
      recordId,
      revision: (previous?.revision ?? 0) + 1,
      writerEpoch: ports.writerEpoch,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      schema: journalRef(null, kind).schema,
      payload,
      fingerprint: canonicalJsonDigest(payload),
    },
  }
}
function replyValue(reply: import('@agnes/protocol/runtime').QueryReply) {
  requireRelease(reply.kind === 'value', 'maintenance_query_unavailable', '/maintenance/query')
  const ref = reply.output
  requireRelease(ref.kind === 'inline', 'content_unavailable', '/maintenance/query')
  requireRelease(
    ref.digest === canonicalJsonDigest(ref.value) && ref.bytes === Buffer.byteLength(jcs(ref.value)),
    'content_identity_mismatch',
    '/maintenance/query',
  )
  return ref.value
}
export async function journalRead(
  ports: AssemblyMaintenancePorts,
  recordIds: readonly string[] | null,
  context: CallContext,
): Promise<MaintenanceEnvelopeJsonValue[]> {
  if (recordIds === null) {
    const result = await ports.store.query(
      readWire('ServiceQuery', {
        target: ports.target,
        method: 'assembly.records',
        input: journalRef({ recordIds: null }, 'journal-query'),
      }),
      context,
    )
    if (!result.ok) throw new MaintenanceFailure(result.error)
    const reply = readWire('QueryReply', result.value)
    const body = fields(replyValue(reply), ['recordIds'], '/maintenance/query')
    const ids = array(body.recordIds, '/maintenance/recordIds').map((id) => readWire('Id', id))
    requireRelease(new Set(ids).size === ids.length, 'maintenance_record_mismatch', '/maintenance/records')
    const collected: MaintenanceEnvelopeJsonValue[] = []
    for (const id of ids) collected.push(...(await journalRead(ports, [id], context)))
    return collected
  }
  const result = await ports.store.query(
    readWire('ServiceQuery', {
      target: ports.target,
      method: 'assembly.records',
      input: journalRef({ recordIds }, 'journal-query'),
    }),
    context,
  )
  if (!result.ok) throw new MaintenanceFailure(result.error)
  const reply = readWire('QueryReply', result.value)
  const body = fields(replyValue(reply), ['records'], '/maintenance/query')
  const records = array(body.records, '/maintenance/records').map((row) =>
    readWire('MaintenanceEnvelopeJsonValue', row),
  )
  requireRelease(
    new Set(records.map((row) => row.recordId)).size === records.length &&
      records.every((row) => recordIds.includes(row.recordId)),
    'maintenance_record_mismatch',
    '/maintenance/records',
  )
  return records
}
export function journalEvent(
  ports: AssemblyMaintenancePorts,
  transactionId: string,
  now: string,
  data: unknown,
): OutboxRecord {
  const payload = journalRef(data, 'release-published')
  return readWire('OutboxRecord', {
    eventId: `event:${transactionId}`,
    sourceAuthorityId: ports.authority.authorityId,
    sourceCommitId: transactionId,
    destination: 'assembly-release-route',
    typeId: payload.schema.typeId,
    payload,
    fingerprint: digest(data),
    delivery: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    claim: null,
    ackRef: null,
    consecutiveFailures: 0,
    lastError: null,
  })
}
export async function journalCommit(
  ports: AssemblyMaintenancePorts,
  transactionId: string,
  mutations: MaintenanceMutation[],
  outbox: OutboxRecord[],
  context: CallContext,
): Promise<void> {
  await authorizeMaintenance(ports, context, null)
  const result = await ports.store.commit(
    readWire('MaintenanceStoreCommitRequest', {
      transactionId,
      authority: ports.authority,
      expectedWriterEpoch: ports.writerEpoch,
      mutations,
      outbox,
    }),
    context,
  )
  if (!result.ok) throw new MaintenanceFailure(result.error)
  const receipt = readWire('MaintenanceStoreCommitResult', result.value)
  requireRelease(
    receipt.transactionId === transactionId &&
      receipt.revisions.length === mutations.length &&
      mutations.every((row) =>
        receipt.revisions.some(
          (revision) => revision.recordId === row.recordId && revision.revision === row.next.revision,
        ),
      ),
    'maintenance_commit_mismatch',
    '/maintenance/commit',
  )
}
