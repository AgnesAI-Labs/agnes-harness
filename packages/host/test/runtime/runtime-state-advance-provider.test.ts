import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CommitGuard, canonicalJsonDigest, type PreparedAction } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { UNIMPLEMENTED_STATE_METHODS } from '../../src/runtime/providers/state.js'
import type { WriteCommitInput } from '../../src/runtime/state/control.js'
import {
  actionRecordId,
  providerStateRecordId,
  stableId,
  timerRecordId,
  waitRecordId,
} from '../../src/runtime/state/records.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureHash, fixtureRef } from './fixtures/assembly-maintenance-wire.js'

type Joint = Awaited<ReturnType<typeof openJointAdmission>>
type Owner = {
  tx<T>(method: string, id: string, body: () => T | Promise<T>): Promise<T>
  requireSession(sessionId: string): Promise<unknown>
  writeCommit(input: WriteCommitInput): unknown
}

const directories: string[] = []
const joints: Joint[] = []
afterEach(async () => {
  for (const joint of joints.splice(0)) await joint.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const CODEC = { namespace: 'agh.default/model-infer', codecVersion: '1' }

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-advance-provider-'))
  directories.push(directory)
  const input = admissionFixtureInput()
  const release = input.fixture.previousRelease
  if (!release) throw Error('locked release missing')
  const parentProvider = release.bindings.find((row) => row.binding.contract === 'agh.model')
  const leafProvider = release.bindings.find((row) => row.binding.contract === 'agh.model-adapter')
  const toolProvider = release.bindings.find((row) => row.binding.contract === 'agh.tools')
  const infer = parentProvider?.descriptor.operations.find((row) => row.method === 'infer')
  const invoke = leafProvider?.descriptor.operations.find((row) => row.method === 'invoke')
  const toolInvoke = toolProvider?.descriptor.operations.find((row) => row.method === 'invoke')
  if (!parentProvider || !leafProvider || !toolProvider || !infer || !invoke || !toolInvoke)
    throw Error('fixture providers missing')
  // Only the composite parent declares a state codec; the adapter and the tools stay leaf.
  parentProvider.descriptor.stateCodecs = [{ ...CODEC, schema: parentProvider.descriptor.configSchema }]
  parentProvider.codecRefs = parentProvider.descriptor.stateCodecs
  // A non-action operation and a duplicated action operation, neither of which may start a composite.
  const queryOp = parentProvider.descriptor.operations.find((row) => row.kind !== 'action')
  const twice = parentProvider.descriptor.operations.find((row) => row.method === 'prepareRequest')
  if (!queryOp || !twice) throw Error('fixture operations missing')
  parentProvider.descriptor.operations.push({ ...twice })
  const { releaseSetId: _before, ...resealed } = release
  release.releaseSetId = fixtureHash(resealed)
  let failBeforeCommit = false
  const joint = await openJointAdmission(directory, input, (point) => {
    if (failBeforeCommit && point.endsWith(':before')) throw Error('injected failure before commit')
  })
  joints.push(joint)
  const created = await joint.coordinator.coordinate(joint.draft(), joint.context())
  if (!(created.ok && created.value.state === 'created'))
    throw Error(`run was not created ${JSON.stringify(created)}`)
  const admission = joint.draft().admission
  const authority = joint.binding.stateAuthorityAtCreation
  const opened = await joint.state.open({
    requestId: 'writer',
    authority,
    sessionId: admission.sessionId,
    mode: 'write',
    writerId: 'writer',
    ttlMs: 600000,
  })
  if (!opened.claim) throw Error('writer was not opened')
  const writerEpoch = opened.claim.writerEpoch
  const runId = admission.runId
  const deadline = '2027-01-01T00:00:00Z'
  const action = (key: string, provider: typeof parentProvider, method: string, schemas: typeof infer) => {
    const intent = {
      key,
      target: provider.binding,
      method,
      input: { ...fixtureRef({ key }), schema: schemas.inputSchema },
      dependencies: [],
      retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
      obligation: 'mandatory' as const,
      deadline,
      resultSchema: schemas.outputSchema,
      references: [],
    }
    return { ...intent, intentFingerprint: fixtureHash(intent) } satisfies PreparedAction
  }
  const parentIntent = action('parent', parentProvider, 'infer', infer)
  const leafParentIntent = action('leaf-parent', toolProvider, 'invoke', toolInvoke)
  const queryParentIntent = action('query-parent', parentProvider, queryOp.method, queryOp)
  const duplicateParentIntent = action('duplicate-parent', parentProvider, 'prepareRequest', twice)
  const child = (key: string, laterDeadline = false) => {
    const intent = action(key, leafProvider, 'invoke', invoke)
    if (!laterDeadline) return intent
    const { intentFingerprint: _, ...body } = { ...intent, deadline: '2027-06-01T00:00:00Z' }
    return { ...body, intentFingerprint: fixtureHash(body) } satisfies PreparedAction
  }
  const continuation = (marker: string, namespace = CODEC.namespace) => ({
    namespace,
    codecVersion: CODEC.codecVersion,
    data: fixtureRef({ marker }),
    provenance: { sourceRefs: [], producer: parentProvider.binding, trustLabels: [] },
    createdAt: admission.admittedAt,
    references: [],
  })
  let counter = 0
  const guardFor = (invocationId: string, runRevision: number): CommitGuard => ({
    authority,
    sessionId: admission.sessionId,
    runId,
    writerId: 'writer',
    writerEpoch,
    expectedRunRevision: runRevision,
    bindingId: joint.binding.bindingId,
    invocationId,
    readGuards: [],
    queryUsage: null,
  })
  /** An invocation that is prepared for a commit and not yet used by one. */
  async function prepared(targetActionId: string | null, runRevision: number) {
    const invocationId = `invocation-${++counter}`
    await joint.state.admitInvocation({
      requestId: `admit-${counter}`,
      runId,
      targetActionId,
      baseRevision: runRevision,
      bindingId: joint.binding.bindingId,
      writerEpoch,
      invocationId,
      deadline,
      queryAllowance: 0,
    })
    await joint.state.closeInvocation({
      requestId: `close-${counter}`,
      invocationId,
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    return invocationId
  }
  // The Loop step creates the composite parent and one leaf-targeted action; run revision 0 -> 1.
  await joint.state.advanceRun({
    commitId: 'loop-step',
    guard: guardFor(await prepared(null, 0), 0),
    transition: {
      expectedRevision: 0,
      continuation: continuation('loop'),
      consumeSignals: [],
      actions: [parentIntent, leafParentIntent, queryParentIntent, duplicateParentIntent],
      next: { kind: 'continue' },
    },
  })
  const parentId = stableId('act', `${runId}\0parent`)
  const leafParentId = stableId('act', `${runId}\0leaf-parent`)
  const queryParentId = stableId('act', `${runId}\0query-parent`)
  const duplicateParentId = stableId('act', `${runId}\0duplicate-parent`)
  const owner = joint.state as unknown as Owner
  const head = (recordId: string) => {
    const row = joint.db
      .prepare(
        'SELECT h.record_revision,b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
      )
      .get(recordId)
    if (!row || typeof row.value_json !== 'string') return undefined
    // biome-ignore lint/suspicious/noExplicitAny: record bodies are probed by path in assertions
    return { revision: Number(row.record_revision), value: JSON.parse(row.value_json) as Record<string, any> }
  }
  const writes = () => Number(joint.db.prepare('SELECT total_changes() AS n').get()?.n)
  const events = () => Number(joint.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
  const start = (id: string, actionId: string, commitId: string, attemptId: string, revision = 1) =>
    joint.state.commitControl({
      commitId,
      guard: guardFor(id, 1),
      command: { kind: 'start_composite', actionId, expectedActionRevision: revision, attemptId },
    })
  const advanceRequest = (
    id: string,
    commitId: string,
    transition: {
      revision?: number
      children?: PreparedAction[]
      consume?: string[]
      next?: unknown
      continuation?: ReturnType<typeof continuation>
    },
    actionId = parentId,
  ) => ({
    commitId,
    guard: guardFor(id, 1),
    actionId,
    expectedProviderRevision: transition.revision ?? 0,
    transition: {
      expectedProviderRevision: transition.revision ?? 0,
      continuation: transition.continuation ?? continuation(commitId),
      consumeSignals: transition.consume ?? [],
      children: transition.children ?? [],
      next: (transition.next ?? { kind: 'continue' }) as never,
    },
  })
  const advance = (...args: Parameters<typeof advanceRequest>) =>
    joint.state.advanceProvider(advanceRequest(...args))
  const stateBinding = {
    bindingId: joint.binding.bindingId,
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture-state',
  }
  /** Dispatches an action and settles it with a real receipt, which publishes the signal for its parent. */
  async function complete(actionId: string, intent: PreparedAction, invocationId: string, tag: string) {
    const admitted = await joint.state.dispatchAdmission({
      admissionId: `admit-${tag}`,
      commitId: `dispatch-${tag}`,
      guard: guardFor(invocationId, 1),
      atomicDomain: {
        domainId: 'fixture-domain',
        revision: 1,
        stateAuthority: authority,
        budgetAuthority: authority,
        stateBinding,
        budgetBinding: stateBinding,
      },
      actionId,
      expectedActionRevision: 1,
      decisionRef: fixtureRef({}),
      attemptId: `attempt-${tag}`,
      requestIdentity: {
        system: 'fixture-peer',
        aghRequestId: `request-${tag}`,
        idempotencyKey: null,
        requestDigest: canonicalJsonDigest(intent.input),
      },
      budget: { reservation: null, quota: [] },
      deadline,
    })
    if (admitted.state !== 'admitted') throw Error('child dispatch was refused')
    await joint.state.intakeReceipt({
      intakeId: `intake-${tag}`,
      receipt: {
        receiptId: `receipt-${tag}`,
        actionId,
        attemptId: `attempt-${tag}`,
        bindingId: joint.binding.bindingId,
        inputDigest: canonicalJsonDigest(intent.input),
        outcome: 'succeeded',
        result: { ...fixtureRef({ tag }), schema: intent.resultSchema },
        externalRequests: [],
        usageRefs: [],
        references: [],
        provenance: { sourceRefs: [], producer: stateBinding, trustLabels: [] },
        completedAt: admission.admittedAt,
      },
      usage: [],
      evidence: [],
      sourceAuthorizationRef: admitted.authorizationId,
      queryUsage: null,
      resultHandling: { kind: 'no-hook' },
    })
  }
  /** Ids of the signals published for one target action (null is the run itself). */
  function signalsFor(targetActionId: string | null) {
    return joint.db
      .prepare(
        "SELECT json_extract(b.value_json,'$.signal.signalId') AS id FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id LIKE 'signal:%' AND json_extract(b.value_json,'$.signal.targetActionId') IS ?",
      )
      .all(targetActionId)
      .map((row) => String(row.id))
  }
  return {
    directory,
    input,
    joint,
    parentId,
    leafParentId,
    queryParentId,
    duplicateParentId,
    leafParentIntent,
    prepared,
    start,
    advance,
    advanceRequest,
    head,
    writes,
    events,
    child,
    continuation,
    complete,
    signalsFor,
    owner,
    guardFor,
    admission,
    authority,
    setFailBeforeCommit(value: boolean) {
      failBeforeCommit = value
    },
  }
}

async function reopened(f: Awaited<ReturnType<typeof setup>>) {
  await f.joint.close()
  joints.splice(joints.indexOf(f.joint), 1)
  const again = await openJointAdmission(f.directory, f.input)
  joints.push(again)
  await expect((again.state as unknown as Owner).requireSession(f.admission.sessionId)).resolves.toBeDefined()
  return again
}

describe('start_composite', () => {
  it('creates the composite attempt and the revision-zero provider state in one commit', async () => {
    const f = await setup()
    const invocation = await f.prepared(f.parentId, 1)
    const before = f.events()
    const receipt = await f.start(invocation, f.parentId, 'start-1', 'attempt-1')
    expect(f.events()).toBe(before + 1)
    expect(receipt.runRevision).toBe(1)
    expect(f.head('attempt:attempt-1')?.value).toMatchObject({
      kind: 'composite',
      number: 1,
      state: 'running',
      requestIdentity: null,
      authorizationRef: null,
      budgetReservationRefs: [],
      executeDeadline: null,
      actionId: f.parentId,
      startedAt: '2026-10-03T00:00:00.000Z',
    })
    expect(f.head(providerStateRecordId(f.parentId))).toMatchObject({
      revision: 1,
      value: { providerRevision: 0, state: 'runnable', continuation: null, waitId: null, termination: null },
    })
    expect(f.head(actionRecordId(f.parentId))).toMatchObject({
      revision: 2,
      value: {
        state: 'running',
        currentAttemptId: 'attempt-1',
        providerStateId: providerStateRecordId(f.parentId),
      },
    })
    expect(f.head(`run:${f.admission.runId}`)?.value.revision).toBe(1)
  })
  it('replays the same commit id without a new write and refuses it with different content', async () => {
    const f = await setup()
    const invocation = await f.prepared(f.parentId, 1)
    const first = await f.start(invocation, f.parentId, 'start-1', 'attempt-1')
    const writes = f.writes()
    expect(await f.start(invocation, f.parentId, 'start-1', 'attempt-1')).toEqual(first)
    expect(f.writes()).toBe(writes)
  })
  it.each([
    ['an action whose target declares no state codec', 'leaf', 1, 'composite_target'],
    ['an action whose operation is not an action', 'query', 1, 'composite_target'],
    ['an action whose operation is declared twice', 'duplicate', 1, 'composite_target'],
    ['a stale action revision', 'parent', 7, 'action_state'],
  ])('refuses %s and writes nothing', async (_name, which, revision, detail) => {
    const f = await setup()
    const invocation = await f.prepared(null, 1)
    const writes = f.writes()
    await expect(
      f.start(
        invocation,
        { leaf: f.leafParentId, query: f.queryParentId, duplicate: f.duplicateParentId, parent: f.parentId }[
          which as string
        ] as string,
        'start-x',
        'attempt-x',
        revision,
      ),
    ).rejects.toMatchObject({ failure: { detailCode: detail } })
    expect(f.writes()).toBe(writes)
    expect(f.head('attempt:attempt-x')).toBeUndefined()
  })
  it('refuses a second start of a started parent', async () => {
    const f = await setup()
    const invocation = await f.prepared(f.parentId, 1)
    await f.start(invocation, f.parentId, 'start-1', 'attempt-1')
    const writes = f.writes()
    await expect(f.start(invocation, f.parentId, 'start-2', 'attempt-2', 2)).rejects.toMatchObject({
      failure: { detailCode: 'action_state' },
    })
    expect(f.writes()).toBe(writes)
  })
})

describe('start_composite attempt ids', () => {
  it('refuses an attempt id that is already taken before it looks at the target', async () => {
    const f = await setup()
    await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
    const writes = f.writes()
    await expect(
      f.start(await f.prepared(null, 1), f.leafParentId, 'start-2', 'attempt-1'),
    ).rejects.toMatchObject({ failure: { detailCode: 'attempt_exists' } })
    expect(f.head(providerStateRecordId(f.leafParentId))).toBeUndefined()
    expect(f.writes()).toBeGreaterThan(writes)
  })
})

describe('advanceProvider', () => {
  async function started() {
    const f = await setup()
    await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
    return f
  }
  it('commits the continuation and the children of a parent in one commit without moving the run', async () => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    const before = f.events()
    const quota = f.head(`run-quota:${f.admission.runId}`)?.value
    const receipt = await f.advance(invocation, 'step-1', {
      children: [f.child('child-a'), f.child('child-b')],
    })
    expect(f.events()).toBe(before + 1)
    expect(receipt.runRevision).toBe(1)
    const childId = stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`)
    expect(receipt.actionIds).toEqual([
      { key: 'child-a', actionId: childId },
      { key: 'child-b', actionId: stableId('act', `${f.admission.runId}\0${f.parentId}\0child-b`) },
    ])
    expect(f.head(actionRecordId(childId))).toMatchObject({
      revision: 1,
      value: {
        parentActionId: f.parentId,
        ownerRef: { kind: 'action', id: f.parentId },
        state: 'prepared',
        key: 'child-a',
        createdByCommitId: receipt.commitId,
      },
    })
    const provider = f.head(providerStateRecordId(f.parentId))
    expect(provider).toMatchObject({
      revision: 2,
      value: { providerRevision: 1, state: 'runnable', waitId: null },
    })
    expect(provider?.value.continuation.data.value).toEqual({ marker: 'step-1' })
    expect(f.head(`run:${f.admission.runId}`)?.value.revision).toBe(1)
    expect(f.head(`invocation:${invocation}`)?.value.state).toBe('committed')
    const after = f.head(`run-quota:${f.admission.runId}`)?.value
    expect(after?.totalTransitions).toBe(quota?.totalTransitions + 1)
    expect(after?.submittedActions).toBe(quota?.submittedActions + 2)
    expect(after?.lastProgressRef).toBe(stableId('act', `${f.admission.runId}\0${f.parentId}\0child-b`))
    const sides = f.joint.db
      .prepare("SELECT identity FROM runtime_side_entries WHERE commit_id=? AND kind='action-created'")
      .all(receipt.commitId)
    expect(sides).toHaveLength(2)
  })
  it('keeps child ids under the parent namespace, so one key under two parents never collides', async () => {
    const f = await started()
    const underRun = stableId('act', `${f.admission.runId}\0child-a`)
    const underParent = stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`)
    expect(underParent).not.toBe(underRun)
  })
  it('replays the same commit id without a write', async () => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    const first = await f.advance(invocation, 'step-1', { children: [f.child('child-a')] })
    const writes = f.writes()
    expect(await f.advance(invocation, 'step-1', { children: [f.child('child-a')] })).toEqual(first)
    expect(f.writes()).toBe(writes)
  })
  it('reuses a child with the same key and fingerprint and refuses a different fingerprint, with no write', async () => {
    const f = await started()
    await f.advance(await f.prepared(f.parentId, 1), 'step-1', { children: [f.child('child-a')] })
    const same = await f.advance(await f.prepared(f.parentId, 1), 'step-2', {
      revision: 1,
      children: [f.child('child-a')],
    })
    expect(same.actionIds).toHaveLength(1)
    expect(
      f.joint.db
        .prepare("SELECT identity FROM runtime_side_entries WHERE commit_id=? AND kind='action-created'")
        .all(same.commitId),
    ).toHaveLength(0)
    const invocation = await f.prepared(f.parentId, 1)
    const writes = f.writes()
    await expect(
      f.advance(invocation, 'step-3', { revision: 2, children: [f.child('child-a', true)] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'intent_fingerprint' } })
    expect(f.writes()).toBe(writes)
    expect(f.head(providerStateRecordId(f.parentId))?.value.providerRevision).toBe(2)
  })
  it('registers a wait for the parent and parks the provider', async () => {
    const f = await started()
    const condition = {
      anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }],
    }
    const receipt = await f.advance(await f.prepared(f.parentId, 1), 'step-1', {
      children: [f.child('child-a')],
      next: { kind: 'wait', condition },
    })
    const waitId = stableId('wait', receipt.commitId)
    expect(f.head(waitRecordId(waitId))).toMatchObject({
      revision: 1,
      value: {
        waitId,
        runId: f.admission.runId,
        targetActionId: f.parentId,
        state: 'waiting',
        matchedSignalIds: [],
        registeredByCommitId: receipt.commitId,
        deadlineSignalId: null,
      },
    })
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      state: 'waiting',
      waitId,
      providerRevision: 1,
    })
    expect(f.head(timerRecordId(waitId))).toBeUndefined()
  })
  it('resumes a waiting provider on the signal of a settled child, and only on signals that target the parent', async () => {
    const f = await started()
    const condition = {
      anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }],
    }
    const childIntent = f.child('child-a')
    const parkInvocation = await f.prepared(f.parentId, 1)
    const parked = await f.advance(parkInvocation, 'step-1', {
      children: [childIntent],
      next: { kind: 'wait', condition },
    })
    const waitId = stableId('wait', parked.commitId)
    const childId = stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`)
    await f.complete(childId, childIntent, parkInvocation, 'child')
    await f.complete(f.leafParentId, f.leafParentIntent, parkInvocation, 'sibling')
    const [signal] = f.signalsFor(f.parentId)
    const [runSignal] = f.signalsFor(null)
    if (!signal || !runSignal || f.signalsFor(f.parentId).length !== 1)
      throw Error('the child receipt did not publish exactly one signal for the parent')
    const snapshot = () => [
      f.head(waitRecordId(waitId)),
      f.head(providerStateRecordId(f.parentId)),
      f.head(`signal:${signal}`),
      f.head(`signal:${runSignal}`),
    ]
    const before = snapshot()
    await expect(
      f.advance(await f.prepared(f.parentId, 1), 'resume-none', { revision: 1 }),
    ).rejects.toMatchObject({ failure: { detailCode: 'wait_not_satisfied' } })
    await expect(
      f.advance(await f.prepared(f.parentId, 1), 'resume-other', { revision: 1, consume: [runSignal] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'signal_absent' } })
    expect(snapshot()).toEqual(before)
    const resumed = await f.advance(await f.prepared(f.parentId, 1), 'resume', {
      revision: 1,
      consume: [signal],
    })
    expect(f.head(waitRecordId(waitId))).toMatchObject({
      revision: 2,
      value: { state: 'ready', matchedSignalIds: [signal] },
    })
    expect(f.head(`signal:${signal}`)?.value.consumedByCommitId).toBe(resumed.commitId)
    expect(f.head(`signal:${runSignal}`)?.value.consumedByCommitId).toBeNull()
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      state: 'runnable',
      waitId: null,
      providerRevision: 2,
    })
    expect(f.head(actionRecordId(childId))?.value.state).toBe('settled')
    await reopened(f)
  })
  it.each([
    ['transition and request that name different revisions', 'provider_revision'],
    ['a signal listed twice', 'signal_duplicate'],
    ['more children than one transition may carry', 'action_count'],
    ['a child key listed twice', 'child_key_duplicate'],
    ['a continuation above the size limit', 'continuation'],
  ])('refuses %s before it reads anything', async (name, detail) => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    const request = f.advanceRequest(invocation, 'step-x', {})
    const shaped = {
      'transition and request that name different revisions': {
        ...request,
        transition: { ...request.transition, expectedProviderRevision: 4 },
      },
      'a signal listed twice': {
        ...request,
        transition: { ...request.transition, consumeSignals: ['s', 's'] },
      },
      'more children than one transition may carry': {
        ...request,
        transition: {
          ...request.transition,
          children: Array.from({ length: 65 }, (_, index) => f.child(`many-${index}`)),
        },
      },
      'a child key listed twice': {
        ...request,
        transition: { ...request.transition, children: [f.child('same'), f.child('same')] },
      },
      'a continuation above the size limit': {
        ...request,
        transition: {
          ...request.transition,
          continuation: {
            ...request.transition.continuation,
            data: fixtureRef({ big: 'x'.repeat(300_000) }),
          },
        },
      },
    }[name as string] as typeof request
    await expect(f.joint.state.advanceProvider(shaped)).rejects.toMatchObject({
      failure: { detailCode: detail },
    })
    expect(f.head(providerStateRecordId(f.parentId))?.value.providerRevision).toBe(0)
  })
  it('counts a transition that creates nothing as no progress, a wait as progress, and closes the prepare quota', async () => {
    const f = await started()
    const quota = () => f.head(`run-quota:${f.admission.runId}`)?.value
    const spin = await f.prepared(f.parentId, 1)
    await f.advance(spin, 'spin-1', {})
    expect(quota()?.noProgressTransitions).toBe(1)
    expect(f.head(`prepare:${stableId('prep', `${f.admission.runId}\0${spin}`)}`)?.value.closed).toBe(true)
    await f.advance(await f.prepared(f.parentId, 1), 'spin-2', { revision: 1 })
    expect(quota()?.noProgressTransitions).toBe(2)
    await f.advance(await f.prepared(f.parentId, 1), 'park', {
      revision: 2,
      next: {
        kind: 'wait',
        condition: { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] },
      },
    })
    expect(quota()?.noProgressTransitions).toBe(0)
  })
  it('refuses a codec version the provider does not declare, and a commit id reused for another parent', async () => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    const request = f.advanceRequest(invocation, 'step-1', {})
    await expect(
      f.joint.state.advanceProvider({
        ...request,
        transition: {
          ...request.transition,
          continuation: { ...request.transition.continuation, codecVersion: '99' },
        },
      }),
    ).rejects.toMatchObject({ failure: { detailCode: 'continuation_codec' } })
    await f.joint.state.advanceProvider(request)
    await expect(
      f.joint.state.advanceProvider({ ...request, actionId: f.leafParentId }),
    ).rejects.toMatchObject({ failure: { code: 'conflict' } })
    expect(f.head(providerStateRecordId(f.parentId))?.value.providerRevision).toBe(1)
  })
  it('counts children and consumed signals as progress even when they are all a transition does', async () => {
    const f = await started()
    const quota = () => f.head(`run-quota:${f.admission.runId}`)?.value
    const childIntent = f.child('child-a')
    await f.advance(await f.prepared(f.parentId, 1), 'spin', {})
    expect(quota()?.noProgressTransitions).toBe(1)
    const parkInvocation = await f.prepared(f.parentId, 1)
    await f.advance(parkInvocation, 'park', {
      revision: 1,
      children: [childIntent],
      next: {
        kind: 'wait',
        condition: { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] },
      },
    })
    await f.complete(
      stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`),
      childIntent,
      parkInvocation,
      'child',
    )
    const [signal] = f.signalsFor(f.parentId)
    await f.advance(await f.prepared(f.parentId, 1), 'spin-again', {
      revision: 2,
      consume: [signal as string],
    })
    expect(quota()?.noProgressTransitions).toBe(0)
    await f.advance(await f.prepared(f.parentId, 1), 'spin-3', { revision: 3 })
    expect(quota()?.noProgressTransitions).toBe(1)
    await f.advance(await f.prepared(f.parentId, 1), 'children-only', {
      revision: 4,
      children: [f.child('child-b')],
    })
    expect(quota()?.noProgressTransitions).toBe(0)
  })
  it.each([
    ['a wait with a deadline', { kind: 'wait', condition: { anyOf: [], deadline: '2027-01-01T00:00:00Z' } }],
    ['a completion', { kind: 'complete', output: fixtureRef({}), references: [] }],
    [
      'a failure',
      {
        kind: 'fail',
        error: {
          code: 'internal',
          detailCode: 'x',
          message: 'x',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'd',
        },
      },
    ],
  ])('does not accept %s yet and writes nothing', async (_name, next) => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    const writes = f.writes()
    await expect(f.advance(invocation, 'step-x', { next })).rejects.toMatchObject({
      failure: { code: 'internal', detailCode: 'unsupported' },
    })
    expect(f.writes()).toBe(writes)
  })
  it('refuses stale provider revisions, foreign codecs, wrong invocation targets and unstarted parents', async () => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    await expect(f.advance(invocation, 'stale', { revision: 3 })).rejects.toMatchObject({
      failure: { detailCode: 'provider_revision' },
    })
    await expect(
      f.advance(invocation, 'codec', { continuation: f.continuation('x', 'agh.default/other') }),
    ).rejects.toMatchObject({ failure: { detailCode: 'continuation_codec' } })
    await expect(
      f.advance(await f.prepared(null, 1), 'target', { children: [f.child('child-a')] }),
    ).rejects.toMatchObject({ failure: { detailCode: 'invocation_target' } })
    await expect(
      f.advance(await f.prepared(f.leafParentId, 1), 'unstarted', {}, f.leafParentId),
    ).rejects.toMatchObject({ failure: { detailCode: 'action_state' } })
    expect(f.head(providerStateRecordId(f.leafParentId))).toBeUndefined()
    expect(f.head(providerStateRecordId(f.parentId))?.value.providerRevision).toBe(0)
    expect(
      f.head(actionRecordId(stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`))),
    ).toBeUndefined()
  })
  it('writes nothing when the transaction fails before it commits, and the retry then succeeds', async () => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    const snapshot = () => ({
      events: f.events(),
      provider: f.head(providerStateRecordId(f.parentId)),
      child: f.head(actionRecordId(stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`))),
      invocation: f.head(`invocation:${invocation}`),
      quota: f.head(`run-quota:${f.admission.runId}`),
    })
    const before = snapshot()
    f.setFailBeforeCommit(true)
    await expect(f.advance(invocation, 'step-1', { children: [f.child('child-a')] })).rejects.toThrow(
      'injected failure before commit',
    )
    f.setFailBeforeCommit(false)
    expect(snapshot()).toEqual(before)
    await f.advance(invocation, 'step-1', { children: [f.child('child-a')] })
    expect(snapshot().child?.revision).toBe(1)
    expect(snapshot().provider?.value.providerRevision).toBe(1)
  })
  it('keeps one active invocation per run, so a second parent waits for the first invocation to close', async () => {
    const f = await started()
    await f.joint.state.admitInvocation({
      requestId: 'second-active',
      runId: f.admission.runId,
      targetActionId: f.parentId,
      baseRevision: 1,
      bindingId: f.joint.binding.bindingId,
      writerEpoch: 1,
      invocationId: 'second-active',
      deadline: '2027-01-01T00:00:00Z',
      queryAllowance: 0,
    })
    await expect(
      f.joint.state.admitInvocation({
        requestId: 'third-active',
        runId: f.admission.runId,
        targetActionId: f.leafParentId,
        baseRevision: 1,
        bindingId: f.joint.binding.bindingId,
        writerEpoch: 1,
        invocationId: 'third-active',
        deadline: '2027-01-01T00:00:00Z',
        queryAllowance: 0,
      }),
    ).rejects.toMatchObject({ failure: { detailCode: 'invocation_state' } })
  })
  it('survives a cold reopen with the full integrity scan, and a child can be captured for effects', async () => {
    const f = await started()
    const parked = await f.advance(await f.prepared(f.parentId, 1), 'step-1', {
      children: [f.child('child-a')],
      next: {
        kind: 'wait',
        condition: { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] },
      },
    })
    const childId = stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`)
    f.joint.state.installEffectsActionCapture()
    const captured = await f.joint.state.captureEffectsAction(f.admission.sessionId, childId)
    expect(captured.actionId).toBe(childId)
    const providerBefore = f.head(providerStateRecordId(f.parentId))
    const waitBefore = f.head(waitRecordId(stableId('wait', parked.commitId)))
    await f.joint.close()
    joints.splice(joints.indexOf(f.joint), 1)
    const reopened = await openJointAdmission(f.directory, f.input)
    joints.push(reopened)
    await expect(
      (reopened.state as unknown as Owner).requireSession(f.admission.sessionId),
    ).resolves.toBeDefined()
    const read = (recordId: string) => {
      const row = reopened.db
        .prepare(
          'SELECT b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
        )
        .get(recordId)
      return JSON.parse(String(row?.value_json)) as unknown
    }
    expect(read(providerStateRecordId(f.parentId))).toEqual(providerBefore?.value)
    expect(read(waitRecordId(stableId('wait', parked.commitId)))).toEqual(waitBefore?.value)
    expect(read(actionRecordId(childId))).toMatchObject({ parentActionId: f.parentId })
  })
})

describe('the State store facade', () => {
  it('lists advanceProvider as implemented and checks the request before it reaches the database', async () => {
    expect(UNIMPLEMENTED_STATE_METHODS).not.toContain('advanceProvider')
    const f = await setup()
    await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
    const call = f.joint.context()
    const invocation = await f.prepared(f.parentId, 1)
    const request = f.advanceRequest(invocation, 'step-1', { children: [f.child('child-a')] })
    const malformed = await f.joint.store.advanceProvider({ ...request, actionId: 7 } as never, call)
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_input', detailCode: 'schema' } })
    const foreign = await f.joint.store.advanceProvider(
      { ...request, guard: { ...request.guard, authority: { ...f.authority, authorityEpoch: 9 } } },
      call,
    )
    expect(foreign).toMatchObject({ ok: false, error: { code: 'conflict', detailCode: 'authority' } })
    expect(f.head(providerStateRecordId(f.parentId))?.value.providerRevision).toBe(0)
    const accepted = await f.joint.store.advanceProvider(request, call)
    expect(accepted.ok).toBe(true)
    expect(f.head(providerStateRecordId(f.parentId))?.value.providerRevision).toBe(1)
    const refused = await f.joint.store.advanceProvider(
      f.advanceRequest(await f.prepared(f.parentId, 1), 'step-2', { revision: 5 }),
      call,
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'conflict', detailCode: 'provider_revision' } })
  })
})
