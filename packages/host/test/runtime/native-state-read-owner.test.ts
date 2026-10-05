import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createNativeStateReadOwner } from '../../src/runtime/state/native-read-owner.js'
import { digestOf } from '../../src/runtime/state/records.js'
import { fixtureRef } from './fixtures/assembly-maintenance-wire.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'

/**
 * Commits prepared Actions to the fixture run through real State invocations (64 per transition)
 * until `count` exist in total.
 * `from` is the position the previous call returned; the result is the position after this call.
 */
async function commitPreparedActions(
  fixture: Awaited<ReturnType<typeof originalNativeFixture>>,
  count: number,
  from: { committed: number; revision: number; writerEpoch: number | null } = {
    committed: 0,
    revision: 0,
    writerEpoch: null,
  },
) {
  const { authority, input } = fixture
  const { state, binding } = fixture.fixture
  const data = fixtureRef({ prompt: 'synthetic' })
  const target = {
    bindingId: binding.bindingId,
    contract: 'agh.tool',
    logicalName: 'tool',
    providerId: 'provider',
  }
  const deadline = '2027-01-01T00:00:00Z'
  const writerEpoch =
    from.writerEpoch ??
    (
      await state.open({
        requestId: 'native-read-bulk-writer',
        authority,
        sessionId: 'fixture-session',
        mode: 'write',
        writerId: 'native-read-bulk',
        ttlMs: 10_000,
      })
    ).claim?.writerEpoch
  if (writerEpoch === undefined) throw Error('write claim missing')
  let { committed, revision } = from
  for (let batch = revision; committed < count; batch++) {
    const invocationId = `native-read-invocation-${batch}`
    await state.admitInvocation({
      requestId: `native-read-admit-${batch}`,
      runId: 'fixture-run-old',
      targetActionId: null,
      baseRevision: revision,
      bindingId: binding.bindingId,
      writerEpoch: writerEpoch,
      invocationId,
      deadline,
      queryAllowance: 0,
    })
    await state.closeInvocation({
      requestId: `native-read-close-${batch}`,
      invocationId,
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    const actions = Array.from({ length: Math.min(64, count - committed) }, (_, index) => {
      const body = {
        key: `native-read-action-${String(committed + index).padStart(4, '0')}`,
        target,
        method: 'run',
        input: data,
        dependencies: [],
        retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
        obligation: 'mandatory' as const,
        deadline,
        resultSchema: data.schema,
        references: [],
      }
      return { ...body, intentFingerprint: digestOf(body) }
    })
    await state.advanceRun({
      commitId: `native-read-advance-${batch}`,
      guard: {
        authority,
        sessionId: 'fixture-session',
        runId: 'fixture-run-old',
        writerId: 'native-read-bulk',
        writerEpoch: writerEpoch,
        expectedRunRevision: revision,
        bindingId: binding.bindingId,
        invocationId,
        readGuards: [],
        queryUsage: null,
      },
      transition: {
        expectedRevision: revision,
        continuation: {
          namespace: 'agh.test',
          codecVersion: '1',
          data,
          provenance: { sourceRefs: [], producer: target, trustLabels: [] },
          createdAt: input.fixture.now,
          references: [],
        },
        consumeSignals: [],
        actions,
        next: { kind: 'continue' },
      },
    })
    committed += actions.length
    revision++
  }
  return { committed, revision, writerEpoch }
}

describe.skipIf(typeof process.getuid !== 'function')('original State native read snapshot', () => {
  it('reads committed Run and Binding from the original connection and rejects copies and damaged history', async () => {
    const native = await originalNativeFixture()
    const { directory, file, input, fixture, identity, grant, reader, authority } = native
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
        value: { state: 'created' },
      })
      const before = fixture.db.prepare('SELECT total_changes() n').get()?.n
      const snapshot = await reader.openVerifiedSnapshot('fixture-session', grant)
      const request = {
        snapshot,
        collection: 'records' as const,
        filter: {},
        order: 'asc' as const,
        cursor: null,
        limit: 1,
      }
      const first = await reader.scanVerifiedPage(snapshot, request, grant)
      expect(first.items).toHaveLength(1)
      expect(first.nextCursor).not.toBeNull()
      const second = await reader.scanVerifiedPage(snapshot, { ...request, cursor: first.nextCursor }, grant)
      expect(second.items).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      expect(new Set([...first.items, ...second.items].map((item) => item.schema.typeId))).toEqual(
        new Set(['agh.runtime/run-record@1', 'agh.runtime/run-binding@1']),
      )
      const [firstItem] = first.items
      const [secondItem] = second.items
      if (!firstItem || !secondItem) throw Error('paged records missing')
      expect(fixture.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
      const advanced = await fixture.state.open({
        requestId: 'native-read-next-commit',
        authority,
        sessionId: 'fixture-session',
        mode: 'write',
        writerId: 'native-read-writer',
        ttlMs: 10_000,
      })
      expect(advanced.snapshot.throughSeq).toBeGreaterThan(snapshot.throughSeq)
      const historical = await reader.scanVerifiedPage(snapshot, { ...request, limit: 500 }, grant)
      expect(historical.items.map((item) => item.recordId)).toEqual([firstItem.recordId, secondItem.recordId])
      await expect(reader.scanVerifiedPage({ ...snapshot }, request, grant)).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, snapshot: { ...snapshot } }, grant),
      ).rejects.toThrow()
      await expect(reader.scanVerifiedPage(snapshot, request, { ...grant })).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, cursor: 'invented' }, grant),
      ).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, filter: { runId: 'fixture-run-old' } }, grant),
      ).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, collection: 'record-versions' }, grant),
      ).rejects.toThrow()
      await expect(reader.scanVerifiedPage(snapshot, { ...request, limit: 501 }, grant)).rejects.toThrow()
      const foreign = new DatabaseSync(file)
      try {
        // The owner takes no database handle and no identity: such a key is refused, not ignored.
        expect(() =>
          createNativeStateReadOwner({
            originalState: fixture.state,
            runtimeScope: native.scope,
            // @ts-expect-error a database handle is not part of the owner's input
            originalDatabase: foreign,
          }),
        ).toThrow()
        expect(() =>
          createNativeStateReadOwner({
            originalState: fixture.state,
            runtimeScope: native.scope,
            // @ts-expect-error an identity module is not part of the owner's input
            originalIdentity: identity,
          }),
        ).toThrow()
      } finally {
        foreign.close()
      }
      const original = fixture.db
        .prepare('SELECT value_json FROM runtime_version_bodies WHERE record_id=?')
        .get(firstItem.recordId)?.value_json
      if (typeof original !== 'string') throw Error('original history missing')
      fixture.db
        .prepare("UPDATE runtime_version_bodies SET value_json='{}' WHERE record_id=?")
        .run(firstItem.recordId)
      await expect(reader.scanVerifiedPage(snapshot, request, grant)).rejects.toThrow()
      fixture.db
        .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=?')
        .run(original, firstItem.recordId)
      expect((await reader.scanVerifiedPage(snapshot, request, grant)).items).toHaveLength(1)
      input.fixture.now = '2026-10-03T00:02:00Z'
      await expect(reader.scanVerifiedPage(snapshot, request, grant)).rejects.toThrow()
      const fresh = await reader.openVerifiedSnapshot('fixture-session', grant)
      identity.revoke()
      await expect(reader.scanVerifiedPage(fresh, { ...request, snapshot: fresh }, grant)).rejects.toThrow()
    } finally {
      await reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

describe.skipIf(typeof process.getuid !== 'function')('native read snapshot admission bound', () => {
  it('admits exactly 128 simultaneous snapshots and refuses the rest before any read settles', async () => {
    const { directory, identity, grant, reader, fixture } = await originalNativeFixture()
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
      })
      const results = await Promise.allSettled(
        Array.from({ length: 129 }, () => reader.openVerifiedSnapshot('fixture-session', grant)),
      )
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(128)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    } finally {
      await reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf(typeof process.getuid !== 'function')('native read continuation replay', () => {
  it('returns the same page when a continuation is read again after its reply was lost', async () => {
    const { directory, identity, grant, reader, fixture } = await originalNativeFixture()
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
      })
      const snapshot = await reader.openVerifiedSnapshot('fixture-session', grant)
      const request = {
        snapshot,
        collection: 'records' as const,
        filter: {},
        order: 'asc' as const,
        cursor: null,
        limit: 1,
      }
      const first = await reader.scanVerifiedPage(snapshot, request, grant)
      expect(first.nextCursor).not.toBeNull()
      const next = { ...request, cursor: first.nextCursor }
      const delivered = await reader.scanVerifiedPage(snapshot, next, grant)
      const replayed = await reader.scanVerifiedPage(snapshot, next, grant)
      expect(replayed).toEqual(delivered)
      expect(replayed.items).toHaveLength(1)
    } finally {
      await reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf(typeof process.getuid !== 'function')('native read full page budget', () => {
  it('serves a full 500-item page and then the remainder from one fixed snapshot', async () => {
    const native = await originalNativeFixture()
    const { directory, identity, grant, reader, fixture } = native
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
      })
      await commitPreparedActions(native, 512)
      const snapshot = await reader.openVerifiedSnapshot('fixture-session', grant)
      const request = {
        snapshot,
        collection: 'records' as const,
        filter: {},
        order: 'asc' as const,
        cursor: null,
        limit: 500,
      }
      const first = await reader.scanVerifiedPage(snapshot, request, grant)
      expect(first.items).toHaveLength(500)
      expect(first.complete).toBe(false)
      expect(first.nextCursor).not.toBeNull()
      const next = { ...request, cursor: first.nextCursor }
      const second = await reader.scanVerifiedPage(snapshot, next, grant)
      expect(second.items).toHaveLength(514 - 500)
      expect(second.complete).toBe(true)
      expect(second.nextCursor).toBeNull()
      const ids = [...first.items, ...second.items].map((item) => item.recordId)
      expect(new Set(ids).size).toBe(514)
      expect(ids).toEqual([...ids].sort())
      expect(await reader.scanVerifiedPage(snapshot, request, grant)).toEqual(first)
    } finally {
      await reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
})

describe.skipIf(typeof process.getuid !== 'function')('native read snapshot slot release', () => {
  it('releases the reserved slot when an open is refused or cancelled in flight', async () => {
    const native = await originalNativeFixture()
    const { directory, identity, grant, reader, fixture } = native
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
      })
      const refused = await Promise.allSettled(
        Array.from({ length: 129 }, () => reader.openVerifiedSnapshot('absent-session', grant)),
      )
      expect(refused.every((result) => result.status === 'rejected')).toBe(true)
      const controller = new AbortController()
      const cancellable = native.bridge.grant(
        { ...native.context, signal: controller.signal },
        'fixture-session',
      )
      if (!cancellable) throw Error('test bridge refused the cancellable caller')
      const cancelled = Promise.allSettled(
        Array.from({ length: 8 }, () => reader.openVerifiedSnapshot('fixture-session', cancellable)),
      )
      controller.abort()
      expect((await cancelled).every((result) => result.status === 'rejected')).toBe(true)
      const admitted = await Promise.allSettled(
        Array.from({ length: 129 }, () => reader.openVerifiedSnapshot('fixture-session', grant)),
      )
      expect(admitted.filter((result) => result.status === 'fulfilled')).toHaveLength(128)
    } finally {
      await reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
})

describe.skipIf(typeof process.getuid !== 'function')('native read visibility', () => {
  it('shows only controlled Run, Binding and Action records from the fixed snapshot', async () => {
    const native = await originalNativeFixture()
    const { directory, identity, grant, reader, fixture } = native
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
      })
      const position = await commitPreparedActions(native, 3)
      const snapshot = await reader.openVerifiedSnapshot('fixture-session', grant)
      await commitPreparedActions(native, 5, position)
      const scan = (
        target: typeof snapshot,
        collection: 'records' | 'actions' | 'signals',
        filter: Record<string, unknown> = {},
      ) =>
        reader.scanVerifiedPage(
          target,
          { snapshot: target, collection, filter, order: 'asc', cursor: null, limit: 500 } as never,
          grant,
        )
      const records = await scan(snapshot, 'records')
      expect(records.items).toHaveLength(5)
      expect(records.items.map((item) => item.schema.typeId).sort()).toEqual([
        'agh.runtime/action-record@1',
        'agh.runtime/action-record@1',
        'agh.runtime/action-record@1',
        'agh.runtime/run-binding@1',
        'agh.runtime/run-record@1',
      ])
      const stored = fixture.db.prepare('SELECT COUNT(*) n FROM runtime_records').get()?.n
      expect(Number(stored)).toBeGreaterThan(records.items.length)
      expect(Object.isFrozen(records)).toBe(true)
      expect(records.items.every((item) => Object.isFrozen(item))).toBe(true)
      const actions = await scan(snapshot, 'actions', { runId: 'fixture-run-old' })
      expect(actions.items).toHaveLength(3)
      expect(
        (await scan(snapshot, 'actions', { runId: 'fixture-run-old', states: ['completed'] })).items,
      ).toHaveLength(0)
      expect((await scan(snapshot, 'signals', { runId: 'fixture-run-old' })).items).toHaveLength(0)
      const later = await reader.openVerifiedSnapshot('fixture-session', grant)
      expect((await scan(later, 'records')).items).toHaveLength(7)
      expect((await scan(later, 'actions', { runId: 'fixture-run-old' })).items).toHaveLength(5)
      expect((await scan(snapshot, 'actions', { runId: 'fixture-run-old' })).items).toHaveLength(3)
    } finally {
      await reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
})

describe.skipIf(typeof process.getuid !== 'function')('native read integrity', () => {
  it('refuses a snapshot whose history was pruned or whose ledger boundary changed, then recovers when restored', async () => {
    const { directory, identity, grant, reader, fixture } = await originalNativeFixture()
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
      })
      const snapshot = await reader.openVerifiedSnapshot('fixture-session', grant)
      const request = {
        snapshot,
        collection: 'records' as const,
        filter: {},
        order: 'asc' as const,
        cursor: null,
        limit: 500,
      }
      const baseline = await reader.scanVerifiedPage(snapshot, request, grant)
      expect(baseline.items).toHaveLength(2)
      const target = baseline.items[0]
      if (!target) throw Error('baseline record missing')
      const body = fixture.db
        .prepare('SELECT * FROM runtime_version_bodies WHERE record_id=? AND record_revision=?')
        .get(target.recordId, target.recordRevision)
      if (typeof body?.value_json !== 'string') throw Error('original body missing')
      fixture.db
        .prepare('DELETE FROM runtime_version_bodies WHERE record_id=? AND record_revision=?')
        .run(target.recordId, target.recordRevision)
      await expect(reader.scanVerifiedPage(snapshot, request, grant)).rejects.toThrow()
      fixture.db
        .prepare('INSERT INTO runtime_version_bodies (record_id,record_revision,value_json) VALUES (?,?,?)')
        .run(target.recordId, target.recordRevision, body.value_json)
      expect(await reader.scanVerifiedPage(snapshot, request, grant)).toEqual(baseline)
      const boundary = fixture.db
        .prepare('SELECT integrity_digest FROM events WHERE session_key=? AND seq=?')
        .get(snapshot.sessionId, snapshot.throughSeq)?.integrity_digest
      if (typeof boundary !== 'string') throw Error('original ledger boundary missing')
      fixture.db
        .prepare('UPDATE events SET integrity_digest=? WHERE session_key=? AND seq=?')
        .run('0'.repeat(64), snapshot.sessionId, snapshot.throughSeq)
      await expect(reader.scanVerifiedPage(snapshot, request, grant)).rejects.toThrow()
      fixture.db
        .prepare('UPDATE events SET integrity_digest=? WHERE session_key=? AND seq=?')
        .run(boundary, snapshot.sessionId, snapshot.throughSeq)
      expect(await reader.scanVerifiedPage(snapshot, request, grant)).toEqual(baseline)
    } finally {
      await reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
