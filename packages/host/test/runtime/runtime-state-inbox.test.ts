import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CommitGuard,
  canonicalJsonDigest,
  type DomainEvent,
  type PreparedAction,
  type ScopeRef,
  type SignalDelivery,
  type StateStoreControlFireTimerRequest,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { UNIMPLEMENTED_STATE_METHODS } from '../../src/runtime/providers/state.js'
import { canonicalJson } from '../../src/runtime/state/canonical-json.js'
import type { SignalSourceMapping } from '../../src/runtime/state/control.js'
import {
  type ControlVersionNote,
  createControlScan,
  finishControlScan,
  noteControlSide,
  noteControlVersion,
} from '../../src/runtime/state/control.js'
import {
  digestOf,
  inboxRecordId,
  outboxRecordId,
  serviceCommandRecordId,
  signalRecordId,
  stableId,
  timerRecordId,
  waitRecordId,
} from '../../src/runtime/state/records.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureHash, fixtureRef } from './fixtures/assembly-maintenance-wire.js'

type Joint = Awaited<ReturnType<typeof openJointAdmission>>
type Owner = { requireSession(sessionId: string): Promise<unknown> }

// Each case opens a real joint State; a loaded machine needs more than the default.
vi.setConfig({ testTimeout: 60_000 })

const directories: string[] = []
const joints: Joint[] = []
afterEach(async () => {
  for (const joint of joints.splice(0)) await joint.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const EVENT_TYPE = 'acme.events/ping@1'
const OTHER_TYPE = 'acme.events/other@1'
const CODEC = { namespace: 'agh.default/model-infer', codecVersion: '1' }
const SIGNALS = { anyOf: [{ kind: 'signals', typeIds: [EVENT_TYPE], afterSeq: 0 }] }
const refusal = (detailCode: string) => ({ failure: { detailCode } })

/** A run that is created and parked on a wait, with a clock the test moves. */
async function setup(options: { park?: boolean; deadline?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-inbox-'))
  directories.push(directory)
  const input = admissionFixtureInput()
  const release = input.fixture.previousRelease
  if (!release) throw Error('locked release missing')
  const modelProvider = release.bindings.find((row) => row.binding.contract === 'agh.model')
  const toolProvider = release.bindings.find((row) => row.binding.contract === 'agh.tools')
  const infer = modelProvider?.descriptor.operations.find((row) => row.method === 'infer')
  const toolInvoke = toolProvider?.descriptor.operations.find((row) => row.method === 'invoke')
  if (!modelProvider || !toolProvider || !infer || !toolInvoke) throw Error('fixture providers missing')
  modelProvider.descriptor.stateCodecs = [{ ...CODEC, schema: modelProvider.descriptor.configSchema }]
  modelProvider.codecRefs = modelProvider.descriptor.stateCodecs
  const { releaseSetId: _before, ...resealed } = release
  release.releaseSetId = fixtureHash(resealed)
  let nowMs = Date.parse(input.fixture.now)
  const joint = await openJointAdmission(directory, input, undefined, false, () => nowMs)
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
    ttlMs: 6_000_000,
  })
  if (!opened.claim) throw Error('writer was not opened')
  const writerEpoch = opened.claim.writerEpoch
  const runId = admission.runId
  const deadline = '2027-01-01T00:00:00Z'
  const tool = (key: string) => {
    const intent = {
      key,
      target: toolProvider.binding,
      method: 'invoke',
      input: { ...fixtureRef({ key }), schema: toolInvoke.inputSchema },
      dependencies: [],
      retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
      obligation: 'mandatory' as const,
      deadline,
      resultSchema: toolInvoke.outputSchema,
      references: [],
    }
    return { ...intent, intentFingerprint: fixtureHash(intent) } satisfies PreparedAction
  }
  const continuation = (marker: string) => ({
    namespace: CODEC.namespace,
    codecVersion: CODEC.codecVersion,
    data: fixtureRef({ marker }),
    provenance: { sourceRefs: [], producer: modelProvider.binding, trustLabels: [] },
    createdAt: admission.admittedAt,
    references: [],
  })
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
  const head = (recordId: string) => {
    const row = joint.db
      .prepare(
        'SELECT h.record_revision,h.last_commit_id,b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
      )
      .get(recordId)
    if (!row || typeof row.value_json !== 'string') return undefined
    return {
      revision: Number(row.record_revision),
      commitId: String(row.last_commit_id),
      // biome-ignore lint/suspicious/noExplicitAny: record bodies are probed by path in assertions
      value: JSON.parse(row.value_json) as Record<string, any>,
    }
  }
  const count = (like: string) =>
    Number(
      joint.db.prepare('SELECT count(*) AS n FROM runtime_record_heads WHERE record_id LIKE ?').get(like)?.n,
    )
  const writes = () => Number(joint.db.prepare('SELECT total_changes() AS n').get()?.n)
  const events = () => Number(joint.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
  const runHead = () => head(`run:${runId}`)
  let counter = 0
  const step = async (commitId: string, transition: { consume?: string[]; next?: unknown }) => {
    const revision = Number(runHead()?.value.revision)
    const invocationId = `invocation-${++counter}`
    await joint.state.admitInvocation({
      requestId: `admit-${counter}`,
      runId,
      targetActionId: null,
      baseRevision: revision,
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
    return joint.state.advanceRun({
      commitId,
      guard: guardFor(invocationId, revision),
      transition: {
        expectedRevision: revision,
        continuation: continuation(commitId),
        consumeSignals: transition.consume ?? [],
        actions: [],
        next: (transition.next ?? { kind: 'continue' }) as never,
      },
    })
  }
  const dueAt = new Date(nowMs + 60_000).toISOString()
  let parked: Awaited<ReturnType<typeof step>> | undefined
  if (options.park !== false) {
    const condition = options.deadline ? { ...SIGNALS, deadline: dueAt } : SIGNALS
    parked = await step('park', { next: { kind: 'wait', condition } })
  }
  const owner = JSON.parse(
    String(
      joint.db.prepare('SELECT owner_json FROM runtime_record_heads WHERE record_id=?').get(`run:${runId}`)
        ?.owner_json,
    ),
  ) as {
    scope: ScopeRef
    ownerBinding: { bindingId: string }
  }
  const sourceBinding = {
    bindingId: 'source-binding',
    contract: 'acme.events',
    logicalName: 'ping',
    providerId: 'acme',
  }
  const schema = { typeId: EVENT_TYPE, revision: 1, digest: fixtureHash({ typeId: EVENT_TYPE }) }
  const event = (eventId: string, payload: unknown = { n: 1 }, typeId = EVENT_TYPE): DomainEvent => {
    const eventSchema = { ...schema, typeId, digest: fixtureHash({ typeId }) }
    return {
      eventId,
      typeId,
      schema: eventSchema,
      source: sourceBinding,
      scope: owner.scope,
      occurredAt: input.fixture.now,
      payload: { ...fixtureRef(payload), schema: eventSchema },
      idempotencyKey: eventId,
      causation: {},
      principalRef: 'fixture-principal',
      correlationId: null,
      provenance: { sourceRefs: [], producer: sourceBinding, trustLabels: [] },
    }
  }
  /** What the selected source owner proves, whatever the delivery claims. */
  const mappingFor = (delivery: SignalDelivery): SignalSourceMapping => ({
    mappingRef: 'mapping-1',
    sourceKind: delivery.sourceKind === 'timer' ? 'timer' : 'domain',
    sourceAuthorityId: delivery.sourceKind === 'timer' ? 'fixture-state' : 'domain-authority',
    sourceAuthorizationRef: 'authorization-1',
    scope: owner.scope,
    typeIds: [EVENT_TYPE, OTHER_TYPE, 'agh.runtime/action-completed@1'],
  })
  let verifier: ((delivery: SignalDelivery) => SignalSourceMapping | undefined) | undefined
  const install = (verify: (delivery: SignalDelivery) => SignalSourceMapping | undefined = mappingFor) => {
    verifier = verify
    joint.state.installSignalSource({ verify: (delivery) => verifier?.(delivery) })
  }
  const delivery = (
    intakeId: string,
    sourceEventId: string,
    over: Partial<SignalDelivery> & { payload?: unknown; typeId?: string } = {},
  ): SignalDelivery => {
    const { payload, typeId, ...rest } = over
    const built = event(sourceEventId, payload, typeId)
    return {
      intakeId,
      sourceAuthority: { authorityId: 'domain-authority', tenantId: 'fixture-tenant', authorityEpoch: 1 },
      sourceEventId,
      consumerId: owner.ownerBinding.bindingId,
      fingerprint: fixtureHash({ sourceEventId, payload: payload ?? { n: 1 }, typeId: typeId ?? EVENT_TYPE }),
      sourceAuthorizationRef: 'authorization-1',
      sourceKind: 'domain',
      event: built,
      target: { runId, targetActionId: null },
      mappingRef: 'mapping-1',
      ...rest,
    }
  }
  const waitId = parked ? stableId('wait', parked.commitId) : ''
  const timerId = parked ? stableId('timer', parked.commitId) : ''
  return {
    directory,
    input,
    joint,
    admission,
    runId,
    parked,
    waitId,
    timerId,
    dueAt,
    head,
    count,
    writes,
    events,
    runHead,
    step,
    tool,
    delivery,
    install,
    mappingFor,
    event,
    owner,
    advance(ms: number) {
      nowMs += ms
    },
    setNow(ms: number) {
      nowMs = ms
    },
    now: () => nowMs,
    context: () => joint.context(),
    toolBinding: toolProvider.binding,
    toolInvoke,
    signalIds: () =>
      joint.db
        .prepare(
          "SELECT json_extract(b.value_json,'$.signal.signalId') AS id FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id LIKE 'signal:%' ORDER BY json_extract(b.value_json,'$.signal.seq')",
        )
        .all()
        .map((row) => String(row.id)),
    wakes: () =>
      joint.db
        .prepare("SELECT event_id, delivery FROM runtime_outbox_delivery WHERE event_id LIKE 'obx-%'")
        .all()
        .map((row) => ({ id: String(row.event_id), delivery: String(row.delivery) })),
  }
}

type Fixture = Awaited<ReturnType<typeof setup>>

async function reopen(f: Fixture) {
  const sessionId = f.admission.sessionId
  await f.joint.close()
  joints.splice(joints.indexOf(f.joint), 1)
  const again = await openJointAdmission(f.directory, f.input, undefined, false, f.now)
  joints.push(again)
  await (again.state as unknown as Owner).requireSession(sessionId)
  return again
}

describe('acceptInbox', () => {
  it('is no longer listed as unimplemented, for any of the four methods this path serves', () => {
    for (const name of ['acceptInbox', 'fireTimer', 'acceptServiceCommand', 'readServiceCommand'])
      expect(UNIMPLEMENTED_STATE_METHODS).not.toContain(name)
  })

  it('stores the signal, the inbox record and a wake event, and marks the matching wait ready', async () => {
    const f = await setup()
    f.install()
    const delivery = f.delivery('intake-1', 'event-1')
    const before = f.events()
    const receipt = await f.joint.state.acceptInbox(delivery, f.context())
    expect(f.events()).toBe(before + 1)
    expect(receipt).toMatchObject({ intakeId: 'intake-1', state: 'accepted' })
    const [signalId] = receipt.signalIds
    if (!signalId) throw Error('no signal')
    const signal = f.head(signalRecordId(signalId))
    expect(signal).toMatchObject({
      commitId: receipt.appliedCommitId,
      value: {
        signal: {
          runId: f.runId,
          targetActionId: null,
          seq: 1,
          typeId: EVENT_TYPE,
          causation: { externalEventId: 'event-1' },
        },
        consumedByCommitId: null,
      },
    })
    const inboxKey = {
      sourceAuthorityId: 'domain-authority',
      eventId: 'event-1',
      consumerId: delivery.consumerId,
    }
    const inbox = f.head(inboxRecordId(stableId('inbox', canonicalJson(inboxKey))))
    expect(inbox).toMatchObject({
      value: {
        ...inboxKey,
        fingerprint: delivery.fingerprint,
        appliedCommitId: receipt.appliedCommitId,
        inboxSeq: 1,
      },
    })
    expect(f.head(waitRecordId(f.waitId))).toMatchObject({
      revision: 2,
      value: { state: 'ready', matchedSignalIds: [signalId], deadlineSignalId: null },
    })
    expect(f.runHead()?.value).toMatchObject({ state: 'waiting', waitId: f.waitId })
    expect(f.wakes()).toEqual([{ id: expect.any(String), delivery: 'pending' }])
    // The Supervisor consumes the signal and the run resumes from the ready wait.
    await f.step('resume', { consume: [signalId] })
    expect(f.runHead()?.value).toMatchObject({ state: 'runnable', waitId: null })
    expect(f.head(waitRecordId(f.waitId))?.value).toMatchObject({
      state: 'ready',
      matchedSignalIds: [signalId],
    })
  })

  it('stores a signal the wait does not ask for and leaves the wait waiting', async () => {
    const f = await setup()
    f.install()
    const receipt = await f.joint.state.acceptInbox(
      f.delivery('intake-1', 'event-1', { typeId: OTHER_TYPE }),
      f.context(),
    )
    expect(receipt.state).toBe('accepted')
    expect(f.count('signal:%')).toBe(1)
    expect(f.head(waitRecordId(f.waitId))).toMatchObject({ revision: 1, value: { state: 'waiting' } })
  })

  it('returns the original receipt for a duplicate delivery and a retried request, with no second signal', async () => {
    const f = await setup()
    f.install()
    const first = await f.joint.state.acceptInbox(f.delivery('intake-1', 'event-1'), f.context())
    const writes = f.writes()
    const retry = await f.joint.state.acceptInbox(f.delivery('intake-1', 'event-1'), f.context())
    expect(retry).toEqual(first)
    expect(f.writes()).toBe(writes)
    const duplicate = await f.joint.state.acceptInbox(f.delivery('intake-2', 'event-1'), f.context())
    expect(duplicate).toEqual({ ...first, state: 'duplicate' })
    const again = await f.joint.state.acceptInbox(f.delivery('intake-2', 'event-1'), f.context())
    expect(again).toEqual(duplicate)
    expect(f.count('signal:%')).toBe(1)
    expect(f.count('inbox:%')).toBe(1)
    expect(f.wakes()).toHaveLength(1)
  })

  it('records a delivery whose content differs as conflicting and creates no second signal', async () => {
    const f = await setup()
    f.install()
    const first = await f.joint.state.acceptInbox(f.delivery('intake-1', 'event-1'), f.context())
    const changed = f.delivery('intake-2', 'event-1', { payload: { n: 2 } })
    const conflicting = await f.joint.state.acceptInbox(changed, f.context())
    expect(conflicting).toEqual({
      intakeId: 'intake-2',
      state: 'conflicting',
      appliedCommitId: first.appliedCommitId,
      signalIds: [],
    })
    // The same content under another fingerprint is not a duplicate either.
    const refingerprinted = f.delivery('intake-4', 'event-1', { fingerprint: fixtureHash('another') })
    expect(await f.joint.state.acceptInbox(refingerprinted, f.context())).toMatchObject({
      state: 'conflicting',
    })
    // The same fingerprint over other content cannot pass as a duplicate either.
    const lying = f.delivery('intake-3', 'event-1', { payload: { n: 3 } })
    lying.fingerprint = f.delivery('x', 'event-1').fingerprint
    expect(await f.joint.state.acceptInbox(lying, f.context())).toMatchObject({ state: 'conflicting' })
    const writes = f.writes()
    expect(await f.joint.state.acceptInbox(changed, f.context())).toEqual(conflicting)
    expect(f.writes()).toBe(writes)
    expect(f.count('signal:%')).toBe(1)
    expect(f.head(waitRecordId(f.waitId))?.revision).toBe(2)
  })

  it('refuses a delivery its source does not prove, and writes nothing', async () => {
    const f = await setup()
    const writes = () => f.writes()
    await expect(
      f.joint.state.acceptInbox(f.delivery('intake-0', 'event-0'), f.context()),
    ).rejects.toMatchObject(refusal('signal_source'))
    f.install()
    const before = writes()
    const cases: [string, SignalDelivery, string][] = [
      ['unproven mapping', f.delivery('i1', 'e1', { mappingRef: 'other-mapping' }), 'signal_source'],
      [
        'other authority',
        f.delivery('i2', 'e2', { sourceAuthorizationRef: 'other-authorization' }),
        'signal_source',
      ],
      ['other consumer', f.delivery('i3', 'e3', { consumerId: 'someone-else' }), 'signal_consumer'],
      ['source kind not proven', f.delivery('i4', 'e4', { sourceKind: 'ingress' }), 'signal_source'],
      [
        'event id differing from the source event',
        f.delivery('i5', 'e5', { sourceEventId: 'e6' }),
        'signal_event',
      ],
      ['unregistered type', f.delivery('i7', 'e7', { typeId: 'acme.events/unknown@1' }), 'signal_type'],
      ['reserved type', f.delivery('i8', 'e8', { typeId: 'agh.runtime/action-completed@1' }), 'signal_type'],
      [
        'run that does not exist',
        f.delivery('i9', 'e9', { target: { runId: 'no-run', targetActionId: null } }),
        'run_absent',
      ],
      [
        'action that does not exist',
        f.delivery('i10', 'e10', { target: { runId: f.runId, targetActionId: 'no-action' } }),
        'signal_target',
      ],
    ]
    for (const [name, delivery, detail] of cases) {
      await expect(f.joint.state.acceptInbox(delivery, f.context()), name).rejects.toMatchObject(
        refusal(detail),
      )
    }
    const scoped = f.delivery('i11', 'e11')
    scoped.event = { ...scoped.event, scope: { kind: 'installation', installationId: 'elsewhere' } }
    await expect(f.joint.state.acceptInbox(scoped, f.context())).rejects.toMatchObject(
      refusal('signal_scope'),
    )
    expect(writes()).toBe(before)
    expect(f.count('signal:%')).toBe(0)
  })

  it('refuses a source mapping whose scope is not the scope of the target run', async () => {
    const f = await setup()
    const elsewhere = { kind: 'installation' as const, installationId: 'elsewhere' }
    f.install((delivery) => ({ ...f.mappingFor(delivery), scope: elsewhere }))
    const delivery = f.delivery('intake-1', 'event-1')
    delivery.event = { ...delivery.event, scope: elsewhere }
    await expect(f.joint.state.acceptInbox(delivery, f.context())).rejects.toMatchObject(
      refusal('signal_scope'),
    )
    expect(f.count('signal:%')).toBe(0)
  })

  it('survives a cold reopen with the full scan, and still answers a duplicate', async () => {
    const f = await setup({ deadline: true })
    f.install()
    const first = await f.joint.state.acceptInbox(f.delivery('intake-1', 'event-1'), f.context())
    f.advance(120_000)
    await f.joint.state.fireTimer({ requestId: 'fire', timerId: f.timerId, expectedRecordRevision: 1 })
    const again = await reopen(f)
    again.state.installSignalSource({ verify: (delivery) => f.mappingFor(delivery) })
    const duplicate = await again.state.acceptInbox(f.delivery('intake-9', 'event-1'), again.context())
    expect(duplicate).toEqual({ ...first, state: 'duplicate' })
    const conflicting = await again.state.acceptInbox(
      f.delivery('intake-10', 'event-1', { payload: { n: 9 } }),
      again.context(),
    )
    expect(conflicting.state).toBe('conflicting')
  })

  it('is reachable through the store port with the same answers', async () => {
    const f = await setup()
    f.install()
    const receipt = await f.joint.store.acceptInbox(f.delivery('intake-1', 'event-1'), f.context())
    expect(receipt).toMatchObject({ ok: true, value: { state: 'accepted' } })
    const refused = await f.joint.store.acceptInbox({ intakeId: 'x' } as never, f.context())
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_input', detailCode: 'schema' } })
  })
})

describe('fireTimer', () => {
  const fire = (f: Fixture, requestId = 'fire', revision = 1): StateStoreControlFireTimerRequest => ({
    requestId,
    timerId: f.timerId,
    expectedRecordRevision: revision,
  })

  it('refuses a timer that is not due and fires it from the store clock once it is', async () => {
    const f = await setup({ deadline: true })
    const writes = f.writes()
    await expect(f.joint.state.fireTimer(fire(f))).rejects.toMatchObject(refusal('timer_not_due'))
    f.setNow(Date.parse(f.dueAt) - 1)
    await expect(f.joint.state.fireTimer(fire(f))).rejects.toMatchObject(refusal('timer_not_due'))
    expect(f.writes()).toBe(writes)
    expect(f.head(timerRecordId(f.timerId))?.value.state).toBe('scheduled')
    f.setNow(Date.parse(f.dueAt))
    const before = f.events()
    const receipt = await f.joint.state.fireTimer(fire(f))
    expect(f.events()).toBe(before + 1)
    const timer = f.head(timerRecordId(f.timerId))
    const signalId = timer?.value.signalId
    expect(receipt).toMatchObject({
      state: 'accepted',
      signalIds: [signalId],
      appliedCommitId: timer?.commitId,
    })
    expect(timer).toMatchObject({
      revision: 2,
      value: { state: 'fired', firedByCommitId: receipt.appliedCommitId },
    })
    expect(f.head(waitRecordId(f.waitId))).toMatchObject({
      revision: 2,
      value: { state: 'ready', deadlineSignalId: signalId, matchedSignalIds: [] },
    })
    expect(f.head(signalRecordId(String(signalId)))).toMatchObject({
      value: { signal: { typeId: 'agh.runtime/timer-fired@1', targetActionId: null, seq: 1 } },
    })
    expect(f.count('inbox:%')).toBe(1)
    expect(f.wakes()).toHaveLength(1)
    // The Supervisor sees the deadline through the ready wait and consumes the timer signal.
    await f.step('timeout', { consume: [String(signalId)] })
    expect(f.runHead()?.value).toMatchObject({ state: 'runnable', waitId: null })
    expect(f.head(timerRecordId(f.timerId))?.value.state).toBe('fired')
  })

  it('answers a fired timer with its original receipt and a retried request with the same answer', async () => {
    const f = await setup({ deadline: true })
    f.advance(120_000)
    const first = await f.joint.state.fireTimer(fire(f))
    const writes = f.writes()
    expect(await f.joint.state.fireTimer(fire(f))).toEqual(first)
    const other = await f.joint.state.fireTimer(fire(f, 'fire-2', 99))
    expect(other).toEqual({ ...first, state: 'duplicate' })
    expect(await f.joint.state.fireTimer(fire(f, 'fire-2', 99))).toEqual(other)
    expect(f.writes()).toBe(writes + 2)
    expect(f.count('signal:%')).toBe(1)
    await expect(f.joint.state.fireTimer({ ...fire(f), timerId: 'no-timer' })).rejects.toMatchObject(
      refusal('timer_absent'),
    )
    await expect(f.joint.state.fireTimer({ ...fire(f), expectedRecordRevision: 5 })).rejects.toMatchObject(
      refusal('idempotency_conflict'),
    )
  })

  it('refuses a stale record revision and never fires a timer the run already cancelled', async () => {
    const f = await setup({ deadline: true })
    f.install()
    f.advance(120_000)
    await expect(f.joint.state.fireTimer(fire(f, 'stale', 7))).rejects.toMatchObject(refusal('revision'))
    const answered = await f.joint.state.acceptInbox(f.delivery('intake-1', 'event-1'), f.context())
    await f.step('resume', { consume: [...answered.signalIds] })
    expect(f.head(timerRecordId(f.timerId))?.value.state).toBe('cancelled')
    const writes = f.writes()
    await expect(f.joint.state.fireTimer(fire(f, 'late'))).rejects.toMatchObject(refusal('timer_cancelled'))
    expect(f.writes()).toBe(writes)
    expect(f.count('signal:%')).toBe(1)
  })

  it('keeps the matched signals when the deadline passes after a signal marked the wait ready', async () => {
    const f = await setup({ deadline: true })
    f.install()
    const answered = await f.joint.state.acceptInbox(f.delivery('intake-1', 'event-1'), f.context())
    f.advance(120_000)
    const receipt = await f.joint.state.fireTimer(fire(f))
    expect(f.head(waitRecordId(f.waitId))?.value).toMatchObject({
      state: 'ready',
      matchedSignalIds: [...answered.signalIds],
      deadlineSignalId: receipt.signalIds[0],
    })
    expect(f.count('signal:%')).toBe(2)
  })

  it('fires a due timer delivered as a timer source, and refuses one that does not describe the timer', async () => {
    const f = await setup({ deadline: true })
    f.install()
    const timer = f.head(timerRecordId(f.timerId))?.value
    const delivery = f.delivery('intake-t', f.timerId, {
      sourceKind: 'timer',
      sourceAuthority: { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 1 },
      fingerprint: fixtureHash({ timerId: f.timerId, dueAt: timer?.dueAt, waitId: f.waitId }),
    })
    await expect(f.joint.state.acceptInbox(delivery, f.context())).rejects.toMatchObject(
      refusal('timer_not_due'),
    )
    f.advance(120_000)
    const stale = { ...delivery, fingerprint: fixtureHash({ other: 1 }), intakeId: 'intake-bad' }
    await expect(f.joint.state.acceptInbox(stale, f.context())).rejects.toMatchObject(refusal('timer_target'))
    const receipt = await f.joint.state.acceptInbox(delivery, f.context())
    expect(receipt.state).toBe('accepted')
    expect(await f.joint.state.acceptInbox(delivery, f.context())).toEqual(receipt)
    expect(f.head(timerRecordId(f.timerId))?.value.state).toBe('fired')
    expect(await f.joint.state.fireTimer(fire(f))).toEqual({ ...receipt, state: 'duplicate' })
  })

  it('survives a cold reopen with the full scan and answers the fired timer again', async () => {
    const f = await setup({ deadline: true })
    f.advance(120_000)
    const first = await f.joint.state.fireTimer(fire(f))
    const again = await reopen(f)
    expect(await again.state.fireTimer(fire(f, 'after-reopen'))).toEqual({ ...first, state: 'duplicate' })
    expect(await again.state.fireTimer(fire(f))).toEqual(first)
  })

  it('is reachable through the store port', async () => {
    const f = await setup({ deadline: true })
    f.advance(120_000)
    expect(await f.joint.store.fireTimer(fire(f), f.context())).toMatchObject({
      ok: true,
      value: { state: 'accepted' },
    })
    expect(await f.joint.store.fireTimer({ requestId: 'x' } as never, f.context())).toMatchObject({
      ok: false,
      error: { detailCode: 'schema' },
    })
  })
})

describe('what the control scan refuses of intake records', () => {
  const owner = {
    authority: { authorityId: 'a', tenantId: 't', authorityEpoch: 1 },
    scope: { kind: 'runtime', installationId: 'i', runtimeId: 'r' },
    ownerBinding: { bindingId: 'consumer', contract: 'c', logicalName: 'n', providerId: 'p' },
  }
  const key = { sourceAuthorityId: 'src', eventId: 'ev', consumerId: 'consumer' }
  const schema = { typeId: EVENT_TYPE, revision: 1, digest: 'a'.repeat(64) }
  const payload = {
    kind: 'inline',
    schema,
    value: { n: 1 },
    digest: canonicalJsonDigest({ n: 1 }),
    bytes: 7,
  }
  const signalId = stableId('inbox-signal', canonicalJson(key))
  const note = (
    recordId: string,
    value: unknown,
    commitId = 'commit-1',
    revision = 1,
  ): ControlVersionNote => ({
    record_id: recordId,
    record_revision: revision,
    commit_id: commitId,
    value_json: JSON.stringify(value),
    owner_json: JSON.stringify(owner),
  })
  const signalValue = {
    signal: {
      signalId,
      runId: 'run-1',
      targetActionId: null,
      seq: 1,
      typeId: EVENT_TYPE,
      schema,
      source: owner.ownerBinding,
      payload,
      createdAt: '2026-01-01T00:00:00Z',
      causation: { externalEventId: 'ev' },
    },
    targetRevisionAtCreation: 0,
    consumedByCommitId: null,
  }
  const finish = (scan: ReturnType<typeof createControlScan>) =>
    finishControlScan(scan, {
      sessionId: 's',
      requests: () => [],
      domainJson: () => undefined,
      signalSeqIndex: () => [{ run_id: 'run-1', target_key: '', next_seq: 2 }],
      activeInvocations: () => [],
    })
  it('refuses a signal that carries an external event but has no inbox record', () => {
    const scan = createControlScan()
    noteControlVersion(scan, note(signalRecordId(signalId), signalValue))
    expect(() => finish(scan)).toThrow()
  })
  const wakeId = (commit: string) => stableId('obx', `${commit}\0wake\0${signalId}`)
  const wakePayload = { signalId, runId: 'run-1', targetActionId: null, typeId: EVENT_TYPE }
  const wakeValue = (commit: string, over: Record<string, unknown> = {}) => ({
    eventId: wakeId(commit),
    sourceAuthorityId: 'a',
    sourceCommitId: commit,
    destination: stableId('obxdst', 'a'),
    typeId: 'agh.runtime/signal-wake@1',
    payload: {
      kind: 'inline',
      schema,
      value: wakePayload,
      digest: digestOf(wakePayload),
      bytes: Buffer.byteLength(canonicalJson(wakePayload)),
    },
    fingerprint: digestOf(wakePayload),
    delivery: 'pending',
    attempts: 0,
    consecutiveFailures: 0,
    nextAttemptAt: '2026-01-01T00:00:00Z',
    claim: null,
    ackRef: null,
    lastError: null,
    ...over,
  })
  const inboxValue = {
    ...key,
    fingerprint: 'b'.repeat(64),
    receivedAt: '2026-01-01T00:00:00Z',
    appliedCommitId: 'commit-1',
    acknowledgement: {
      kind: 'inline',
      schema,
      value: { intakeId: 'intake-1', signalIds: [signalId] },
      digest: digestOf({ intakeId: 'intake-1', signalIds: [signalId] }),
      bytes: Buffer.byteLength(canonicalJson({ intakeId: 'intake-1', signalIds: [signalId] })),
    },
    inboxSeq: 1,
  }
  /** A whole intake as State writes it: signal, inbox record and wake event in one commit. */
  const whole = (
    over: {
      signalCommit?: string
      wakeCommit?: string
      wakeNoteCommit?: string
      wake?: boolean
      wakeOver?: Record<string, unknown>
    } = {},
  ) => {
    const scan = createControlScan()
    noteControlVersion(scan, note(signalRecordId(signalId), signalValue, over.signalCommit ?? 'commit-1'))
    noteControlVersion(scan, note(inboxRecordId(stableId('inbox', canonicalJson(key))), inboxValue))
    if (over.wake !== false) {
      const commit = over.wakeCommit ?? 'commit-1'
      const written = over.wakeNoteCommit ?? commit
      noteControlVersion(
        scan,
        note(outboxRecordId(wakeId('commit-1')), wakeValue(commit, over.wakeOver), written),
      )
      noteControlSide(scan, { commitId: written, kind: 'outbox-created', eventId: wakeId('commit-1') })
    }
    return scan
  }
  it('accepts a whole intake and refuses each part that does not belong to the others', () => {
    expect(() => finish(whole())).not.toThrow()
    expect(() => finish(whole({ wake: false })), 'no wake event').toThrow()
    expect(() => finish(whole({ signalCommit: 'commit-2' })), 'signal of another commit').toThrow()
    expect(() => finish(whole({ wakeCommit: 'commit-2' })), 'wake of another commit').toThrow()
    expect(
      () => finish(whole({ wakeNoteCommit: 'commit-2' })),
      'wake written by another commit than the inbox record',
    ).toThrow()
    expect(
      () => finish(whole({ wakeOver: { destination: stableId('obxdst', 'other') } })),
      'wake for another destination',
    ).toThrow()
    expect(
      () => finish(whole({ wakeOver: { fingerprint: 'c'.repeat(64) } })),
      'wake with a fingerprint of other content',
    ).toThrow()
  })
  it('refuses an inbox record under an id that is not its key', () => {
    const scan = createControlScan()
    const value = {
      ...key,
      fingerprint: 'b'.repeat(64),
      receivedAt: '2026-01-01T00:00:00Z',
      appliedCommitId: 'commit-1',
      acknowledgement: payload,
      inboxSeq: 1,
    }
    expect(() => noteControlVersion(scan, note('inbox:other', value))).toThrow()
  })
  it('refuses a service command record under an id that is not its key', () => {
    const scan = createControlScan()
    const value = {
      commandId: 'c',
      fingerprint: 'b'.repeat(64),
      sessionId: 's',
      principalRef: 'p',
      sourceRef: 'src',
      extensionId: 'e',
      serviceName: 'svc',
      releaseSetId: 'r',
      bindingId: 'b',
      runId: 'run',
      actionId: 'act',
      state: 'accepted',
      resultRef: null,
      error: null,
      ownerRef: { kind: 'run', id: 'run' },
    }
    expect(() => noteControlVersion(scan, note(serviceCommandRecordId('other'), value))).toThrow()
  })
})

describe('acceptServiceCommand and readServiceCommand', () => {
  const runAdmission = (f: Fixture) => {
    const run = f.runHead()?.value
    if (!run) throw Error('run missing')
    return {
      ticketId: run.admissionTicketId,
      fingerprint: fixtureHash('admission'),
      releaseSetId: f.joint.draft().admission.releaseSetId,
      bindingId: run.bindingId,
      packagePinReceipt: fixtureRef({ pin: 1 }),
      runId: run.runId,
      sessionId: run.sessionId,
      lane: run.lane,
      workspaceId: f.joint.draft().admission.workspaceId,
      input: run.input,
      admittedAt: f.joint.draft().admission.admittedAt,
      deadline: run.deadline,
      conversation: null,
    }
  }
  const request = (f: Fixture, over: Record<string, unknown> = {}) => {
    const action = f.tool('service-action')
    const admission = runAdmission(f)
    return {
      commandId: 'command-1',
      requestDigest: fixtureHash('request-1'),
      releaseSetId: admission.releaseSetId,
      bindingId: admission.bindingId,
      sessionId: admission.sessionId,
      extensionId: 'acme.extension',
      serviceName: 'ping',
      mode: 'effect' as const,
      operation: { target: action.target, method: action.method, input: action.input },
      admission,
      action,
      ...over,
    }
  }
  const other = (f: Fixture) => ({ ...f.context(), principalRef: 'another-principal' })

  it('records the command with its first action in one commit and answers a retry from the record', async () => {
    const f = await setup({ park: false })
    const asked = request(f)
    const before = f.events()
    const record = await f.joint.state.acceptServiceCommand(asked, f.context())
    expect(f.events()).toBe(before + 1)
    const actionId = stableId('act', `${f.runId}\0service-action`)
    expect(record).toMatchObject({
      commandId: 'command-1',
      fingerprint: asked.requestDigest,
      sessionId: asked.sessionId,
      principalRef: f.context().principalRef,
      extensionId: 'acme.extension',
      serviceName: 'ping',
      runId: f.runId,
      actionId,
      state: 'accepted',
      resultRef: null,
      error: null,
      ownerRef: { kind: 'run', id: f.runId },
    })
    expect(record.sourceRef).not.toBe(f.context().principalRef)
    const action = f.head(`action:${actionId}`)
    expect(action).toMatchObject({
      revision: 1,
      value: { state: 'prepared', parentActionId: null, key: 'service-action' },
    })
    const stored = f.joint.db
      .prepare(
        "SELECT record_id,last_commit_id FROM runtime_record_heads WHERE record_id LIKE 'service-command:%'",
      )
      .all()
    expect(stored).toHaveLength(1)
    expect(String(stored[0]?.last_commit_id)).toBe(action?.commitId)
    expect(f.head(`run-quota:${f.runId}`)?.value).toMatchObject({
      submittedActions: 1,
      lastProgressRef: actionId,
    })
    const writes = f.writes()
    expect(await f.joint.state.acceptServiceCommand(asked, f.context())).toEqual(record)
    expect(f.writes()).toBe(writes)
    const readRequest = {
      commandId: 'command-1',
      sessionId: asked.sessionId,
      extensionId: 'acme.extension',
      serviceName: 'ping',
    }
    expect(await f.joint.state.readServiceCommand(readRequest, f.context())).toEqual(record)
    expect(await f.joint.state.readServiceCommand(readRequest, other(f))).toBeNull()
    expect(
      await f.joint.state.readServiceCommand({ ...readRequest, serviceName: 'pong' }, f.context()),
    ).toBeNull()
    expect(
      await f.joint.state.readServiceCommand({ ...readRequest, extensionId: 'else' }, f.context()),
    ).toBeNull()
    expect(
      await f.joint.state.readServiceCommand({ ...readRequest, commandId: 'nope' }, f.context()),
    ).toBeNull()
  })

  it('refuses a command that does not match its run or operation, and writes nothing', async () => {
    const f = await setup({ park: false })
    const first = request(f)
    const writes = f.writes()
    const bad = (name: string, over: Record<string, unknown>, detail: string) =>
      expect(f.joint.state.acceptServiceCommand(request(f, over), f.context()), name).rejects.toMatchObject(
        refusal(detail),
      )
    await bad(
      'admission of another session',
      { admission: { ...runAdmission(f), sessionId: 'other-session' } },
      'service_admission',
    )
    await bad('another session', { sessionId: 'other-session' }, 'session_absent')
    await bad('other binding', { bindingId: 'other-binding' }, 'service_admission')
    await bad('other release', { releaseSetId: fixtureHash('other') }, 'service_admission')
    await bad(
      'conversation admission',
      { admission: { ...runAdmission(f), conversation: { turnId: 't' } } },
      'service_admission',
    )
    await bad('other ticket', { admission: { ...runAdmission(f), ticketId: 'other-ticket' } }, 'service_run')
    await bad('unknown run', { admission: { ...runAdmission(f), runId: 'no-run' } }, 'run_absent')
    await bad(
      'operation of another method',
      { operation: { ...first.operation, method: 'other' } },
      'service_action',
    )
    await bad(
      'operation of another input',
      { operation: { ...first.operation, input: fixtureRef({ other: 1 }) } },
      'service_action',
    )
    expect(f.writes()).toBe(writes)
    expect(f.count('service-command:%')).toBe(0)
    expect(f.count('action:%')).toBe(0)
  })

  it('refuses a changed request under the same key and a second command on a run that carries work', async () => {
    const f = await setup({ park: false })
    await f.joint.state.acceptServiceCommand(request(f), f.context())
    await expect(
      f.joint.state.acceptServiceCommand(request(f, { requestDigest: fixtureHash('changed') }), f.context()),
    ).rejects.toMatchObject(refusal('idempotency_conflict'))
    await expect(
      f.joint.state.acceptServiceCommand(request(f, { commandId: 'command-2' }), other(f)),
    ).rejects.toMatchObject(refusal('service_run'))
    expect(f.count('service-command:%')).toBe(1)
    expect(f.count('action:%')).toBe(1)
  })

  it('survives a cold reopen with the full scan and still reads the command', async () => {
    const f = await setup({ park: false })
    const asked = request(f)
    const record = await f.joint.state.acceptServiceCommand(asked, f.context())
    const again = await reopen(f)
    expect(
      await again.state.readServiceCommand(
        {
          commandId: 'command-1',
          sessionId: record.sessionId,
          extensionId: 'acme.extension',
          serviceName: 'ping',
        },
        again.context(),
      ),
    ).toEqual(record)
    expect(await again.state.acceptServiceCommand(asked, again.context())).toEqual(record)
  })

  it('is reachable through the store port, which validates the wire shape', async () => {
    const f = await setup({ park: false })
    const accepted = await f.joint.store.acceptServiceCommand(request(f), f.context())
    expect(accepted).toMatchObject({ ok: true, value: { state: 'accepted' } })
    expect(
      await f.joint.store.readServiceCommand(
        {
          commandId: 'command-1',
          sessionId: f.admission.sessionId,
          extensionId: 'acme.extension',
          serviceName: 'ping',
        },
        f.context(),
      ),
    ).toMatchObject({ ok: true, value: { commandId: 'command-1' } })
    expect(await f.joint.store.acceptServiceCommand({ commandId: 'x' } as never, f.context())).toMatchObject({
      ok: false,
      error: { detailCode: 'schema' },
    })
    expect(await f.joint.store.readServiceCommand({ commandId: 'x' } as never, f.context())).toMatchObject({
      ok: false,
      error: { detailCode: 'schema' },
    })
  })
})
