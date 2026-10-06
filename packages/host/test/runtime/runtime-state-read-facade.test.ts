import { rmSync } from 'node:fs'
import {
  type CommitGuard,
  canonicalJsonDigest,
  type PreparedAction,
  RuntimeSchemaRefs,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createStateQueryService, readGuardOf } from '../../src/runtime/state/query-service.js'
import { DEFAULT_READABLE } from '../../src/runtime/state/read-scope.js'
import { actionIdOf, actionRecordId, stableId, waitRecordId } from '../../src/runtime/state/records.js'
import { fixtureHash, fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import {
  actionScope,
  callerWith,
  FIXTURE_RUN,
  FIXTURE_SESSION,
  runScope,
  sessionScope,
} from './fixtures/state-query-fixture.js'

const CODEC = { namespace: 'agh.default/model-infer', codecVersion: '1' }
const SIGNALS = { anyOf: [{ kind: 'signals', typeIds: ['agh.runtime/action-completed@1'], afterSeq: 0 }] }
const deadline = '2027-01-01T00:00:00Z'

async function world(options: { secondLoop?: boolean } = {}) {
  let loopBinding: unknown
  let leaf: { schemas: { inputSchema: unknown; outputSchema: unknown }; binding: unknown } | undefined
  let model: { schemas: { inputSchema: unknown; outputSchema: unknown }; binding: unknown } | undefined
  let tool: { schemas: { inputSchema: unknown; outputSchema: unknown }; binding: unknown } | undefined
  const native = await originalNativeFixture({
    prepare(input) {
      const release = input.fixture.previousRelease
      if (!release) throw Error('locked release missing')
      const providers = release.bindings
      const modelProvider = providers.find((row) => row.binding.contract === 'agh.model')
      const leafProvider = providers.find((row) => row.binding.contract === 'agh.model-adapter')
      const toolProvider = providers.find((row) => row.binding.contract === 'agh.tools')
      const infer = modelProvider?.descriptor.operations.find((row) => row.method === 'infer')
      const invoke = leafProvider?.descriptor.operations.find((row) => row.method === 'invoke')
      const toolInvoke = toolProvider?.descriptor.operations.find((row) => row.method === 'invoke')
      if (!modelProvider || !leafProvider || !toolProvider || !infer || !invoke || !toolInvoke)
        throw Error('fixture providers missing')
      modelProvider.descriptor.stateCodecs = [{ ...CODEC, schema: modelProvider.descriptor.configSchema }]
      modelProvider.codecRefs = modelProvider.descriptor.stateCodecs
      model = { schemas: infer, binding: modelProvider.binding }
      leaf = { schemas: invoke, binding: leafProvider.binding }
      tool = { schemas: toolInvoke, binding: toolProvider.binding }
      loopBinding = providers.find((row) => row.binding.contract === 'agh.loop')?.binding
      if (!loopBinding) throw Error('fixture loop provider missing')
      if (options.secondLoop) {
        const second = structuredClone(toolProvider)
        second.binding = {
          ...second.binding,
          contract: 'agh.loop',
          logicalName: 'loop-2',
          providerId: 'fixture-loop-2',
        }
        providers.push(second)
      }
      const { releaseSetId: _before, ...resealed } = release
      release.releaseSetId = fixtureHash(resealed)
    },
  })
  const { state } = native.fixture
  const created = await native.fixture.coordinator.coordinate(
    native.fixture.draft(),
    native.fixture.context(),
  )
  if (!(created.ok && created.value.state === 'created')) throw Error('run was not created')
  const opened = await state.open({
    requestId: 'writer',
    authority: native.authority,
    sessionId: FIXTURE_SESSION,
    mode: 'write',
    writerId: 'writer',
    ttlMs: 600000,
  })
  if (!opened.claim) throw Error('writer was not opened')
  const writerEpoch = opened.claim.writerEpoch
  const bindingId = native.fixture.binding.bindingId
  if (!model || !leaf || !tool) throw Error('fixture providers missing')
  const intent = (key: string, from: NonNullable<typeof tool>, method: string): PreparedAction => {
    const body = {
      key,
      target: from.binding,
      method,
      input: { ...fixtureRef({ key }), schema: from.schemas.inputSchema },
      dependencies: [],
      retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
      obligation: 'mandatory' as const,
      deadline,
      resultSchema: from.schemas.outputSchema,
      references: [],
    }
    return { ...body, intentFingerprint: fixtureHash(body) } as PreparedAction
  }
  const continuation = (marker: string) => ({
    namespace: CODEC.namespace,
    codecVersion: CODEC.codecVersion,
    data: fixtureRef({ marker }),
    provenance: { sourceRefs: [], producer: model?.binding as never, trustLabels: [] },
    createdAt: native.input.fixture.now,
    references: [],
  })
  let counter = 0
  const guardFor = (invocationId: string, runRevision: number, readGuards: CommitGuard['readGuards'] = []) =>
    ({
      authority: native.authority,
      sessionId: FIXTURE_SESSION,
      runId: FIXTURE_RUN,
      writerId: 'writer',
      writerEpoch,
      expectedRunRevision: runRevision,
      bindingId,
      invocationId,
      readGuards,
      queryUsage: null,
    }) as CommitGuard
  async function prepared(
    targetActionId: string | null,
    runRevision: number,
    readGuards: CommitGuard['readGuards'] = [],
    baseRevision = runRevision,
  ) {
    const invocationId = `invocation-${++counter}`
    await state.admitInvocation({
      requestId: `admit-${counter}`,
      runId: FIXTURE_RUN,
      targetActionId,
      baseRevision,
      bindingId,
      writerEpoch,
      invocationId,
      deadline,
      queryAllowance: 0,
    })
    await state.closeInvocation({
      requestId: `close-${counter}`,
      invocationId,
      state: 'prepared',
      readGuards: [...readGuards],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    return invocationId
  }
  const stateBinding = {
    bindingId,
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture-state',
  }
  /** Dispatches a top-level or child action and settles it with a real receipt, which publishes a signal. */
  async function settle(
    actionId: string,
    action: PreparedAction,
    invocationId: string,
    tag: string,
    runRevision: number,
  ) {
    const admitted = await state.dispatchAdmission({
      admissionId: `admit-${tag}`,
      commitId: `dispatch-${tag}`,
      guard: guardFor(invocationId, runRevision),
      atomicDomain: {
        domainId: 'fixture-domain',
        revision: 1,
        stateAuthority: native.authority,
        budgetAuthority: native.authority,
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
        requestDigest: canonicalJsonDigest(action.input),
      },
      budget: { reservation: null, quota: [] },
      deadline,
    })
    if (admitted.state !== 'admitted') throw Error('dispatch was refused')
    await state.intakeReceipt({
      intakeId: `intake-${tag}`,
      receipt: {
        receiptId: `receipt-${tag}`,
        actionId,
        attemptId: `attempt-${tag}`,
        bindingId,
        inputDigest: canonicalJsonDigest(action.input),
        outcome: 'succeeded',
        result: { ...fixtureRef({ tag }), schema: action.resultSchema },
        externalRequests: [],
        usageRefs: [],
        references: [],
        provenance: { sourceRefs: [], producer: stateBinding, trustLabels: [] },
        completedAt: native.input.fixture.now,
      },
      usage: [],
      evidence: [],
      sourceAuthorizationRef: admitted.authorizationId,
      queryUsage: null,
      resultHandling: { kind: 'no-hook' },
    })
  }
  const jobs = ['job-a', 'job-b', 'job-c'].map((key) =>
    intent(key, tool as NonNullable<typeof tool>, 'invoke'),
  )
  const parent = intent('parent', model, 'infer')
  const child = intent('child', leaf, 'invoke')
  // The Loop step: three tool actions and one composite parent (run revision 0 -> 1).
  const loopInvocation = await prepared(null, 0)
  await state.advanceRun({
    commitId: 'loop-step',
    guard: guardFor(loopInvocation, 0),
    transition: {
      expectedRevision: 0,
      continuation: continuation('loop'),
      consumeSignals: [],
      actions: [...jobs, parent],
      next: { kind: 'continue' },
    },
  })
  const parentId = actionIdOf(FIXTURE_RUN, null, 'parent')
  // The parent starts, parks on a wait with one child (provider revision 0 -> 1, run revision stays 1).
  await state.commitControl({
    commitId: 'start-1',
    guard: guardFor(await prepared(parentId, 1), 1),
    command: {
      kind: 'start_composite',
      actionId: parentId,
      expectedActionRevision: 1,
      attemptId: 'attempt-p',
    },
  })
  const parkInvocation = await prepared(parentId, 1, [], 0)
  const parked = await state.advanceProvider({
    commitId: 'park-1',
    guard: guardFor(parkInvocation, 1),
    actionId: parentId,
    expectedProviderRevision: 0,
    transition: {
      expectedProviderRevision: 0,
      continuation: continuation('park'),
      consumeSignals: [],
      children: [child],
      next: { kind: 'wait', condition: SIGNALS as never },
    },
  })
  const childId = actionIdOf(FIXTURE_RUN, parentId, 'child')
  const service = createStateQueryService({
    owner: native.reader,
    bridge: native.bridge,
    authority: native.authority,
    now: native.now,
  })
  const { reader } = service
  const writes = () => Number(native.fixture.db.prepare('SELECT total_changes() AS n').get()?.n)
  async function open(caller = callerWith(native, sessionScope(native))) {
    const snapshot = await reader.open(caller, null)
    if (!snapshot.ok) throw Error(`open failed ${JSON.stringify(snapshot.error)}`)
    return snapshot.value
  }
  return {
    native,
    service,
    reader,
    state,
    writes,
    open,
    prepared,
    guardFor,
    settle,
    continuation,
    parentId,
    childId,
    parent,
    child,
    jobs,
    parked,
    loopBinding,
    waitId: stableId('wait', parked.commitId),
    jobId: (index: number) => actionIdOf(FIXTURE_RUN, null, `job-${'abc'[index]}`),
    async close() {
      await service.close()
      await native.reader.close()
      native.identity.close()
      await native.fixture.close()
      rmSync(native.directory, { recursive: true, force: true })
    },
  }
}

async function within(
  body: (w: Awaited<ReturnType<typeof world>>) => Promise<void>,
  options: { secondLoop?: boolean } = {},
) {
  const w = await world(options)
  try {
    await body(w)
  } finally {
    await w.close()
  }
}
const run = (w: Awaited<ReturnType<typeof world>>) => callerWith(w.native, runScope(w.native))
const session = (w: Awaited<ReturnType<typeof world>>) => callerWith(w.native, sessionScope(w.native))
const action = (w: Awaited<ReturnType<typeof world>>, actionId: string) =>
  callerWith(w.native, actionScope(w.native, actionId))
function value<T>(outcome: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) throw Error(JSON.stringify(outcome.error))
  return outcome.value
}

describe.skipIf(typeof process.getuid !== 'function')('State read facade for the supervisor', () => {
  it('derives the action id exactly as State does', async () => {
    await within(async (w) => {
      expect(actionIdOf('r', null, 'k')).toBe(stableId('act', 'r\0k'))
      expect(actionIdOf('r', 'p', 'k')).toBe(stableId('act', 'r\0p\0k'))
      expect(actionIdOf('r', null, 'k')).not.toBe(actionIdOf('r', 'p', 'k'))
      const snapshot = await w.open()
      const read = value(await w.reader.getAction(session(w), snapshot, w.jobId(0)))
      expect(read?.stored.value).toMatchObject({ actionId: w.jobId(0), key: 'job-a', parentActionId: null })
    })
  })

  it('reads an action by run, parent and key, and treats a wrong namespace as absent', async () => {
    await within(async (w) => {
      const snapshot = await w.open()
      const base = session(w)
      const byKey = async (parentActionId: string | null, key: string, caller = base) =>
        w.reader.getActionByKey(
          caller,
          caller === base ? snapshot : await w.open(caller),
          { runId: FIXTURE_RUN, parentActionId },
          key,
        )
      const job = value(await byKey(null, 'job-b'))
      expect(job?.stored.value).toMatchObject({ actionId: w.jobId(1), key: 'job-b' })
      expect(value(await byKey(null, 'parent'))?.stored.value).toMatchObject({ actionId: w.parentId })
      expect(value(await byKey(w.parentId, 'child'))?.stored.value).toMatchObject({
        actionId: w.childId,
        parentActionId: w.parentId,
      })
      expect(value(await byKey(null, 'child'))).toBeNull()
      expect(value(await byKey(w.parentId, 'job-a'))).toBeNull()
      expect(value(await byKey(null, 'nobody'))).toBeNull()
      expect(
        value(
          await w.reader.getActionByKey(
            session(w),
            snapshot,
            { runId: 'other-run', parentActionId: null },
            'job-a',
          ),
        ),
      ).toBeNull()
      const asRun = run(w)
      expect(
        value(
          await w.reader.getActionByKey(
            asRun,
            await w.open(asRun),
            { runId: FIXTURE_RUN, parentActionId: null },
            'parent',
          ),
        )?.stored.value,
      ).toMatchObject({ actionId: w.parentId })
      // An action caller sees its own action and nothing else, and the refusal does not tell which.
      const own = action(w, w.parentId)
      expect(value(await byKey(null, 'parent', own))?.stored.value).toMatchObject({ actionId: w.parentId })
      expect(value(await byKey(null, 'job-a', own))).toBeNull()
      expect(value(await byKey(null, 'nobody', own))).toBeNull()
      const bad = await w.reader.getActionByKey(
        session(w),
        snapshot,
        { runId: 7 as never, parentActionId: null },
        'k',
      )
      expect(bad).toMatchObject({ ok: false, error: { detailCode: 'state_request' } })
    })
  })

  it('reads a wait record inside the window of its target', async () => {
    await within(async (w) => {
      expect(DEFAULT_READABLE.some((entry) => entry.kind === 'wait')).toBe(true)
      const snapshot = await w.open()
      const read = value(await w.reader.getWait(session(w), snapshot, w.waitId))
      expect(read?.stored.value).toMatchObject({
        waitId: w.waitId,
        runId: FIXTURE_RUN,
        targetActionId: w.parentId,
        state: 'waiting',
      })
      expect(read?.stored.meta.recordId).toBe(waitRecordId(w.waitId))
      const waitAs = async (caller: ReturnType<typeof run>) =>
        value(await w.reader.getWait(caller, await w.open(caller), w.waitId))
      expect(await waitAs(run(w))).not.toBeNull()
      expect(await waitAs(action(w, w.parentId))).not.toBeNull()
      expect(await waitAs(action(w, w.jobId(0)))).toBeNull()
      expect(value(await w.reader.getWait(session(w), snapshot, 'no-such-wait'))).toBeNull()
    })
  })

  it('names the Loop binding of a run from its run binding', async () => {
    await within(async (w) => {
      const snapshot = await w.open()
      expect(value(await w.reader.getLoopBinding(session(w), snapshot, FIXTURE_RUN))).toEqual(w.loopBinding)
      expect(value(await w.reader.getLoopBinding(session(w), snapshot, 'no-such-run'))).toBeNull()
    })
  })

  it('refuses a run binding that names two Loops', async () => {
    await within(
      async (w) => {
        const snapshot = await w.open()
        expect(await w.reader.getLoopBinding(session(w), snapshot, FIXTURE_RUN)).toMatchObject({
          ok: false,
          error: { code: 'incompatible', detailCode: 'state_loop_binding' },
        })
      },
      { secondLoop: true },
    )
  })

  it('pages unconsumed signals in sequence order with a high water that counts consumed ones', async () => {
    await within(async (w) => {
      const invocation = await w.prepared(null, 1)
      // Revision 1 -> 2 (a continue step), then three top-level receipts publish three run signals.
      await w.state.advanceRun({
        commitId: 'idle',
        guard: w.guardFor(invocation, 1),
        transition: {
          expectedRevision: 1,
          continuation: w.continuation('idle'),
          consumeSignals: [],
          actions: [],
          next: { kind: 'continue' },
        },
      })
      for (const [index, job] of w.jobs.entries())
        await w.settle(w.jobId(index), job, invocation, `job-${index}`, 2)
      await w.settle(w.childId, w.child, invocation, 'child', 2)
      const before = w.writes()
      const snapshot = await w.open()
      const target = { runId: FIXTURE_RUN, targetActionId: null }
      const first = value(await w.reader.signals(session(w), snapshot, target, { afterSeq: 0, limit: 2 }))
      expect(first.items.map((signal) => signal.seq)).toEqual([1, 2])
      expect(first).toMatchObject({ complete: false, signalHighWater: 3 })
      const rest = value(
        await w.reader.signals(session(w), snapshot, target, {
          afterSeq: first.items[1]?.seq ?? 0,
          limit: 2,
        }),
      )
      expect(rest.items.map((signal) => signal.seq)).toEqual([3])
      expect(rest).toMatchObject({ complete: true, signalHighWater: 3 })
      const all = value(await w.reader.signals(session(w), snapshot, target, { afterSeq: 0, limit: 3 }))
      expect(all).toMatchObject({ complete: true, signalHighWater: 3 })
      expect(
        all.items.every((signal) => signal.targetActionId === null && signal.runId === FIXTURE_RUN),
      ).toBe(true)
      const none = value(await w.reader.signals(session(w), snapshot, target, { afterSeq: 3, limit: 5 }))
      expect(none).toEqual({ items: [], complete: true, signalHighWater: 3 })
      // The signal of the child is for the parent, not for the run.
      const forParent = value(
        await w.reader.signals(
          session(w),
          snapshot,
          { runId: FIXTURE_RUN, targetActionId: w.parentId },
          { afterSeq: 0, limit: 5 },
        ),
      )
      expect(forParent.items).toHaveLength(1)
      expect(forParent.items[0]).toMatchObject({ targetActionId: w.parentId, seq: 1 })
      expect(w.writes()).toBe(before)
      w.reader.release(snapshot)
      // Consume the first signal: it leaves the unconsumed page but not the high water.
      const first1 = all.items[0]?.signalId
      if (!first1) throw Error('no signal')
      const next = await w.prepared(null, 2)
      await w.state.advanceRun({
        commitId: 'consume',
        guard: w.guardFor(next, 2),
        transition: {
          expectedRevision: 2,
          continuation: w.continuation('consume'),
          consumeSignals: [first1],
          actions: [],
          next: { kind: 'continue' },
        },
      })
      const later = await w.open()
      const afterConsume = value(await w.reader.signals(session(w), later, target, { afterSeq: 0, limit: 5 }))
      expect(afterConsume.items.map((signal) => signal.seq)).toEqual([2, 3])
      expect(afterConsume.signalHighWater).toBe(3)
    })
  })

  it('shows an action caller only the signals aimed at its own action and refuses another run', async () => {
    await within(async (w) => {
      const invocation = await w.prepared(null, 1)
      await w.settle(w.childId, w.child, invocation, 'child', 1)
      await w.settle(w.jobId(0), w.jobs[0] as PreparedAction, invocation, 'job', 1)
      const parentCaller = action(w, w.parentId)
      const snapshot = await w.open(parentCaller)
      const mine = value(
        await w.reader.signals(
          parentCaller,
          snapshot,
          { runId: FIXTURE_RUN, targetActionId: w.parentId },
          { afterSeq: 0, limit: 5 },
        ),
      )
      expect(mine.items).toHaveLength(1)
      const runLevel = value(
        await w.reader.signals(
          parentCaller,
          snapshot,
          { runId: FIXTURE_RUN, targetActionId: null },
          { afterSeq: 0, limit: 5 },
        ),
      )
      expect(runLevel).toEqual({ items: [], complete: true, signalHighWater: 0 })
      const foreign = await w.reader.signals(
        parentCaller,
        snapshot,
        { runId: 'another-run', targetActionId: null },
        { afterSeq: 0, limit: 5 },
      )
      expect(foreign).toMatchObject({ ok: false, error: { detailCode: 'state_scope' } })
    })
  })

  it('refuses malformed signal requests by name', async () => {
    await within(async (w) => {
      const snapshot = await w.open()
      const target = { runId: FIXTURE_RUN, targetActionId: null }
      for (const page of [
        { afterSeq: -1, limit: 5 },
        { afterSeq: 0, limit: 0 },
        { afterSeq: 0, limit: 501 },
        { afterSeq: 1.5, limit: 5 },
      ])
        expect(await w.reader.signals(session(w), snapshot, target, page)).toMatchObject({
          ok: false,
          error: { detailCode: 'state_request' },
        })
    })
  })

  it('builds a read guard a commit accepts while the record is unchanged and refuses once it moved', async () => {
    await within(async (w) => {
      const snapshot = await w.open()
      const recordId = actionRecordId(w.jobId(1))
      const read = value(await w.reader.getAction(session(w), snapshot, w.jobId(1)))
      const guard = readGuardOf(recordId, read)
      expect(guard).toEqual({ recordId, expectedRecordRevision: read?.stored.meta.recordRevision })
      expect(readGuardOf('action:nothing', null)).toEqual({
        recordId: 'action:nothing',
        expectedRecordRevision: null,
      })
      // Still current: the invocation prepares and a step commits under the guard.
      const fresh = await w.prepared(null, 1, [guard])
      await w.state.advanceRun({
        commitId: 'guarded',
        guard: w.guardFor(fresh, 1, [guard]),
        transition: {
          expectedRevision: 1,
          continuation: w.continuation('guarded'),
          consumeSignals: [],
          actions: [],
          next: { kind: 'continue' },
        },
      })
      // The action moves (a receipt), so the old read no longer guards anything.
      await w.settle(w.jobId(1), w.jobs[1] as PreparedAction, fresh, 'job-b', 2)
      await expect(w.prepared(null, 2, [guard])).rejects.toMatchObject({
        failure: { detailCode: 'read_guard' },
      })
    })
  })

  it('builds a guard for an absent record that holds while the record is absent', async () => {
    await within(async (w) => {
      const absent = readGuardOf(actionRecordId('act-nothing'), null)
      expect(absent.expectedRecordRevision).toBeNull()
      await expect(w.prepared(null, 1, [absent])).resolves.toBeDefined()
    })
  })

  it('reads the visibility record of a settled action receipt inside the window of its action', async () => {
    await within(async (w) => {
      expect(DEFAULT_READABLE.some((entry) => entry.kind === 'visibility')).toBe(true)
      const before = await w.open()
      expect(value(await w.reader.getActionVisibility(session(w), before, 'receipt-job'))).toBeNull()
      const invocation = await w.prepared(null, 1)
      await w.settle(w.jobId(0), w.jobs[0] as PreparedAction, invocation, 'job', 1)
      const snapshot = await w.open()
      const read = value(await w.reader.getActionVisibility(session(w), snapshot, 'receipt-job'))
      expect(read?.stored.value).toMatchObject({
        actionId: w.jobId(0),
        sourceReceiptId: 'receipt-job',
        state: 'ready',
      })
      expect(read?.stored.meta.recordId).toBe('visibility:receipt-job')
      const generic = value(
        await w.reader.get(
          session(w),
          snapshot,
          'visibility:receipt-job',
          RuntimeSchemaRefs.ActionVisibilityValue,
        ),
      )
      expect(generic?.versionDigest).toBe(read?.versionDigest)
      // The snapshot taken before the receipt still sees nothing.
      expect(value(await w.reader.getActionVisibility(session(w), before, 'receipt-job'))).toBeNull()
      const visibilityAs = async (caller: ReturnType<typeof run>) =>
        value(await w.reader.getActionVisibility(caller, await w.open(caller), 'receipt-job'))
      expect(await visibilityAs(run(w))).not.toBeNull()
      expect(await visibilityAs(action(w, w.jobId(0)))).not.toBeNull()
      expect(await visibilityAs(action(w, w.jobId(1)))).toBeNull()
      expect(await visibilityAs(action(w, w.parentId))).toBeNull()
    })
  })

  it('lists the actions of a run in every page and keeps other runs and sibling actions out', async () => {
    await within(async (w) => {
      const snapshot = await w.open()
      const ids = (read: readonly { stored: { value: { actionId: string } } }[]) =>
        read.map((row) => row.stored.value.actionId).sort()
      const all = value(await w.reader.actions(session(w), snapshot, { runId: FIXTURE_RUN }))
      expect(ids(all)).toEqual([w.jobId(0), w.jobId(1), w.jobId(2), w.parentId, w.childId].sort())
      expect(all.every((row) => row.stored.meta.recordRevision >= 1)).toBe(true)
      const top = value(
        await w.reader.actions(session(w), snapshot, { runId: FIXTURE_RUN, parentActionId: null }),
      )
      expect(ids(top)).toEqual([w.jobId(0), w.jobId(1), w.jobId(2), w.parentId].sort())
      const children = value(
        await w.reader.actions(session(w), snapshot, { runId: FIXTURE_RUN, parentActionId: w.parentId }),
      )
      expect(ids(children)).toEqual([w.childId])
      const waiting = value(
        await w.reader.actions(session(w), snapshot, { runId: FIXTURE_RUN, states: ['pending' as never] }),
      )
      expect(waiting.every((row) => row.stored.value.state === ('pending' as never))).toBe(true)
      expect(value(await w.reader.actions(session(w), snapshot, { runId: 'other-run' }))).toEqual([])
      const asRun = run(w)
      expect(ids(value(await w.reader.actions(asRun, await w.open(asRun), { runId: FIXTURE_RUN })))).toEqual(
        ids(all),
      )
      const own = action(w, w.parentId)
      expect(ids(value(await w.reader.actions(own, await w.open(own), { runId: FIXTURE_RUN })))).toEqual([
        w.parentId,
      ])
      expect(await w.reader.actions(own, await w.open(own), { runId: 'another-run' })).toMatchObject({
        ok: false,
        error: { detailCode: 'state_scope' },
      })
      expect(await w.reader.actions(session(w), snapshot, { runId: 7 as never })).toMatchObject({
        ok: false,
        error: { detailCode: 'state_request' },
      })
    })
  })

  it('lists more actions than one scan page holds', async () => {
    await within(async (w) => {
      const rebuilt = (row: PreparedAction, key: string) => {
        const { intentFingerprint: _drop, ...rest } = { ...row, key }
        return { ...rest, intentFingerprint: fixtureHash(rest) } as PreparedAction
      }
      // State accepts 64 actions per step, so eight steps make 512 more than one 500-item page.
      for (let step = 0; step < 8; step++) {
        const revision = 1 + step
        const invocation = await w.prepared(null, revision)
        await w.state.advanceRun({
          commitId: `bulk-${step}`,
          guard: w.guardFor(invocation, revision),
          transition: {
            expectedRevision: revision,
            continuation: w.continuation(`bulk-${step}`),
            consumeSignals: [],
            actions: Array.from({ length: 64 }, (_, index) =>
              rebuilt(w.jobs[0] as PreparedAction, `bulk-${step}-${index}`),
            ),
            next: { kind: 'continue' },
          },
        })
      }
      const snapshot = await w.open()
      const all = value(
        await w.reader.actions(session(w), snapshot, { runId: FIXTURE_RUN, parentActionId: null }),
      )
      expect(all).toHaveLength(4 + 512)
      expect(new Set(all.map((row) => row.stored.value.actionId)).size).toBe(4 + 512)
    })
  })

  it('writes nothing while it reads', async () => {
    await within(async (w) => {
      const snapshot = await w.open()
      const before = w.writes()
      await w.reader.getActionByKey(
        session(w),
        snapshot,
        { runId: FIXTURE_RUN, parentActionId: null },
        'job-a',
      )
      await w.reader.getWait(session(w), snapshot, w.waitId)
      await w.reader.getActionVisibility(session(w), snapshot, 'receipt-none')
      await w.reader.actions(session(w), snapshot, { runId: FIXTURE_RUN })
      await w.reader.getLoopBinding(session(w), snapshot, FIXTURE_RUN)
      await w.reader.signals(
        session(w),
        snapshot,
        { runId: FIXTURE_RUN, targetActionId: null },
        { afterSeq: 0, limit: 5 },
      )
      expect(w.writes()).toBe(before)
    })
  })
})
