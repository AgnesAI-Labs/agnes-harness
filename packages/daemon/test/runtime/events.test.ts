import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DomainStore, type OutboxSink, openDomainStore } from '../../src/runtime/events/outbox.js'

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
