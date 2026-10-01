import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeClientTransportPolicy } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { fail } from '../../src/runtime/projection/commands.js'
import { createProjectionProvider } from '../../src/runtime/providers/projection.js'

const NO_READS = {
  query: async () => fail('unsupported', 'no selector reads in this test'),
  resolveData: async () => fail('unsupported', 'no selector reads in this test'),
}
const MAX_FALLBACK_TEXT_BYTES = 4096
const MAX_DOMAIN_VIEW_BYTES = 262_144
const KEEP = 100
const ref = (typeId: string): Wire.SchemaRef => ({ typeId, revision: 1, digest: canonicalJsonDigest(typeId) })
const SCHEMAS = {
  state: ref('slow.ticks/state@1'),
  read: ref('slow.ticks/read-state@1'),
  view: ref('slow.ticks/card@1'),
  query: ref('slow.ticks/query@1'),
  tick: ref('slow.ticks/ticked@1'),
}
const WORKSPACE = {
  kind: 'workspace',
  installationId: 'slow',
  runtimeId: 'slow',
  workspaceId: 'slow',
} as const
const SESSION = { ...WORKSPACE, kind: 'session', sessionId: 'slow' } as const
const BINDING = { bindingId: 'slow', contract: 'agh.projection', logicalName: 'ticks', providerId: 'default' }
const bytes = (value: unknown) => new TextEncoder().encode(jcs(value)).length
const inline = (schema: Wire.SchemaRef, value: Wire.JsonValue): Wire.DataRef => ({
  kind: 'inline',
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: bytes(value),
})

type Ticks = { count: number; first: string | null; recent: string[] }

/** Committed records built on demand, so the journal itself is never held in memory. */
function journal() {
  const handed = { records: 0 }
  const record = (sequence: number): Wire.DomainEventRecord => ({
    event: {
      eventId: `tick-${sequence}`,
      typeId: SCHEMAS.tick.typeId,
      schema: SCHEMAS.tick,
      source: BINDING,
      scope: SESSION,
      occurredAt: '2026-10-01T00:00:00.000Z',
      payload: { kind: 'inline', schema: SCHEMAS.tick, value: {}, digest: '0'.repeat(64), bytes: 2 },
      idempotencyKey: `tick-${sequence}`,
      causation: {},
      principalRef: 'slow-author',
      correlationId: null,
      provenance: { sourceRefs: [], producer: BINDING, trustLabels: [] },
    },
    authorityId: 'slow-authority',
    sequence,
    aggregate: {
      authorityId: 'slow-authority',
      typeId: 'slow.ticks/clock@1',
      id: 'clock',
      revision: sequence,
    },
    fingerprint: '0'.repeat(64),
  })
  return {
    handed,
    read: async (after: number, limit: number) => {
      const out: Wire.DomainEventRecord[] = []
      for (let sequence = after + 1; sequence <= after + limit; sequence++) out.push(record(sequence))
      handed.records += out.length
      return out
    },
  }
}

function provider(total: number) {
  const source = journal()
  let limit = total
  const native = { generation: 1, upto: 40 }
  const nodes = Array.from({ length: native.upto }, (_, index) => ({
    kind: 'assistant' as const,
    id: `n${index + 1}`,
    seq: index + 1,
    text: `reply ${index + 1}`,
  }))
  const projection = createProjectionProvider({
    binding: BINDING,
    reads: NO_READS,
    domain: {
      domainType: 'slow.ticks/clock@1',
      stateSchema: SCHEMAS.state,
      readStateSchema: SCHEMAS.read,
      viewSchema: SCHEMAS.view,
      onCommittedTypes: [SCHEMAS.tick.typeId],
      readerPolicy: {
        capability: 'slow.read',
        rules: ['/count', '/first', '/recent'].map((pointer) => ({
          pointer,
          resourcePointer: '',
          operation: 'read',
        })),
      },
      // The author keeps a bounded state; the digest is left out because nothing here reads it.
      reducer: {
        reduce({ state, event }) {
          const prior = (
            state?.kind === 'inline' ? state.value : { count: 0, first: null, recent: [] }
          ) as Ticks
          const value: Ticks = {
            count: prior.count + 1,
            first: prior.first ?? event.eventId,
            recent: [...prior.recent.slice(-(KEEP - 1)), event.eventId],
          }
          return {
            ok: true,
            value: { kind: 'inline', schema: SCHEMAS.state, value, digest: '0'.repeat(64), bytes: 0 },
          }
        },
      },
      selector: {
        async selectAuthorized(input) {
          const ticks = (input.state.kind === 'inline' ? input.state.value : {}) as Ticks
          const card = (
            viewId: string,
            revision: number,
            eventIds: string[],
            text: string,
          ): Wire.DomainView => ({
            kind: 'domain',
            viewId,
            revision,
            domainType: 'slow.ticks/clock@1',
            viewSchema: SCHEMAS.view,
            renderKey: 'slow.ticks/card',
            scope: SESSION,
            source: { eventIds, projectionRevision: input.projectionRevision },
            phase: 'finalized',
            fallbackText: text,
            data: { text },
            resources: [],
            actions: [],
          })
          const summary = card(
            'summary',
            ticks.count,
            [ticks.first ?? '', ...ticks.recent.slice(-7)],
            `${ticks.count} ticks`,
          )
          const items = [summary, ...ticks.recent.map((id) => card(id, 1, [id], `tick ${id}`))]
          return { ok: true, value: { items, pageState: null, complete: true } }
        },
      },
      checkReadState: () => true,
      listQuery: inline(SCHEMAS.query, { all: true }),
      commands: new Map(),
    },
    access: {
      grant: async () => ({ ok: true, value: { readerId: 'slow-reader', role: 'reader' } }),
      allows: async () => true,
      canReadResource: async () => true,
    },
    native: {
      head: () => native,
      async page(sessionId, beforeIndex, count) {
        const end = Math.min(beforeIndex ?? nodes.length, nodes.length)
        const start = Math.max(0, end - count)
        return {
          ok: true,
          value: {
            timeline: {
              sessionId,
              upto: native.upto,
              generation: 1,
              opState: null,
              nodes: nodes.slice(start, end),
              turns: [],
            },
            history:
              start > 0
                ? { hasEarlier: true, cursor: `native-${start}`, startIndex: start, totalNodes: nodes.length }
                : { hasEarlier: false, startIndex: start, totalNodes: nodes.length },
          },
        }
      },
    },
    journal: (after, count) => source.read(after, Math.max(0, Math.min(count, limit - after))),
    owner: {
      namespace: 'slow.ticks',
      authorityId: 'slow-authority',
      aggregate: { typeId: 'slow.ticks/clock@1', id: 'clock' },
      source: BINDING,
      stateSchema: SCHEMAS.state,
      destination: 'runtime-inbox',
      storage: {
        transaction: async () => {
          throw new Error('commands are not used here')
        },
      },
      clock: { now: () => '2026-10-01T00:00:00Z', newId: () => 'unused' },
    },
  })
  return {
    projection,
    source,
    grow(more: number) {
      limit += more
    },
  }
}

const context: CallContext = {
  principalRef: 'slow-reader',
  scope: WORKSPACE,
  bindingId: 'slow',
  invocationId: 'slow',
  deadline: '2100-01-01T00:00:00.000Z',
  traceRef: 'slow',
  authorizationRef: 'slow',
  signal: new AbortController().signal,
}

describe.each([100_000, 1_000_000])('projection window over %i committed events', (total) => {
  it('folds incrementally and serves bounded snapshots and windows, never the whole history', async () => {
    const { projection, source, grow } = provider(total)
    const query = {
      domainType: 'slow.ticks/clock@1',
      query: inline(SCHEMAS.query, { all: true }),
      scope: SESSION,
      cursor: null,
      limit: 50,
    }
    const page = await projection.snapshot(query, context)
    if (!page.ok) throw new Error(page.error.message)
    expect(page.value.projectionRevision).toBe(total)
    expect(source.handed.records).toBe(total)
    expect(page.value.items).toHaveLength(50)
    const [summary] = page.value.items
    expect(summary?.data).toEqual({ text: `${total} ticks` })
    expect(summary?.source.eventIds.length).toBeLessThanOrEqual(8)
    for (const view of page.value.items) {
      expect(bytes(view)).toBeLessThanOrEqual(MAX_DOMAIN_VIEW_BYTES)
      expect(new TextEncoder().encode(view.fallbackText).length).toBeLessThanOrEqual(MAX_FALLBACK_TEXT_BYTES)
    }
    expect(bytes(page.value)).toBeLessThanOrEqual(RuntimeClientTransportPolicy.maxJsonBytes)

    const opened = await projection.openConversation({ sessionId: 'slow', limit: 20 }, context)
    if (!opened.ok) throw new Error(opened.error.message)
    expect(opened.value.order.length).toBeLessThanOrEqual(20)
    expect(bytes(opened.value)).toBeLessThanOrEqual(RuntimeClientTransportPolicy.maxJsonBytes)
    let window = opened.value
    for (let pageIndex = 0; pageIndex < 3 && window.nextPageCursor; pageIndex++) {
      const older = await projection.conversationHistory(
        { sessionId: 'slow', cursor: window.nextPageCursor, limit: 20 },
        context,
      )
      if (!older.ok) throw new Error(older.error.message)
      expect(older.value.order.length).toBeLessThanOrEqual(20)
      expect(older.value.epoch).toBe(opened.value.epoch)
      window = older.value
    }

    grow(1)
    const next = await projection.snapshot(query, context)
    if (!next.ok) throw new Error(next.error.message)
    expect(next.value.projectionRevision).toBe(total + 1)
    // One more record, not the history again.
    expect(source.handed.records).toBe(total + 1)
  }, 600_000)
})
