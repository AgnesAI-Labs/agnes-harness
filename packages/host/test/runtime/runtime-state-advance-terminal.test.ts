import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CommitGuard, canonicalJsonDigest, type PreparedAction } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import {
  actionRecordId,
  referenceRecordId,
  stableId,
  timerRecordId,
  waitRecordId,
} from '../../src/runtime/state/records.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureHash, fixtureRef } from './fixtures/assembly-maintenance-wire.js'

type Joint = Awaited<ReturnType<typeof openJointAdmission>>
type Owner = { requireSession(sessionId: string): Promise<unknown> }

const directories: string[] = []
const joints: Joint[] = []
afterEach(async () => {
  for (const joint of joints.splice(0)) await joint.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const CODEC = { namespace: 'agh.default/model-infer', codecVersion: '1' }
const SIGNALS = { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] }

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-advance-terminal-'))
  directories.push(directory)
  const input = admissionFixtureInput()
  const release = input.fixture.previousRelease
  if (!release) throw Error('locked release missing')
  const modelProvider = release.bindings.find((row) => row.binding.contract === 'agh.model')
  const leafProvider = release.bindings.find((row) => row.binding.contract === 'agh.model-adapter')
  const toolProvider = release.bindings.find((row) => row.binding.contract === 'agh.tools')
  const infer = modelProvider?.descriptor.operations.find((row) => row.method === 'infer')
  const invoke = leafProvider?.descriptor.operations.find((row) => row.method === 'invoke')
  const toolInvoke = toolProvider?.descriptor.operations.find((row) => row.method === 'invoke')
  if (!modelProvider || !leafProvider || !toolProvider || !infer || !invoke || !toolInvoke)
    throw Error('fixture providers missing')
  modelProvider.descriptor.stateCodecs = [{ ...CODEC, schema: modelProvider.descriptor.configSchema }]
  modelProvider.codecRefs = modelProvider.descriptor.stateCodecs
  const { releaseSetId: _before, ...resealed } = release
  release.releaseSetId = fixtureHash(resealed)
  const joint = await openJointAdmission(directory, input)
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
  const action = (key: string, provider: typeof modelProvider, method: string, schemas: typeof infer) => {
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
  const tool = (key: string) => action(key, toolProvider, 'invoke', toolInvoke)
  const parentIntent = action('parent', modelProvider, 'infer', infer)
  const childIntent = action('child', leafProvider, 'invoke', invoke)
  const continuation = (marker: string) => ({
    namespace: CODEC.namespace,
    codecVersion: CODEC.codecVersion,
    data: fixtureRef({ marker }),
    provenance: { sourceRefs: [], producer: modelProvider.binding, trustLabels: [] },
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
  const runHead = () => head(`run:${runId}`)
  const idOf = (key: string) => stableId('act', `${runId}\0${key}`)
  /** Overwrites fields of a record head in place, to put an action in a state no command reaches yet. */
  const edit = (recordId: string, patch: Record<string, unknown>) => {
    const row = head(recordId)
    if (!row) throw Error(`no record ${recordId}`)
    joint.db
      .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
      .run(JSON.stringify({ ...row.value, ...patch }), recordId, row.revision)
  }
  /** Marks a submitted action detached (State accepts only mandatory submissions today) with an optional owner. */
  const detach = (key: string, ownerRef?: { kind: string; id: string }) => {
    const row = head(actionRecordId(idOf(key)))
    if (!row) throw Error(`no action ${key}`)
    edit(actionRecordId(idOf(key)), {
      intent: { ...row.value.intent, obligation: 'detached' },
      ...(ownerRef ? { ownerRef } : {}),
    })
  }
  const stateBinding = {
    bindingId: joint.binding.bindingId,
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture-state',
  }
  /** Dispatches a top-level action and settles it with a real receipt, which publishes a signal for the run. */
  async function settle(
    actionId: string,
    intent: PreparedAction,
    invocationId: string,
    tag: string,
    runRevision: number,
  ) {
    const admitted = await joint.state.dispatchAdmission({
      admissionId: `admit-${tag}`,
      commitId: `dispatch-${tag}`,
      guard: guardFor(invocationId, runRevision),
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
    if (admitted.state !== 'admitted') throw Error('dispatch was refused')
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
  function runSignals() {
    return joint.db
      .prepare(
        "SELECT json_extract(b.value_json,'$.signal.signalId') AS id FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id LIKE 'signal:%' AND json_extract(b.value_json,'$.signal.targetActionId') IS NULL ORDER BY json_extract(b.value_json,'$.signal.seq')",
      )
      .all()
      .map((row) => String(row.id))
  }
  /** An open prepared invocation for the next run-level step; a refused step leaves it open for the retry. */
  let open: string | null = null
  const prime = async () => {
    open ??= await prepared(null, Number(runHead()?.value.revision))
    return open
  }
  /** One run-level step; the run revision moves by one when it succeeds. */
  const step = async (
    commitId: string,
    transition: {
      actions?: PreparedAction[]
      consume?: string[]
      next?: unknown
      conversation?: unknown[]
    },
  ) => {
    const revision = Number(runHead()?.value.revision)
    const invocation = await prime()
    const receipt = await joint.state.advanceRun({
      commitId,
      guard: guardFor(invocation, revision),
      transition: {
        expectedRevision: revision,
        continuation: continuation(commitId),
        consumeSignals: transition.consume ?? [],
        actions: transition.actions ?? [],
        next: (transition.next ?? { kind: 'continue' }) as never,
        ...(transition.conversation ? { conversation: transition.conversation as never } : {}),
      },
    })
    open = null
    return receipt
  }
  const first = await step('loop-step', {
    actions: [tool('job'), tool('later'), tool('detached')],
  })
  return {
    directory,
    input,
    joint,
    admission,
    authority,
    first,
    step,
    prime,
    prepared,
    guardFor,
    settle,
    head,
    runHead,
    writes,
    events,
    edit,
    detach,
    idOf,
    tool,
    parentIntent,
    childIntent,
    runSignals,
    runId,
    continuation,
  }
}

const refusal = (detailCode: string) => ({ failure: { detailCode } })

describe('advanceRun wait', () => {
  it('parks the run on a wait record in one commit and leaves the conversation empty', async () => {
    const f = await setup()
    await f.step('idle', {})
    const idle = () => f.head(`run-quota:${f.runId}`)?.value.noProgressTransitions
    expect(idle()).toBe(1)
    await f.prime()
    const before = f.events()
    const receipt = await f.step('wait-1', { next: { kind: 'wait', condition: SIGNALS } })
    expect(idle()).toBe(0)
    expect(f.events()).toBe(before + 1)
    const waitId = stableId('wait', receipt.commitId)
    expect(receipt.runRevision).toBe(3)
    expect(f.runHead()?.value).toMatchObject({ state: 'waiting', waitId, revision: 3, terminal: null })
    expect(f.head(waitRecordId(waitId))).toMatchObject({
      revision: 1,
      value: {
        waitId,
        runId: f.runId,
        targetActionId: null,
        condition: SIGNALS,
        registeredByCommitId: receipt.commitId,
        state: 'waiting',
        matchedSignalIds: [],
        deadlineSignalId: null,
      },
    })
    expect(f.head(timerRecordId(stableId('timer', receipt.commitId)))).toBeUndefined()
  })
  it('records a timer for a deadline wait and does not fire it', async () => {
    const f = await setup()
    const condition = { anyOf: SIGNALS.anyOf, deadline: '2026-12-01T00:00:00Z' }
    const receipt = await f.step('wait-1', { next: { kind: 'wait', condition } })
    const waitId = stableId('wait', receipt.commitId)
    const timerId = stableId('timer', receipt.commitId)
    expect(f.head(timerRecordId(timerId))).toMatchObject({
      revision: 1,
      value: {
        timerId,
        runId: f.runId,
        targetActionId: null,
        waitId,
        dueAt: condition.deadline,
        state: 'scheduled',
        registeredByCommitId: receipt.commitId,
        firedByCommitId: null,
      },
    })
    expect(f.head(waitRecordId(waitId))?.value.condition).toEqual(condition)
  })
  it('accepts a wait on an action of the same batch or an earlier one, and refuses any other action', async () => {
    const f = await setup()
    await f.prime()
    const writes = f.writes()
    await expect(
      f.step('wait-bad-key', {
        next: {
          kind: 'wait',
          condition: {
            anyOf: [
              { kind: 'actions', mode: 'all', actions: [{ localKey: 'nobody' }], readyWhen: 'receipt' },
            ],
          },
        },
      }),
    ).rejects.toMatchObject(refusal('wait_action_unknown'))
    await expect(
      f.step('wait-bad-id', {
        next: {
          kind: 'wait',
          condition: {
            anyOf: [
              { kind: 'actions', mode: 'any', actions: [{ existingActionId: 'x' }], readyWhen: 'receipt' },
            ],
          },
        },
      }),
    ).rejects.toMatchObject(refusal('wait_action_unknown'))
    expect(f.writes()).toBe(writes)
    expect(f.runHead()?.value.state).toBe('admitted')
    await f.step('wait-ok', {
      actions: [f.tool('fresh')],
      next: {
        kind: 'wait',
        condition: {
          anyOf: [
            {
              kind: 'actions',
              mode: 'all',
              actions: [{ localKey: 'fresh' }, { localKey: 'job' }, { existingActionId: f.idOf('later') }],
              readyWhen: 'receipt',
            },
          ],
        },
      },
    })
    expect(f.runHead()?.value.state).toBe('waiting')
    expect(f.head(actionRecordId(f.idOf('fresh')))).toBeDefined()
  })
  it('resumes a waiting run only on a consumed signal, closes the wait and cancels its timer', async () => {
    const f = await setup()
    const parked = await f.step('wait-1', {
      next: { kind: 'wait', condition: { anyOf: SIGNALS.anyOf, deadline: '2026-12-01T00:00:00Z' } },
    })
    const waitId = stableId('wait', parked.commitId)
    const timerId = stableId('timer', parked.commitId)
    await f.settle(f.idOf('job'), f.tool('job'), 'invocation-2', 'job', 2)
    const [signal] = f.runSignals()
    if (!signal) throw Error('the receipt published no run signal')
    const snapshot = () => [f.runHead(), f.head(waitRecordId(waitId)), f.head(timerRecordId(timerId))]
    const before = snapshot()
    await expect(f.step('resume-none', {})).rejects.toMatchObject(refusal('wait_not_satisfied'))
    await expect(f.step('resume-bad', { consume: ['no-such-signal'] })).rejects.toMatchObject(
      refusal('signal_absent'),
    )
    expect(snapshot()).toEqual(before)
    const resumed = await f.step('resume', { consume: [signal] })
    expect(f.runHead()?.value).toMatchObject({ state: 'runnable', waitId: null, revision: 3 })
    expect(f.head(waitRecordId(waitId))).toMatchObject({
      revision: 2,
      value: { state: 'ready', matchedSignalIds: [signal] },
    })
    expect(f.head(timerRecordId(timerId))).toMatchObject({ revision: 2, value: { state: 'cancelled' } })
    expect(f.head(`signal:${signal}`)?.value.consumedByCommitId).toBe(resumed.commitId)
  })
  it('replays the same commit without a new write', async () => {
    const f = await setup()
    const invocation = await f.prepared(null, 1)
    const request = {
      commitId: 'wait-1',
      guard: f.guardFor(invocation, 1),
      transition: {
        expectedRevision: 1,
        continuation: f.continuation('wait-1'),
        consumeSignals: [],
        actions: [],
        next: { kind: 'wait' as const, condition: SIGNALS as never },
      },
    }
    const firstReceipt = await f.joint.state.advanceRun(request)
    const writes = f.writes()
    expect(await f.joint.state.advanceRun(request)).toEqual(firstReceipt)
    expect(f.writes()).toBe(writes)
  })
})

describe('advanceRun complete', () => {
  const output = fixtureRef({ answer: 1 })
  const complete = (references: unknown[] = []) => ({ kind: 'complete', output, references })
  const pin = (pinId: string) => ({
    kind: 'blob',
    authorityId: 'fixture-authority',
    resourceId: `blob-${pinId}`,
    version: '1',
    digest: fixtureHash({ pinId }),
    pinId,
  })

  it('refuses in the supervisor order and writes nothing until every condition holds', async () => {
    const f = await setup()
    // An open composite parent with an open child, next to two prepared mandatory actions and one detached.
    await f.step('more', { actions: [f.parentIntent] })
    const parent = f.idOf('parent')
    const started = await f.joint.state.commitControl({
      commitId: 'start-1',
      guard: f.guardFor(await f.prepared(parent, 2), 2),
      command: {
        kind: 'start_composite',
        actionId: parent,
        expectedActionRevision: 1,
        attemptId: 'attempt-1',
      },
    })
    expect(started.runRevision).toBe(2)
    const advanced = await f.joint.state.advanceProvider({
      commitId: 'child-1',
      guard: f.guardFor(await f.prepared(parent, 2), 2),
      actionId: parent,
      expectedProviderRevision: 0,
      transition: {
        expectedProviderRevision: 0,
        continuation: f.continuation('child-1'),
        consumeSignals: [],
        children: [f.childIntent],
        next: { kind: 'continue' },
      },
    })
    const childId = stableId('act', `${f.runId}\0${parent}\0child`)
    expect(advanced.actionIds).toEqual([{ key: 'child', actionId: childId }])
    const refused = async (detailCode: string, actions: PreparedAction[] = []) => {
      await f.prime()
      const writes = f.writes()
      await expect(f.step(`try-${detailCode}`, { actions, next: complete() })).rejects.toMatchObject(
        refusal(detailCode),
      )
      expect(f.writes()).toBe(writes)
      expect(f.runHead()?.value).toMatchObject({ state: 'admitted', terminal: null, revision: 2 })
    }
    f.edit(actionRecordId(f.idOf('job')), { state: 'unknown' })
    await refused('complete_new_actions', [f.tool('extra')])
    await refused('complete_unknown')
    f.edit(actionRecordId(f.idOf('job')), { state: 'settled' })
    await refused('complete_children')
    f.edit(actionRecordId(childId), { state: 'settled' })
    f.edit(actionRecordId(parent), { state: 'settled' })
    await refused('complete_pending')
    f.edit(actionRecordId(f.idOf('later')), { state: 'settled' })
    f.detach('detached')
    await refused('detached_owner_missing')
    f.detach('detached', { kind: 'job', id: 'job-1' })
    await f.step('done', { next: complete() })
    expect(f.runHead()?.value).toMatchObject({
      state: 'succeeded',
      waitId: null,
      revision: 3,
      terminal: {
        outcome: 'succeeded',
        output,
        references: [],
        error: null,
        unknownActionIds: [],
        detachedOwnerRefs: [{ kind: 'job', id: 'job-1' }],
      },
    })
  })
  it('completes a waiting run that consumed its signal, with a reference record per pin, and survives a cold reopen', async () => {
    const f = await setup()
    await f.step('wait-1', { next: { kind: 'wait', condition: SIGNALS } })
    const invocation = 'invocation-2'
    await f.settle(f.idOf('job'), f.tool('job'), invocation, 'job', 2)
    await f.settle(f.idOf('later'), f.tool('later'), invocation, 'later', 2)
    await f.settle(f.idOf('detached'), f.tool('detached'), invocation, 'detached', 2)
    const [signal] = f.runSignals()
    if (!signal) throw Error('no run signal')
    const references = [pin('pin-a'), pin('pin-b')]
    await expect(
      f.step('dup', { consume: [signal], next: complete([pin('x'), pin('x')]) }),
    ).rejects.toMatchObject(refusal('reference_duplicate'))
    expect(f.runHead()?.value.state).toBe('waiting')
    const done = await f.step('done', { consume: [signal], next: complete(references) })
    const terminal = f.runHead()?.value.terminal
    expect(f.runHead()?.value).toMatchObject({ state: 'succeeded', waitId: null, revision: 3 })
    expect(terminal.references).toEqual(references)
    const refId = stableId('ref', `${f.runId}\0pin-a`)
    expect(f.head(referenceRecordId(refId))).toMatchObject({
      revision: 1,
      value: {
        referenceId: refId,
        sourceRecordId: `run:${f.runId}`,
        status: 'pending',
        target: { kind: 'retained', retention: references[0] },
      },
    })
    const runBefore = f.runHead()
    await f.joint.close()
    joints.splice(joints.indexOf(f.joint), 1)
    const again = await openJointAdmission(f.directory, f.input)
    joints.push(again)
    await expect(
      (again.state as unknown as Owner).requireSession(f.admission.sessionId),
    ).resolves.toBeDefined()
    const row = again.db
      .prepare(
        'SELECT b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
      )
      .get(`run:${f.runId}`)
    expect(JSON.parse(String(row?.value_json))).toEqual(runBefore?.value)
    expect(done.runRevision).toBe(3)
  })
  it('still refuses a conversation contribution', async () => {
    const f = await setup()
    await expect(
      f.step('talk', { conversation: [{ role: 'assistant' }], next: complete() }),
    ).rejects.toMatchObject({ failure: { code: 'internal', detailCode: 'unsupported' } })
    expect(f.runHead()?.value.state).toBe('admitted')
  })
  it('refuses a second terminal step once the run has succeeded', async () => {
    const f = await setup()
    f.edit(actionRecordId(f.idOf('job')), { state: 'settled' })
    f.edit(actionRecordId(f.idOf('later')), { state: 'settled' })
    f.edit(actionRecordId(f.idOf('detached')), { state: 'settled' })
    await f.step('done', { next: complete() })
    for (const next of [{ kind: 'wait', condition: SIGNALS }, complete()]) {
      await expect(f.step(`again-${next.kind}`, { next })).rejects.toMatchObject(refusal('run_state'))
    }
    expect(f.runHead()?.value).toMatchObject({ state: 'succeeded', revision: 2 })
  })
})

describe('advanceRun fail', () => {
  const error = {
    code: 'internal',
    detailCode: 'loop_failed',
    message: 'the loop gave up',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'diagnostic-1',
  }
  it('puts the run in failing with a cancellation and a terminal candidate, and finalizes nothing', async () => {
    const f = await setup()
    f.edit(actionRecordId(f.idOf('job')), { state: 'unknown' })
    f.detach('detached', { kind: 'job', id: 'job-1' })
    await f.prime()
    const writes = f.writes()
    await expect(
      f.step('fail-actions', { actions: [f.tool('extra')], next: { kind: 'fail', error } }),
    ).rejects.toMatchObject(refusal('fail_new_actions'))
    expect(f.writes()).toBe(writes)
    const receipt = await f.step('fail-1', { next: { kind: 'fail', error } })
    expect(receipt.runRevision).toBe(2)
    expect(f.runHead()?.value).toMatchObject({
      state: 'failing',
      waitId: null,
      cancellation: { reason: 'loop_failed', by: 'writer' },
      terminal: {
        outcome: 'failed',
        output: null,
        references: [],
        error,
        unknownActionIds: [f.idOf('job')],
        detachedOwnerRefs: [{ kind: 'job', id: 'job-1' }],
      },
    })
    for (const next of [
      { kind: 'wait', condition: SIGNALS },
      { kind: 'fail', error },
    ]) {
      await expect(f.step(`after-${next.kind}`, { next })).rejects.toMatchObject(refusal('run_state'))
    }
    expect(f.runHead()?.value.state).toBe('failing')
  })
  it('fails a waiting run without a signal and cancels its wait and timer', async () => {
    const f = await setup()
    const parked = await f.step('wait-1', {
      next: { kind: 'wait', condition: { anyOf: SIGNALS.anyOf, deadline: '2026-12-01T00:00:00Z' } },
    })
    await f.step('fail-1', { next: { kind: 'fail', error } })
    expect(f.runHead()?.value).toMatchObject({ state: 'failing', waitId: null })
    expect(f.head(waitRecordId(stableId('wait', parked.commitId)))?.value).toMatchObject({
      state: 'cancelled',
      matchedSignalIds: [],
    })
    expect(f.head(timerRecordId(stableId('timer', parked.commitId)))?.value.state).toBe('cancelled')
  })
  it('refuses a wait or a completion on a cancelled run', async () => {
    const f = await setup()
    f.edit(`run:${f.runId}`, {
      cancellation: { reason: 'stop', requestedAt: '2026-10-01T00:00:00Z', by: 'user' },
    })
    for (const next of [
      { kind: 'wait', condition: SIGNALS },
      { kind: 'complete', output: fixtureRef({}), references: [] },
    ]) {
      await expect(f.step(`cancelled-${next.kind}`, { next })).rejects.toMatchObject(refusal('run_cancelled'))
    }
  })
})

describe('the State store facade', () => {
  it('takes a wait, a completion and a failure through request validation', async () => {
    const f = await setup()
    const call = f.joint.context()
    const invocation = await f.prime()
    const request = (next: unknown) => ({
      commitId: 'facade-1',
      guard: f.guardFor(invocation, 1),
      transition: {
        expectedRevision: 1,
        continuation: f.continuation('facade'),
        consumeSignals: [],
        actions: [],
        next,
      },
    })
    const malformed = await f.joint.store.advanceRun(
      request({ kind: 'wait', condition: { anyOf: 'nothing' } }) as never,
      call,
    )
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_input', detailCode: 'schema' } })
    expect(f.runHead()?.value.revision).toBe(1)
    const accepted = await f.joint.store.advanceRun(
      request({ kind: 'wait', condition: SIGNALS }) as never,
      call,
    )
    expect(accepted.ok).toBe(true)
    expect(f.runHead()?.value).toMatchObject({ state: 'waiting', revision: 2 })
  })
})
