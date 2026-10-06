// Actual original State preparation/response and durable identity fixture. Restricted source owner, not production installation.
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
import { afterEach } from 'vitest'
import { defaultPolicyDecision } from '../../core/src/runtime/policy/decision-composition.js'
import { jcs } from '../../protocol/src/jcs.js'
import { createIdentityAuthority } from '../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../src/runtime/identity/verify.js'
import type { ApprovalPreparation } from '../src/runtime/state/approval.js'
import type { ControlPorts } from '../src/runtime/state/control.js'
import { digestOf, stableId } from '../src/runtime/state/records.js'
import { type RuntimeApprovalJointOwner, RuntimeStateDatabase } from '../src/runtime/state/transactions.js'

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
type FixtureApproval = {
  actionId: string
  question: Extract<InteractionRecord['request'], { kind: 'approval' }>
  facts: TrustedPolicyFacts
  preparation: AuthorizationPreparation
  decision: PolicyDecision
  prepare: ApprovalPreparation
}
export async function interactionStateFixture(
  options: {
    failBeforeCommit?: () => boolean
    missingOwner?: boolean
    beforeCommit?: () => void
    /** Prepared actions in the run, each with its own approval preparation. */
    actions?: number
  } = {},
) {
  let auth:
    | { context: CallContext; capability: object; evidence: DataRef; revoke(): void; current(): boolean }
    | undefined
  const approvals = new Map<string, FixtureApproval>()
  const actualQuestions = new Map<string, InteractionRecord>()
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
      const approval = approvals.get(request.command.actionId)
      if (!approval) refuseSource()
      actualQuestions.set(approval.actionId, record)
      return {
        kind: 'authorize_action',
        actionId: request.command.actionId,
        expectedActionRevision: request.command.expectedActionRevision,
        decision: 'ask',
        decisionRef: inline(approval.decision, 'decision'),
        interactionId: record.interactionId,
        validUntil: approval.decision.validUntil,
        hookResults: [],
      }
    },
    verifyAuthorizationPreparation(value) {
      const approval = approvals.get(value.actionId)
      if (!auth?.current() || !approval || jcs(value) !== jcs(approval.preparation)) return undefined
      return approval.facts
    },
    verifyApprovalAsk(command) {
      const approval = approvals.get(command.actionId)
      const interaction = actualQuestions.get(command.actionId)
      if (
        !auth?.current() ||
        !approval ||
        !interaction ||
        jcs(command.decisionRef) !== jcs(inline(approval.decision, 'decision'))
      )
        return undefined
      return { preparationId: approval.preparation.preparationId, decision: approval.decision, interaction }
    },
  }
  function refuseSource(): never {
    throw Error('actual selected approval source is not current')
  }

  const dir = mkdtempSync(join(tmpdir(), 'approval-control-'))
  dirs.push(dir)
  const file = join(dir, 'state.sqlite')
  const commits: { wrote: boolean }[] = []
  const readScope = {
    kind: 'session' as const,
    installationId: 'installation',
    runtimeId: 'runtime',
    workspaceId: 'workspace',
    sessionId: 'session',
  }
  let realmComplete = true
  const selectedReadOwner = validateRuntime('RecordOwner', joint.owner)
  if (!selectedReadOwner.ok) throw Error('invalid actual selected read owner')
  const readOwner = {
    owner: selectedReadOwner.value,
    cursorKey: new Uint8Array(32).fill(11),
    now: () => Date.parse(now),
    current(queryContext: CallContext) {
      if (!auth || queryContext !== auth.context || !auth.current())
        throw Error('actual reader identity is no longer current')
      return { binding: 'fixture-reader', scope: readScope }
    },
    responseRealmComplete() {
      return realmComplete
    },
  }
  const store = new RuntimeStateDatabase({
    interactionRead: readOwner,
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
  // One action keeps the original identifiers; more are advanced in transitions of at most 64 actions.
  const actionCount = options.actions ?? 1
  const suffix = (i: number) => (i === 0 ? '' : `-${i}`)
  const keys = Array.from({ length: actionCount }, (_, i) => `tool${suffix(i)}`)
  for (let batch = 0; batch * 64 < actionCount; batch++) {
    const invocationId = `invocation${suffix(batch)}`
    await store.admitInvocation({
      requestId: `invoke${suffix(batch)}`,
      runId: 'run',
      targetActionId: null,
      baseRevision: batch,
      bindingId: 'binding',
      writerEpoch: 1,
      invocationId,
      deadline,
      queryAllowance: 0,
    })
    await store.closeInvocation({
      requestId: `close${suffix(batch)}`,
      invocationId,
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    const actions = keys.slice(batch * 64, batch * 64 + 64).map((key): PreparedAction => {
      const actionBody = {
        key,
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
      return { ...actionBody, intentFingerprint: digestOf(actionBody) }
    })
    await store.advanceRun({
      commitId: `advance${suffix(batch)}`,
      guard: { ...guard, invocationId, expectedRunRevision: batch },
      transition: {
        expectedRevision: batch,
        continuation: {
          namespace: 'agh.test',
          codecVersion: '1',
          data,
          provenance: { sourceRefs: [], producer: binding, trustLabels: [] },
          createdAt: now,
          references: [],
        },
        consumeSignals: [],
        actions,
        next: { kind: 'continue' },
      },
    })
  }
  const owner = store as unknown as Owner
  guard.expectedRunRevision = Math.ceil(actionCount / 64)
  guard.readGuards = [{ recordId: 'taint:run', expectedRecordRevision: 1 }]
  function approvalFor(i: number): FixtureApproval {
    const actionId = stableId('act', `run\0${keys[i]}`)
    const question = {
      kind: 'approval' as const,
      title: 'Approve tool',
      body: 'Original question',
      actionRef: actionId,
      inputDigest: digestOf(data),
      policyDecisionRef: `decision${suffix(i)}`,
      scope,
      allowedResponders: ['human'],
      expiresAt: deadline,
      idempotencyKey: `question${suffix(i)}`,
      risk: 'always' as const,
      intentDigest: '0'.repeat(64),
    }
    const intent = computeApprovalIntentDigest(question)
    if (!intent.ok) throw Error('actual intent construction failed')
    question.intentDigest = intent.value
    const facts: TrustedPolicyFacts = {
      factsId: `facts${suffix(i)}`,
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
      preparationId: `preparation${suffix(i)}`,
      actionId,
      inputDigest: question.inputDigest,
      toolCallResults: null,
      approvalRequest: question,
      policyFactsRef: inline(facts, 'facts'),
      fingerprint: digestOf({ actionId, inputDigest: question.inputDigest, request: question, facts }),
    }
    const prepare: ApprovalPreparation = {
      commitId: `prepare${suffix(i)}`,
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
      decisionId: `decision${suffix(i)}`,
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
    return { actionId, question, facts, preparation, decision, prepare }
  }
  for (let i = 0; i < actionCount; i++) {
    const approval = approvalFor(i)
    approvals.set(approval.actionId, approval)
  }
  const first = [...approvals.values()][0]
  if (!first) throw Error('fixture needs at least one action')
  const { actionId, question, prepare } = first
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
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const p = Buffer.from(
    JSON.stringify({ iss: 'issuer', sub: 'human', exp: Math.floor(Date.parse(now) / 1000) + 3600 }),
  ).toString('base64url')
  const fixtureSigningMaterial = ['actual', 'fixture', 'key'].join('-')
  const signature = createHmac('sha256', fixtureSigningMaterial).update(`${h}.${p}`).digest('base64url')
  const verified = verifyIdentityJwt(`${h}.${p}.${signature}`, {
    now: () => Date.parse(now),
    generation: 'generation',
    nonces: createIdentityNonceOwner(owner.db),
    jwt: { issuer: 'issuer', secret: fixtureSigningMaterial },
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
    readOwner,
    readScope,
    partialRealm: () => {
      realmComplete = false
    },
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
    /** Every prepared action's approval, the first being `prepare`/`question`/`actionId`. */
    approvals: [...approvals.values()].map(({ actionId, question, prepare }) => ({
      actionId,
      question,
      prepare,
    })),
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
