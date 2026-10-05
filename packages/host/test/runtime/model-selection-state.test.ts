import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { runRecordId } from '../../src/runtime/state/records.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import { createStateSessionControlFixture } from './fixtures/runtime-session-control.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

describe('what the State does today with a stale parameter read guard', () => {
  it('refuses the commit of an invocation whose read guard names a record revision that has moved', async () => {
    const world = await originalNativeFixture()
    const { directory, fixture, identity, reader, authority } = world
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
        value: { state: 'created' },
      })
      const { state, binding } = fixture
      const open = await state.open({
        requestId: 'selection-writer',
        authority,
        sessionId: 'fixture-session',
        mode: 'write',
        writerId: 'selection',
        ttlMs: 10_000,
      })
      const writerEpoch = open.claim?.writerEpoch
      if (writerEpoch === undefined) throw new Error('write claim missing')
      await state.admitInvocation({
        requestId: 'selection-admit',
        runId: 'fixture-run-old',
        targetActionId: null,
        baseRevision: 0,
        bindingId: binding.bindingId,
        writerEpoch,
        invocationId: 'selection-invocation',
        deadline: '2027-01-01T00:00:00Z',
        queryAllowance: 0,
      })
      // A record the invocation read, now one revision behind: the same rule that guards a
      // session parameter pointer the invocation was prepared from.
      await expect(
        state.closeInvocation({
          requestId: 'selection-close',
          invocationId: 'selection-invocation',
          state: 'prepared',
          readGuards: [{ recordId: runRecordId('fixture-run-old'), expectedRecordRevision: 99 }],
          domainReads: [],
          unresolvedInflightIds: [],
          observedQueryCount: 0,
        }),
      ).rejects.toMatchObject({ failure: { code: 'conflict', detailCode: 'read_guard' } })
    } finally {
      reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('what the session control accepts today', () => {
  async function fixture() {
    const f = await createStateSessionControlFixture()
    cleanup.push(f.close)
    return f
  }
  const writes = (db: Awaited<ReturnType<typeof fixture>>['db']) =>
    db.prepare('SELECT total_changes() n').get()?.n

  it('refuses a model switch and a next-request preset switch, with no writes', async () => {
    const f = await fixture()
    const before = writes(f.db)
    const base = f.command()
    const setModel = {
      ...base,
      command: {
        kind: 'set-model' as const,
        slot: 'primary' as const,
        route: 'route-1',
        model: 'model-a',
        thinking: null,
      },
    }
    const nextRequest = { ...base, command: { ...base.command, apply: 'next-request' as const } }
    for (const request of [setModel, nextRequest])
      expect(await f.store.submitSessionControl(request, f.context)).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'unsupported_session_control_command' },
      })
    expect(writes(f.db)).toBe(before)
  })

  it('records a next-run switch as accepted without any effective revision and leaves the parameters as they were', async () => {
    const f = await fixture()
    const initial = await f.store.readSessionControl({ sessionId: 'session' }, f.context)
    const result = await f.store.submitSessionControl(f.command('first', 0, 'base'), f.context)
    expect(result).toMatchObject({ ok: true, value: { status: 'accepted', effective: null } })
    const after = await f.store.readSessionControl({ sessionId: 'session' }, f.context)
    if (!initial.ok || !after.ok) throw new Error('session control read failed')
    // The control revision moved; the effective parameters, which a frame would carry, did not.
    expect(after.value.revision).toBe(initial.value.revision + 1)
    expect(after.value.parameters).toEqual(initial.value.parameters)
  })
})
