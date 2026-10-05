import { randomBytes } from 'node:crypto'
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { fail, openDomainStore } from '../../../src/runtime/events/outbox.js'
import { createEventsProvider, type EventsGate } from '../../../src/runtime/providers/events.js'

const workspace = {
  kind: 'workspace' as const,
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'w-1',
}
const session: Wire.ScopeRef = { ...workspace, kind: 'session', sessionId: 'session-1' }
const PRODUCER: Wire.BindingRef = {
  bindingId: 'producer-1',
  contract: 'acme.notes',
  logicalName: 'notes',
  providerId: 'acme',
}
const schema: Wire.SchemaRef = {
  typeId: 'acme.notes/noted@1',
  revision: 1,
  digest: canonicalJsonDigest('noted'),
}
const aggregate = { authorityId: 'notes-authority', typeId: 'acme.notes/item@1', id: 'item-1', revision: 1 }
const causation = { runId: 'run-1' }

const call = (principalRef: string, scope: Wire.ScopeRef, bindingId: string, signal?: AbortSignal) => ({
  principalRef,
  scope,
  bindingId,
  invocationId: `${principalRef}-invocation`,
  deadline: '2100-01-01T00:00:00.000Z',
  traceRef: `${principalRef}-trace`,
  authorizationRef: `${principalRef}-authorization`,
  signal: signal ?? new AbortController().signal,
})
export const producer = (signal?: AbortSignal) => call('producer', session, PRODUCER.bindingId, signal)
export const reader = (signal?: AbortSignal, principalRef = 'reader') =>
  call(principalRef, workspace, 'reader-binding', signal)

export const publication = (key: string, note = key): Wire.EventsPublishRequest => ({
  domainSchema: schema,
  payload: {
    kind: 'inline',
    schema,
    value: { note },
    digest: canonicalJsonDigest({ note }),
    bytes: Buffer.byteLength(jcs({ note })),
  },
  causationRef: {
    kind: 'run',
    value: {
      runId: causation.runId,
      session: {
        sessionId: 'session-1',
        authority: { authorityId: 'state-authority', tenantId: 'tenant-1', authorityEpoch: 1 },
      },
    },
  },
  typeId: schema.typeId,
  idempotencyKey: key,
  aggregate,
})
export const read = (cursor: string | null, limit = 2): Wire.EventsSubscribeRequest => ({
  scopeRef: session,
  types: [schema.typeId],
  cursor,
  limit,
})

/** A Host gate that vouches for one producer of one aggregate in `session`, and for one reader. */
export function testGate(): EventsGate {
  const producerNow = (context: { bindingId: string }) =>
    context.bindingId === PRODUCER.bindingId
      ? { ok: true as const, value: PRODUCER }
      : fail('permission_denied', 'not a registered producer', 'test-gate')
  return {
    producer: async (_typeId, _schema, context) => producerNow(context),
    revision: async (target) => (target.id === aggregate.id ? aggregate.revision : null),
    origin: async () => ({ ok: true, value: { scope: session, causation } }),
    withCommit(_typeId, _schema, _aggregate, _causation, context, body) {
      const held = producerNow(context)
      if (!held.ok) return held
      return {
        ok: true,
        value: body({ producer: held.value, scope: session, causation, revision: aggregate.revision }),
      }
    },
    canRead: async (_scope, context) => context.principalRef === 'reader',
  }
}

const owner = (authorityId = 'authority-1'): Wire.RecordOwner => ({
  authority: { authorityId, tenantId: 'tenant-1', authorityEpoch: 1 },
  scope: workspace,
  ownerBinding: {
    bindingId: 'events-1',
    contract: 'agh.events',
    logicalName: 'events',
    providerId: 'default',
  },
})

/** The provider over its own store at `file`, signing cursors with `cursorKey`; null installs no gate. */
export const openEvents = (
  file: string,
  cursorKey: Uint8Array,
  gate: EventsGate | null = testGate(),
  authorityId?: string,
) =>
  createEventsProvider({
    binding: owner().ownerBinding,
    store: openDomainStore({ file, owner: owner(authorityId), permits: async () => false }),
    cursorKey,
    ...(gate === null ? {} : { gate }),
    ownsStore: true,
  })

const settled = async <T>(
  outcome: Promise<{ ok: true; value: T } | { ok: false; error: Wire.RuntimeError }>,
) => {
  const value = await outcome
  if (!value.ok) throw new Error(value.error.detailCode)
  return value.value
}

/**
 * `events-issuer <database>`: with a key of its own, commits three events, reads them two at a time and
 * prints the page cursor and checkpoint it was issued as one JSON line, then blocks until killed.
 */
async function issue(file: string) {
  const events = openEvents(file, randomBytes(32))
  for (const n of [1, 2, 3]) await settled(events.publish(publication(`restart-${n}`), producer()))
  const first = await settled(events.subscribe(read(null), reader()))
  const last = await settled(events.subscribe(read(first.page.nextCursor), reader()))
  writeSync(1, `${JSON.stringify({ page: first.page.nextCursor, checkpoint: last.checkpoint })}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const file = process.argv[2]
  if (file === undefined) throw new Error('expected: events-issuer <database>')
  await issue(file)
}
