import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthorizationPreparation,
  CommitControlRequest,
  CommitGuard,
  DataRef,
  InteractionRecord,
  PolicyDecision,
  PreparedAction,
  TrustedPolicyFacts,
} from '@agnes/protocol/runtime'
import { RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { afterEach, expect, it } from 'vitest'
import { jcs } from '../../protocol/src/jcs.js'
import { type ControlPorts, commitControlTx } from '../src/runtime/state/control.js'
import { digestOf, stableId } from '../src/runtime/state/records.js'
import { RuntimeStateDatabase } from '../src/runtime/state/transactions.js'

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
  codec: 'lease' | 'facts' | 'decision' = 'lease',
): Extract<DataRef, { kind: 'inline' }> {
  const text = jcs(value)
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) throw Error('invalid fixture JSON')
  const definition =
    codec === 'facts'
      ? 'TrustedPolicyFacts'
      : codec === 'decision'
        ? 'PolicyDecision'
        : 'StateLeaseRecordValue'
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
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'approval-control-'))
  dirs.push(dir)
  const store = new RuntimeStateDatabase({
    file: join(dir, 'state.sqlite'),
    authority,
    now: () => Date.parse(now),
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
  const body = {
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
  const action: PreparedAction = { ...body, intentFingerprint: digestOf(body) }
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
    intentDigest: action.intentFingerprint,
  }
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
    approvalRequestRef: null,
  }
  const preparation: AuthorizationPreparation = {
    preparationId: 'preparation',
    actionId,
    inputDigest: question.inputDigest,
    toolCallResults: null,
    approvalRequest: question,
    policyFactsRef: inline(facts, 'facts'),
    fingerprint: 'a'.repeat(64),
  }
  const prepare: CommitControlRequest = {
    commitId: 'prepare',
    guard,
    command: { kind: 'prepare_authorization', actionId, expectedActionRevision: 1, preparation },
  }
  const interaction: InteractionRecord = {
    interactionId: 'interaction',
    owner: { runId: 'run', actionId },
    request: question,
    version: 1,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    terminationReason: null,
    resolution: null,
  }
  const decision: PolicyDecision = {
    decisionId: 'decision',
    decision: 'ask',
    principalRef: 'human',
    scope,
    inputDigest: question.inputDigest,
    policyRevision: 1,
    factsRef: preparation.policyFactsRef,
    conditions: data,
    reasonCodes: [],
    approvalSpec: question,
    validUntil: deadline,
  }
  const ask: CommitControlRequest = {
    commitId: 'ask',
    guard,
    command: {
      kind: 'authorize_action',
      actionId,
      expectedActionRevision: 1,
      decision: 'ask',
      decisionRef: inline(decision, 'decision'),
      interactionId: 'interaction',
      validUntil: deadline,
    },
  }
  // Restricted selected owner fixtures prove only this test's original policy/question inputs, not a production policy provider.
  const ports: ControlPorts = {
    ...owner.controlPorts(),
    verifyAuthorizationPreparation: (value) => (jcs(value) === jcs(preparation) ? facts : undefined),
    verifyApprovalAsk: () => ({ preparationId: 'preparation', decision, interaction }),
  }
  const tx = <T>(fn: () => T | Promise<T>) => owner.tx('approval-test', 'test', fn)
  const state = () =>
    [
      'events',
      'runtime_record_heads',
      'runtime_version_bodies',
      'runtime_commit_proofs',
      'runtime_leases',
    ].map((name) => owner.db.prepare(`SELECT * FROM ${name}`).all())
  return { store, owner, ports, prepare, ask, facts, preparation, interaction, decision, tx, state, actionId }
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('writes actual original authorization preparation with cutoff proof, preserving action and taint and proving the record after cold open', async () => {
  const f = await fixture()
  await f.tx(() => commitControlTx(f.ports, f.prepare))
  const value = f.owner.db
    .prepare('SELECT value_json FROM runtime_records WHERE record_id=?')
    .get('authorization-preparation:preparation') as { value_json: string }
  expect(JSON.parse(value.value_json)).toEqual(f.preparation)
  expect(
    JSON.parse(
      (
        f.owner.db
          .prepare('SELECT value_json FROM runtime_records WHERE record_id=?')
          .get(`action:${f.actionId}`) as { value_json: string }
      ).value_json,
    ).state,
  ).toBe('prepared')
  await f.store.open({
    requestId: 'cold-proof',
    authority,
    sessionId: 'session',
    mode: 'read',
    writerId: null,
    ttlMs: null,
  })
})
it('refuses missing owner, forged current cutoff, changed action input and missing read guard without a new commit', async () => {
  const f = await fixture(),
    before = f.state()
  await expect(
    f.tx(() => commitControlTx({ ...f.ports, verifyAuthorizationPreparation: () => undefined }, f.prepare)),
  ).rejects.toThrow('source is unavailable')
  await expect(
    f.tx(() =>
      commitControlTx(
        {
          ...f.ports,
          verifyAuthorizationPreparation: () => ({
            ...f.facts,
            taint: { ...f.facts.taint, current: { recordRevision: 1, sourceSeq: 1, clearedThroughSeq: 0 } },
          }),
        },
        f.prepare,
      ),
    ),
  ).rejects.toThrow('current State cutoff')
  const changed = {
    ...f.prepare,
    command: { ...f.prepare.command, preparation: { ...f.preparation, inputDigest: 'f'.repeat(64) } },
  } as CommitControlRequest
  await expect(f.tx(() => commitControlTx(f.ports, changed))).rejects.toThrow()
  await expect(
    f.tx(() => commitControlTx(f.ports, { ...f.prepare, guard: { ...f.prepare.guard, readGuards: [] } })),
  ).rejects.toThrow('read guard')
  expect(f.state()).toEqual(before)
})
it('refuses ask without actual pending Interaction/Policy source and rolls original preparation staging back', async () => {
  const f = await fixture(),
    before = f.state()
  await expect(
    f.tx(async () => {
      f.owner.beginStaging('joint')
      try {
        await commitControlTx(f.ports, f.prepare)
        await commitControlTx({ ...f.ports, verifyApprovalAsk: () => undefined }, f.ask)
        f.owner.flushStaging()
      } finally {
        f.owner.clearStaging()
      }
    }),
  ).rejects.toThrow('ask authority source')
  expect(f.state()).toEqual(before)
})
it('stages original preparation and authenticated ask in one native commit, preserving taint and making only the actual action await approval', async () => {
  const f = await fixture()
  const before = f.owner.db
    .prepare("SELECT count(*) AS n FROM events WHERE type='runtime/state-commit'")
    .get() as { n: number }
  await f.tx(async () => {
    f.owner.beginStaging('joint')
    try {
      await commitControlTx(f.ports, f.prepare)
      await commitControlTx(f.ports, f.ask)
      f.owner.flushStaging()
    } finally {
      f.owner.clearStaging()
    }
  })
  const after = f.owner.db
    .prepare("SELECT count(*) AS n FROM events WHERE type='runtime/state-commit'")
    .get() as { n: number }
  expect(after.n - before.n).toBe(1)
  const action = JSON.parse(
    (
      f.owner.db
        .prepare('SELECT value_json FROM runtime_records WHERE record_id=?')
        .get(`action:${f.actionId}`) as { value_json: string }
    ).value_json,
  )
  expect(action.state).toBe('awaiting-approval')
  expect(action.currentAttemptId).toBe(null)
  const proof = JSON.parse(
    (
      f.owner.db
        .prepare('SELECT value_json FROM runtime_records WHERE record_id=?')
        .get(`approval-ask:${f.actionId}:preparation`) as { value_json: string }
    ).value_json,
  )
  expect(proof).toEqual(f.ask)
  await f.store.open({
    requestId: 'proof',
    authority,
    sessionId: 'session',
    mode: 'read',
    writerId: null,
    ttlMs: null,
  })
})
