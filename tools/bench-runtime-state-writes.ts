// Times 300 intakeReceipt, 300 claimOutbox, and 300 ackOutbox calls in one session.
// Setup (createRun, write-open, action admission, and mark_running) is not included.
// The store clock is Date.now, so the writer lease has to stay live for the whole sample.
// A 50-call window reports its maximum and the average of the 25th and 26th ordered samples.
//
//   tsx tools/bench-runtime-state-writes.ts
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
  AckOutboxRequest,
  AdvanceRunRequest,
  CallContext,
  ClaimOutboxRequest,
  CloseInvocationRequest,
  CommitControlRequest,
  CommitGuard,
  DispatchAdmissionRequest,
  InvocationAdmission,
  OutboxClaim,
  Outcome,
  PreparedAction,
  Receipt,
  ReceiptIntakeRequest,
  RunAdmission,
  StateAuthorityRef,
  UsageFact,
} from '../packages/extension-api/src/runtime/index.ts'
import { createRuntimeStateStore } from '../packages/host/src/runtime/providers/state.ts'
import { digestOf as canonicalDigest, stableId } from '../packages/host/src/runtime/state/records.ts'
import { jcs } from '../packages/protocol/src/jcs.ts'

const CALLS = 300
const BATCH = 64
const LEASE_TTL_MS = 600_000
const WINDOWS = [
  [1, 50],
  [51, 100],
  [101, 150],
  [151, 200],
  [201, 250],
  [251, 300],
] as const

const authority: StateAuthorityRef = {
  authorityId: 'authority-bench',
  tenantId: 'tenant-bench',
  authorityEpoch: 1,
}
const scope = { installationId: 'install-bench', kind: 'installation' as const }
const admittedAt = '2026-04-01T00:00:00.000Z'
const sessionId = 'session-bench'
const runId = 'run-bench'
const bindingId = 'binding-bench'
const writerId = 'writer-bench'

const toolBinding = {
  bindingId,
  contract: 'agh.test/tool',
  logicalName: 'tool',
  providerId: 'provider-bench',
}
const runBinding = {
  bindingId,
  contract: 'agh.runtime/run-admission',
  logicalName: 'run',
  providerId: 'runtime-state',
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(jcs(value)).digest('hex')
}

function inline(value: unknown) {
  const canonical = jcs(value)
  const schemaDocument = { $id: 'agh.test/json@1', type: 'object' }
  return {
    kind: 'inline' as const,
    schema: { typeId: 'agh.test/json@1', revision: 1, digest: digestOf(schemaDocument) },
    value,
    digest: digestOf(value),
    bytes: Buffer.byteLength(canonical),
  }
}

function unwrap<T>(result: Outcome<T>, label: string): T {
  if (!result.ok) {
    const error = result.error
    throw new Error(`${label}: ${error.code}/${error.detailCode} ${error.message}`)
  }
  return result.value
}

function context(deadline: string): CallContext {
  return {
    principalRef: 'principal-bench',
    scope,
    bindingId,
    invocationId: 'invocation-bench',
    deadline,
    traceRef: 'trace-bench',
    authorizationRef: 'auth-bench',
    signal: new AbortController().signal,
  }
}

function admission(deadline: string): RunAdmission {
  const ticketId = 'ticket-bench'
  const text = 'bench'
  return {
    ticketId,
    fingerprint: digestOf({ ticketId, text }),
    releaseSetId: 'release-bench',
    bindingId,
    packagePinReceipt: inline({ pin: 'package' }),
    runId,
    sessionId,
    lane: 'main',
    workspaceId: 'workspace-bench',
    input: inline({ text }),
    admittedAt,
    deadline,
    conversation: null,
  }
}

function continuation(step: number, createdAt: string) {
  return {
    namespace: 'agh.test/loop',
    codecVersion: '1',
    data: inline({ step }),
    provenance: { sourceRefs: [] as string[], producer: toolBinding, trustLabels: [] as string[] },
    createdAt,
    references: [],
  }
}

function preparedAction(key: string, deadline: string): PreparedAction {
  const input = inline({ text: key })
  const body = {
    key,
    target: toolBinding,
    method: 'run',
    input,
    dependencies: [],
    retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] as number[] },
    obligation: 'mandatory' as const,
    deadline,
    resultSchema: input.schema,
    references: [],
  }
  return { ...body, intentFingerprint: canonicalDigest(body) }
}

function commitGuard(invocationId: string, expectedRunRevision: number): CommitGuard {
  return {
    authority,
    sessionId,
    runId,
    writerId,
    writerEpoch: 1,
    expectedRunRevision,
    bindingId,
    invocationId,
    readGuards: [],
    queryUsage: null,
  }
}

function advanceBody(index: number, revision: number, actions: PreparedAction[]): AdvanceRunRequest {
  const invocationId = `invocation-${index}`
  return {
    commitId: `advance-${index}`,
    guard: commitGuard(invocationId, revision),
    transition: {
      expectedRevision: revision,
      continuation: continuation(revision + 1, admittedAt),
      consumeSignals: [],
      actions,
      next: { kind: 'continue' },
    },
  }
}

function dispatchBody(
  index: number,
  action: PreparedAction,
  invocationId: string,
  runRevision: number,
  deadline: string,
): DispatchAdmissionRequest {
  const admissionId = `admission-${index}`
  return {
    admissionId,
    commitId: `dispatch-${index}`,
    guard: commitGuard(invocationId, runRevision),
    atomicDomain: {
      domainId: 'domain-bench',
      revision: 1,
      stateAuthority: authority,
      budgetAuthority: authority,
      stateBinding: runBinding,
      budgetBinding: runBinding,
    },
    actionId: stableId('act', `${runId}\0${action.key}`),
    expectedActionRevision: 1,
    decisionRef: inline({ allow: admissionId }),
    attemptId: `attempt-${admissionId}`,
    requestIdentity: {
      system: 'tool',
      aghRequestId: `agh-${admissionId}`,
      idempotencyKey: null,
      requestDigest: canonicalDigest(action.input),
    },
    budget: { reservation: null, quota: [] },
    deadline,
  }
}

function intakeBody(
  index: number,
  action: PreparedAction,
  attemptId: string,
  authorizationRef: string,
): ReceiptIntakeRequest {
  const actionId = stableId('act', `${runId}\0${action.key}`)
  const originKey = `origin-${index}`
  const usage: UsageFact = {
    usageId: `usage-${index}`,
    originKey,
    actionId,
    attemptId,
    source: toolBinding,
    dimensions: inline({ tokens: 1 }),
    externalRequest: {
      system: 'ext',
      requestId: `ext-${index}`,
      requestDigest: 'e'.repeat(64),
    },
    observedAt: admittedAt,
    certainty: 'measured',
  }
  const receipt: Receipt = {
    receiptId: `receipt-${index}`,
    actionId,
    attemptId,
    bindingId,
    inputDigest: canonicalDigest(action.input),
    outcome: 'succeeded',
    result: inline({ ok: true }),
    externalRequests: [],
    usageRefs: [usage.usageId],
    references: [],
    provenance: { sourceRefs: [], producer: toolBinding, trustLabels: [] },
    completedAt: admittedAt,
  }
  return {
    intakeId: `intake-${index}`,
    receipt,
    usage: [usage],
    evidence: [],
    sourceAuthorizationRef: authorizationRef,
    queryUsage: null,
    resultHandling: { kind: 'no-hook' },
  }
}

function segment(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right)
  const medianMs = ((sorted[24] ?? 0) + (sorted[25] ?? 0)) / 2
  return { medianMs, maxMs: sorted.at(-1) ?? 0 }
}

function windowsOf(samples: readonly number[]) {
  return WINDOWS.map(([from, to]) => ({ from, to, ...segment(samples.slice(from - 1, to)) }))
}

async function timeCall(samples: number[], body: () => Promise<void>): Promise<void> {
  const started = performance.now()
  await body()
  samples.push(performance.now() - started)
}

async function prepareInvocation(
  store: ReturnType<typeof createRuntimeStateStore>,
  index: number,
  baseRevision: number,
  deadline: string,
  call: CallContext,
): Promise<void> {
  const invocationId = `invocation-${index}`
  const admit: InvocationAdmission = {
    requestId: `admit-${invocationId}`,
    runId,
    targetActionId: null,
    baseRevision,
    bindingId,
    writerEpoch: 1,
    invocationId,
    deadline,
    queryAllowance: 0,
  }
  unwrap(await store.admitInvocation(admit, call), `admit ${index}`)
  const close: CloseInvocationRequest = {
    requestId: `close-${invocationId}`,
    invocationId,
    state: 'prepared',
    readGuards: [],
    domainReads: [],
    unresolvedInflightIds: [],
    observedQueryCount: 0,
  }
  unwrap(await store.closeInvocation(close, call), `close ${index}`)
}

async function main(): Promise<void> {
  const deadline = new Date(Date.now() + LEASE_TTL_MS).toISOString()
  const call = context(deadline)
  const directory = mkdtempSync(join(tmpdir(), 'agnes-state-writes-'))
  const file = join(directory, 'state.sqlite')
  const store = createRuntimeStateStore({ file, authority, now: () => Date.now() })
  const intakeMs: number[] = []
  const claimMs: number[] = []
  const ackMs: number[] = []
  try {
    unwrap(await store.createRun(admission(deadline), call), 'createRun')
    unwrap(
      await store.open(
        {
          requestId: 'open-write',
          authority,
          sessionId,
          mode: 'write',
          writerId,
          ttlMs: LEASE_TTL_MS,
        },
        call,
      ),
      'write-open',
    )
    const actions: PreparedAction[] = []
    let revision = 0
    let batch = 0
    while (actions.length < CALLS) {
      batch += 1
      const count = Math.min(BATCH, CALLS - actions.length)
      const created: PreparedAction[] = []
      for (let offset = 0; offset < count; offset += 1) {
        created.push(preparedAction(`step-${actions.length + offset + 1}`, deadline))
      }
      await prepareInvocation(store, batch, revision, deadline, call)
      const receipt = unwrap(
        await store.advanceRun(advanceBody(batch, revision, created), call),
        `advance ${batch}`,
      )
      revision = receipt.runRevision
      actions.push(...created)
    }
    const invocationId = `invocation-${batch}`
    const ready: { action: PreparedAction; attemptId: string; authorizationId: string }[] = []
    for (let index = 1; index <= CALLS; index += 1) {
      const action = actions[index - 1]
      if (!action) throw new Error(`missing action ${index}`)
      const request = dispatchBody(index, action, invocationId, revision, deadline)
      const admitted = unwrap(await store.dispatchAdmission(request, call), `dispatch ${index}`)
      if (admitted.state !== 'admitted') throw new Error(`dispatch ${index} settled as ${admitted.state}`)
      const mark: CommitControlRequest = {
        commitId: `mark-${index}`,
        guard: commitGuard(invocationId, revision),
        command: {
          kind: 'mark_running',
          attemptId: request.attemptId,
          expectedAttemptRevision: 1,
          externalRequests: [],
        },
      }
      unwrap(await store.commitControl(mark, call), `mark ${index}`)
      ready.push({ action, attemptId: request.attemptId, authorizationId: admitted.authorizationId })
    }
    for (let index = 1; index <= CALLS; index += 1) {
      const item = ready[index - 1]
      if (!item) throw new Error(`missing intake ${index}`)
      const request = intakeBody(index, item.action, item.attemptId, item.authorizationId)
      await timeCall(intakeMs, async () => {
        const accepted = unwrap(await store.intakeReceipt(request, call), `intake ${index}`)
        if (accepted.state !== 'accepted') throw new Error(`intake ${index} settled as ${accepted.state}`)
      })
    }
    const destination = stableId('obxdst', authority.authorityId)
    const claims: OutboxClaim[] = []
    for (let index = 1; index <= CALLS; index += 1) {
      const request: ClaimOutboxRequest = {
        requestId: `claim-${index}`,
        destination,
        ownerId: 'owner-bench',
        limit: 1,
        leaseMs: 60_000,
      }
      await timeCall(claimMs, async () => {
        const claimed = unwrap(await store.claimOutbox(request, call), `claim ${index}`)
        const claim = claimed[0]?.claim
        if (!claim) throw new Error(`claim ${index} returned no event`)
        claims.push(claim)
      })
    }
    for (let index = 1; index <= CALLS; index += 1) {
      const claim = claims[index - 1]
      if (!claim) throw new Error(`missing claim ${index}`)
      const request: AckOutboxRequest = {
        requestId: `ack-${index}`,
        claim,
        acknowledgement: inline({ acked: true }),
      }
      await timeCall(ackMs, async () => {
        const acked = unwrap(await store.ackOutbox(request, call), `ack ${index}`)
        if (acked.state !== 'acked') throw new Error(`ack ${index} settled as ${acked.state}`)
      })
    }
    console.log(
      JSON.stringify({
        mode: 'state-writes',
        calls: CALLS,
        window: 50,
        sessionId,
        leaseTtlMs: LEASE_TTL_MS,
        note: 'Times only intakeReceipt, claimOutbox, and ackOutbox. The segment median averages the 25th and 26th ordered samples.',
        intakeReceipt: windowsOf(intakeMs),
        claimOutbox: windowsOf(claimMs),
        ackOutbox: windowsOf(ackMs),
      }),
    )
  } finally {
    store.close()
  }
}

await main()
