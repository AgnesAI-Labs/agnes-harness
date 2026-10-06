import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ControlVersionNote,
  createControlScan,
  noteControlVersion,
  runAcceptsNewWork,
} from '../src/runtime/state/control.js'
import {
  matchesKnownSchema,
  PROVIDER_STATE_SCHEMA,
  providerStateRecordId,
  RESOLUTION_SCHEMA,
  type RecordOwner,
  resolutionRecordId,
  stableId,
  stateSchemaDefinition,
  TIMER_SCHEMA,
  timerRecordId,
  WAIT_SCHEMA,
  waitRecordId,
} from '../src/runtime/state/records.js'
import { RuntimeStateDatabase } from '../src/runtime/state/transactions.js'

const provider = (over: Record<string, unknown> = {}) => ({
  actionId: 'action-1',
  providerRevision: 0,
  state: 'runnable',
  continuation: null,
  waitId: null,
  writerEpoch: 0,
  termination: null,
  ...over,
})
const wait = (over: Record<string, unknown> = {}) => ({
  waitId: 'wait-1',
  runId: 'run',
  targetActionId: null,
  condition: { anyOf: [], deadline: '2026-05-01T00:00:00Z' },
  registeredByCommitId: 'commit-1',
  state: 'waiting',
  matchedSignalIds: [],
  deadlineSignalId: null,
  ...over,
})
const timer = (over: Record<string, unknown> = {}) => ({
  timerId: 'timer-1',
  runId: 'run',
  targetActionId: null,
  waitId: 'wait-1',
  dueAt: '2026-05-01T00:00:00Z',
  state: 'scheduled',
  signalId: 'signal-1',
  registeredByCommitId: 'commit-1',
  firedByCommitId: null,
  ...over,
})
const resolution = (over: Record<string, unknown> = {}) => ({
  resolutionId: stableId('res', 'action-1'),
  actionId: 'action-1',
  previousReceiptIds: [],
  selectedReceiptId: null,
  evidenceRefs: [],
  state: 'unresolved',
  ownerRef: { kind: 'reconciliation', id: 'owner-1' },
  nextCheckAt: null,
  reason: 'no answer',
  ...over,
})
const unresolvedAction = (over: Record<string, unknown> = {}) => ({
  actionId: 'action-1',
  state: 'unknown',
  resolutionId: stableId('res', 'action-1'),
  ownerRef: { kind: 'reconciliation', id: 'owner-1' },
  ...over,
})
const note = (recordId: string, value: unknown, revision = 1): ControlVersionNote => ({
  record_id: recordId,
  record_revision: revision,
  commit_id: 'commit-1',
  value_json: JSON.stringify(value),
})
const scanned = (version: ControlVersionNote) => () => noteControlVersion(createControlScan(), version)

describe('the three record schemas', () => {
  it('are registered under their own identities and known to State', () => {
    const refs = [PROVIDER_STATE_SCHEMA, WAIT_SCHEMA, TIMER_SCHEMA]
    expect(refs.map((ref) => ref.typeId)).toEqual([
      'agh.runtime/provider-state@1',
      'agh.runtime/wait-record@1',
      'agh.runtime/timer-record@1',
    ])
    expect(new Set(refs.map((ref) => ref.digest)).size).toBe(3)
    for (const ref of refs) expect(matchesKnownSchema(ref)).toBe(true)
    expect(matchesKnownSchema({ ...WAIT_SCHEMA, digest: 'f'.repeat(64) })).toBe(false)
    expect(stateSchemaDefinition(PROVIDER_STATE_SCHEMA)).toBe('ProviderStateValue')
    expect(stateSchemaDefinition(WAIT_SCHEMA)).toBe('WaitRecordValue')
    expect(stateSchemaDefinition(TIMER_SCHEMA)).toBe('TimerRecordValue')
    expect(PROVIDER_STATE_SCHEMA).toEqual(RuntimeSchemaRefs.ProviderStateValue)
  })
  it('accept the wire values the records are written from', () => {
    expect(validateRuntime('ProviderStateValue', provider()).ok).toBe(true)
    expect(validateRuntime('WaitRecordValue', wait()).ok).toBe(true)
    expect(validateRuntime('TimerRecordValue', timer()).ok).toBe(true)
    expect(validateRuntime('WaitRecordValue', wait({ state: 'late' })).ok).toBe(false)
  })
  it('registers the resolution record and accepts the wire value it is written from', () => {
    expect(RESOLUTION_SCHEMA.typeId).toBe('agh.runtime/resolution-record@1')
    expect(matchesKnownSchema(RESOLUTION_SCHEMA)).toBe(true)
    expect(stateSchemaDefinition(RESOLUTION_SCHEMA)).toBe('ResolutionRecordValue')
    expect(resolutionRecordId('r')).toBe('resolution:r')
    expect(validateRuntime('ResolutionRecordValue', resolution()).ok).toBe(true)
    expect(validateRuntime('ResolutionRecordValue', resolution({ state: 'lost' })).ok).toBe(false)
  })
  it('get record ids with distinct prefixes that carry the owning id', () => {
    expect(providerStateRecordId('a')).toBe('provider:a')
    expect(waitRecordId('w')).toBe('wait:w')
    expect(timerRecordId('t')).toBe('timer:t')
  })
})

describe('what the control scan does with the new records', () => {
  it('accepts a resolution through its states and an unresolved action that names its owner', () => {
    const id = `resolution:${stableId('res', 'action-1')}`
    expect(scanned(note(id, resolution()))).not.toThrow()
    expect(scanned(note(id, resolution({ state: 'conflicting' }), 2))).not.toThrow()
    expect(
      scanned(note(id, resolution({ state: 'resolved', selectedReceiptId: 'receipt-1' }), 3)),
    ).not.toThrow()
    expect(scanned(note('action:action-1', unresolvedAction()))).not.toThrow()
    expect(scanned(note('action:action-1', unresolvedAction({ state: 'reconciling' }), 2))).not.toThrow()
    expect(
      scanned(
        note(
          'action:action-1',
          unresolvedAction({ state: 'settled', ownerRef: { kind: 'run', id: 'r' } }),
          3,
        ),
      ),
    ).not.toThrow()
  })
  it.each([
    ['resolution id that names another record', 'resolution:other', resolution()],
    [
      'resolution of another action',
      `resolution:${stableId('res', 'action-1')}`,
      resolution({ actionId: 'action-2' }),
    ],
    [
      'resolution with an unknown state',
      `resolution:${stableId('res', 'action-1')}`,
      resolution({ state: 'lost' }),
    ],
    [
      'resolved resolution without a receipt',
      `resolution:${stableId('res', 'action-1')}`,
      resolution({ state: 'resolved' }),
    ],
    [
      'open resolution that selects a receipt',
      `resolution:${stableId('res', 'action-1')}`,
      resolution({ selectedReceiptId: 'receipt-1' }),
    ],
    [
      'open resolution without a reconciliation owner',
      `resolution:${stableId('res', 'action-1')}`,
      resolution({ ownerRef: { kind: 'run', id: 'r' } }),
    ],
    ['unknown action without a resolution', 'action:action-1', unresolvedAction({ resolutionId: null })],
    [
      'unknown action with another action resolution',
      'action:action-1',
      unresolvedAction({ resolutionId: stableId('res', 'action-2') }),
    ],
    [
      'reconciling action owned by its run',
      'action:action-1',
      unresolvedAction({ state: 'reconciling', ownerRef: { kind: 'run', id: 'r' } }),
    ],
  ])('refuses a %s', (_name, recordId, value) => {
    expect(scanned(note(recordId, value))).toThrow()
  })
  it('accepts well-formed versions of each', () => {
    expect(scanned(note('provider:action-1', provider()))).not.toThrow()
    expect(
      scanned(note('provider:action-1', provider({ state: 'waiting', waitId: 'wait-1' }), 2)),
    ).not.toThrow()
    const error = {
      code: 'internal',
      detailCode: 'x',
      message: 'x',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'd',
    }
    const ended = { outcome: 'failed', error }
    expect(scanned(note('provider:action-1', provider({ state: 'draining' }), 2))).not.toThrow()
    expect(
      scanned(note('provider:action-1', provider({ state: 'draining', termination: ended }), 3)),
    ).not.toThrow()
    expect(
      scanned(note('provider:action-1', provider({ state: 'failed', termination: ended }), 4)),
    ).not.toThrow()
    expect(scanned(note('provider:action-1', provider({ state: 'completed' }), 4))).not.toThrow()
    expect(scanned(note('wait:wait-1', wait()))).not.toThrow()
    expect(scanned(note('wait:wait-1', wait({ state: 'ready' }), 2))).not.toThrow()
    expect(scanned(note('wait:wait-1', wait({ state: 'cancelled' }), 2))).not.toThrow()
    expect(scanned(note('timer:timer-1', timer()))).not.toThrow()
    expect(
      scanned(note('timer:timer-1', timer({ state: 'fired', firedByCommitId: 'commit-2' }), 2)),
    ).not.toThrow()
    expect(scanned(note('timer:timer-1', timer({ state: 'cancelled' }), 2))).not.toThrow()
  })
  it.each([
    ['provider id that names another action', 'provider:other', provider()],
    ['provider with an unknown state', 'provider:action-1', provider({ state: 'paused' })],
    ['waiting provider without a wait', 'provider:action-1', provider({ state: 'waiting' })],
    ['runnable provider that still names a wait', 'provider:action-1', provider({ waitId: 'wait-1' })],
    ['provider with an empty action id', 'provider:', provider({ actionId: '' })],
    ['failed provider without a termination', 'provider:action-1', provider({ state: 'failed' })],
    [
      'completed provider with a termination',
      'provider:action-1',
      provider({
        state: 'completed',
        termination: { outcome: 'failed', error: { code: 'internal', detailCode: 'x' } },
      }),
    ],
    [
      'runnable provider with a termination',
      'provider:action-1',
      provider({ termination: { outcome: 'cancelled', error: { code: 'cancelled', detailCode: 'x' } } }),
    ],
    ['wait with an empty id', 'wait:', wait({ waitId: '' })],
    ['timer with an empty id', 'timer:', timer({ timerId: '' })],
    ['wait id that names another wait', 'wait:other', wait()],
    ['wait without a run', 'wait:wait-1', wait({ runId: '' })],
    ['wait with an unknown state', 'wait:wait-1', wait({ state: 'late' })],
    ['wait without matched signals', 'wait:wait-1', wait({ matchedSignalIds: null })],
    ['timer id that names another timer', 'timer:other', timer()],
    ['timer without a run', 'timer:timer-1', timer({ runId: '' })],
    ['timer with an unknown state', 'timer:timer-1', timer({ state: 'late' })],
    ['fired timer without a fire commit', 'timer:timer-1', timer({ state: 'fired' })],
    ['scheduled timer with a fire commit', 'timer:timer-1', timer({ firedByCommitId: 'commit-2' })],
  ])('refuses a %s', (_name, recordId, value) => {
    expect(scanned(note(recordId, value))).toThrow()
  })
  it('refuses a body that is not an object', () => {
    expect(scanned(note('wait:wait-1', []))).toThrow()
  })
})

describe('the run state gate', () => {
  it('lets only runs that are still working take new work', () => {
    for (const state of ['admitted', 'runnable', 'waiting']) expect(runAcceptsNewWork(state)).toBe(true)
    for (const state of [
      'failing',
      'cancelling',
      'draining',
      'succeeded',
      'failed',
      'cancelled',
      'frozen',
      'migrating',
      'blocked_incompatible',
      'blocked_integrity',
      '',
    ])
      expect(runAcceptsNewWork(state)).toBe(false)
  })
})

const authority = { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 }
const owner: RecordOwner = {
  authority,
  scope: { installationId: 'installation', kind: 'installation' },
  ownerBinding: {
    bindingId: 'run-binding',
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'default-state',
  },
}
const now = Date.parse('2026-04-01T00:00:00Z')
const dirs: string[] = []
const stores: RuntimeStateDatabase[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
type Owner = {
  tx<T>(method: string, id: string, body: () => T | Promise<T>): Promise<T>
  requireSession(sessionId: string): Promise<unknown>
  writeCommit(input: Record<string, unknown>): unknown
}

async function seeded(file: string) {
  const store = new RuntimeStateDatabase({ file, authority, now: () => now })
  stores.push(store)
  const data = {
    kind: 'inline' as const,
    schema: RuntimeSchemaRefs.StateLeaseRecordValue,
    value: { sessionId: 'input', lastWriterEpoch: 0, claim: null },
    digest: canonicalJsonDigest({ sessionId: 'input', lastWriterEpoch: 0, claim: null }),
    bytes: 52,
  }
  await store.createRun({
    scope: owner.scope as never,
    admission: {
      ticketId: 'ticket',
      fingerprint: 'a'.repeat(64),
      releaseSetId: 'release',
      bindingId: 'run-binding',
      packagePinReceipt: data,
      runId: 'run',
      sessionId: 'session',
      lane: 'main',
      workspaceId: 'workspace',
      input: data,
      admittedAt: '2026-04-01T00:00:00.000Z',
      deadline: '2026-05-01T00:00:00Z',
      conversation: null,
    },
  })
  return store
}

function commit(
  store: RuntimeStateDatabase,
  commitId: string,
  creates: { id: string; schema: unknown; value: unknown }[],
) {
  const target = store as unknown as Owner
  return target.tx('records-fixture', commitId, async () => {
    const verified = await target.requireSession('session')
    target.writeCommit({
      sessionId: 'session',
      verified,
      commitId,
      at: '2026-04-01T00:00:00.000Z',
      fingerprint: canonicalJsonDigest(commitId),
      runId: 'run',
      actionId: null,
      writerEpoch: 0,
      runRevision: 0,
      actionIds: [],
      creates: creates.map((item) => ({
        recordId: item.id,
        schema: item.schema,
        minReader: 2,
        recordRevision: 1,
        owner,
        value: item.value,
      })),
      updates: [],
      sides: [],
    })
  })
}

describe('the new records in a real State database', () => {
  it('survive a close and reopen and pass the full scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-records-'))
    dirs.push(dir)
    const file = join(dir, 'state.sqlite')
    const first = await seeded(file)
    await commit(first, 'records-1', [
      {
        id: 'provider:action-1',
        schema: PROVIDER_STATE_SCHEMA,
        value: provider({ state: 'waiting', waitId: 'wait-1' }),
      },
      { id: 'wait:wait-1', schema: WAIT_SCHEMA, value: wait({ targetActionId: 'action-1' }) },
      { id: 'timer:timer-1', schema: TIMER_SCHEMA, value: timer({ targetActionId: 'action-1' }) },
    ])
    first.close()
    const second = new RuntimeStateDatabase({ file, authority, now: () => now })
    stores.push(second)
    await expect((second as unknown as Owner).requireSession('session')).resolves.toBeDefined()
    const rows = (
      second as unknown as { db: { prepare(sql: string): { all(): { record_id: string }[] } } }
    ).db
      .prepare(
        "SELECT record_id FROM runtime_records WHERE record_id LIKE 'provider:%' OR record_id LIKE 'wait:%' OR record_id LIKE 'timer:%' ORDER BY record_id",
      )
      .all()
    expect(rows.map((row) => row.record_id)).toEqual(['provider:action-1', 'timer:timer-1', 'wait:wait-1'])
  })
  it('make the full scan refuse a stored version that breaks its invariant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-records-'))
    dirs.push(dir)
    const file = join(dir, 'state.sqlite')
    const first = await seeded(file)
    await commit(first, 'records-bad', [
      { id: 'provider:action-1', schema: PROVIDER_STATE_SCHEMA, value: provider({ state: 'waiting' }) },
    ])
    first.close()
    const second = new RuntimeStateDatabase({ file, authority, now: () => now })
    stores.push(second)
    await expect((second as unknown as Owner).requireSession('session')).rejects.toMatchObject({
      failure: { detailCode: 'integrity', message: 'provider state wait does not match its state' },
    })
  })
})
