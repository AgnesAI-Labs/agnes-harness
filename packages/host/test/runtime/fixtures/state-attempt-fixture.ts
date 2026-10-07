/**
 * Real attempts of every shape State writes today, produced only through State's own commands on
 * the shared joint admission fixture, plus the read stack that serves them. The bridge is the
 * test-only local adapter, not a production bridge.
 */
import { rmSync } from 'node:fs'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { PreparedAction, ScopeRef } from '@agnes/protocol/runtime'
import { createLocalDeploymentIdentity } from '../../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../../src/runtime/identity/local-deployment-owner.js'
import { createNativeStateReadOwner } from '../../../src/runtime/state/native-read-owner.js'
import { createStateQueryService } from '../../../src/runtime/state/query-service.js'
import { actionRecordId, stableId } from '../../../src/runtime/state/records.js'
import { openJointAdmission } from './assembly-admission-joint.js'
import { fixtureRef } from './assembly-maintenance-wire.js'
import { originalNativeFixture } from './native-state-read-fixture.js'
import { prepareProviders, setup } from './state-composite-fixture.js'
import { localTestBridge } from './state-query-fixture.js'

const WORKSPACE = 'fixture-workspace'
const OWNER = { kind: 'reconciliation' as const, id: 'reconciliation-1' }
const ERROR = {
  code: 'internal' as const,
  detailCode: 'settled_without_dispatch',
  message: 'the action was settled without a dispatch',
  retryAdvice: { kind: 'never' as const },
  diagnosticId: 'diagnostic-1',
}

export type Stack = Awaited<ReturnType<typeof stackOf>>

/** One read stack over a joint State: identity context, read owner and query service. */
function stackOf(
  input: Readonly<{
    context: CallContext
    scope: Extract<ScopeRef, { kind: 'runtime' }>
    authority: { authorityId: string; tenantId: string; authorityEpoch: number }
    now: () => number
    reader: ReturnType<typeof createNativeStateReadOwner>
    bridge: Parameters<typeof createStateQueryService>[0]['bridge']
    close: () => Promise<void>
  }>,
) {
  const service = createStateQueryService({
    owner: input.reader,
    bridge: input.bridge,
    authority: input.authority,
    now: input.now,
  })
  const base = { ...input.scope, workspaceId: WORKSPACE, sessionId: 'fixture-session' }
  let closing: Promise<void> | null = null
  const caller = (scope: ScopeRef): CallContext => ({ ...input.context, scope })
  return {
    service,
    reader: service.reader,
    authority: input.authority,
    caller,
    session: () => caller({ ...base, kind: 'session' }),
    run: (runId: string) => caller({ ...base, kind: 'run', runId }),
    action: (runId: string, actionId: string) => caller({ ...base, kind: 'action', runId, actionId }),
    /** Service, then read owner, then State; closing twice is harmless. */
    close() {
      closing ??= (async () => {
        await service.close()
        await input.reader.close()
        await input.close()
      })()
      return closing
    },
  }
}

/** The same State reopened cold: a new connection, identity, read owner and service. */
export async function openCold(world: AttemptWorld): Promise<Stack> {
  const { native } = world
  const joint = await openJointAdmission(native.deploymentDirectory, native.input)
  const identity = createLocalDeploymentIdentity({
    database: joint.db,
    deploymentDirectory: native.deploymentDirectory,
    owner: captureLocalDeploymentOwner({
      database: joint.db,
      deploymentDirectory: native.deploymentDirectory,
    }),
    authority: native.authority,
    scope: native.scope,
    now: native.now,
  })
  const connection = await identity.connect(new AbortController().signal)
  const context = connection.issue('2030-01-01T00:00:00Z', 'cold-attempt-read')
  const reader = createNativeStateReadOwner({ originalState: joint.state, runtimeScope: native.scope })
  const { bridge } = localTestBridge({ context, identity, scope: native.scope, database: joint.db })
  return stackOf({
    context,
    scope: native.scope,
    authority: native.authority,
    now: native.now,
    reader,
    bridge,
    close: async () => {
      identity.close()
      await joint.close()
    },
  })
}

export type AttemptWorld = Awaited<ReturnType<typeof attemptWorld>>

export async function attemptWorld() {
  const native = await originalNativeFixture({ prepare: (input) => void prepareProviders(input) })
  const f = await setup({
    native: { directory: native.directory, input: native.input, fixture: native.fixture },
  })
  const stack = stackOf({
    context: native.context,
    scope: native.scope,
    authority: native.authority,
    now: native.now,
    reader: native.reader,
    bridge: native.bridge,
    close: async () => {
      native.identity.close()
      await native.fixture.close()
    },
  })
  const runId = f.admission.runId
  const childId = (key: string) => stableId('act', `${runId}\0${f.parentId}\0${key}`)
  const head = (recordId: string) => {
    const found = f.head(recordId)
    if (!found) throw Error(`no record ${recordId}`)
    return found
  }
  const control = (invocation: string, commitId: string, command: unknown) =>
    native.fixture.state.commitControl({
      commitId,
      guard: f.guardFor(invocation, Number(head(`run:${runId}`).value.revision)),
      command,
    } as never)

  // The composite parent starts: a composite attempt, which has no request identity.
  await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
  const kids: PreparedAction[] = ['child-a', 'child-b', 'child-c'].map((key) => f.child(key))
  const step = await f.prepared(f.parentId, 1)
  await f.advance(step, 'step-1', { children: kids })
  // child-a: dispatched and settled by a real receipt. child-b and child-c: dispatched and open.
  await f.complete(childId('child-a'), kids[0] as PreparedAction, step, 'child-a')
  for (const [index, tag] of [
    [1, 'child-b'],
    [2, 'child-c'],
  ] as const) {
    const admitted = await f.dispatch(childId(tag), kids[index] as PreparedAction, step, tag)
    if (admitted.state !== 'admitted') throw Error('child dispatch was refused')
  }
  const dispatching = await stack.reader.open(stack.session(), null)
  if (!dispatching.ok) throw Error('midpoint snapshot was refused')

  // child-b's effect owner lost the answer: the attempt moves to unknown with a resolution record.
  const open = await f.prepared(null, 1)
  await control(open, 'unknown-b', {
    kind: 'mark_unknown',
    attemptId: 'attempt-child-b',
    expectedAttemptRevision: head('attempt:attempt-child-b').revision,
    evidence: [],
    reconciliationOwnerRef: OWNER,
    reason: 'the answer was lost',
  })
  // A reconciliation check on it, begun and completed without an answer.
  await native.fixture.state.beginReconciliation({
    requestId: 'begin-1',
    checkId: 'check-1',
    actionId: childId('child-b'),
    expectedActionRevision: head(actionRecordId(childId('child-b'))).revision,
    bindingId: native.fixture.binding.bindingId,
    invocationId: open,
    lookupMethod: 'reconcile',
    input: fixtureRef({ lookup: 'receipt' }),
    deadline: '2027-01-01T00:00:00Z',
  } as never)
  await native.fixture.state.completeReconciliation({
    requestId: 'complete-1',
    checkId: 'check-1',
    result: { kind: 'unknown', evidence: fixtureRef({ e: 'unknown' }), reason: 'no answer yet' },
    evidence: [],
  } as never)
  // An action settled without ever being dispatched: a control attempt, number 0.
  await control(await f.prepared(null, 1), 'settle-1', {
    kind: 'settle_undispatched',
    actionId: f.leafParentId,
    expectedActionRevision: head(actionRecordId(f.leafParentId)).revision,
    outcome: 'failed',
    error: ERROR,
  })

  return {
    native,
    f,
    stack,
    runId,
    childId,
    head,
    kids,
    /** A snapshot taken while child-b and child-c were still dispatching. */
    dispatching: dispatching.value,
    controlId: stableId('ctl', `settle\0${f.leafParentId}`),
    async close(...cold: Stack[]) {
      for (const other of cold) await other.close()
      await stack.close()
      rmSync(native.directory, { recursive: true, force: true })
    },
  }
}
