/** Test owner bootstraps genuine committed Action; no Attempt is created until admit(). */
import { DatabaseSync } from 'node:sqlite'
import {
  boundedCanonicalJson,
  type CommitGuard,
  canonicalJsonDigest,
  type DataRef,
  type PreparedAction,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { stableId } from '../../../src/runtime/state/records.js'
import { RuntimeStateDatabase } from '../../../src/runtime/state/transactions.js'

const stamp = '2026-04-01T00:00:00.000Z',
  deadline = '2026-05-01T00:00:00.000Z'
export const effectsPreparedFixtureAuthority = {
  authorityId: 'effects-state',
  tenantId: 'tenant',
  authorityEpoch: 1,
}
export const effectsPreparedFixtureScope = { installationId: 'installation', kind: 'installation' as const }
export async function createEffectsPreparedStateFixture(file: string) {
  const state = new RuntimeStateDatabase({
    file,
    authority: effectsPreparedFixtureAuthority,
    now: () => Date.parse(stamp),
  })
  const value = { sessionId: 'input', lastWriterEpoch: 0, claim: null }
  const bytes = boundedCanonicalJson(value, { maxBytes: 4096, maxDepth: 16, maxMembers: 64 })
  if (!bytes.ok || !validateRuntime('StateLeaseRecordValue', value).ok) throw Error('Fixture codec refused')
  const data: DataRef = {
    kind: 'inline',
    schema: RuntimeSchemaRefs.StateLeaseRecordValue,
    value,
    bytes: bytes.value.bytes,
    digest: canonicalJsonDigest(value),
  }
  await state.createRun({
    admission: {
      ticketId: 'ticket',
      fingerprint: canonicalJsonDigest({ ticket: 'effects' }),
      releaseSetId: 'release',
      bindingId: 'binding',
      packagePinReceipt: data,
      runId: 'run',
      sessionId: 'session',
      lane: 'main',
      workspaceId: 'workspace',
      input: data,
      admittedAt: stamp,
      deadline,
      conversation: null,
    },
    scope: effectsPreparedFixtureScope,
  })
  await state.open({
    requestId: 'write',
    authority: effectsPreparedFixtureAuthority,
    sessionId: 'session',
    mode: 'write',
    writerId: 'writer',
    ttlMs: 600000,
  })
  await state.admitInvocation({
    requestId: 'invoke',
    runId: 'run',
    targetActionId: null,
    baseRevision: 0,
    bindingId: 'binding',
    writerEpoch: 1,
    invocationId: 'invocation',
    deadline,
    queryAllowance: 0,
  })
  await state.closeInvocation({
    requestId: 'close',
    invocationId: 'invocation',
    state: 'prepared',
    readGuards: [],
    domainReads: [],
    unresolvedInflightIds: [],
    observedQueryCount: 0,
  })
  const binding = {
    bindingId: 'binding',
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture-state',
  }
  const target = {
    bindingId: 'leaf',
    contract: 'agh.tool',
    logicalName: 'default',
    providerId: 'fixture-leaf',
  }
  const intent = {
    key: 'effect',
    target,
    method: 'run',
    input: data,
    dependencies: [],
    retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
    obligation: 'mandatory' as const,
    deadline,
    resultSchema: data.schema,
    references: [],
  }
  const prepared: PreparedAction = { ...intent, intentFingerprint: canonicalJsonDigest(intent) }
  const guard: CommitGuard = {
    authority: effectsPreparedFixtureAuthority,
    sessionId: 'session',
    runId: 'run',
    writerId: 'writer',
    writerEpoch: 1,
    expectedRunRevision: 0,
    bindingId: 'binding',
    invocationId: 'invocation',
    readGuards: [],
    queryUsage: null,
  }
  await state.advanceRun({
    commitId: 'advance',
    guard,
    transition: {
      expectedRevision: 0,
      continuation: {
        namespace: 'agh.test',
        codecVersion: '1',
        data,
        provenance: { sourceRefs: [], producer: binding, trustLabels: [] },
        createdAt: stamp,
        references: [],
      },
      consumeSignals: [],
      actions: [prepared],
      next: { kind: 'continue' },
    },
  })
  const actionId = stableId('act', 'run\0effect')
  guard.expectedRunRevision = 1
  const dispatch = {
    admissionId: 'admit',
    commitId: 'dispatch',
    guard,
    atomicDomain: {
      domainId: 'fixture-domain',
      revision: 1,
      stateAuthority: effectsPreparedFixtureAuthority,
      budgetAuthority: effectsPreparedFixtureAuthority,
      stateBinding: binding,
      budgetBinding: binding,
    },
    actionId,
    expectedActionRevision: 1,
    decisionRef: data,
    attemptId: 'attempt',
    requestIdentity: {
      system: 'fixture-peer',
      aghRequestId: 'request',
      idempotencyKey: null,
      requestDigest: canonicalJsonDigest(data),
    },
    budget: { reservation: null, quota: [] },
    deadline,
  }
  let admitted: Awaited<ReturnType<typeof state.dispatchAdmission>> | undefined
  const admit = async () => {
    const result = await state.dispatchAdmission(dispatch)
    if (result.state !== 'admitted') throw Error('Real State refused attempt')
    admitted = result
    return result
  }
  const db = new DatabaseSync(file)
  function record(id: string) {
    const row = db
      .prepare(
        'SELECT h.record_revision,b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
      )
      .get(id)
    if (!row || typeof row.value_json !== 'string') throw Error('Original record absent')
    return {
      revision: Number(row.record_revision),
      value: JSON.parse(row.value_json) as Record<string, unknown>,
    }
  }
  return {
    state,
    db,
    data,
    guard,
    dispatch,
    actionId,
    admit,
    get admitted() {
      if (admitted?.state !== 'admitted') throw Error('Attempt not durably admitted')
      return admitted
    },
    record,
    close() {
      db.close()
      state.close()
    },
  }
}
