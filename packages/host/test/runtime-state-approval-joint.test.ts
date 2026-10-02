import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { InteractionTransaction, StoredInteractionResponse, StoredInteractionWake } from '@agnes/core'
import { jcs } from '@agnes/protocol'
import {
  type ApprovalRequest,
  canonicalJsonDigest,
  computeApprovalIntentDigest,
  type DataRef,
  type InteractionRecord,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
} from '@agnes/protocol/runtime'
import { afterEach, expect, it } from 'vitest'
import { createIdentityAuthority } from '../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../src/runtime/identity/verify.js'
import {
  type ApprovalJointPorts,
  type ApprovalPreparation,
  prepareApprovalInTransaction,
  resolveApprovalInTransaction,
} from '../src/runtime/state/approval.js'
import type { SessionView, WriteCommitInput } from '../src/runtime/state/control.js'
import type { StoredRecord } from '../src/runtime/state/records.js'
import { refuse } from '../src/runtime/state/refusal.js'
import { RuntimeStateDatabase } from '../src/runtime/state/transactions.js'

const now = Date.parse('2026-04-01T00:00:00Z'),
  at = new Date(now).toISOString()
const scope = { installationId: 'installation', kind: 'installation' as const }
const authority = { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 }
const binding = {
  bindingId: 'interaction',
  contract: 'agh.interaction',
  logicalName: 'default',
  providerId: 'default-interaction',
}
const dirs: string[] = [],
  stores: RuntimeStateDatabase[] = []
type Owner = {
  db: DatabaseSync
  tx<T>(method: string, id: string, body: () => T | Promise<T>): Promise<T>
  requireSession(sessionId: string): Promise<SessionView>
  writeCommit(input: WriteCommitInput): unknown
}
const inline = (schema: DataRef['schema'], value: unknown): DataRef => ({
  kind: 'inline',
  schema,
  value: value as never,
  digest: canonicalJsonDigest(value as never),
  bytes: Buffer.byteLength(jcs(value)),
})
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'state-approval-joint-'))
  dirs.push(dir)
  const store = new RuntimeStateDatabase({ file: join(dir, 'state.sqlite'), authority, now: () => now })
  stores.push(store)
  const owner = store as unknown as Owner
  const data = inline(RuntimeSchemaRefs.StateLeaseRecordValue, {
    sessionId: 'input',
    lastWriterEpoch: 0,
    claim: null,
  })
  await store.createRun({
    scope,
    admission: {
      ticketId: 'ticket',
      fingerprint: 'a'.repeat(64),
      releaseSetId: 'release',
      bindingId: 'run-binding',
      packagePinReceipt: data,
      runId: 'run',
      sessionId: 'session',
      lane: 'main',
      workspaceId: 'workspace',
      input: data,
      admittedAt: at,
      deadline: '2026-05-01T00:00:00Z',
      conversation: null,
    },
  })
  // Restricted actual JWT/claims issuer fixture; actual current authority is durable SQLite, not JSON.
  const projections = new Map<string, string>()
  const identity = createIdentityAuthority(
    owner.db,
    {
      async create(bound) {
        const ref = inline(RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope, { kind: 'local' })
        projections.set(bound.authorizationRef, jcs({ ref, bound }))
        return ref
      },
      validate(ref, bound) {
        return projections.get(bound.authorizationRef) === jcs({ ref, bound })
      },
    },
    () => now,
    (_current, target) => target.bindingId === binding.bindingId && jcs(target.scope) === jcs(scope),
    () => true,
  )
  const fixtureSigningKey = Buffer.from('isolated test signing material')
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const p = Buffer.from(
    JSON.stringify({ iss: 'issuer', sub: 'human', exp: Math.floor(now / 1000) + 3600 }),
  ).toString('base64url')
  const signature = createHmac('sha256', fixtureSigningKey).update(`${h}.${p}`).digest('base64url')
  const verified = verifyIdentityJwt(`${h}.${p}.${signature}`, {
    now: () => now,
    generation: 'generation',
    nonces: createIdentityNonceOwner(owner.db),
    jwt: { issuer: 'issuer', secret: fixtureSigningKey.toString() },
  })
  if (!verified.ok) throw Error('actual signed JWT refused')
  const instance = await identity.accept({
    verified: verified.value,
    principalRef: 'human',
    tenantRef: 'tenant',
    bindingId: binding.bindingId,
    scope,
    signal: new AbortController().signal,
    source: { kind: 'deployment', generation: 'generation', keyId: 'fixture-key' },
  })
  if (!instance) throw Error('actual identity missing')
  const context = identity.issue(instance.authorizationRef, {
    bindingId: binding.bindingId,
    scope,
    invocationId: 'invocation',
    traceRef: 'trace',
    deadline: '2026-04-01T00:30:00Z',
    signal: new AbortController().signal,
  })
  if (!context) throw Error('actual context missing')
  const capability = Object.freeze({})
  const authEvidence = inline(RuntimeMethodSchemaRefs['agh.identity'].authenticate.output, instance.identity)
  let drafts = new Map<string, { record: InteractionRecord; original?: InteractionRecord }>(),
    wake: StoredInteractionWake | undefined
  let fullFingerprint = '',
    failWake = false,
    revokeDuringWrite = false,
    commitNumber = 0
  const rows = () =>
    owner.db
      .prepare(
        `SELECT record_id,record_revision,last_commit_id,value_json FROM runtime_record_heads h JOIN runtime_version_bodies b USING(record_id,record_revision) WHERE schema_json=?`,
      )
      .all(jcs(RuntimeSchemaRefs.InteractionRecord)) as {
      record_id: string
      record_revision: number
      last_commit_id: string
      value_json: string
    }[]
  const record = (id: string) =>
    drafts.get(id)?.record ??
    rows()
      .map((row) => JSON.parse(row.value_json) as InteractionRecord)
      .find((r) => r.interactionId === id)
  const response = (id: string): StoredInteractionResponse | undefined => {
    const r = rows()
      .map((row) => JSON.parse(row.value_json) as InteractionRecord)
      .find((r) => r.status === 'answered' && r.resolution.responseId === id)
    if (r?.status !== 'answered') return undefined
    return {
      responseId: id,
      fingerprint: canonicalJsonDigest({
        method: 'respondApproval',
        interactionId: r.interactionId,
        expectedVersion: r.version - 1,
        actorRef: r.resolution.actorRef,
        answer: r.resolution.answer,
      }),
      status: {
        interactionId: r.interactionId,
        responseId: id,
        status: 'accepted',
        version: r.version,
        result: r,
        error: null,
      },
    }
  }
  const tx: InteractionTransaction = {
    record,
    recordByIdempotencyKey: (key) =>
      rows()
        .map((row) => JSON.parse(row.value_json) as InteractionRecord)
        .find((r) => r.request.idempotencyKey === key),
    response,
    putRecord(r) {
      const original = record(r.interactionId)
      drafts.set(r.interactionId, { record: r, ...(original ? { original } : {}) })
      if (revokeDuringWrite) identity.revoke(instance.authorizationRef)
    },
    putResponse() {
      throw Error('must use complete original-source journal')
    },
    wake() {
      return undefined
    },
    dueWakes() {
      return []
    },
    putWake(w) {
      wake = w
    },
  }
  const eventFingerprint = (id: string) => {
    const row = rows().find((row) => row.record_id === `interaction:${id}`)
    if (!row) return undefined
    const event = owner.db
      .prepare(`SELECT data FROM events WHERE session_key='session' AND json_extract(data,'$.commitId')=?`)
      .get(row.last_commit_id) as { data: string } | undefined
    if (!event) throw Error('original actual commit missing')
    return (JSON.parse(event.data) as { transactionFingerprint: string }).transactionFingerprint
  }
  const ports: ApprovalJointPorts = {
    now: () => at,
    assertTransaction() {
      if (!owner.db.isTransaction) throw Error('original transaction absent')
    },
    assertJoint(ctx) {
      if (ctx !== context || !identity.current(ctx))
        refuse('denied', 'authentication', 'current selected caller missing')
    },
    currentResponder(ctx, token) {
      if (token !== capability || !identity.current(ctx))
        refuse('denied', 'authentication', 'actual responder missing')
      return { actorRef: 'human', evidence: { kind: 'human', authenticationRef: authEvidence } }
    },
    interaction: tx,
    prepared(id) {
      const r = record(id),
        fp = eventFingerprint(id)
      return r && fp ? { record: r, fingerprint: fp } : undefined
    },
    stagePreparation(_id, fp) {
      fullFingerprint = fp
    },
    fullResponse(id) {
      const r = response(id)
      const fp = r?.status.interactionId ? eventFingerprint(r.status.interactionId) : undefined
      return r && fp ? { response: r, fingerprint: fp } : undefined
    },
    stageFullResponse(fp) {
      fullFingerprint = fp
    },
    stageResolvedWake() {
      if (failWake) throw Error('actual inbox staging failed')
    },
  }
  const questionBase = {
    kind: 'approval' as const,
    title: 'Approve',
    body: 'Run command',
    actionRef: 'action',
    inputDigest: 'a'.repeat(64),
    policyDecisionRef: 'policy',
    scope,
    allowedResponders: ['human'],
    expiresAt: '2026-04-01T00:20:00Z',
    idempotencyKey: 'prepare',
    risk: 'always' as const,
    intentDigest: '0'.repeat(64),
  }
  const digest = computeApprovalIntentDigest(questionBase)
  if (!digest.ok) throw Error('fixture intent invalid')
  const question: ApprovalRequest = { ...questionBase, intentDigest: digest.value }
  const preparation: ApprovalPreparation = {
    commitId: 'preparation',
    guard: {
      authority,
      sessionId: 'session',
      runId: 'run',
      writerId: 'writer',
      writerEpoch: 1,
      expectedRunRevision: 0,
      bindingId: 'run-binding',
      invocationId: 'invocation',
      readGuards: [],
      queryUsage: null,
    },
    command: {
      kind: 'prepare_authorization',
      actionId: 'action',
      expectedActionRevision: 0,
      preparation: {
        preparationId: 'authorization-preparation',
        actionId: 'action',
        inputDigest: question.inputDigest,
        toolCallResults: null,
        approvalRequest: question,
        policyFactsRef: data,
        fingerprint: 'b'.repeat(64),
      },
    },
  }
  async function run<T>(body: () => Promise<T>): Promise<T> {
    return owner.tx('approval-fixture', `approval-${++commitNumber}`, async () => {
      drafts = new Map()
      wake = undefined
      fullFingerprint = ''
      const verifiedSession = await owner.requireSession('session')
      const result = await body()
      if (drafts.size) {
        const creates: StoredRecord[] = [],
          updates: { record: StoredRecord; previousRevision: number }[] = []
        for (const [id, draft] of drafts) {
          const stored: StoredRecord = {
            recordId: `interaction:${id}`,
            schema: RuntimeSchemaRefs.InteractionRecord,
            minReader: 2,
            recordRevision: draft.record.version,
            owner: { authority, scope, ownerBinding: binding },
            value: draft.record,
          }
          if (draft.original) updates.push({ record: stored, previousRevision: draft.original.version })
          else creates.push(stored)
        }
        owner.writeCommit({
          sessionId: 'session',
          verified: verifiedSession,
          commitId: `approval-${commitNumber}`,
          at,
          fingerprint: fullFingerprint,
          runId: 'run',
          actionId: null,
          writerEpoch: 0,
          runRevision: 0,
          actionIds: [],
          creates,
          updates,
          sides: [],
        })
      }
      return result
    })
  }
  const prepare = () =>
    run(() =>
      prepareApprovalInTransaction(ports, {
        request: question,
        owner: { runId: 'run', actionId: 'action' },
        preparation,
        context,
      }),
    )
  const resolve = (id: string, responseId = 'response', extra = {}) =>
    run(() =>
      resolveApprovalInTransaction(ports, {
        request: {
          interactionId: id,
          responseId,
          expectedVersion: 1,
          decision: 'approve',
          intentDigest: question.intentDigest,
          ...extra,
        },
        context,
        authentication: capability,
      }),
    )
  return {
    store,
    owner,
    prepare,
    resolve,
    context,
    ports,
    capability,
    question,
    preparation,
    rows,
    run,
    revoke: () => identity.revoke(instance.authorizationRef),
    setFailWake: () => {
      failWake = true
    },
    setRevokeDuringWrite: () => {
      revokeDuringWrite = true
    },
    wake: () => wake,
    count: () =>
      owner.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_key='session'").get() as { n: number },
  }
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('actual original SQLite commits creation and answer once; lost answer reply replays without a new event', async () => {
  const f = await fixture(),
    r = await f.prepare(),
    before = f.count().n
  const first = await f.resolve(r.interactionId)
  expect(first.status).toBe('accepted')
  expect(f.count().n).toBe(before + 1)
  expect(f.wake()?.wake.responseId).toBe('response')
  const after = f.count().n
  expect(await f.resolve(r.interactionId)).toEqual(first)
  expect(f.count().n).toBe(after)
})
it('actual original transaction rolls answer and complete replay decision back when inbox staging fails', async () => {
  const f = await fixture(),
    r = await f.prepare(),
    before = f.count().n
  f.setFailWake()
  await expect(f.resolve(r.interactionId)).rejects.toThrow('inbox staging failed')
  expect(f.rows()).toHaveLength(1)
  const persisted = f.rows()[0]
  if (!persisted) throw Error('original pending record missing')
  expect(JSON.parse(persisted.value_json).status).toBe('pending')
  expect(f.count().n).toBe(before)
})
it('same response ID with changed complete input conflicts and another response loses original version CAS', async () => {
  const f = await fixture(),
    r = await f.prepare()
  await f.resolve(r.interactionId)
  const after = f.count().n
  await expect(f.resolve(r.interactionId, 'response', { grantScope: 'once' })).rejects.toMatchObject({
    failure: { detailCode: 'idempotency_conflict' },
  })
  await expect(f.resolve(r.interactionId, 'other-response')).rejects.toMatchObject({
    detailCode: 'revision_conflict',
  })
  expect(f.count().n).toBe(after)
})
it('actual durable current revocation during rule await rolls the whole pending answer back', async () => {
  const f = await fixture(),
    r = await f.prepare(),
    before = f.count().n
  f.setRevokeDuringWrite()
  await expect(f.resolve(r.interactionId)).rejects.toThrow()
  expect(f.count().n).toBe(before)
  const persisted = f.rows()[0]
  if (!persisted) throw Error('original pending record missing')
  expect(JSON.parse(persisted.value_json).status).toBe('pending')
})
it('a cloned CallContext or client JSON capability cannot mint responder authority', async () => {
  const f = await fixture(),
    r = await f.prepare()
  await expect(
    f.run(() =>
      resolveApprovalInTransaction(f.ports, {
        request: {
          interactionId: r.interactionId,
          responseId: 'response',
          expectedVersion: 1,
          decision: 'deny',
          intentDigest: f.question.intentDigest,
        },
        context: { ...f.context },
        authentication: {},
      }),
    ),
  ).rejects.toThrow()
})

it('preparation requires the same exact action and immutable question source', async () => {
  const f = await fixture(),
    before = f.count().n
  await expect(
    f.run(() =>
      prepareApprovalInTransaction(f.ports, {
        request: f.question,
        owner: { runId: 'run', actionId: 'different-action' },
        preparation: f.preparation,
        context: f.context,
      }),
    ),
  ).rejects.toThrow('actual authorization preparation')
  expect(f.rows()).toHaveLength(0)
  expect(f.count().n).toBe(before)
})
it('preparation replay returns the original record and rejects changed complete preparation input', async () => {
  const f = await fixture(),
    original = await f.prepare(),
    after = f.count().n
  expect(await f.prepare()).toEqual(original)
  expect(f.count().n).toBe(after)
  await expect(
    f.run(() =>
      prepareApprovalInTransaction(f.ports, {
        request: f.question,
        owner: { runId: 'run', actionId: 'action' },
        context: f.context,
        preparation: { ...f.preparation, command: { ...f.preparation.command, expectedActionRevision: 1 } },
      }),
    ),
  ).rejects.toThrow('different complete input')
  expect(f.count().n).toBe(after)
})
