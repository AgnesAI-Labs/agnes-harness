import { rmSync } from 'node:fs'
import type { SnapshotRef, StateScanRequest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { inWindow } from '../../src/runtime/state/native-read-owner.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import { commitPreparedActions, FIXTURE_RUN, FIXTURE_SESSION } from './fixtures/state-query-fixture.js'

type Native = Awaited<ReturnType<typeof originalNativeFixture>>
const req = (
  snapshot: SnapshotRef,
  collection: string,
  filter: Record<string, unknown> = {},
  cursor: string | null = null,
  limit = 500,
) => ({ snapshot, collection, filter, order: 'asc', cursor, limit }) as unknown as StateScanRequest

async function withNative(body: (native: Native) => Promise<void>) {
  const native = await originalNativeFixture()
  try {
    await native.fixture.coordinator.coordinate(native.fixture.draft(), native.fixture.context())
    await body(native)
  } finally {
    native.reader.close()
    native.identity.close()
    await native.fixture.close()
    rmSync(native.directory, { recursive: true, force: true })
  }
}

describe.skipIf(typeof process.getuid !== 'function')('native owner windows, point reads and packing', () => {
  it('shows only the action window to an action reader, and reads one record without paging', async () => {
    await withNative(async (native) => {
      const { context, reader, fixture } = native
      await commitPreparedActions(native, 3)
      const snapshot = await reader.openVerifiedSnapshot(FIXTURE_SESSION, context)
      const all = await reader.scanVerifiedPage(
        snapshot,
        req(snapshot, 'actions', { runId: FIXTURE_RUN }),
        context,
      )
      const [mine, sibling] = [all.items[0], all.items[1]]
      if (!mine || !sibling) throw Error('fixture actions missing')
      const target = (mine.value as { actionId: string }).actionId
      const window = { kind: 'action' as const, runId: FIXTURE_RUN, actionId: target }
      const seen = await reader.scanVerifiedPage(snapshot, req(snapshot, 'records'), context, { window })
      expect(seen.items.map((item) => item.schema.typeId).sort()).toEqual([
        'agh.runtime/action-record@1',
        'agh.runtime/run-binding@1',
        'agh.runtime/run-record@1',
      ])
      expect(
        await reader.readVerifiedRecord(snapshot, sibling.recordId, sibling.schema, context, window),
      ).toBeNull()
      expect(
        (await reader.readVerifiedRecord(snapshot, mine.recordId, mine.schema, context, window))?.recordId,
      ).toBe(mine.recordId)
      const before = fixture.db.prepare('SELECT total_changes() n').get()?.n
      await reader.readVerifiedRecord(snapshot, sibling.recordId, sibling.schema, context, window)
      expect(fixture.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
    })
  }, 120_000)

  it('binds a cursor to its window so another window cannot continue it', async () => {
    await withNative(async (native) => {
      const { context, reader } = native
      await commitPreparedActions(native, 3)
      const snapshot = await reader.openVerifiedSnapshot(FIXTURE_SESSION, context)
      const first = await reader.scanVerifiedPage(snapshot, req(snapshot, 'records', {}, null, 1), context, {
        window: { kind: 'run', runId: FIXTURE_RUN },
      })
      expect(first.nextCursor).not.toBeNull()
      await expect(
        reader.scanVerifiedPage(snapshot, req(snapshot, 'records', {}, first.nextCursor, 1), context, {
          window: { kind: 'session' },
        }),
      ).rejects.toThrow()
    })
  }, 120_000)

  it('lets pack shorten a page and continues from the last included item', async () => {
    await withNative(async (native) => {
      const { context, reader } = native
      await commitPreparedActions(native, 4)
      const snapshot = await reader.openVerifiedSnapshot(FIXTURE_SESSION, context)
      const seen: string[] = []
      let cursor: string | null = null
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await reader.scanVerifiedPage(snapshot, req(snapshot, 'records', {}, cursor), context, {
          pack: () => 2,
        })
        expect(page.items.length).toBeLessThanOrEqual(2)
        seen.push(...page.items.map((item) => item.recordId))
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      expect(new Set(seen).size).toBe(6)
      await expect(
        reader.scanVerifiedPage(snapshot, req(snapshot, 'records'), context, { pack: () => 0 }),
      ).rejects.toThrow()
    })
  }, 120_000)

  it('frees the reserved slot on release while other snapshots stay readable', async () => {
    await withNative(async (native) => {
      const { context, reader } = native
      const opened = await Promise.allSettled(
        Array.from({ length: 129 }, () => reader.openVerifiedSnapshot(FIXTURE_SESSION, context)),
      )
      const ok = opened.filter(
        (item): item is PromiseFulfilledResult<SnapshotRef> => item.status === 'fulfilled',
      )
      expect(ok.length).toBe(128)
      await expect(reader.openVerifiedSnapshot(FIXTURE_SESSION, context)).rejects.toThrow()
      const [first, second] = [ok[0]?.value, ok[1]?.value]
      if (!first || !second) throw Error('snapshots missing')
      reader.releaseSnapshot(first, context)
      const again = await reader.openVerifiedSnapshot(FIXTURE_SESSION, context)
      expect(again.snapshotId).not.toBe(first.snapshotId)
      await expect(reader.scanVerifiedPage(first, req(first, 'records'), context)).rejects.toThrow()
      expect(
        (await reader.scanVerifiedPage(second, req(second, 'records'), context)).items.length,
      ).toBeGreaterThan(0)
    })
  }, 120_000)

  it('reports the session facts of an open', async () => {
    await withNative(async ({ context, reader }) => {
      const result = await reader.openVerifiedResult(FIXTURE_SESSION, context)
      expect(result.snapshot.sessionId).toBe(FIXTURE_SESSION)
      expect(result.formatVersion).toBeGreaterThan(0)
      expect([1, 2]).toContain(result.minReader)
      expect(result.parent).toBeNull()
    })
  }, 60_000)

  it('decides window membership per record kind', () => {
    const rel = (
      kind: Parameters<typeof inWindow>[1]['kind'],
      actionId: string | null,
      target: string | null,
    ) => ({
      runId: 'r1',
      actionId,
      target,
      kind,
    })
    const action = { kind: 'action' as const, runId: 'r1', actionId: 'a1' }
    expect(inWindow({ kind: 'session' }, rel('signal', null, 'zzz'))).toBe(true)
    expect(inWindow({ kind: 'run', runId: 'r2' }, rel('run', null, null))).toBe(false)
    expect(inWindow({ kind: 'run', runId: 'r1' }, rel('action', 'a2', null))).toBe(true)
    expect(inWindow(action, rel('run', null, null))).toBe(true)
    expect(inWindow(action, rel('binding', null, null))).toBe(true)
    expect(inWindow(action, rel('action', 'a1', null))).toBe(true)
    expect(inWindow(action, rel('action', 'a2', null))).toBe(false)
    expect(inWindow(action, rel('attempt', 'a1', null))).toBe(true)
    expect(inWindow(action, rel('attempt', 'a2', null))).toBe(false)
    expect(inWindow(action, rel('signal', null, 'a1'))).toBe(true)
    expect(inWindow(action, rel('signal', null, 'a2'))).toBe(false)
    expect(inWindow(action, rel('signal', null, null))).toBe(false)
    expect(inWindow({ ...action, runId: 'r2' }, rel('action', 'a1', null))).toBe(false)
  })
})
