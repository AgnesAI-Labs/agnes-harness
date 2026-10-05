import { createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime/authoring'
import {
  boundedCanonicalJson,
  type CommitGuard,
  canonicalJsonDigest,
  type DataRef,
  type PreparedAction,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createIdentityAuthority } from '../../../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../../src/runtime/identity/verify.js'
import { stableId } from '../../../src/runtime/state/records.js'
import { RuntimeStateDatabase } from '../../../src/runtime/state/transactions.js'

const stamp = '2026-04-01T00:00:00.000Z',
  deadline = '2026-05-01T00:00:00.000Z'
export const effectsFixtureAuthority = { authorityId: 'effects-state', tenantId: 'tenant', authorityEpoch: 1 }
export const effectsFixtureScope = { installationId: 'installation', kind: 'installation' as const }
export async function createEffectsStateFixture(file: string) {
  const state = new RuntimeStateDatabase({
    file,
    authority: effectsFixtureAuthority,
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
    scope: effectsFixtureScope,
  })
  await state.open({
    requestId: 'write',
    authority: effectsFixtureAuthority,
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
    authority: effectsFixtureAuthority,
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
      stateAuthority: effectsFixtureAuthority,
      budgetAuthority: effectsFixtureAuthority,
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
  const admitted = await state.dispatchAdmission(dispatch)
  if (admitted.state !== 'admitted') throw Error('Real State refused attempt')
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
    admitted,
    record,
    close() {
      db.close()
      state.close()
    },
  }
}

/** Real signed acceptance and SQLite-backed issuance; caller JSON never establishes current. */
export async function createEffectsIdentityFixture(clockHook?: () => undefined | number) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE fixture_claims(id TEXT PRIMARY KEY, binding TEXT NOT NULL, body TEXT NOT NULL)')
  const schema = defineGeneratedAuthorSchema<{ principalRef: string }>({
    ownerPackageId: 'fixture.effects',
    name: 'Claims',
    typeId: 'fixture.effects/claims@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Claims',
      $defs: {
        Claims: {
          type: 'object',
          additionalProperties: false,
          required: ['principalRef'],
          properties: { principalRef: { type: 'string' } },
        },
      },
    },
  })
  const identity = createIdentityAuthority(
    db,
    {
      async create(binding) {
        const claims = schema.encode({ principalRef: binding.principalRef })
        if (!claims.ok) throw Error('Claims refused')
        db.prepare('INSERT INTO fixture_claims VALUES(?,?,?)').run(
          binding.authorizationRef,
          canonicalJsonDigest(binding),
          canonicalJsonDigest(claims.value),
        )
        return claims.value
      },
      validate(ref, binding) {
        const row = db
          .prepare('SELECT binding,body FROM fixture_claims WHERE id=?')
          .get(binding.authorizationRef)
        return row?.binding === canonicalJsonDigest(binding) && row.body === canonicalJsonDigest(ref)
      },
    },
    () => {
      const at = clockHook?.()
      return typeof at === 'number' ? at : Date.parse(stamp)
    },
    (_source, target) =>
      target.bindingId === 'binding' &&
      canonicalJsonDigest(target.scope) === canonicalJsonDigest(effectsFixtureScope),
    (source) => source.kind === 'deployment' && source.generation === 'generation',
  )
  const key = randomBytes(32).toString('base64'),
    head = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    body = Buffer.from(
      JSON.stringify({ iss: 'fixture', sub: 'person', exp: Date.parse(deadline) / 1000 }),
    ).toString('base64url'),
    unsigned = `${head}.${body}`
  const verified = verifyIdentityJwt(
    `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`,
    {
      now: () => Date.parse(stamp),
      generation: 'generation',
      nonces: createIdentityNonceOwner(db),
      jwt: { issuer: 'fixture', secret: key },
    },
  )
  // Sign with the exact verifier bytes; the fixture never borrows deployment JWT keys.
  if (!verified.ok) throw Error('Signed fixture refused')
  const lifetime = new AbortController(),
    accepted = await identity.accept({
      verified: verified.value,
      principalRef: 'person',
      tenantRef: 'tenant',
      bindingId: 'binding',
      scope: effectsFixtureScope,
      signal: lifetime.signal,
      source: { kind: 'deployment', generation: 'generation', keyId: null },
    })
  if (!accepted) throw Error('Identity refused')
  const context = identity.issue(accepted.authorizationRef, {
    bindingId: 'binding',
    scope: effectsFixtureScope,
    invocationId: 'invocation',
    traceRef: 'trace',
    deadline,
    signal: lifetime.signal,
  })
  if (!context) throw Error('Context not issued')
  return {
    identity,
    context: context as CallContext,
    revoke() {
      lifetime.abort()
    },
    close() {
      identity.close()
      db.close()
    },
  }
}
