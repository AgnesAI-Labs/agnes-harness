import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { createEventsFixture } from '../../../../../packages/extension-api/testkit/runtime/contracts/events.js'
import { EVENTS_PROVIDER, openEventsStore } from '../../../src/providers/events.js'

const session: Wire.ScopeRef = {
  kind: 'session',
  installationId: 'conformance',
  runtimeId: 'conformance',
  workspaceId: 'conformance',
  sessionId: 'recover',
}
const schema: Wire.SchemaRef = {
  typeId: 'conformance.events/noted@1',
  revision: 1,
  digest: canonicalJsonDigest('conformance.events/noted@1'),
}
const call = (principalRef: string, scope: Wire.ScopeRef, bindingId: string): CallContext => ({
  principalRef,
  scope,
  bindingId,
  invocationId: `${principalRef}-invocation`,
  deadline: '2100-01-01T00:00:00.000Z',
  traceRef: `${principalRef}-trace`,
  authorizationRef: `${principalRef}-authorization`,
  signal: new AbortController().signal,
})
export const producer = call('events-producer', session, 'conformance-producer')
export const reader = call(
  'events-reader',
  { kind: 'workspace', installationId: 'conformance', runtimeId: 'conformance', workspaceId: 'conformance' },
  'events-reader-binding',
)

/** The reference store over `path`, wired to a fresh conformance fixture. */
export const openStore = (path: string, authorityId = 'reference-events-authority') =>
  openEventsStore(path, {
    binding: {
      bindingId: 'reference-events',
      contract: EVENTS_PROVIDER.contract,
      logicalName: 'events',
      providerId: EVENTS_PROVIDER.id,
    },
    authorityId,
    access: createEventsFixture().gate,
  })

export const publication = (key: string): Wire.EventsPublishRequest => {
  const value = { note: key }
  return {
    domainSchema: schema,
    payload: {
      kind: 'inline',
      schema,
      value,
      digest: canonicalJsonDigest(value),
      bytes: Buffer.byteLength(jcs(value)),
    },
    causationRef: {
      kind: 'run',
      value: {
        runId: 'recover-run',
        session: {
          sessionId: 'recover',
          authority: { authorityId: 'conformance-state', tenantId: 'conformance', authorityEpoch: 1 },
        },
      },
    },
    typeId: schema.typeId,
    idempotencyKey: key,
    aggregate: {
      authorityId: 'conformance-domain',
      typeId: 'conformance.events/item@1',
      id: 'recover-item',
      revision: 1,
    },
  }
}

export const read = (cursor: string | null): Wire.EventsSubscribeRequest => ({
  scopeRef: session,
  types: [schema.typeId],
  cursor,
  limit: 2,
})

const settled = async <T>(outcome: Promise<Outcome<T>>) => {
  const value = await outcome
  if (!value.ok) throw new Error(value.error.detailCode)
  return value.value
}

/**
 * `reference-events-issuer <database>`: commits three events, reads them two at a time and prints the
 * page cursor and checkpoint it was issued as one JSON line, then blocks with the store open until killed.
 */
async function issue(path: string) {
  const store = openStore(path)
  for (const n of [1, 2, 3]) await settled(store.publish(publication(`restart-${n}`), producer))
  const first = await settled(store.subscribe(read(null), reader))
  const last = await settled(store.subscribe(read(first.page.nextCursor), reader))
  writeSync(1, `${JSON.stringify({ page: first.page.nextCursor, checkpoint: last.checkpoint })}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const path = process.argv[2]
  if (path === undefined) throw new Error('expected: reference-events-issuer <database>')
  await issue(path)
}
