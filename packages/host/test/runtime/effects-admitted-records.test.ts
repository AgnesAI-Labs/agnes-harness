import { rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createAdmittedEffectsRecordReader } from '../../src/runtime/effects/admitted-records.js'
import { digestOf, stableId } from '../../src/runtime/state/records.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'

async function admittedFixture(clock?: () => number) {
  const f = await originalNativeFixture(clock ? { clock } : {})
  expect(await f.fixture.coordinator.coordinate(f.fixture.draft(), f.fixture.context())).toMatchObject({
    ok: true,
    value: { state: 'created' },
  })
  const state = f.fixture.state
  const binding = f.fixture.binding
  const target = binding.providers.find((row) => row.binding.contract === 'agh.tools')
  if (!target) throw Error('selected tool binding absent')
  const data = fixtureRef({ prompt: 'synthetic' })
  const intent = {
    key: 'native-effect',
    target: target.binding,
    method: 'invoke',
    input: data,
    dependencies: [],
    retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
    obligation: 'mandatory' as const,
    deadline: '2027-01-01T00:00:00Z',
    resultSchema: data.schema,
    references: [],
  }
  const writer = await state.open({
    requestId: 'effect-open',
    authority: f.authority,
    sessionId: 'fixture-session',
    mode: 'write',
    writerId: 'effects-writer',
    ttlMs: 10_000,
  })
  const writerEpoch = writer.claim?.writerEpoch
  if (writerEpoch === undefined) throw Error('writer claim absent')
  const guard = {
    authority: f.authority,
    sessionId: 'fixture-session',
    runId: 'fixture-run-old',
    writerId: 'effects-writer',
    writerEpoch,
    expectedRunRevision: 0,
    bindingId: binding.bindingId,
    invocationId: 'effect-invocation',
    readGuards: [],
    queryUsage: null,
  }
  await state.admitInvocation({
    requestId: 'effect-admit',
    runId: guard.runId,
    targetActionId: null,
    baseRevision: 0,
    bindingId: binding.bindingId,
    writerEpoch,
    invocationId: guard.invocationId,
    deadline: intent.deadline,
    queryAllowance: 0,
  })
  await state.closeInvocation({
    requestId: 'effect-close',
    invocationId: guard.invocationId,
    state: 'prepared',
    readGuards: [],
    domainReads: [],
    unresolvedInflightIds: [],
    observedQueryCount: 0,
  })
  const advanced = await state.advanceRun({
    commitId: 'effect-advance',
    guard,
    transition: {
      expectedRevision: 0,
      continuation: {
        namespace: 'agh.test',
        codecVersion: '1',
        data,
        provenance: { sourceRefs: [], producer: target.binding, trustLabels: [] },
        createdAt: f.input.fixture.now,
        references: [],
      },
      consumeSignals: [],
      actions: [{ ...intent, intentFingerprint: digestOf(intent) }],
      next: { kind: 'continue' as const },
    },
  })
  expect(advanced).toBeDefined()
  const actionId = stableId('act', `${guard.runId}\0${intent.key}`)
  const requestIdentity = {
    system: 'fixture-peer',
    aghRequestId: 'effect-request',
    idempotencyKey: null,
    requestDigest: digestOf(data),
  }
  const pinned = f.fixture.db
    .prepare('SELECT dispatch_domain_json FROM runtime_session_meta WHERE session_id=?')
    .get('fixture-session')?.dispatch_domain_json
  const atomicDomain =
    typeof pinned === 'string'
      ? JSON.parse(pinned)
      : {
          domainId: 'fixture-domain',
          revision: 1,
          stateAuthority: f.authority,
          budgetAuthority: f.authority,
          stateBinding: { ...target.binding, bindingId: binding.bindingId },
          budgetBinding: { ...target.binding, bindingId: binding.bindingId },
        }
  const admitted = await state.dispatchAdmission({
    admissionId: 'effect-admission',
    commitId: 'effect-dispatch',
    guard: { ...guard, expectedRunRevision: 1 },
    atomicDomain,
    actionId,
    expectedActionRevision: 1,
    decisionRef: data,
    attemptId: 'effect-attempt',
    requestIdentity,
    budget: { reservation: null, quota: [] },
    deadline: intent.deadline,
  })
  expect(admitted.state).toBe('admitted')
  const reader = createAdmittedEffectsRecordReader({
    originalState: state,
    originalIdentity: f.identity,
    originalDatabase: f.fixture.db,
  })
  const ids = {
    sessionId: 'fixture-session',
    runId: guard.runId,
    actionId,
    attemptId: 'effect-attempt',
    expectedRequestIdentity: requestIdentity,
  }
  return { f, reader, ids }
}

describe.skipIf(typeof process.getuid !== 'function')('original admitted effects records', () => {
  it('reads committed State and C14 facts, refusing wrong attempt, identity and window', async () => {
    const { f, reader, ids } = await admittedFixture()
    try {
      const changes = f.fixture.db.prepare('SELECT total_changes() n').get()?.n
      const fact = await reader.read(f.context, ids)
      expect(fact.attempt.requestIdentity).toEqual(ids.expectedRequestIdentity)
      expect(fact.action.currentAttemptId).toBe(ids.attemptId)
      expect(fact.action.createdByCommitId).toBe('effect-advance')
      expect(fact.actionCommitId).toBe('effect-dispatch')
      expect(fact.attemptCommitId).toBe('effect-dispatch')
      expect(Object.isFrozen(fact.action.intent)).toBe(true)
      expect(f.fixture.db.prepare('SELECT total_changes() n').get()?.n).toBe(changes)
      await expect(reader.read(f.context, { ...ids, attemptId: 'other' })).rejects.toThrow()
      await expect(
        reader.read(f.context, {
          ...ids,
          expectedRequestIdentity: { ...ids.expectedRequestIdentity, aghRequestId: 'other' },
        }),
      ).rejects.toThrow()
      await expect(reader.read(f.context, { ...ids, actionId: 'other' })).rejects.toThrow()
      await expect(reader.read(f.context, { ...ids, runId: 'other' })).rejects.toThrow()
      f.identity.revoke()
      await expect(reader.read(f.context, ids)).rejects.toThrow()
    } finally {
      reader.close()
      f.reader.close()
      f.identity.close()
      await f.fixture.close()
      rmSync(f.directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('rejects a read whose original C14 authority is revoked while the read awaits State', async () => {
    const { f, reader, ids } = await admittedFixture()
    try {
      const pending = reader.read(f.context, ids)
      f.identity.revoke()
      await expect(pending).rejects.toThrow()
    } finally {
      reader.close()
      f.reader.close()
      f.identity.close()
      await f.fixture.close()
      rmSync(f.directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('rejects a selector changed during the original State read and releases the snapshot', async () => {
    let duringRead = () => {}
    const { f, reader, ids } = await admittedFixture(() => {
      duringRead()
      return Date.parse('2026-10-03T00:00:00Z')
    })
    try {
      const mutable = { ...ids }
      duringRead = () => {
        mutable.attemptId = 'other'
        duringRead = () => {}
      }
      await expect(reader.read(f.context, mutable)).rejects.toThrow()
      await expect(
        reader.read(f.context, {
          ...ids,
          get attemptId() {
            return ids.attemptId
          },
        }),
      ).rejects.toThrow()
      expect((await reader.read(f.context, ids)).attempt.attemptId).toBe(ids.attemptId)
    } finally {
      reader.close()
      f.reader.close()
      f.identity.close()
      await f.fixture.close()
      rmSync(f.directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('rejects close while the original State read is awaiting its snapshot', async () => {
    let duringRead = () => {}
    const { f, reader, ids } = await admittedFixture(() => {
      duringRead()
      return Date.parse('2026-10-03T00:00:00Z')
    })
    try {
      duringRead = () => {
        reader.close()
        duringRead = () => {}
      }
      await expect(reader.read(f.context, ids)).rejects.toThrow()
    } finally {
      reader.close()
      f.reader.close()
      f.identity.close()
      await f.fixture.close()
      rmSync(f.directory, { recursive: true, force: true })
    }
  }, 60_000)
})
