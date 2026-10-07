import { afterEach, describe, expect, it } from 'vitest'
import { UNIMPLEMENTED_STATE_METHODS } from '../../src/runtime/providers/state.js'
import {
  actionRecordId,
  providerStateRecordId,
  stableId,
  timerRecordId,
  waitRecordId,
} from '../../src/runtime/state/records.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { cleanup, joints, type Owner, reopened, setup } from './fixtures/state-composite-fixture.js'

afterEach(cleanup)

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
  async function started(options: { secondParent?: boolean } = {}) {
    const f = await setup(options)
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
  const admit = (f: Awaited<ReturnType<typeof started>>, id: string, target: string | null, base?: number) =>
    f.joint.state.admitInvocation({
      requestId: `req-${id}`,
      runId: f.admission.runId,
      targetActionId: target,
      baseRevision: base ?? f.baseOf(target, 1),
      bindingId: f.joint.binding.bindingId,
      writerEpoch: 1,
      invocationId: id,
      deadline: '2027-01-01T00:00:00Z',
      queryAllowance: 0,
    })
  const activeRows = (f: Awaited<ReturnType<typeof started>>) =>
    f.joint.db
      .prepare(
        'SELECT target_key, invocation_id FROM runtime_active_invocation_target ORDER BY invocation_id',
      )
      .all()
      .map((row) => `${String(row.target_key)}=${String(row.invocation_id)}`)
  it('allows one active invocation per target, so parents and the run itself each have their own', async () => {
    const f = await started({ secondParent: true })
    await f.start(await f.prepared(f.secondParentId, 1), f.secondParentId, 'start-2', 'attempt-2')
    await admit(f, 'run-level', null)
    await admit(f, 'parent-a', f.parentId)
    await admit(f, 'parent-b', f.secondParentId)
    expect(activeRows(f)).toEqual([`${f.parentId}=parent-a`, `${f.secondParentId}=parent-b`, `=run-level`])
    await expect(admit(f, 'run-again', null)).rejects.toMatchObject({
      failure: { detailCode: 'invocation_state' },
    })
    await expect(admit(f, 'parent-a-again', f.parentId)).rejects.toMatchObject({
      failure: { detailCode: 'invocation_state' },
    })
    expect(activeRows(f)).toHaveLength(3)
    await f.joint.state.closeInvocation({
      requestId: 'close-parent-a',
      invocationId: 'parent-a',
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    expect(activeRows(f)).toEqual([`${f.secondParentId}=parent-b`, `=run-level`])
    await admit(f, 'parent-a-next', f.parentId)
  })
  it('compares the base revision with the target provider revision, and verifies the target', async () => {
    const f = await started({ secondParent: true })
    // The provider revision is 0 and the run revision is 1: the run revision is stale for a started parent.
    await expect(admit(f, 'stale-parent', f.parentId, 1)).rejects.toMatchObject({
      failure: { detailCode: 'revision' },
    })
    await expect(admit(f, 'stale-run', null, 0)).rejects.toMatchObject({
      failure: { detailCode: 'revision' },
    })
    await f.advance(await f.prepared(f.parentId, 1), 'step-1', {})
    await expect(admit(f, 'old-provider', f.parentId, 0)).rejects.toMatchObject({
      failure: { detailCode: 'revision' },
    })
    await admit(f, 'current-provider', f.parentId, 1)
    // A parent that has not started has no provider revision of its own and is based on the run.
    await admit(f, 'unstarted', f.secondParentId, 1)
    await expect(admit(f, 'unknown-target', 'no-such-action', 1)).rejects.toMatchObject({
      failure: { detailCode: 'invocation_target' },
    })
    expect(activeRows(f)).toHaveLength(2)
  })
  it('refuses a target action that belongs to another run', async () => {
    const f = await started()
    const id = `action:${f.leafParentId}`
    const body = f.head(id)?.value
    const set = (runId: unknown) =>
      f.joint.db
        .prepare(
          "UPDATE runtime_version_bodies SET value_json=json_set(value_json,'$.runId',?) WHERE record_id=?",
        )
        .run(runId as string, id)
    set('another-run')
    await expect(admit(f, 'foreign', f.leafParentId, 1)).rejects.toMatchObject({
      failure: { detailCode: 'invocation_target' },
    })
    set(body?.runId)
    await admit(f, 'own', f.leafParentId, 1)
  })
  it('refuses a run advance on an invocation that targets a parent', async () => {
    const f = await started()
    const invocation = await f.prepared(f.parentId, 1)
    await expect(
      f.joint.state.advanceRun({
        commitId: 'wrong-target',
        guard: f.guardFor(invocation, 1),
        transition: {
          expectedRevision: 1,
          continuation: f.continuation('x'),
          consumeSignals: [],
          actions: [],
          next: { kind: 'continue' },
        },
      }),
    ).rejects.toMatchObject({ failure: { detailCode: 'invocation_target' } })
  })
  it('advances several waiting parents of one run independently, and survives a cold reopen with the scan', async () => {
    const f = await started({ secondParent: true })
    await f.start(await f.prepared(f.secondParentId, 1), f.secondParentId, 'start-2', 'attempt-2')
    const wait = {
      kind: 'wait',
      condition: { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] },
    }
    const a = f.child('child-a')
    const b = f.child('child-b')
    const invocationA = await f.prepared(f.parentId, 1)
    const invocationB = await f.prepared(f.secondParentId, 1)
    await f.advance(invocationA, 'park-a', { children: [a], next: wait })
    await f.advance(invocationB, 'park-b', { children: [b], next: wait }, f.secondParentId)
    const childA = stableId('act', `${f.admission.runId}\0${f.parentId}\0child-a`)
    const childB = stableId('act', `${f.admission.runId}\0${f.secondParentId}\0child-b`)
    await f.complete(childB, b, invocationB, 'b')
    expect(f.signalsFor(f.parentId)).toEqual([])
    const [signalB] = f.signalsFor(f.secondParentId)
    await f.advance(
      await f.prepared(f.secondParentId, 1),
      'resume-b',
      {
        revision: 1,
        consume: [signalB as string],
      },
      f.secondParentId,
    )
    expect(f.head(providerStateRecordId(f.secondParentId))?.value.providerRevision).toBe(2)
    expect(f.head(providerStateRecordId(f.parentId))?.value).toMatchObject({
      providerRevision: 1,
      state: 'waiting',
    })
    await f.complete(childA, a, invocationA, 'a')
    // Two parents hold active invocations at the moment of the reopen.
    await admit(f, 'open-a', f.parentId)
    await admit(f, 'open-b', f.secondParentId, 2)
    const again = await reopened(f)
    expect(again.db.prepare('SELECT count(*) AS n FROM runtime_active_invocation_target').get()?.n).toBe(2)
  })
  it('migrates a database written with the one-per-run index and still passes the scan', async () => {
    const f = await started()
    await admit(f, 'old-active', null)
    f.joint.db.exec(`DROP TABLE runtime_active_invocation_target;
      CREATE TABLE runtime_active_invocation (run_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL) WITHOUT ROWID;`)
    f.joint.db
      .prepare('INSERT INTO runtime_active_invocation (run_id, invocation_id) VALUES (?, ?)')
      .run(f.admission.runId, 'old-active')
    const again = await reopened(f)
    expect(
      again.db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_active_invocation'").get(),
    ).toBeUndefined()
    expect(
      again.db.prepare('SELECT target_key, invocation_id FROM runtime_active_invocation_target').all(),
    ).toEqual([{ target_key: '', invocation_id: 'old-active' }])
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
