// Times 300 advanceRun calls and 300 dispatchAdmission calls in one session.
// Setup (createRun, write-open, invocation admission and close) is not included.
// The store clock is Date.now, so the writer lease has to stay live for the whole sample.
//
//   tsx tools/bench-runtime-state-writes.ts
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
  AdvanceRunRequest,
  CallContext,
  CloseInvocationRequest,
  CommitGuard,
  DispatchAdmissionRequest,
  InvocationAdmission,
  Outcome,
  PreparedAction,
  RunAdmission,
  StateAuthorityRef,
} from '../packages/extension-api/src/runtime/index.ts'
import { createRuntimeStateStore } from '../packages/host/src/runtime/providers/state.ts'
import { digestOf as canonicalDigest, stableId } from '../packages/host/src/runtime/state/records.ts'
import { jcs } from '../packages/protocol/src/jcs.ts'

const CALLS = 300
const LEASE_TTL_MS = 600_000
const WINDOWS = [
  [1, 10],
  [141, 150],
  [291, 300],
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

function advanceBody(index: number, revision: number, action: PreparedAction): AdvanceRunRequest {
  const invocationId = `invocation-${index}`
  return {
    commitId: `advance-${index}`,
    guard: commitGuard(invocationId, revision),
    transition: {
      expectedRevision: revision,
      continuation: continuation(revision + 1, admittedAt),
      consumeSignals: [],
      actions: [action],
      next: { kind: 'continue' },
    },
  }
}

function dispatchBody(
  index: number,
  action: PreparedAction,
  runRevision: number,
  deadline: string,
): DispatchAdmissionRequest {
  const admissionId = `admission-${index}`
  return {
    admissionId,
    commitId: `dispatch-${index}`,
    guard: commitGuard(`invocation-${CALLS}`, runRevision),
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

function mean(samples: readonly number[]): number {
  const total = samples.reduce((sum, sample) => sum + sample, 0)
  return samples.length === 0 ? 0 : total / samples.length
}

/** Nearest-rank percentile. A window of 10 uses the largest sample as P95. */
function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

function windowsOf(samples: readonly number[]) {
  return WINDOWS.map(([from, to]) => {
    const slice = samples.slice(from - 1, to)
    return { from, to, meanMs: mean(slice), p95Ms: percentile(slice, 95) }
  })
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
  const advanceMs: number[] = []
  const dispatchMs: number[] = []
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
    for (let index = 1; index <= CALLS; index += 1) {
      const revision = index - 1
      await prepareInvocation(store, index, revision, deadline, call)
      const action = preparedAction(`step-${index}`, deadline)
      actions.push(action)
      const started = performance.now()
      const receipt = unwrap(
        await store.advanceRun(advanceBody(index, revision, action), call),
        `advance ${index}`,
      )
      advanceMs.push(performance.now() - started)
      if (receipt.runRevision !== index) {
        throw new Error(`advance ${index} left revision ${receipt.runRevision}`)
      }
    }
    for (let index = 1; index <= CALLS; index += 1) {
      const action = actions[index - 1]
      if (!action) throw new Error(`missing action ${index}`)
      const started = performance.now()
      const admitted = unwrap(
        await store.dispatchAdmission(dispatchBody(index, action, CALLS, deadline), call),
        `dispatch ${index}`,
      )
      dispatchMs.push(performance.now() - started)
      if (admitted.state !== 'admitted') throw new Error(`dispatch ${index} settled as ${admitted.state}`)
    }
    console.log(
      JSON.stringify({
        mode: 'state-writes',
        calls: CALLS,
        sessionId,
        leaseTtlMs: LEASE_TTL_MS,
        note: 'Times only advanceRun and dispatchAdmission. Open performance is not part of this sample.',
        advanceRun: windowsOf(advanceMs),
        dispatchAdmission: windowsOf(dispatchMs),
      }),
    )
  } finally {
    store.close()
  }
}

await main()
