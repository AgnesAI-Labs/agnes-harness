import { DatabaseSync } from 'node:sqlite'
import {
  type AttemptRecordValue,
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { proveAttempt } from '../../src/runtime/state/attempt-proof.js'
import {
  attemptRecordId,
  reconciliationCheckRecordId,
  resolutionRecordId,
  stableId,
} from '../../src/runtime/state/records.js'
import { type AttemptWorld, attemptWorld, openCold, type Stack } from './fixtures/state-attempt-fixture.js'

// Every test reads a whole verified session; a loaded shared runner is slow at that.
vi.setConfig({ testTimeout: 120_000 })

const scanSchemas = RuntimeMethodSchemaRefs['agh.state'].scan
const STATE = {
  bindingId: 'state',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'state-provider',
}

// biome-ignore lint/suspicious/noExplicitAny: results are probed by path in assertions
type Loose = any

function scan(stack: Stack, snapshot: Loose, filter: Record<string, unknown>, caller = stack.session()) {
  const body = boundedCanonicalJson(
    { snapshot, collection: 'records', filter, order: 'asc', cursor: null, limit: 500 },
    { maxBytes: 262_144, maxDepth: 64, maxMembers: 16_384 },
  )
  if (!body.ok) throw Error('bounds')
  return stack.service.query(
    {
      target: STATE,
      method: 'scan',
      snapshot: snapshot.snapshotId,
      input: {
        kind: 'inline',
        schema: scanSchemas.input,
        value: body.value.json,
        digest: canonicalJsonDigest(body.value.json),
        bytes: body.value.bytes,
      },
    },
    caller,
  ) as Promise<Loose>
}

function itemsOf(reply: Loose): Loose[] {
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true)
  const page = validateRuntime('StateScanResult', reply.value.output.value)
  if (!page.ok) throw Error('page invalid')
  expect(page.value.complete).toBe(true)
  return page.value.items
}

function ok<T>(outcome: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) throw Error(JSON.stringify(outcome.error))
  return outcome.value
}

let world: AttemptWorld
let cold: Stack | undefined
beforeAll(async () => {
  world = await attemptWorld()
}, 240_000)
afterAll(async () => {
  await world?.close(...(cold ? [cold] : []))
}, 60_000)

type Facts = Array<{ recordId: string; value: Loose }>
/** Test-only: shows the read owner facts that no State command can write, by rewriting what State hands it. */
function showing(stack: Stack, change: (fact: Facts[number]) => Facts[number]) {
  const state = world.native.fixture.state as unknown as Loose
  const original = state.interactionReadSnapshot
  state.interactionReadSnapshot = (run: () => Promise<unknown>, check: () => void) =>
    original.call(
      state,
      async () => {
        const out = await run()
        return Array.isArray(out) ? out.map(change) : out
      },
      check,
    )
  return () => {
    delete state.interactionReadSnapshot
    return stack
  }
}

const ATTEMPTS = ['attempt-1', 'attempt-child-a', 'attempt-child-b', 'attempt-child-c'] as const

describe.skipIf(typeof process.getuid !== 'function')('State read of real attempts', () => {
  it('reads a leaf attempt with the identity, binding and digest State admitted it with', async () => {
    const { stack, native, kids, childId } = world
    const snapshot = ok(await stack.reader.open(stack.session(), null))
    const read = ok(await stack.reader.getAttempt(stack.session(), snapshot, 'attempt-child-a'))
    expect(read?.stored.value).toEqual(world.head('attempt:attempt-child-a').value)
    expect(read?.stored.value).toMatchObject({
      attemptId: 'attempt-child-a',
      actionId: childId('child-a'),
      number: 1,
      kind: 'leaf',
      state: 'settled',
      bindingId: native.fixture.binding.bindingId,
      inputDigest: canonicalJsonDigest(kids[0]?.input),
      requestIdentity: {
        system: 'fixture-peer',
        aghRequestId: 'request-child-a',
        idempotencyKey: null,
        requestDigest: canonicalJsonDigest(kids[0]?.input),
      },
      receiptIds: [expect.any(String)],
    })
    expect(read?.stored.meta).toMatchObject({
      recordId: attemptRecordId('attempt-child-a'),
      schema: RuntimeSchemaRefs.AttemptRecordValue,
      recordRevision: world.head('attempt:attempt-child-a').revision,
    })
    expect(read?.stored.owner.authority).toEqual(native.authority)
  })

  it('reads a composite attempt, which has no request identity', async () => {
    const { stack, f } = world
    const snapshot = ok(await stack.reader.open(stack.session(), null))
    const read = ok(await stack.reader.getAttempt(stack.session(), snapshot, 'attempt-1'))
    expect(read?.stored.value).toMatchObject({
      attemptId: 'attempt-1',
      actionId: f.parentId,
      number: 1,
      kind: 'composite',
      state: 'running',
      requestIdentity: null,
      authorizationRef: null,
    })
    expect(read?.stored.value).toEqual(world.head('attempt:attempt-1').value)
  })

  it('reads the control attempt of an action settled without a dispatch', async () => {
    const { stack, f, controlId, runId } = world
    const snapshot = ok(await stack.reader.open(stack.session(), null))
    const read = ok(await stack.reader.getAttempt(stack.session(), snapshot, controlId))
    expect(read?.stored.value).toMatchObject({
      attemptId: controlId,
      actionId: f.leafParentId,
      number: 0,
      kind: 'control',
      state: 'settled',
      requestIdentity: null,
      authorizationRef: null,
      receiptIds: [stableId('rcpt', `settle\0${f.leafParentId}`)],
    })
    // the action window of that action sees it; the run window and its sibling's window differ
    const own = stack.action(runId, f.leafParentId)
    expect(
      ok(await stack.reader.getAttempt(own, ok(await stack.reader.open(own, null)), controlId)),
    ).not.toBeNull()
    const sibling = stack.action(runId, f.parentId)
    expect(
      ok(await stack.reader.getAttempt(sibling, ok(await stack.reader.open(sibling, null)), controlId)),
    ).toBeNull()
  })

  it('reads an unknown attempt at the version each snapshot saw, and shows no resolution or check record', async () => {
    const { stack, runId, childId, dispatching } = world
    const caller = stack.action(runId, childId('child-b'))
    const fresh = ok(await stack.reader.open(caller, null))
    const now = ok(await stack.reader.getAttempt(caller, fresh, 'attempt-child-b'))
    expect(now?.stored.value).toMatchObject({ state: 'unknown', receiptIds: [] })
    expect(now?.stored.meta.recordRevision).toBe(2)
    // the snapshot taken before the mark still reads the dispatching version, with its own meta
    const before = ok(await stack.reader.getAttempt(stack.session(), dispatching, 'attempt-child-b'))
    expect(before?.stored.value).toMatchObject({ state: 'dispatching' })
    expect(before?.stored.meta.recordRevision).toBe(1)
    expect(before?.stored.meta.lastCommitId).not.toBe(now?.stored.meta.lastCommitId)
    expect(before?.versionDigest).not.toBe(now?.versionDigest)
    // resolution and reconciliation check records exist but are not readable records
    const session = stack.session()
    const snapshot = ok(await stack.reader.open(session, null))
    for (const [recordId, schema] of [
      [resolutionRecordId(stableId('res', childId('child-b'))), RuntimeSchemaRefs.ResolutionRecordValue],
      [reconciliationCheckRecordId('check-1'), RuntimeSchemaRefs.ReconciliationCheckValue],
    ] as const) {
      expect(world.head(recordId)).toBeDefined()
      const refused = await stack.reader.get(session, snapshot, recordId, schema)
      expect(refused.ok ? null : refused.error.detailCode).toBe('state_type')
      const scanned = await scan(stack, snapshot, { typeIds: [schema.typeId] })
      expect(scanned.error?.detailCode).toBe('state_type')
    }
  })

  it('returns every attempt through the Stored envelope and no other kind of record beside the readable ones', async () => {
    const { stack, controlId } = world
    const snapshot = ok(await stack.reader.open(stack.session(), null))
    const items = itemsOf(
      await scan(stack, snapshot, { typeIds: [RuntimeSchemaRefs.AttemptRecordValue.typeId] }),
    )
    expect(items.map((item: Loose) => item.value.value.attemptId).sort()).toEqual(
      [...ATTEMPTS, controlId].sort(),
    )
    for (const item of items) {
      expect(item.schema).toEqual(RuntimeSchemaRefs.StoredRecord)
      expect(item.digest).toBe(canonicalJsonDigest(item.value))
      expect(item.value.meta.schema).toEqual(RuntimeSchemaRefs.AttemptRecordValue)
      expect(item.value.meta.recordId).toBe(attemptRecordId(item.value.value.attemptId))
    }
    const all = itemsOf(await scan(stack, snapshot, {}))
    const readable = new Set(
      [
        RuntimeSchemaRefs.RunRecordValue,
        RuntimeSchemaRefs.RunBinding,
        RuntimeSchemaRefs.ActionRecordValue,
        RuntimeSchemaRefs.AttemptRecordValue,
        RuntimeSchemaRefs.SignalRecordValue,
        RuntimeSchemaRefs.WaitRecordValue,
      ].map((schema) => schema.typeId),
    )
    expect(all.length).toBeGreaterThan(items.length)
    expect(all.filter((item: Loose) => !readable.has(item.value.meta.schema.typeId))).toEqual([])
  })

  it('gives each window only its own attempts, and the same null for absent and outside', async () => {
    const { stack, runId, childId, f } = world
    const childA = stack.action(runId, childId('child-a'))
    const snapshot = ok(await stack.reader.open(childA, null))
    expect(ok(await stack.reader.getAttempt(childA, snapshot, 'attempt-child-a'))).not.toBeNull()
    const outside = [
      await stack.reader.getAttempt(childA, snapshot, 'attempt-child-b'),
      await stack.reader.getAttempt(childA, snapshot, 'attempt-1'),
      await stack.reader.getAttempt(childA, snapshot, 'attempt-no-such'),
    ]
    for (const read of outside) expect(read).toEqual({ ok: true, value: null })
    // the parent's window holds its composite attempt, not its children's
    const parent = stack.action(runId, f.parentId)
    const parentSnapshot = ok(await stack.reader.open(parent, null))
    expect(ok(await stack.reader.getAttempt(parent, parentSnapshot, 'attempt-1'))).not.toBeNull()
    expect(await stack.reader.getAttempt(parent, parentSnapshot, 'attempt-child-a')).toEqual({
      ok: true,
      value: null,
    })
    // the run window holds all of them; another run's window none
    const run = stack.run(runId)
    const runSnapshot = ok(await stack.reader.open(run, null))
    for (const id of ATTEMPTS) expect(ok(await stack.reader.getAttempt(run, runSnapshot, id))).not.toBeNull()
    const other = stack.run('some-other-run')
    const otherSnapshot = ok(await stack.reader.open(other, null))
    for (const id of ATTEMPTS)
      expect(await stack.reader.getAttempt(other, otherSnapshot, id)).toEqual({ ok: true, value: null })
    // the action window's records scan returns only its own attempt
    const items = itemsOf(
      await scan(stack, snapshot, { typeIds: [RuntimeSchemaRefs.AttemptRecordValue.typeId] }, childA),
    )
    expect(items.map((item: Loose) => item.value.value.attemptId)).toEqual(['attempt-child-a'])
  })

  it('refuses by name every attempt that does not fit its action and run, for every window', async () => {
    const { stack, runId, childId } = world
    const rewrite = (patch: Record<string, unknown>) => (fact: Facts[number]) =>
      fact.recordId === attemptRecordId('attempt-child-a')
        ? { ...fact, value: { ...fact.value, ...patch } }
        : fact
    for (const patch of [
      { requestIdentity: null },
      { actionId: 'an-action-State-never-wrote' },
      { bindingId: 'another-binding' },
      { inputDigest: canonicalJsonDigest('another input') },
      { kind: 'control' },
    ]) {
      const bySession = stack.session()
      const byChildB = stack.action(runId, childId('child-b'))
      const sessionSnapshot = ok(await stack.reader.open(bySession, null))
      const childSnapshot = ok(await stack.reader.open(byChildB, null))
      const restore = showing(stack, rewrite(patch))
      try {
        // one bad record refuses the history for every window, including a sibling's own attempt
        for (const [caller, snapshot, id] of [
          [bySession, sessionSnapshot, 'attempt-child-a'],
          [byChildB, childSnapshot, 'attempt-child-b'],
        ] as const) {
          const read = await stack.reader.getAttempt(caller, snapshot, id)
          expect(read.ok ? null : read.error.detailCode, JSON.stringify(patch)).toBe('state_integrity')
        }
        const scanned = await scan(stack, sessionSnapshot, {})
        expect(scanned.error?.detailCode, JSON.stringify(patch)).toBe('state_integrity')
      } finally {
        restore()
      }
      expect(ok(await stack.reader.getAttempt(bySession, sessionSnapshot, 'attempt-child-a'))).not.toBeNull()
    }
  })

  it('reads the same attempts byte for byte after a cold reopen, and refuses the old snapshot', async () => {
    const { stack, controlId, dispatching } = world
    const before = new Map<string, Loose>()
    const snapshot = ok(await stack.reader.open(stack.session(), null))
    for (const id of [...ATTEMPTS, controlId]) {
      const read = ok(await stack.reader.getAttempt(stack.session(), snapshot, id))
      if (!read) throw Error(`attempt ${id} is missing`)
      before.set(id, read)
    }
    const wasBefore = itemsOf(
      await scan(stack, snapshot, { typeIds: [RuntimeSchemaRefs.AttemptRecordValue.typeId] }),
    )
    await stack.close()
    cold = await openCold(world)
    const old = await cold.reader.getAttempt(cold.session(), dispatching, 'attempt-child-b')
    expect(old.ok ? null : old.error.detailCode).toBe('resync_required')
    const fresh = ok(await cold.reader.open(cold.session(), null))
    for (const [id, expected] of before) {
      const read = ok(await cold.reader.getAttempt(cold.session(), fresh, id))
      expect(read).toEqual(expected)
    }
    const after = itemsOf(await scan(cold, fresh, { typeIds: [RuntimeSchemaRefs.AttemptRecordValue.typeId] }))
    expect(after).toEqual(wasBefore)
  }, 120_000)

  it('refuses a cold open when an attempt body was rewritten, by the integrity scan', async () => {
    const { native, runId } = world
    if (!cold) throw Error('cold stack missing')
    await cold.close()
    cold = undefined
    const raw = new DatabaseSync(native.file)
    try {
      const row = raw
        .prepare(
          `SELECT h.record_revision AS revision, b.value_json AS body FROM runtime_record_heads h
           JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision
           WHERE h.record_id=?`,
        )
        .get(attemptRecordId('attempt-child-a'))
      if (!row) throw Error('attempt row missing')
      raw
        .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
        .run(
          JSON.stringify({ ...JSON.parse(String(row.body)), inputDigest: 'sha256:'.padEnd(71, '0') }),
          attemptRecordId('attempt-child-a'),
          row.revision,
        )
    } finally {
      raw.close()
    }
    cold = await openCold(world)
    const opened = await cold.reader.open(cold.run(runId), null)
    expect(opened.ok ? null : opened.error.detailCode).toBe('state_integrity')
  }, 120_000)
})

describe('proof of one attempt against its action and run', () => {
  const action = { intent: { input: { value: 1 } } } as Loose
  const digest = canonicalJsonDigest({ value: 1 })
  const identity = { system: 's', aghRequestId: 'r', idempotencyKey: null, requestDigest: digest }
  const leaf: AttemptRecordValue = {
    attemptId: 'a',
    actionId: 'x',
    number: 1,
    kind: 'leaf',
    bindingId: 'b',
    inputDigest: digest,
    state: 'dispatching',
    requestIdentity: identity,
    externalRequests: [],
    authorizationRef: 'az',
    budgetReservationRefs: [],
    streamIds: [],
    startedAt: null,
    executeDeadline: null,
    finishedAt: null,
    receiptIds: [],
    writerEpoch: 1,
  }
  const composite: AttemptRecordValue = {
    ...leaf,
    kind: 'composite',
    requestIdentity: null,
    authorizationRef: null,
  }
  const control: AttemptRecordValue = {
    ...composite,
    kind: 'control',
    number: 0,
    state: 'settled',
    receiptIds: ['r'],
  }
  const refused = (value: AttemptRecordValue, binding = 'b') => {
    try {
      proveAttempt(value, action, binding)
    } catch (caught) {
      return (caught as { failure?: { detailCode: string } }).failure?.detailCode
    }
    return 'accepted'
  }

  it('accepts the three shapes State writes', () => {
    for (const value of [leaf, composite, control, { ...leaf, state: 'unknown' as const }])
      expect(refused(value)).toBe('accepted')
  })
  it('refuses, as integrity, every incoherent shape', () => {
    const cases: [string, AttemptRecordValue, string?][] = [
      ['another binding', leaf, 'other'],
      ['another input', { ...leaf, inputDigest: canonicalJsonDigest('other') }],
      ['a leaf without a request identity', { ...leaf, requestIdentity: null }],
      [
        'a leaf whose request is for other input',
        { ...leaf, requestIdentity: { ...identity, requestDigest: canonicalJsonDigest(2) } },
      ],
      ['a leaf without an authorization', { ...leaf, authorizationRef: null }],
      ['a leaf numbered zero', { ...leaf, number: 0 }],
      ['a composite with a request identity', { ...composite, requestIdentity: identity }],
      ['a composite with an authorization', { ...composite, authorizationRef: 'az' }],
      ['a control that is numbered', { ...control, number: 1 }],
      ['a control that is not settled', { ...control, state: 'running' }],
      ['a control with a request identity', { ...control, requestIdentity: identity }],
      ['a control without its receipt', { ...control, receiptIds: [] }],
    ]
    for (const [name, value, binding] of cases) expect(refused(value, binding), name).toBe('integrity')
  })
  it('refuses an action without an input', () => {
    expect(() => proveAttempt(leaf, { intent: {} } as Loose, 'b')).toThrow()
  })
})
