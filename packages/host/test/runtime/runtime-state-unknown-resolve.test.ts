import type { PreparedAction } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { actionRecordId, providerStateRecordId, stableId } from '../../src/runtime/state/records.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { cleanup, reopened, setup } from './fixtures/state-composite-fixture.js'

afterEach(cleanup)

type Fixture = Awaited<ReturnType<typeof setup>>

const ERROR = {
  code: 'internal' as const,
  detailCode: 'composite_failed',
  message: 'the composite failed',
  retryAdvice: { kind: 'never' as const },
  diagnosticId: 'diagnostic-1',
}
const OWNER = { kind: 'reconciliation' as const, id: 'reconciliation-1' }
const NEXT_OWNER = { kind: 'reconciliation' as const, id: 'reconciliation-2' }
const EVIDENCE = fixtureRef({ lookup: 'first' })
const MORE_EVIDENCE = fixtureRef({ lookup: 'second' })

const runId = (f: Fixture) => f.admission.runId
const childId = (f: Fixture, key: string) => stableId('act', `${runId(f)}\0${f.parentId}\0${key}`)
const resolutionRecord = (actionId: string) => `resolution:${stableId('res', actionId)}`

function control(f: Fixture, invocation: string, commitId: string, command: unknown) {
  const revision = Number(f.head(`run:${runId(f)}`)?.value.revision)
  return f.joint.state.commitControl({ commitId, guard: f.guardFor(invocation, revision), command } as never)
}

const markUnknown = (f: Fixture, invocation: string, commitId: string, tag: string, patch = {}) =>
  control(f, invocation, commitId, {
    kind: 'mark_unknown',
    attemptId: `attempt-${tag}`,
    expectedAttemptRevision: Number(f.head(`attempt:attempt-${tag}`)?.revision),
    evidence: [EVIDENCE],
    reconciliationOwnerRef: OWNER,
    reason: 'the effect owner lost the answer',
    ...patch,
  })

const resolve = (f: Fixture, invocation: string, commitId: string, actionId: string, patch = {}) =>
  control(f, invocation, commitId, {
    kind: 'resolve_action',
    actionId,
    expectedActionRevision: Number(f.head(actionRecordId(actionId))?.revision),
    selectedReceiptId: null,
    evidence: [],
    state: 'unresolved',
    ownerRef: OWNER,
    nextCheckAt: null,
    ...patch,
  })

/** Rewrites the stored body of the current version. Used only to rewind a state no command can reach. */
function forge(f: Fixture, recordId: string, patch: Record<string, unknown>) {
  const head = f.head(recordId)
  if (!head) throw Error(`no record ${recordId}`)
  f.joint.db
    .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
    .run(JSON.stringify({ ...head.value, ...patch }), recordId, head.revision)
}

/** A started parent with one child per key, every child dispatched (attempt `attempt-<key>`) and open. */
async function dispatchedChildren(f: Fixture, keys: string[]) {
  await f.start(await f.prepared(f.parentId, 1), f.parentId, 'start-1', 'attempt-1')
  const children = keys.map((key) => f.child(key))
  const invocation = await f.prepared(f.parentId, 1)
  await f.advance(invocation, 'step-1', { children })
  for (const [index, key] of keys.entries()) {
    const admitted = await f.dispatch(childId(f, key), children[index] as PreparedAction, invocation, key)
    if (admitted.state !== 'admitted') throw Error('child dispatch was refused')
  }
  return { children, invocation }
}

const mirrors = (f: Fixture) =>
  f.joint.db
    .prepare(
      "SELECT record_id, record_revision FROM runtime_record_heads WHERE record_id LIKE 'quota:%' ORDER BY 1",
    )
    .all()
    .map((row) => `${row.record_id}@${row.record_revision}`)

describe('mark_unknown', () => {
  it('moves the attempt and the action to unknown in one commit and keeps what it cannot know', async () => {
    const f = await setup()
    await dispatchedChildren(f, ['child-a'])
    const child = childId(f, 'child-a')
    const held = mirrors(f)
    const invocation = await f.prepared(null, 1)
    const events = f.events()
    const receipt = await markUnknown(f, invocation, 'unknown-1', 'child-a')
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    expect(f.head('attempt:attempt-child-a')?.value).toMatchObject({ state: 'unknown', receiptIds: [] })
    expect(f.head(actionRecordId(child))?.value).toMatchObject({
      state: 'unknown',
      ownerRef: OWNER,
      resolutionId: stableId('res', child),
      firstReceiptId: null,
      resolvedReceiptId: null,
    })
    expect(f.head(resolutionRecord(child))?.value).toEqual({
      resolutionId: stableId('res', child),
      actionId: child,
      previousReceiptIds: [],
      selectedReceiptId: null,
      evidenceRefs: [EVIDENCE],
      state: 'unresolved',
      ownerRef: OWNER,
      nextCheckAt: null,
      reason: 'the effect owner lost the answer',
    })
    expect(mirrors(f)).toEqual(held)
    expect(f.signalsFor(f.parentId)).toHaveLength(0)
    expect(f.head(`run:${runId(f)}`)?.value.revision).toBe(1)
    const writes = f.writes()
    expect(await markUnknown(f, invocation, 'unknown-1', 'child-a', { expectedAttemptRevision: 1 })).toEqual(
      receipt,
    )
    expect(f.writes()).toBe(writes)
    await reopened(f)
  })
  it('accepts an attempt that is already running, and leaves the other attempts alone', async () => {
    const f = await setup()
    await dispatchedChildren(f, ['child-a', 'child-b'])
    const invocation = await f.prepared(null, 1)
    await control(f, invocation, 'running-a', {
      kind: 'mark_running',
      attemptId: 'attempt-child-a',
      expectedAttemptRevision: 1,
      externalRequests: [],
    })
    expect(f.head('attempt:attempt-child-a')?.value.state).toBe('running')
    await markUnknown(f, invocation, 'unknown-a', 'child-a')
    expect(f.head('attempt:attempt-child-a')?.value.state).toBe('unknown')
    expect(f.head('attempt:attempt-child-b')?.value.state).toBe('dispatching')
    expect(f.head(actionRecordId(childId(f, 'child-b')))?.value).toMatchObject({
      state: 'dispatching',
      resolutionId: null,
    })
    await reopened(f)
  })
  it('refuses a stale revision, a settled or unknown attempt, an owner that is no reconciliation and a missing attempt', async () => {
    const f = await setup()
    await dispatchedChildren(f, ['child-a', 'child-b'])
    await f.joint.state.intakeReceipt({
      intakeId: 'intake-b',
      receipt: {
        receiptId: 'receipt-b',
        actionId: childId(f, 'child-b'),
        attemptId: 'attempt-child-b',
        bindingId: f.joint.binding.bindingId,
        inputDigest: String(f.head('attempt:attempt-child-b')?.value.inputDigest),
        outcome: 'succeeded',
        result: { ...fixtureRef({ b: 1 }), schema: f.child('child-b').resultSchema },
        externalRequests: [],
        usageRefs: [],
        references: [],
        provenance: {
          sourceRefs: [],
          producer: {
            bindingId: f.joint.binding.bindingId,
            contract: 'agh.state',
            logicalName: 'default',
            providerId: 'fixture-state',
          },
          trustLabels: [],
        },
        completedAt: f.admission.admittedAt,
      },
      usage: [],
      evidence: [],
      sourceAuthorizationRef: String(f.head('attempt:attempt-child-b')?.value.authorizationRef),
      queryUsage: null,
      resultHandling: { kind: 'no-hook' },
    })
    const invocation = await f.prepared(null, 1)
    const snapshot = () => [
      f.head('attempt:attempt-child-a'),
      f.head(actionRecordId(childId(f, 'child-a'))),
      f.head(resolutionRecord(childId(f, 'child-a'))),
      f.head('attempt:attempt-child-b'),
      f.head(actionRecordId(childId(f, 'child-b'))),
    ]
    const before = snapshot()
    const writes = f.writes()
    const refused = (commitId: string, tag: string, patch: object, detail: string) =>
      expect(markUnknown(f, invocation, commitId, tag, patch)).rejects.toMatchObject({
        failure: { detailCode: detail },
      })
    await refused('u-1', 'child-a', { expectedAttemptRevision: 9 }, 'attempt_revision')
    await refused('u-2', 'child-a', { reconciliationOwnerRef: { kind: 'run', id: runId(f) } }, 'owner_ref')
    await refused('u-3', 'child-a', { reconciliationOwnerRef: { kind: 'job', id: 'job-1' } }, 'owner_ref')
    await refused('u-4', 'child-b', {}, 'attempt_state')
    await refused('u-5', '1', {}, 'attempt_state')
    await expect(
      markUnknown(f, invocation, 'u-6', 'nothing', { expectedAttemptRevision: 1 }),
    ).rejects.toMatchObject({ failure: { detailCode: 'attempt_absent' } })
    expect(snapshot()).toEqual(before)
    expect(f.writes()).toBe(writes)
    await markUnknown(f, invocation, 'u-7', 'child-a')
    const marked = f.writes()
    await refused('u-8', 'child-a', {}, 'attempt_state')
    expect(f.writes()).toBe(marked)
    forge(f, 'attempt:attempt-child-b', { state: 'running' })
    forge(f, actionRecordId(childId(f, 'child-b')), { state: 'running', currentAttemptId: 'attempt-other' })
    await refused('u-8b', 'child-b', {}, 'attempt_state')
    forge(f, actionRecordId(childId(f, 'child-b')), { currentAttemptId: 'attempt-child-b' })
    forge(f, 'attempt:attempt-child-b', { state: 'settled' })
    await refused('u-8c', 'child-b', {}, 'attempt_state')
    forge(f, 'attempt:attempt-child-b', { state: 'running' })
    forge(f, actionRecordId(childId(f, 'child-b')), { runId: 'another-run', state: 'running' })
    await refused('u-9', 'child-b', {}, 'attempt_state')
    forge(f, actionRecordId(childId(f, 'child-b')), { runId: runId(f), state: 'settled' })
    await refused('u-10', 'child-b', {}, 'attempt_state')
  })
  it('refuses a missing invocation and a run guard of another revision, writing nothing', async () => {
    const f = await setup()
    await dispatchedChildren(f, ['child-a'])
    const spare = await f.prepared(null, 1)
    const writes = f.writes()
    await expect(
      f.joint.state.commitControl({
        commitId: 'u-1',
        guard: f.guardFor('no-such-invocation', 1),
        command: {
          kind: 'mark_unknown',
          attemptId: 'attempt-child-a',
          expectedAttemptRevision: 1,
          evidence: [],
          reconciliationOwnerRef: OWNER,
          reason: 'x',
        },
      } as never),
    ).rejects.toMatchObject({ failure: { detailCode: 'invocation_absent' } })
    await expect(
      f.joint.state.commitControl({
        commitId: 'u-2',
        guard: f.guardFor(spare, 5),
        command: {
          kind: 'mark_unknown',
          attemptId: 'attempt-child-a',
          expectedAttemptRevision: 1,
          evidence: [],
          reconciliationOwnerRef: OWNER,
          reason: 'x',
        },
      } as never),
    ).rejects.toMatchObject({ failure: { detailCode: 'revision' } })
    expect(f.writes()).toBe(writes)
  })
  it('never lets a composite parent attempt become unknown', async () => {
    const f = await setup()
    await dispatchedChildren(f, [])
    const invocation = await f.prepared(null, 1)
    const writes = f.writes()
    await expect(markUnknown(f, invocation, 'u-1', '1')).rejects.toMatchObject({
      failure: { detailCode: 'attempt_state' },
    })
    expect(f.writes()).toBe(writes)
    expect(f.head(actionRecordId(f.parentId))?.value.state).toBe('running')
  })
})

describe('an unknown effect and the run', () => {
  it('keeps the run and the parent from completing, whoever hands it over', async () => {
    const f = await setup()
    await dispatchedChildren(f, ['child-a'])
    await markUnknown(f, await f.prepared(null, 1), 'unknown-1', 'child-a')
    const parentInvocation = await f.prepared(f.parentId, 1)
    const runInvocation = await f.prepared(null, 1)
    const writes = f.writes()
    await expect(
      f.advance(parentInvocation, 'complete-parent', {
        revision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
        next: { kind: 'complete', output: fixtureRef({}), references: [] },
      }),
    ).rejects.toMatchObject({ failure: { detailCode: 'complete_unknown' } })
    await expect(
      f.joint.state.advanceRun({
        commitId: 'complete-run',
        guard: f.guardFor(runInvocation, 1),
        transition: {
          expectedRevision: 1,
          continuation: f.continuation('done'),
          consumeSignals: [],
          actions: [],
          next: { kind: 'complete', output: fixtureRef({}), references: [] },
        },
      }),
    ).rejects.toMatchObject({ failure: { detailCode: 'complete_unknown' } })
    expect(f.writes()).toBe(writes)
  })
  it('lets a failed composite parent finish only when the unknown child names its reconciliation owner', async () => {
    const f = await setup()
    await dispatchedChildren(f, ['child-a'])
    await markUnknown(f, await f.prepared(null, 1), 'unknown-1', 'child-a')
    await f.advance(await f.prepared(f.parentId, 1), 'fail-1', {
      revision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
      next: { kind: 'fail', error: ERROR },
    })
    const finalize = (commitId: string, invocation: string, ownerRefs: unknown[]) =>
      control(f, invocation, commitId, {
        kind: 'finalize_composite',
        actionId: f.parentId,
        expectedProviderRevision: Number(f.head(providerStateRecordId(f.parentId))?.value.providerRevision),
        outcome: 'failed',
        error: ERROR,
        ownerRefs,
      })
    const invocation = await f.prepared(f.parentId, 1)
    await expect(finalize('finalize-1', invocation, [])).rejects.toMatchObject({
      failure: { detailCode: 'finalize_children' },
    })
    await expect(
      finalize('finalize-2', invocation, [{ kind: 'reconciliation', id: 'other' }]),
    ).rejects.toMatchObject({ failure: { detailCode: 'finalize_children' } })
    await finalize('finalize-3', invocation, [OWNER])
    expect(f.head(actionRecordId(f.parentId))?.value.state).toBe('settled')
    expect(f.head(actionRecordId(childId(f, 'child-a')))?.value).toMatchObject({
      state: 'unknown',
      ownerRef: OWNER,
    })
    expect(f.head('attempt:attempt-child-a')?.value.state).toBe('unknown')
    await reopened(f)
  })
})

describe('resolve_action', () => {
  async function unknownChild(f: Fixture, keys = ['child-a']) {
    await dispatchedChildren(f, keys)
    const invocation = await f.prepared(null, 1)
    for (const key of keys) await markUnknown(f, invocation, `unknown-${key}`, key)
    return invocation
  }
  const resolutionOf = (f: Fixture, key = 'child-a') => f.head(resolutionRecord(childId(f, key)))

  it('keeps an unresolved action unknown, hands it over, schedules the next check and keeps all evidence', async () => {
    const f = await setup()
    const invocation = await unknownChild(f)
    const child = childId(f, 'child-a')
    const events = f.events()
    const revision = Number(f.head(actionRecordId(child))?.revision)
    const receipt = await resolve(f, invocation, 'resolve-1', child, {
      evidence: [MORE_EVIDENCE, EVIDENCE],
      ownerRef: NEXT_OWNER,
      nextCheckAt: '2026-11-01T00:00:00Z',
    })
    expect(f.events()).toBe(events + 1)
    expect(receipt.runRevision).toBe(1)
    expect(resolutionOf(f)?.value).toMatchObject({
      state: 'unresolved',
      ownerRef: NEXT_OWNER,
      nextCheckAt: '2026-11-01T00:00:00Z',
      evidenceRefs: [EVIDENCE, MORE_EVIDENCE],
      selectedReceiptId: null,
    })
    expect(f.head(actionRecordId(child))?.value).toMatchObject({ state: 'unknown', ownerRef: NEXT_OWNER })
    expect(f.head('attempt:attempt-child-a')?.value.state).toBe('unknown')
    const writes = f.writes()
    expect(
      await resolve(f, invocation, 'resolve-1', child, {
        expectedActionRevision: revision,
        evidence: [MORE_EVIDENCE, EVIDENCE],
        ownerRef: NEXT_OWNER,
        nextCheckAt: '2026-11-01T00:00:00Z',
      }),
    ).toEqual(receipt)
    expect(f.writes()).toBe(writes)
    await resolve(f, invocation, 'resolve-2', child, { state: 'conflicting', ownerRef: NEXT_OWNER })
    expect(resolutionOf(f)?.value).toMatchObject({ state: 'conflicting', nextCheckAt: null })
    expect(f.head(actionRecordId(child))?.value.state).toBe('unknown')
    await reopened(f)
  })
  it('refuses a stale revision, an action that is not unknown, a foreign action and bad owners or receipts, writing nothing', async () => {
    const f = await setup()
    const invocation = await unknownChild(f, ['child-a', 'child-b'])
    const child = childId(f, 'child-a')
    const snapshot = () => [f.head(actionRecordId(child)), resolutionOf(f), f.head('attempt:attempt-child-a')]
    const before = snapshot()
    const writes = f.writes()
    const refused = (commitId: string, actionId: string, patch: object, detail: string) =>
      expect(resolve(f, invocation, commitId, actionId, patch)).rejects.toMatchObject({
        failure: { detailCode: detail },
      })
    await refused('r-1', child, { expectedActionRevision: 9 }, 'action_state')
    await refused('r-2', f.parentId, {}, 'action_state')
    await refused('r-3', 'no-such-action', { expectedActionRevision: 1 }, 'action_state')
    await refused('r-4', child, { ownerRef: { kind: 'run', id: runId(f) } }, 'resolution')
    await refused('r-5', child, { selectedReceiptId: 'receipt-x' }, 'resolution')
    await refused('r-6', child, { state: 'conflicting', selectedReceiptId: 'receipt-x' }, 'resolution')
    await refused('r-7', child, { state: 'resolved' }, 'resolution')
    await refused(
      'r-8',
      child,
      { state: 'resolved', selectedReceiptId: 'receipt-x', nextCheckAt: '2026-11-01T00:00:00Z' },
      'resolution',
    )
    await refused(
      'r-9',
      child,
      { state: 'resolved', selectedReceiptId: 'receipt-x', ownerRef: NEXT_OWNER },
      'resolution',
    )
    await refused('r-10', child, { state: 'resolved', selectedReceiptId: 'receipt-x' }, 'receipt_absent')
    expect(snapshot()).toEqual(before)
    expect(f.writes()).toBe(writes)
    forge(f, actionRecordId(childId(f, 'child-b')), { state: 'settled' })
    await refused('r-11', childId(f, 'child-b'), {}, 'action_state')
    forge(f, actionRecordId(child), { runId: 'another-run' })
    await refused('r-12', child, {}, 'action_state')
  })
  describe('resolved', () => {
    /** A child whose real receipt exists, rewound to open so that the real commands reach resolve_action. */
    async function receiptedUnknown(f: Fixture, patch: Record<string, unknown> = {}) {
      const { children, invocation } = await dispatchedChildren(f, ['child-a', 'child-b'])
      const child = childId(f, 'child-a')
      const intent = children[0] as PreparedAction
      const stateBinding = {
        bindingId: f.joint.binding.bindingId,
        contract: 'agh.state',
        logicalName: 'default',
        providerId: 'fixture-state',
      }
      const attempt = f.head('attempt:attempt-child-a')?.value
      await f.joint.state.intakeReceipt({
        intakeId: 'intake-a',
        receipt: {
          receiptId: 'receipt-a',
          actionId: child,
          attemptId: 'attempt-child-a',
          bindingId: f.joint.binding.bindingId,
          inputDigest: String(attempt?.inputDigest),
          outcome: 'succeeded',
          result: { ...fixtureRef({ a: 1 }), schema: intent.resultSchema },
          externalRequests: [],
          usageRefs: [],
          references: [],
          provenance: { sourceRefs: [], producer: stateBinding, trustLabels: [] },
          completedAt: f.admission.admittedAt,
          ...patch,
        },
        usage: [],
        evidence: [],
        sourceAuthorizationRef: String(attempt?.authorizationRef),
        queryUsage: null,
        resultHandling: { kind: 'no-hook' },
      })
      forge(f, 'attempt:attempt-child-a', { state: 'running', receiptIds: [] })
      forge(f, actionRecordId(child), { state: 'running', firstReceiptId: null, resolvedReceiptId: null })
      await markUnknown(f, invocation, 'unknown-a', 'child-a')
      return { invocation, child }
    }

    it('settles the action with a receipt State holds, the attempt with it, and keeps the resolution', async () => {
      const f = await setup()
      const { invocation, child } = await receiptedUnknown(f)
      forge(f, 'attempt:attempt-child-a', { receiptIds: ['receipt-earlier'] })
      const events = f.events()
      const revision = Number(f.head(actionRecordId(child))?.revision)
      const receipt = await resolve(f, invocation, 'resolve-1', child, {
        state: 'resolved',
        selectedReceiptId: 'receipt-a',
        evidence: [MORE_EVIDENCE],
      })
      expect(f.events()).toBe(events + 1)
      expect(f.head(actionRecordId(child))?.value).toMatchObject({
        state: 'settled',
        firstReceiptId: 'receipt-a',
        resolvedReceiptId: 'receipt-a',
        ownerRef: OWNER,
      })
      expect(f.head('attempt:attempt-child-a')?.value).toMatchObject({
        state: 'settled',
        receiptIds: ['receipt-earlier', 'receipt-a'],
      })
      expect(resolutionOf(f)?.value).toMatchObject({
        previousReceiptIds: ['receipt-earlier'],
        state: 'resolved',
        selectedReceiptId: 'receipt-a',
        evidenceRefs: [EVIDENCE, MORE_EVIDENCE],
        nextCheckAt: null,
      })
      expect(f.head('attempt:attempt-child-b')?.value.state).toBe('dispatching')
      const writes = f.writes()
      expect(
        await resolve(f, invocation, 'resolve-1', child, {
          expectedActionRevision: revision,
          state: 'resolved',
          selectedReceiptId: 'receipt-a',
          evidence: [MORE_EVIDENCE],
        }),
      ).toEqual(receipt)
      expect(f.writes()).toBe(writes)
      await expect(resolve(f, invocation, 'resolve-2', child)).rejects.toMatchObject({
        failure: { detailCode: 'action_state' },
      })
    })
    it('refuses a receipt of another action or attempt and an unknown-effect receipt, writing nothing', async () => {
      const f = await setup()
      const { invocation, child } = await receiptedUnknown(f, { outcome: 'unknown_effect' })
      const writes = f.writes()
      const chosen = { state: 'resolved', selectedReceiptId: 'receipt-a' }
      await expect(resolve(f, invocation, 'resolve-1', child, chosen)).rejects.toMatchObject({
        failure: { detailCode: 'receipt_conflict' },
      })
      expect(f.writes()).toBe(writes)
      const g = await setup()
      const other = await receiptedUnknown(g)
      forge(g, 'receipt:receipt-a', {
        receipt: { ...g.head('receipt:receipt-a')?.value.receipt, actionId: childId(g, 'child-b') },
      })
      await expect(resolve(g, other.invocation, 'resolve-1', other.child, chosen)).rejects.toMatchObject({
        failure: { detailCode: 'receipt_conflict' },
      })
      forge(g, 'receipt:receipt-a', {
        receipt: {
          ...g.head('receipt:receipt-a')?.value.receipt,
          actionId: other.child,
          attemptId: 'attempt-child-b',
        },
      })
      await expect(resolve(g, other.invocation, 'resolve-2', other.child, chosen)).rejects.toMatchObject({
        failure: { detailCode: 'receipt_conflict' },
      })
    })
  })
})
