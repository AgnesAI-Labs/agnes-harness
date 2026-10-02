import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  callContext,
  createProjectionFixture,
  inline,
  listQuery,
  sessionScope,
} from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import { createReferenceRegistry } from '../index.js'
import { PROJECTION_PROVIDER } from './projection.js'
import { openReferenceProjection } from './projection-contract.js'

const opened: { directory: string; close(): void }[] = []
afterEach(() => {
  // Windows refuses to remove a directory while the database inside it is still open.
  for (const { directory, close } of opened.splice(0)) {
    close()
    rmSync(directory, { recursive: true, force: true })
  }
})

function fresh() {
  const directory = mkdtempSync(join(tmpdir(), 'reference-projection-'))
  const path = join(directory, 'projection.sqlite')
  const fixture = createProjectionFixture()
  const store = openReferenceProjection(path, fixture)
  opened.push({ directory, close: () => store.current().close() })
  return { path, fixture, store }
}

const added = (n: number, board = 'open', artifact?: string): Wire.DomainEvent => {
  const schema = { typeId: 'conformance.tasks/added@1', revision: 1, digest: 'a'.repeat(64) }
  const source = { bindingId: 'unit', contract: 'agh.projection', logicalName: 'tasks', providerId: 'unit' }
  return {
    eventId: `unit-${n}`,
    typeId: schema.typeId,
    schema,
    source,
    scope: sessionScope('unit'),
    occurredAt: '2026-10-01T00:00:00.000Z',
    payload: inline(schema, {
      taskId: `task-${n}`,
      board,
      title: `Task ${n}`,
      ...(artifact ? { artifact } : {}),
    }),
    idempotencyKey: `unit-${n}`,
    causation: {},
    principalRef: 'unit-author',
    correlationId: null,
    provenance: { sourceRefs: [], producer: source, trustLabels: [] },
  }
}

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.detailCode)
  return outcome.value
}

describe('reference projection: checkpoint and tail', () => {
  it('rebuilds the same cut from checkpoints, from the journal alone and after a reopen', async () => {
    const { path, store } = fresh()
    for (let n = 0; n < 10; n++) store.current().append([added(n)])
    expect(
      store
        .current()
        .checkpoints()
        .map((row) => row.revision),
    ).toEqual([4, 8])
    const before = value(await store.current().snapshot(listQuery('unit', 20), callContext()))
    expect(before.items.map((view) => view.viewId)).toEqual(Array.from({ length: 10 }, (_, n) => `task-${n}`))
    store.reopen()
    const reopened = value(await store.current().snapshot(listQuery('unit', 20), callContext()))
    expect(reopened.items).toEqual(before.items)
    store.current().close()
    const db = new DatabaseSync(path)
    db.exec('DELETE FROM checkpoints')
    db.close()
    store.reopen()
    const replayed = value(await store.current().snapshot(listQuery('unit', 20), callContext()))
    expect(replayed.items).toEqual(before.items)
  })

  it('keeps the checkpoint and the cut before an event the reducer refuses', async () => {
    const { fixture, store } = fresh()
    store.current().append([added(1), added(2), added(3)])
    const broken = { ...added(4), eventId: 'unit-broken', typeId: 'conformance.tasks/broken@1' }
    store.current().append([broken, ...Array.from({ length: 6 }, (_, n) => added(10 + n))])
    expect(store.current().checkpoints()).toEqual([])
    const cut = value(await store.current().snapshot(listQuery('unit', 20), callContext()))
    expect(cut.projectionRevision).toBe(3)
    expect(cut.items.map((view) => view.viewId)).toEqual(['task-1', 'task-2', 'task-3'])
    expect(fixture.prepared()).toBe(0)
  })

  it('trims a closed board, the private note and a hidden artifact before the selector and recheck', async () => {
    const { fixture, store } = fresh()
    store.current().append([added(1), added(2, 'vault'), added(3, 'open', 'art')])
    fixture.gate.hideArtifact('art')
    const page = value(await store.current().snapshot(listQuery('unit', 20), callContext()))
    expect(page.items.map((view) => view.viewId)).toEqual(['task-1'])
    expect(JSON.stringify(page)).not.toContain('private-')
    expect(JSON.stringify(page)).not.toContain('Task 2')
    expect(JSON.stringify(page)).not.toContain('Task 3')
  })
})

describe('reference projection: registry and window scope', () => {
  it('fills the projection slot of the reference registry', () => {
    const slot = createReferenceRegistry([PROJECTION_PROVIDER]).find(
      (item) => item.contract === 'agh.projection',
    )
    expect(slot?.provider).toEqual(PROJECTION_PROVIDER)
    expect(slot?.providerFile).toBe('examples/runtime-reference/src/providers/projection.ts')
    expect(existsSync(new URL(`../../../../${slot?.providerFile}`, import.meta.url))).toBe(true)
  })

  it('reads the window scope from the caller and refuses a session outside it', async () => {
    const { store } = fresh()
    const outside = { ...callContext(), scope: sessionScope('elsewhere') }
    const refused = await store.current().openConversation({ sessionId: 'unit', limit: 5 }, outside)
    expect(refused).toMatchObject({ ok: false, error: { detailCode: 'permission_denied' } })
  })
})
