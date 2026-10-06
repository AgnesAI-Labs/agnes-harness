import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DomainStore, fail, type OutboxSink, openDomainStore } from '../../src/runtime/events/outbox.js'
import { createEventsProvider, type EventsGate } from '../../src/runtime/providers/events.js'
import { openEvents, producer, publication, read, reader, testGate } from './fixtures/events-issuer.js'

const schema = (typeId: string): Wire.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest(typeId),
})
const inline = (ref: Wire.SchemaRef, value: Wire.JsonValue): Wire.DataRef => ({
  kind: 'inline',
  schema: ref,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})
const stateSchema = schema('acme.tasks/state@1')
const signalSchema = schema('acme.tasks/wake@1')
const binding = {
  bindingId: 'binding-1',
  contract: 'agh.projection',
  logicalName: 'tasks',
  providerId: 'p-1',
}
const workspace = {
  kind: 'workspace' as const,
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'w-1',
}
const session = { ...workspace, kind: 'session' as const, sessionId: 'session-1' }
const owner: Wire.RecordOwner = {
  authority: { authorityId: 'authority-1', tenantId: 'tenant-1', authorityEpoch: 1 },
  scope: workspace,
  ownerBinding: binding,
}
const signal: Wire.DomainDispatch = {
  key: 'wake',
  kind: 'signal',
  runId: 'run-1',
  typeId: signalSchema.typeId,
  schema: signalSchema,
  payload: inline(signalSchema, { go: true }),
}
const operator: Wire.CallContextWire = {
  principalRef: 'operator-1',
  scope: workspace,
  bindingId: 'binding-admin',
  invocationId: 'invocation-1',
  deadline: '2026-10-02T00:00:00Z',
  traceRef: 'trace-1',
  authorizationRef: 'authorization-1',
}

const event = (eventId: string, commandId: string): Wire.DomainEvent => ({
  eventId,
  typeId: signalSchema.typeId,
  schema: signalSchema,
  source: binding,
  scope: session,
  occurredAt: '2026-10-01T00:00:00Z',
  payload: inline(signalSchema, { go: true }),
  idempotencyKey: `${commandId}/wake`,
  causation: { commandId },
  principalRef: 'alice',
  correlationId: null,
  provenance: { sourceRefs: [], producer: binding, trustLabels: [] },
})

/** Writes what one accepted runtime-accepted command commits: journal, state, event record and dispatch. */
function commit(store: DomainStore, n: number, fault?: () => void) {
  const commandId = `cmd-${n}`
  return store.transaction((tx) => {
    const revision = tx.state().revision + 1
    tx.putState({ value: inline(stateSchema, { n }), revision })
    tx.putEvent({
      event: event(`fact-${n}`, commandId),
      authorityId: 'authority-1',
      sequence: tx.lastSequence() + 1,
      aggregate: { authorityId: 'authority-1', typeId: 'acme.tasks/board@1', id: 'board-1', revision },
      fingerprint: canonicalJsonDigest(`fact-${n}`),
    })
    tx.putDispatch({
      commandId,
      key: 'wake',
      destination: 'runtime-inbox',
      sourceCommitId: `commit-${n}`,
      event: event(`wake-${n}`, commandId),
      dispatch: signal,
      fingerprint: canonicalJsonDigest(`wake-${n}`),
    })
    fault?.()
    tx.putCommand({
      key: canonicalJsonDigest(`request-${n}`),
      fingerprint: canonicalJsonDigest(`request-${n}`),
      name: 'launch',
      handle: {
        commandId,
        requestId: `request-${n}`,
        revision: 1,
        completion: 'runtime-accepted',
        status: 'running',
        result: null,
        error: null,
      },
      value: null,
      dispatchKeys: ['wake'],
    })
  })
}

const keyOf = (n: number): Wire.OutboxDeliveryKey => ({
  sourceAuthorityId: 'authority-1',
  eventId: `wake-${n}`,
  destination: 'runtime-inbox',
})

/** A deduplicating stand-in for the Runtime inbox; its runtime reference is a fixture value. */
function inbox() {
  const accepted = new Map<string, string>()
  const seen: string[] = []
  const sink: OutboxSink = async ({ record }) => {
    seen.push(record.eventId)
    const deliveryId = accepted.get(record.eventId) ?? `fixture-delivery-${accepted.size + 1}`
    accepted.set(record.eventId, deliveryId)
    return {
      ok: true,
      value: {
        deliveryId,
        runtimeRef: { kind: 'event', authorityId: 'runtime-inbox-fixture', eventId: record.eventId },
      },
    }
  }
  return { sink, seen }
}
const down: OutboxSink = async () => ({
  ok: false,
  error: {
    code: 'retryable',
    detailCode: 'backend_unavailable',
    message: 'inbox down',
    retryAdvice: { kind: 'retry_read' },
    diagnosticId: 'test-inbox',
  },
})

let dir: string
let clock: number
let allowed: boolean
const open = (extra: Partial<Parameters<typeof openDomainStore>[0]> = {}) =>
  openDomainStore({
    file: join(dir, 'domain.db'),
    owner,
    now: () => clock,
    permits: async () => allowed,
    ...extra,
  })
/** Changes the database file behind the store, as an operator or an older build would. */
const raw = (sql: string) => {
  const db = new DatabaseSync(join(dir, 'domain.db'))
  db.exec(sql)
  db.close()
}
const sequences = (store: DomainStore) => store.events(0, 10).map((record) => record.sequence)
const outcome = (value: { ok: boolean; error?: Wire.RuntimeError }) =>
  value.ok ? 'ok' : value.error?.detailCode

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agnes-domain-outbox-'))
  clock = Date.parse('2026-10-01T00:00:00Z')
  allowed = true
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Fails due rows until row n is dead, following each backoff; returns the waits row n saw. */
async function killRow(store: DomainStore, n: number) {
  const waits: number[] = []
  while (store.record(keyOf(n))?.delivery !== 'dead') {
    await store.flush(down)
    const next = Date.parse(store.record(keyOf(n))?.nextAttemptAt ?? '')
    waits.push(next - clock)
    clock = next - 1
    expect(await store.flush(down)).toMatchObject({ retrying: 0, dead: 0 })
    clock = next
  }
  return waits
}

describe('domain store transactions', () => {
  it('commits journal, state, event record and outbox row together and keeps them across a restart', async () => {
    const store = open()
    await expect(
      commit(store, 1, () => {
        throw new Error('crash before commit')
      }),
    ).rejects.toThrow('crash before commit')
    expect(await store.transaction((tx) => tx.state())).toEqual({ value: null, revision: 0 })
    expect(store.events(0, 10)).toEqual([])
    expect(store.record(keyOf(1))).toBeUndefined()

    await commit(store, 1)
    store.close()
    const reopened = open()
    const [record] = reopened.events(0, 10)
    expect(record).toMatchObject({ authorityId: 'authority-1', sequence: 1, event: { eventId: 'fact-1' } })
    expect(reopened.record(keyOf(1))).toMatchObject({
      eventId: 'wake-1',
      sourceCommitId: 'commit-1',
      delivery: 'pending',
      attempts: 0,
      consecutiveFailures: 0,
      lastError: null,
      claim: null,
    })
    const journal = await reopened.transaction((tx) => tx.command(canonicalJsonDigest('request-1')))
    expect(journal?.handle).toMatchObject({ commandId: 'cmd-1', status: 'running' })
    reopened.close()
  })

  it('refuses a state write that does not follow the stored revision', async () => {
    const store = open()
    await commit(store, 1)
    await expect(
      store.transaction((tx) => tx.putState({ value: inline(stateSchema, { n: 9 }), revision: 3 })),
    ).rejects.toThrow('revision moved')
    expect((await store.transaction((tx) => tx.state())).revision).toBe(1)
    store.close()
  })

  it('keeps the highest issued sequence across a reopen, so a deleted tail is never numbered again', async () => {
    const store = open()
    await commit(store, 1)
    await commit(store, 2)
    store.close()
    raw('DELETE FROM domain_events WHERE sequence = 2')
    const reopened = open()
    expect(reopened.eventHistory()).toEqual({ count: 1, first: 1, last: 1, highwater: 2 })
    const [first] = reopened.events(0, 1)
    if (first === undefined) throw new Error('missing first event')
    const reused = {
      ...first,
      sequence: 2,
      event: { ...first.event, eventId: 'reused', idempotencyKey: 'k' },
    }
    await expect(reopened.transaction((tx) => tx.putEvent(reused))).rejects.toThrow('high-water')
    await commit(reopened, 3)
    expect(sequences(reopened)).toEqual([1, 3])
    reopened.close()
  })

  it('starts the high-water of a database written before it at its newest event, once', async () => {
    const store = open()
    await commit(store, 1)
    await commit(store, 2)
    store.close()
    raw('DROP TABLE domain_event_highwater')
    const migrated = open()
    expect(await migrated.transaction((tx) => tx.lastSequence())).toBe(2)
    migrated.close()
    raw('DELETE FROM domain_events WHERE sequence = 2')
    const reopened = open()
    expect(await reopened.transaction((tx) => tx.lastSequence())).toBe(2)
    reopened.close()
  })

  it('refuses a second event under a stored identity and rolls its whole transaction back', async () => {
    const store = open()
    await commit(store, 1)
    const [first] = store.events(0, 1)
    if (first === undefined) throw new Error('missing first event')
    await expect(
      store.transaction((tx) => {
        tx.putState({ value: inline(stateSchema, { n: 2 }), revision: 2 })
        tx.putEvent({ ...first, sequence: 2, event: { ...first.event, eventId: 'again' } })
      }),
    ).rejects.toThrow('already holds this identity')
    expect((await store.transaction((tx) => tx.state())).revision).toBe(1)
    expect(store.eventHistory()).toEqual({ count: 1, first: 1, last: 1, highwater: 1 })
    store.close()
  })

  it('notifies each subscriber once after a commit that wrote, past listeners that fail', async () => {
    const store = open()
    const seen: number[] = []
    store.subscribeCommitted(() => {
      throw new Error('listener threw')
    })
    store.subscribeCommitted(() => Promise.reject(new Error('listener rejected')))
    store.subscribeCommitted(() => seen.push(store.events(0, 10).length))
    const committed = commit(store, 1)
    // Called after commit and before the transaction resolves, so the listener already reads the event.
    expect(seen).toEqual([1])
    await committed
    await store.transaction((tx) => tx.state())
    await expect(
      commit(store, 2, () => {
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    expect(seen).toEqual([1])
    const kept = await store.transaction((tx) => {
      tx.putState({ value: inline(stateSchema, { n: 2 }), revision: 2 })
      return 'kept'
    })
    expect(kept).toBe('kept')
    expect(seen).toEqual([1, 1])
    store.close()
  })

  it('stops notifying after unsubscribe or close, and a cold reopen reads accepted commands only', async () => {
    const store = open()
    let calls = 0
    const stop = store.subscribeCommitted(() => calls++)
    store.subscribeCommitted(() => calls++)
    await commit(store, 1)
    stop()
    stop()
    await commit(store, 2)
    expect(calls).toBe(3)
    store.close()

    // Only accepted commands are journaled, so a not-accepted row here can only be corruption.
    const key = canonicalJsonDigest('request-x')
    const handle = {
      requestId: 'request-x',
      status: 'not-accepted',
      commandId: null,
      revision: null,
      completion: null,
      result: null,
      error: null,
    }
    const body = { key, fingerprint: key, name: 'launch', handle, value: null, dispatchKeys: [] }
    const raw = new DatabaseSync(join(dir, 'domain.db'))
    raw
      .prepare('INSERT INTO domain_commands (key, command_id, body_json) VALUES (?, ?, ?)')
      .run(key, 'cmd-x', JSON.stringify(body))
    raw.close()

    const reopened = open()
    await commit(reopened, 3)
    expect(calls).toBe(3)
    const accepted = await reopened.transaction((tx) => tx.command(canonicalJsonDigest('request-1')))
    expect(accepted?.handle).toMatchObject({ commandId: 'cmd-1', status: 'running' })
    await expect(reopened.transaction((tx) => tx.command(key))).rejects.toThrow('never accepted')
    reopened.close()
  })
})

describe('outbox delivery', () => {
  it('acks a delivered row and reports the ack as dispatch progress', async () => {
    const store = open()
    await commit(store, 1)
    const { sink } = inbox()
    expect(await store.flush(sink)).toEqual({ acked: 1, retrying: 0, dead: 0, lost: 0 })
    expect(store.record(keyOf(1))).toMatchObject({
      delivery: 'acked',
      attempts: 1,
      ackRef: 'fixture-delivery-1',
    })
    expect(await store.transaction((tx) => tx.dispatches('cmd-1'))).toEqual([
      {
        key: 'wake',
        ack: {
          deliveryId: 'fixture-delivery-1',
          runtimeRef: { kind: 'event', authorityId: 'runtime-inbox-fixture', eventId: 'wake-1' },
        },
      },
    ])
    expect(await store.flush(sink)).toEqual({ acked: 0, retrying: 0, dead: 0, lost: 0 })
    store.close()
  })

  it('backs off from one second doubling to sixty and turns dead after twenty consecutive failures', async () => {
    const store = open()
    await commit(store, 1)
    const waits = await killRow(store, 1)
    expect(waits).toHaveLength(20)
    expect(waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(store.record(keyOf(1))).toMatchObject({
      delivery: 'dead',
      attempts: 20,
      consecutiveFailures: 20,
      lastError: { detailCode: 'backend_unavailable' },
    })
    clock += 3_600_000
    expect(await store.flush(inbox().sink)).toMatchObject({ acked: 0 })
    store.close()
  })

  it('redelivers the same event id after a restart and after a lease expires, ignoring a stale settle', async () => {
    let store = open()
    await commit(store, 1)
    store.close()
    store = open({ leaseMs: 5000 })
    let release: (() => void) | undefined
    const hung: OutboxSink = (delivery) =>
      new Promise((resolve) => {
        release = () => resolve(inbox().sink(delivery))
      })
    const first = store.flush(hung, 'worker-a')
    await new Promise((resolve) => setImmediate(resolve))
    clock += 5000
    const { sink, seen } = inbox()
    expect(await store.flush(sink, 'worker-b')).toMatchObject({ acked: 1 })
    release?.()
    expect(await first).toMatchObject({ lost: 1, acked: 0 })
    expect(seen).toEqual(['wake-1'])
    expect(store.record(keyOf(1))).toMatchObject({
      delivery: 'acked',
      attempts: 2,
      ackRef: 'fixture-delivery-1',
    })
    store.close()
  })
})

describe('outbox administration', () => {
  it('lists dead letters by delivery key under the current permission, page by page', async () => {
    const store = open()
    await commit(store, 1)
    await commit(store, 2)
    await killRow(store, 1)
    const request = { scope: workspace, destination: null, cursor: null, limit: 1 }
    const first = await store.control.deadLetters(request, operator)
    if (!first.ok) throw new Error(first.error.message)
    expect(first.value.items).toHaveLength(1)
    expect(first.value.items[0]).toMatchObject({
      delivery: keyOf(1),
      owner,
      deliveryRevision: 41,
      outbox: { delivery: 'dead', eventId: 'wake-1', consecutiveFailures: 20 },
    })
    // Row 2 died alongside row 1, in the same flushes.
    expect(first.value.nextCursor).not.toBeNull()
    const second = await store.control.deadLetters({ ...request, cursor: first.value.nextCursor }, operator)
    expect(second).toMatchObject({ ok: true, value: { complete: true, items: [{ delivery: keyOf(2) }] } })
    const elsewhere = { ...request, scope: { ...workspace, workspaceId: 'w-2' } }
    expect(await store.control.deadLetters(elsewhere, operator)).toMatchObject({
      ok: true,
      value: { items: [] },
    })
    expect(
      outcome(
        await store.control.deadLetters(
          { ...request, destination: 'other', cursor: first.value.nextCursor },
          operator,
        ),
      ),
    ).toBe('invalid_request')
    expect(outcome(await store.control.deadLetters({ ...request, cursor: 'not a cursor' }, operator))).toBe(
      'invalid_request',
    )
    allowed = false
    expect(outcome(await store.control.deadLetters(request, operator))).toBe('permission_denied')
    store.close()
  })

  it('redrives a dead delivery under its original event id, keeping attempts and the last error', async () => {
    const store = open()
    await commit(store, 1)
    await killRow(store, 1)
    const dead = store.record(keyOf(1))
    const request = {
      requestId: 'repair-1',
      scope: workspace,
      delivery: keyOf(1),
      expectedDeliveryRevision: 41,
      reason: 'inbox restored',
    }
    for (const [change, code] of [
      [{ expectedDeliveryRevision: 40 }, 'revision_conflict'],
      [{ delivery: { ...keyOf(1), destination: 'elsewhere' } }, 'not_found'],
      [{ scope: { ...workspace, workspaceId: 'w-2' } }, 'not_found'],
      [{ reason: '' }, 'invalid_request'],
      [{ reason: 'x'.repeat(8193) }, 'invalid_request'],
    ] as const)
      expect(outcome(await store.control.redriveOutbox({ ...request, ...change }, operator))).toBe(code)
    allowed = false
    expect(outcome(await store.control.redriveOutbox(request, operator))).toBe('permission_denied')
    allowed = true

    const result = { ok: true, value: { delivery: keyOf(1), state: 'pending', deliveryRevision: 42 } }
    expect(await store.control.redriveOutbox(request, operator)).toEqual(result)
    expect(store.record(keyOf(1))).toEqual({
      ...dead,
      delivery: 'pending',
      consecutiveFailures: 0,
      nextAttemptAt: '2026-10-01T00:00:00.000Z',
    })
    // The same request returns its original decision; another meaning under that id conflicts.
    expect(await store.control.redriveOutbox(request, operator)).toEqual(result)
    expect(outcome(await store.control.redriveOutbox({ ...request, reason: 'other' }, operator))).toBe(
      'idempotency_conflict',
    )
    // Not dead any more, so a second redrive at the new revision is refused.
    const again = { ...request, requestId: 'repair-2', expectedDeliveryRevision: 42 }
    expect(outcome(await store.control.redriveOutbox(again, operator))).toBe('revision_conflict')

    const { sink, seen } = inbox()
    expect(await store.flush(sink)).toMatchObject({ acked: 1 })
    expect(seen).toEqual(['wake-1'])
    expect(store.record(keyOf(1))).toMatchObject({ delivery: 'acked', attempts: 21, lastError: null })
    store.close()
  })
})

describe('events provider', () => {
  const key = randomBytes(32)
  const file = () => join(dir, 'domain.db')
  type Read = Awaited<ReturnType<ReturnType<typeof openEvents>['subscribe']>>
  const seen = (result: Read) =>
    result.ok
      ? {
          keys: result.value.page.items.map((record) => record.event.idempotencyKey),
          complete: result.value.page.complete,
          next: result.value.page.nextCursor,
          checkpoint: result.value.checkpoint,
        }
      : result.error.detailCode
  const cursors = (result: Read) => ({
    next: result.ok ? (result.value.page.nextCursor ?? '') : '',
    checkpoint: result.ok ? (result.value.checkpoint ?? '') : '',
  })
  const remove = (sequence: number) => {
    const db = new DatabaseSync(file())
    db.prepare('DELETE FROM domain_events WHERE sequence = ?').run(sequence)
    db.close()
  }
  const relabel = (cursor: string, kind: 'page' | 'checkpoint') => {
    const fields = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
    fields[3] = kind
    return Buffer.from(JSON.stringify(fields)).toString('base64url')
  }
  const publishAll = async (events: ReturnType<typeof openEvents>, ...keys: string[]) => {
    for (const key of keys) expect(outcome(await events.publish(publication(key), producer()))).toBe('ok')
  }

  it('keeps a page cursor to its page set and completes empty and exactly full pages with a checkpoint', async () => {
    const events = openEvents(file(), key)
    const complete = { complete: true, next: null, checkpoint: expect.any(String) }
    expect(seen(await events.subscribe(read(null), reader()))).toEqual({ keys: [], ...complete })
    await publishAll(events, 'k-1', 'k-2')
    expect(seen(await events.subscribe(read(null), reader()))).toEqual({ keys: ['k-1', 'k-2'], ...complete })
    await publishAll(events, 'k-3')
    const first = await events.subscribe(read(null), reader())
    expect(seen(first)).toEqual({
      keys: ['k-1', 'k-2'],
      complete: false,
      next: expect.any(String),
      checkpoint: null,
    })
    await publishAll(events, 'k-4')
    const rest = await events.subscribe(read(cursors(first).next), reader())
    expect(seen(rest)).toEqual({ keys: ['k-3'], ...complete })
    expect(seen(await events.subscribe(read(cursors(rest).checkpoint), reader()))).toEqual({
      keys: ['k-4'],
      ...complete,
    })
    events.close()
  })

  it('refuses every read and publication once a row of the history is missing', async () => {
    const events = openEvents(file(), key)
    await publishAll(events, 'k-1', 'k-2', 'k-3')
    const first = await events.subscribe(read(null), reader())
    remove(2)
    for (const cursor of [null, cursors(first).next])
      expect(seen(await events.subscribe(read(cursor), reader()))).toBe('resync_required')
    expect(outcome(await events.publish(publication('k-4'), producer()))).toBe('resync_required')
    events.close()
    const store = open()
    expect(store.eventHistory()).toEqual({ count: 2, first: 1, last: 3, highwater: 3 })
    store.close()
  })

  it('refuses every read and publication once the tail of the history is deleted, cursor or not', async () => {
    const events = openEvents(file(), key)
    await publishAll(events, 'k-1', 'k-2')
    const before = await events.subscribe(read(null), reader())
    remove(2)
    for (const cursor of [null, cursors(before).checkpoint])
      expect(seen(await events.subscribe(read(cursor), reader()))).toBe('resync_required')
    // As the reference provider does, a publication refuses instead of numbering past the deleted tail.
    expect(outcome(await events.publish(publication('k-3'), producer()))).toBe('resync_required')
    events.close()
    const store = open()
    expect(store.eventHistory()).toEqual({ count: 1, first: 1, last: 1, highwater: 2 })
    store.close()
  })

  it('refuses a cursor relabelled as the other kind, signed with another key or issued by another authority', async () => {
    const events = openEvents(file(), key)
    await publishAll(events, 'k-1', 'k-2', 'k-3')
    const first = await events.subscribe(read(null), reader())
    const { checkpoint } = cursors(await events.subscribe(read(cursors(first).next), reader()))
    for (const cursor of [relabel(cursors(first).next, 'checkpoint'), relabel(checkpoint, 'page')])
      expect(seen(await events.subscribe(read(cursor), reader()))).toBe('resync_required')
    const restarted = openEvents(file(), randomBytes(32))
    expect(seen(await restarted.subscribe(read(checkpoint), reader()))).toBe('resync_required')
    expect(seen(await restarted.subscribe(read(null), reader()))).toMatchObject({ keys: ['k-1', 'k-2'] })
    restarted.close()
    const foreign = openEvents(join(dir, 'foreign.db'), key, testGate(), 'authority-2')
    const issued = cursors(await foreign.subscribe(read(null), reader())).checkpoint
    foreign.close()
    expect(seen(await events.subscribe(read(issued), reader()))).toBe('resync_required')
    expect(seen(await events.subscribe(read(checkpoint), reader()))).toMatchObject({
      keys: [],
      complete: true,
    })
    events.close()
  })

  it('refuses a ninth concurrent read without queueing it and settles waiting reads on close', async () => {
    const gate = testGate()
    let entered = 0
    let eight = () => {}
    const waiting = new Promise<void>((resolve) => {
      eight = resolve
    })
    const events = openEvents(file(), key, {
      ...gate,
      canRead: () => {
        if (++entered === 8) eight()
        return new Promise<boolean>(() => {})
      },
    })
    const pending = Array.from({ length: 8 }, () => events.subscribe(read(null), reader()))
    await waiting
    const refused = await events.subscribe(read(null), reader())
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'quota', detailCode: 'rate_limit', retryAdvice: { kind: 'retry_read' } },
    })
    const advice = refused.ok ? undefined : refused.error.retryAdvice
    const retryAt = Date.parse(advice?.kind === 'retry_read' ? (advice.notBefore ?? '') : '')
    expect(retryAt - Date.now()).toBeGreaterThan(0)
    expect(retryAt - Date.now()).toBeLessThanOrEqual(1000)
    expect(entered).toBe(8)
    events.close()
    expect((await Promise.all(pending)).map(outcome)).toEqual(Array(8).fill('backend_unavailable'))
    expect(outcome(await events.subscribe(read(null), reader()))).toBe('backend_unavailable')
    expect(outcome(await events.publish(publication('k-1'), producer()))).toBe('backend_unavailable')
  })

  it('commits inside the gate hold after producer, origin, replay lookup and revision, and keeps a borrowed store', async () => {
    const store = open()
    const gate = testGate()
    const calls: string[] = []
    const noted = <T>(call: string, value: T) => {
      calls.push(call)
      return value
    }
    const recording: EventsGate = {
      ...gate,
      producer: async (...args) => noted('producer', gate.producer(...args)),
      origin: async (...args) => noted('origin', gate.origin(...args)),
      revision: async (target) => noted('revision', gate.revision(target)),
      withCommit(typeId, schema, aggregate, causation, context, body) {
        const before = store.eventHistory().count
        const held = gate.withCommit(typeId, schema, aggregate, causation, context, body)
        calls.push(`hold ${before}->${store.eventHistory().count}`)
        return held
      },
    }
    expect(() => createEventsProvider({ binding, store, cursorKey: new Uint8Array(31) })).toThrow('32 bytes')
    const events = createEventsProvider({ binding, store, cursorKey: key, gate: recording })
    const published = await events.publish(publication('k-1'), producer())
    expect(calls).toEqual(['producer', 'origin', 'hold 0->0', 'revision', 'hold 0->1'])
    calls.length = 0
    expect(await events.publish(publication('k-1'), producer())).toEqual(published)
    expect(calls).toEqual(['producer', 'origin', 'hold 1->1'])
    events.close()
    expect(store.events(0, 10)).toHaveLength(1)
    store.close()
  })

  it('refuses a publication no gate vouches for and writes nothing', async () => {
    const gate = testGate()
    const unvouched: (EventsGate | null)[] = [
      null,
      { ...gate, producer: async () => ({ ok: true, value: undefined as never }) },
      { ...gate, origin: async () => undefined as never },
    ]
    for (const candidate of unvouched) {
      const events = openEvents(file(), key, candidate)
      expect(outcome(await events.publish(publication('k-1'), producer()))).toBe('permission_denied')
      if (candidate === null)
        expect(seen(await events.subscribe(read(null), reader()))).toBe('permission_denied')
      events.close()
    }
    const store = open()
    expect(store.eventHistory().count).toBe(0)
    store.close()
  })

  it('replays or refuses a publication whose identity an event committed through the command path holds', async () => {
    const scratch = openEvents(join(dir, 'scratch.db'), key)
    await publishAll(scratch, 'k-1')
    const issued = await scratch.subscribe(read(null), reader())
    const published = issued.ok ? issued.value.page.items[0] : undefined
    scratch.close()
    if (published === undefined) throw new Error('scratch provider published nothing')
    const store = open()
    await store.transaction((tx) => {
      // The same identity under the command path: once with the same fingerprint, once with another.
      tx.putEvent({ ...published, sequence: 1, event: { ...published.event, eventId: 'command-k-1' } })
      tx.putEvent({
        ...published,
        sequence: 2,
        event: { ...published.event, eventId: 'command-k-2', idempotencyKey: 'k-2' },
        fingerprint: canonicalJsonDigest('another plan'),
      })
    })
    const events = createEventsProvider({ binding, store, cursorKey: key, gate: testGate() })
    expect(await events.publish(publication('k-1'), producer())).toEqual({
      ok: true,
      value: { eventRef: { kind: 'event', authorityId: 'authority-1', eventId: 'command-k-1' } },
    })
    expect(outcome(await events.publish(publication('k-2'), producer()))).toBe('idempotency_conflict')
    expect(store.eventHistory().count).toBe(2)
    events.close()
    store.close()
  })

  it('catches up from its own checkpoint after a commit hint, which grants no cursor, scope, read or write', async () => {
    // A transport hint only says records may be new. The reader answers it by reading from the checkpoint
    // this provider issued to it; a cursor or scope the hint names, or the hint itself, authorizes nothing.
    const gate = testGate()
    let readable = true
    let producing = true
    const revocable: EventsGate = {
      ...gate,
      producer: async (...args) =>
        producing ? gate.producer(...args) : fail('permission_denied', 'producer revoked', 'test-gate'),
      canRead: async (_scope, context) => readable && ['reader', 'auditor'].includes(context.principalRef),
    }
    let store = open()
    let events = createEventsProvider({ binding, store, cursorKey: key, gate: revocable })
    let hints = 0
    store.subscribeCommitted(() => hints++)
    const elsewhere = { ...session, sessionId: 'session-2' }
    /** Reads two at a time until a page completes; each event is named with the session it belongs to. */
    const catchUp = async (from: string | null, context = reader(), scopeRef: Wire.ScopeRef = session) => {
      const keys: string[] = []
      for (let cursor = from; ; ) {
        const result = await events.subscribe({ ...read(cursor), scopeRef }, context)
        if (!result.ok) return result.error.detailCode
        const { page, checkpoint } = result.value
        for (const { event } of page.items)
          keys.push(`${event.idempotencyKey}@${'sessionId' in event.scope ? event.scope.sessionId : '-'}`)
        // An unfinished page continues by its page cursor only; a finished one by its checkpoint only.
        expect({ next: page.nextCursor !== null, checkpoint: checkpoint !== null }).toEqual({
          next: !page.complete,
          checkpoint: page.complete,
        })
        if (page.nextCursor === null) return { keys, checkpoint: checkpoint ?? '' }
        cursor = page.nextCursor
      }
    }
    const at = (caught: Awaited<ReturnType<typeof catchUp>>) =>
      typeof caught === 'string' ? caught : caught.checkpoint

    const start = at(await catchUp(null))
    // Published from the covering workspace context, each event keeps its original object's session.
    const covering = { ...producer(), scope: workspace }
    for (const n of [1, 2, 3])
      expect(outcome(await events.publish(publication(`k-${n}`), covering))).toBe('ok')
    expect(hints).toBe(3)
    // Checkpoints a hint could carry: another reader's, and one issued for a read of another session.
    const auditor = await catchUp(null, reader(undefined, 'auditor'))
    expect(auditor).toMatchObject({ keys: ['k-1@session-1', 'k-2@session-1', 'k-3@session-1'] })
    const foreign = await catchUp(null, reader(), elsewhere)
    expect(foreign).toEqual({ keys: [], checkpoint: expect.any(String) })
    for (const hinted of [at(auditor), at(foreign)]) expect(await catchUp(hinted)).toBe('resync_required')
    expect(await catchUp(start, reader(), elsewhere)).toBe('resync_required')

    // Three hints, answered once from the own checkpoint; a commit hinted mid-page stays out of that page set.
    const first = await events.subscribe(read(start), reader())
    expect(seen(first)).toMatchObject({ keys: ['k-1', 'k-2'], complete: false, checkpoint: null })
    expect(outcome(await events.publish(publication('k-4'), producer()))).toBe('ok')
    const rest = await catchUp(cursors(first).next)
    expect(rest).toEqual({ keys: ['k-3@session-1'], checkpoint: expect.any(String) })
    const fourth = await catchUp(at(rest))
    expect(fourth).toEqual({ keys: ['k-4@session-1'], checkpoint: expect.any(String) })
    // A repeated hint with nothing new completes empty, still with a checkpoint.
    expect(await catchUp(at(fourth))).toEqual({ keys: [], checkpoint: expect.any(String) })

    // A revoked producer's replay writes nothing, so no hint follows; restored, the same key replays.
    producing = false
    expect(outcome(await events.publish(publication('k-1'), producer()))).toBe('permission_denied')
    producing = true
    expect(outcome(await events.publish(publication('k-1'), producer()))).toBe('ok')
    expect({ hints, events: store.eventHistory().count }).toEqual({ hints: 4, events: 4 })
    expect(await catchUp(at(fourth))).toEqual({ keys: [], checkpoint: expect.any(String) })

    // A hint after the reader lost its permission reads nothing; restored, nothing was skipped.
    expect(outcome(await events.publish(publication('k-5'), producer()))).toBe('ok')
    readable = false
    for (const principal of ['reader', 'auditor'])
      expect(await catchUp(at(fourth), reader(undefined, principal))).toBe('permission_denied')
    readable = true
    expect(await catchUp(at(fourth))).toEqual({ keys: ['k-5@session-1'], checkpoint: expect.any(String) })

    // After a restart the new process's hint cannot revive an old checkpoint; a resync reads all once.
    events.close()
    store.close()
    store = open()
    events = createEventsProvider({ binding, store, cursorKey: randomBytes(32), gate: revocable })
    store.subscribeCommitted(() => hints++)
    expect(outcome(await events.publish(publication('k-6'), producer()))).toBe('ok')
    expect(hints).toBe(6)
    expect(await catchUp(at(fourth))).toBe('resync_required')
    const resynced = await catchUp(null)
    expect(resynced).toEqual({
      keys: [1, 2, 3, 4, 5, 6].map((n) => `k-${n}@session-1`),
      checkpoint: expect.any(String),
    })

    // A history gap refuses the hinted catch-up and the resync alike rather than skipping it.
    remove(3)
    for (const from of [at(resynced), null]) expect(await catchUp(from)).toBe('resync_required')
    events.close()
    store.close()
  })
})
