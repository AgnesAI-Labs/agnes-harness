import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import type {
  AuthorizationPreparation,
  CommitGuard,
  DataRef,
  InteractionRecord,
  PolicyDecision,
  PreparedAction,
  TrustedPolicyFacts,
} from '@agnes/protocol/runtime'
import {
  computeApprovalIntentDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, expect, it } from 'vitest'
import { defaultPolicyDecision } from '../../core/src/runtime/policy/decision-composition.js'
import { jcs } from '../../protocol/src/jcs.js'
import { createIdentityAuthority } from '../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../src/runtime/identity/verify.js'
import type { ApprovalPreparation } from '../src/runtime/state/approval.js'
import type { ControlPorts } from '../src/runtime/state/control.js'
import { digestOf, stableId } from '../src/runtime/state/records.js'
import { type RuntimeApprovalJointOwner, RuntimeStateDatabase } from '../src/runtime/state/transactions.js'
import { measureApprovalCommitIncrement } from './helpers/runtime-approval-commit-count.js'

const now = '2026-04-01T00:00:00.000Z',
  deadline = '2026-05-01T00:00:00.000Z'
const authority = { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
  scope = { installationId: 'installation', kind: 'installation' as const }
const binding = { bindingId: 'binding', contract: 'agh.tool', logicalName: 'tool', providerId: 'provider' }
const stores: RuntimeStateDatabase[] = [],
  dirs: string[] = []
type Owner = {
  db: DatabaseSync
  tx<T>(method: string, id: string, body: () => T | Promise<T>): Promise<T>
  controlPorts(): ControlPorts
  beginStaging(id: string): void
  flushStaging(): unknown
  clearStaging(): void
}
function inline(
  value: unknown,
  codec: 'lease' | 'facts' | 'decision' | 'json' = 'json',
): Extract<DataRef, { kind: 'inline' }> {
  const text = jcs(value)
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) throw Error('invalid fixture JSON')
  const definition =
    codec === 'facts'
      ? 'TrustedPolicyFacts'
      : codec === 'decision'
        ? 'PolicyDecision'
        : codec === 'lease'
          ? 'StateLeaseRecordValue'
          : 'JsonValue'
  if (!validateRuntime(definition, value).ok) throw Error('fixture author codec rejects payload')
  const document = { $id: `agh.test/approval-${codec}@1`, type: 'object' }
  return {
    kind: 'inline',
    schema:
      codec === 'lease'
        ? RuntimeSchemaRefs.StateLeaseRecordValue
        : { typeId: document.$id, revision: 1, digest: digestOf(document) },
    value: parsed.value,
    bytes: Buffer.byteLength(text),
    digest: digestOf(value),
  }
}
const interactionBinding = {
  bindingId: 'interaction-binding',
  contract: 'agh.interaction',
  logicalName: 'default',
  providerId: 'default-interaction',
}
async function fixture(
  options: { failBeforeCommit?: () => boolean; missingOwner?: boolean; beforeCommit?: () => void } = {},
) {
  let auth:
    | { context: CallContext; capability: object; evidence: DataRef; revoke(): void; current(): boolean }
    | undefined
  let actualQuestion: InteractionRecord | undefined
  const joint: RuntimeApprovalJointOwner = {
    owner: {
      authority: { authorityId: 'interaction-authority', tenantId: 'tenant', authorityEpoch: 1 },
      scope,
      ownerBinding: interactionBinding,
    },
    assertJoint(context, state, session) {
      if (
        !auth ||
        context !== auth.context ||
        !auth.current() ||
        jcs(state) !== jcs(authority) ||
        session !== 'session'
      )
        refuseSource()
    },
    currentResponder(context, capability) {
      if (!auth || context !== auth.context || capability !== auth.capability || !auth.current())
        refuseSource()
      return { actorRef: 'human', evidence: { kind: 'human', authenticationRef: auth.evidence } }
    },
    ask(context, request, record) {
      this.assertJoint(context, authority, 'session')
      actualQuestion = record
      return {
        kind: 'authorize_action',
        actionId: request.command.actionId,
        expectedActionRevision: request.command.expectedActionRevision,
        decision: 'ask',
        decisionRef: inline(decision, 'decision'),
        interactionId: record.interactionId,
        validUntil: decision.validUntil,
        hookResults: [],
      }
    },
    verifyAuthorizationPreparation(value) {
      if (!auth?.current() || jcs(value) !== jcs(preparation)) return undefined
      return facts
    },
    verifyApprovalAsk(command) {
      if (
        !auth?.current() ||
        !actualQuestion ||
        jcs(command.decisionRef) !== jcs(inline(decision, 'decision'))
      )
        return undefined
      return { preparationId: preparation.preparationId, decision, interaction: actualQuestion }
    },
  }
  function refuseSource(): never {
    throw Error('actual selected approval source is not current')
  }

  const dir = mkdtempSync(join(tmpdir(), 'approval-control-'))
  dirs.push(dir)
  const file = join(dir, 'state.sqlite')
  const commits: { wrote: boolean }[] = []
  const store = new RuntimeStateDatabase({
    file,
    onCommit: (notice) => commits.push(notice),
    authority,
    now: () => Date.parse(now),
    ...(!options.missingOwner ? { approvalJoint: joint } : {}),
    beforeCommit: () => {
      options.beforeCommit?.()
      if (options.failBeforeCommit?.()) throw Error('actual precommit failure')
    },
  })
  stores.push(store)
  const data = inline({ sessionId: 'input', lastWriterEpoch: 0, claim: null })
  await store.createRun({
    admission: {
      ticketId: 'ticket',
      fingerprint: 'a'.repeat(64),
      releaseSetId: 'release',
      bindingId: 'binding',
      packagePinReceipt: data,
      runId: 'run',
      sessionId: 'session',
      lane: 'main',
      workspaceId: 'workspace',
      input: data,
      admittedAt: now,
      deadline,
      conversation: null,
    },
    scope,
  })
  await store.open({
    requestId: 'write',
    authority,
    sessionId: 'session',
    mode: 'write',
    writerId: 'writer',
    ttlMs: 600000,
  })
  await store.admitInvocation({
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
  await store.closeInvocation({
    requestId: 'close',
    invocationId: 'invocation',
    state: 'prepared',
    readGuards: [],
    domainReads: [],
    unresolvedInflightIds: [],
    observedQueryCount: 0,
  })
  const actionBody = {
    key: 'tool',
    target: binding,
    method: 'run',
    input: data,
    dependencies: [],
    retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
    obligation: 'mandatory' as const,
    deadline,
    resultSchema: data.schema,
    references: [],
  }
  const action: PreparedAction = { ...actionBody, intentFingerprint: digestOf(actionBody) }
  const guard: CommitGuard = {
    authority,
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
  await store.advanceRun({
    commitId: 'advance',
    guard,
    transition: {
      expectedRevision: 0,
      continuation: {
        namespace: 'agh.test',
        codecVersion: '1',
        data,
        provenance: { sourceRefs: [], producer: binding, trustLabels: [] },
        createdAt: now,
        references: [],
      },
      consumeSignals: [],
      actions: [action],
      next: { kind: 'continue' },
    },
  })
  const actionId = stableId('act', 'run\0tool'),
    owner = store as unknown as Owner
  guard.expectedRunRevision = 1
  guard.readGuards = [{ recordId: 'taint:run', expectedRecordRevision: 1 }]
  const question = {
    kind: 'approval' as const,
    title: 'Approve tool',
    body: 'Original question',
    actionRef: actionId,
    inputDigest: digestOf(data),
    policyDecisionRef: 'decision',
    scope,
    allowedResponders: ['human'],
    expiresAt: deadline,
    idempotencyKey: 'question',
    risk: 'always' as const,
    intentDigest: '0'.repeat(64),
  }
  const intent = computeApprovalIntentDigest(question)
  if (!intent.ok) throw Error('actual intent construction failed')
  question.intentDigest = intent.value
  const facts: TrustedPolicyFacts = {
    factsId: 'facts',
    actionId,
    inputDigest: digestOf(data),
    evaluatedAt: now,
    toolPolicy: null,
    actor: { principalRef: 'human', revision: 1, executionDomain: 'domain', packageDigest: 'a'.repeat(64) },
    taint: {
      runId: 'run',
      current: { recordRevision: 1, sourceSeq: 0, clearedThroughSeq: 0 },
      captured: { recordRevision: 1, sourceSeq: 0, clearedThroughSeq: 0 },
      tainted: false,
      sourceRefs: [],
    },
    configuration: { revision: 1, profileDigest: 'a'.repeat(64), mode: 'manual', yolo: false },
    authorization: { decision: 'require-approval', policyRevision: 1, sourceRefs: [] },
    grants: [],
    guardian: { state: 'not-needed', actionId: null, resultRef: null, decision: null },
    hookResults: null,
    approvalRequestRef: inline(question),
  }
  const preparation: AuthorizationPreparation = {
    preparationId: 'preparation',
    actionId,
    inputDigest: question.inputDigest,
    toolCallResults: null,
    approvalRequest: question,
    policyFactsRef: inline(facts, 'facts'),
    fingerprint: digestOf({ actionId, inputDigest: question.inputDigest, request: question, facts }),
  }
  const prepare: ApprovalPreparation = {
    commitId: 'prepare',
    guard,
    command: { kind: 'prepare_authorization', actionId, expectedActionRevision: 1, preparation },
  }
  const composed = defaultPolicyDecision(
    {
      principalRef: 'human',
      resourceRef: {
        kind: 'resource',
        value: { resourceId: 'tool', version: 'v1', digest: question.inputDigest },
      },
      actionType: 'agh.test/tool@1',
      inputDigest: question.inputDigest,
      scope,
      policyRevision: 1,
      verifiedFacts: facts,
    },
    {
      toolName: 'tool',
      trustedManagementTool: false,
      hookDenied: false,
      priorDecisions: {},
      rules: {},
      argvNormalized: true,
      approval: question,
      guardianVerified: false,
      guardianScopes: [],
    },
  )
  if (composed.decision !== 'ask') throw Error('actual policy did not require human approval')
  const decision: PolicyDecision = {
    decisionId: 'decision',
    decision: composed.decision,
    principalRef: 'human',
    scope,
    inputDigest: question.inputDigest,
    policyRevision: 1,
    factsRef: preparation.policyFactsRef,
    conditions: data,
    reasonCodes: [...composed.reasonCodes],
    approvalSpec: question,
    validUntil: deadline,
  }
  // Restricted actual JWT/claims issuer fixture; actual current authority is durable SQLite, not JSON.
  const projections = new Map<string, string>()
  const identity = createIdentityAuthority(
    owner.db,
    {
      async create(bound) {
        const ref = {
          ...inline({ kind: 'local' }),
          schema: RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
        }
        projections.set(bound.authorizationRef, jcs({ ref, bound }))
        return ref
      },
      validate(ref, bound) {
        return projections.get(bound.authorizationRef) === jcs({ ref, bound })
      },
    },
    () => Date.parse(now),
    (_current, target) =>
      target.bindingId === interactionBinding.bindingId && jcs(target.scope) === jcs(scope),
    () => true,
  )
  const fixtureSigningKey = Buffer.from('isolated test signing material')
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const p = Buffer.from(
    JSON.stringify({ iss: 'issuer', sub: 'human', exp: Math.floor(Date.parse(now) / 1000) + 3600 }),
  ).toString('base64url')
  const signature = createHmac('sha256', fixtureSigningKey).update(`${h}.${p}`).digest('base64url')
  const verified = verifyIdentityJwt(`${h}.${p}.${signature}`, {
    now: () => Date.parse(now),
    generation: 'generation',
    nonces: createIdentityNonceOwner(owner.db),
    jwt: { issuer: 'issuer', secret: fixtureSigningKey.toString() },
  })
  if (!verified.ok) throw Error('actual signed JWT refused')
  const instance = await identity.accept({
    verified: verified.value,
    principalRef: 'human',
    tenantRef: 'tenant',
    bindingId: interactionBinding.bindingId,
    scope,
    signal: new AbortController().signal,
    source: { kind: 'deployment', generation: 'generation', keyId: 'fixture-key' },
  })
  if (!instance) throw Error('actual identity missing')
  const context = identity.issue(instance.authorizationRef, {
    bindingId: interactionBinding.bindingId,
    scope,
    invocationId: 'invocation',
    traceRef: 'trace',
    deadline: '2026-04-01T00:30:00Z',
    signal: new AbortController().signal,
  })
  if (!context) throw Error('actual context missing')
  const capability = Object.freeze({})
  const authEvidence = {
    ...inline(instance.identity),
    schema: RuntimeMethodSchemaRefs['agh.identity'].authenticate.output,
  }
  auth = {
    context,
    capability,
    evidence: authEvidence,
    revoke: () => {
      identity.revoke(instance.authorizationRef)
    },
    current: () => !!identity.current(context),
  }
  const prepareApproval = () =>
    store.prepareApproval({
      request: question,
      owner: { runId: 'run', actionId },
      preparation: prepare,
      context,
    })
  const resolveApproval = (interactionId: string, responseId = 'response', extra = {}) =>
    store.resolveApproval({
      context,
      authentication: capability,
      request: {
        interactionId,
        responseId,
        expectedVersion: 1,
        decision: 'approve',
        intentDigest: question.intentDigest,
        ...extra,
      },
    })
  const body = (id: string) => {
    const row = owner.db
      .prepare(
        'SELECT value_json FROM runtime_record_heads h JOIN runtime_version_bodies b USING(record_id,record_revision) WHERE record_id=?',
      )
      .get(id) as { value_json: string } | undefined
    return row ? JSON.parse(row.value_json) : undefined
  }
  const count = () => ({
    events: (
      owner.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_key='session'").get() as { n: number }
    ).n,
    aux: (owner.db.prepare('SELECT COUNT(*) AS n FROM runtime_aux_commits').get() as { n: number }).n,
  })
  return {
    file,
    commits,
    store,
    owner,
    joint,
    context,
    capability,
    auth,
    prepare,
    question,
    actionId,
    prepareApproval,
    resolveApproval,
    body,
    count,
    cold: () =>
      store.open({
        requestId: 'cold',
        authority,
        sessionId: 'session',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      }),
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('real dedicated prepare and resolve each commit once with cutoff, answer, inbox and signal; replay writes nothing', async () => {
  const f = await fixture(),
    before = f.count(),
    record = await f.prepareApproval()
  expect(f.body(`action:${f.actionId}`).state).toBe('awaiting-approval')
  expect(f.body('authorization-preparation:preparation').approvalRequest).toEqual(f.question)
  expect(f.count()).toEqual({ events: before.events + 1, aux: before.aux })
  expect(await f.prepareApproval()).toEqual(record)
  expect(f.count()).toEqual({ events: before.events + 1, aux: before.aux })
  const answered = await f.resolveApproval(record.interactionId)
  expect(answered.status).toBe('accepted')
  expect(f.count()).toEqual({ events: before.events + 2, aux: before.aux })
  await expect(f.cold()).resolves.toMatchObject({ minReader: 2 })
  const inbox = f.owner.db
    .prepare(
      'SELECT value_json FROM runtime_record_heads h JOIN runtime_version_bodies b USING(record_id,record_revision) WHERE schema_json=?',
    )
    .all(jcs(RuntimeSchemaRefs.InboxRecord)) as { value_json: string }[]
  expect(inbox).toHaveLength(1)
  expect(JSON.parse(inbox[0]?.value_json ?? '{}').eventId).toBe(`${record.interactionId}@2`)
  const signals = f.owner.db
    .prepare(
      'SELECT value_json FROM runtime_record_heads h JOIN runtime_version_bodies b USING(record_id,record_revision) WHERE schema_json=?',
    )
    .all(jcs(RuntimeSchemaRefs.SignalRecordValue)) as { value_json: string }[]
  expect(signals).toHaveLength(1)
  expect(JSON.parse(signals[0]?.value_json ?? '{}').signal.causation.interactionId).toBe(record.interactionId)
  expect(await f.resolveApproval(record.interactionId)).toEqual(answered)
  expect(f.count()).toEqual({ events: before.events + 2, aux: before.aux })
})
it('actual pre-COMMIT failure rolls back preparation question, ask, cutoff and action state', async () => {
  let fail = false
  const f = await fixture({ failBeforeCommit: () => fail }),
    before = f.count()
  fail = true
  await expect(f.prepareApproval()).rejects.toThrow('actual precommit failure')
  expect(f.body(`action:${f.actionId}`).state).toBe('prepared')
  expect(f.body('authorization-preparation:preparation')).toBeUndefined()
  expect(f.count()).toEqual(before)
  const records = f.owner.db
    .prepare('SELECT record_id FROM runtime_record_heads WHERE schema_json=?')
    .all(jcs(RuntimeSchemaRefs.InteractionRecord))
  expect(records).toHaveLength(0)
})
it('actual answer precommit failure rolls back answer source, inbox, signal and sequence watermark', async () => {
  let fail = false
  const f = await fixture({ failBeforeCommit: () => fail }),
    record = await f.prepareApproval(),
    before = f.count()
  fail = true
  await expect(f.resolveApproval(record.interactionId)).rejects.toThrow('actual precommit failure')
  expect(f.body(`interaction:${record.interactionId}`).status).toBe('pending')
  expect(f.count()).toEqual(before)
  expect(f.owner.db.prepare('SELECT run_id FROM runtime_signal_seq').all()).toHaveLength(0)
  for (const schema of [
    RuntimeSchemaRefs.InboxRecord,
    RuntimeSchemaRefs.SignalRecordValue,
    RuntimeSchemaRefs.ApprovalRespondRequest,
  ])
    expect(
      f.owner.db.prepare('SELECT record_id FROM runtime_record_heads WHERE schema_json=?').all(jcs(schema)),
    ).toHaveLength(0)
})
it('lost committed answer reply restores from immutable method input and answer membership; altered raw reply conflicts', async () => {
  const f = await fixture(),
    record = await f.prepareApproval(),
    answered = await f.resolveApproval(record.interactionId),
    after = f.count()
  expect(await f.resolveApproval(record.interactionId)).toEqual(answered)
  expect(f.count()).toEqual(after)
  await expect(f.resolveApproval(record.interactionId, 'response', { grantScope: 'once' })).rejects.toThrow(
    'different complete input',
  )
  await expect(f.resolveApproval(record.interactionId, 'second-response')).rejects.toMatchObject({
    detailCode: 'revision_conflict',
  })
  expect(f.count()).toEqual(after)
})
it('missing qualified selected owner and revoked actual current authentication refuse dedicated entries', async () => {
  const missing = await fixture({ missingOwner: true })
  await expect(missing.prepareApproval()).rejects.toThrow('owners are missing')
  const f = await fixture(),
    record = await f.prepareApproval(),
    before = f.count()
  f.auth.revoke()
  await expect(f.resolveApproval(record.interactionId)).rejects.toThrow('not current')
  expect(f.count()).toEqual(before)
})

it('counts original paired State commits including auxiliary writes through the authoritative helper', async () => {
  const result = await measureApprovalCommitIncrement(async (scenario) => {
    const f = await fixture()
    if (scenario === 'approval-k1') {
      const question = await f.prepareApproval()
      await f.resolveApproval(question.interactionId)
    }
    return { file: f.file, commits: f.commits }
  })
  expect(result.increment).toBe(2)
})

it('rejects human proof changes at the last original COMMIT gate and rolls back the whole answer', async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  let revoke = false
  f = await fixture({
    beforeCommit: () => {
      if (revoke && f)
        f.joint.currentResponder = () => {
          throw Error('human proof revoked at commit')
        }
    },
  })
  const question = await f.prepareApproval()
  const before = f.count()
  revoke = true
  await expect(f.resolveApproval(question.interactionId)).rejects.toThrow('human proof revoked at commit')
  expect(f.count()).toEqual(before)
  expect(f.body(`interaction:${question.interactionId}`).status).toBe('pending')
})
