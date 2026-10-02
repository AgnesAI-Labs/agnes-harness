import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeClientTransportPolicy } from '@agnes/protocol/runtime'
import { expect } from 'vitest'

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
  command: ref('slow.ticks/command-state@1'),
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

/** The tick committed at `sequence`. */
export const tickEvent = (sequence: number): Wire.DomainEvent => ({
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
})

/** The journal record of the tick committed at `sequence`. */
export const tickRecord = (sequence: number): Wire.DomainEventRecord => ({
  event: tickEvent(sequence),
  authorityId: 'slow-authority',
  sequence,
  aggregate: { authorityId: 'slow-authority', typeId: 'slow.ticks/clock@1', id: 'clock', revision: sequence },
  fingerprint: '0'.repeat(64),
})

const nodes = Array.from({ length: 40 }, (_, index) => ({
  kind: 'assistant' as const,
  id: `n${index + 1}`,
  seq: index + 1,
  text: `reply ${index + 1}`,
}))
const head = { generation: 1, upto: nodes.length }

/**
 * A domain whose state stays bounded however long its history grows, a fixed native conversation and
 * one reader, so any projection provider can be checked for bounded reads over a long history.
 */
export const TICKS = {
  binding: BINDING,
  authorityId: 'slow-authority',
  domain: {
    domainType: 'slow.ticks/clock@1',
    stateSchema: SCHEMAS.state,
    readStateSchema: SCHEMAS.read,
    viewSchema: SCHEMAS.view,
    commandStateSchema: SCHEMAS.command,
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
      reduce({
        state,
        event,
      }: {
        state: Wire.DataRef | null
        event: Wire.DomainEvent
      }): Outcome<Wire.DataRef> {
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
      async selectAuthorized(
        input: Wire.DomainSelectorSelectAuthorizedRequest,
      ): Promise<Outcome<Wire.DomainSelectorSelectAuthorizedResult>> {
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
    grant: async () => ({ ok: true as const, value: { readerId: 'slow-reader', role: 'reader' } }),
    allows: async () => true,
    canReadResource: async () => true,
  },
  native: {
    head: () => head,
    async page(
      sessionId: string,
      beforeIndex: number | null,
      count: number,
    ): Promise<Outcome<Wire.UIOpeningResult>> {
      const end = Math.min(beforeIndex ?? nodes.length, nodes.length)
      const start = Math.max(0, end - count)
      return {
        ok: true,
        value: {
          timeline: {
            sessionId,
            upto: head.upto,
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
  context: {
    principalRef: 'slow-reader',
    scope: WORKSPACE,
    bindingId: 'slow',
    invocationId: 'slow',
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: 'slow',
    authorizationRef: 'slow',
    signal: new AbortController().signal,
  } satisfies CallContext,
  query: {
    domainType: 'slow.ticks/clock@1',
    query: inline(SCHEMAS.query, { all: true }),
    scope: SESSION,
    cursor: null,
    limit: 50,
  },
}

type Read<T> = (request: unknown, context: CallContext) => Promise<Outcome<T>>

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

/**
 * Reads a snapshot page after `total` ticks, opens a window and walks three history pages back,
 * checking that every page stays within the client limits however long the history is.
 */
export async function expectBoundedReads(
  projection: Readonly<{
    snapshot: Read<Wire.ProjectionSnapshot>
    openConversation: Read<Wire.RuntimeConversationWindow>
    conversationHistory: Read<Wire.RuntimeConversationWindow>
  }>,
  total: number,
): Promise<void> {
  const page = value(await projection.snapshot(TICKS.query, TICKS.context))
  expect(page.projectionRevision).toBe(total)
  expect(page.items).toHaveLength(50)
  const [summary] = page.items
  expect(summary?.data).toEqual({ text: `${total} ticks` })
  expect(summary?.source.eventIds.length).toBeLessThanOrEqual(8)
  for (const view of page.items) {
    expect(bytes(view)).toBeLessThanOrEqual(MAX_DOMAIN_VIEW_BYTES)
    expect(new TextEncoder().encode(view.fallbackText).length).toBeLessThanOrEqual(MAX_FALLBACK_TEXT_BYTES)
  }
  expect(bytes(page)).toBeLessThanOrEqual(RuntimeClientTransportPolicy.maxJsonBytes)

  const opened = value(await projection.openConversation({ sessionId: 'slow', limit: 20 }, TICKS.context))
  expect(opened.order.length).toBeLessThanOrEqual(20)
  expect(bytes(opened)).toBeLessThanOrEqual(RuntimeClientTransportPolicy.maxJsonBytes)
  let window = opened
  for (let pageIndex = 0; pageIndex < 3 && window.nextPageCursor; pageIndex++) {
    const older = value(
      await projection.conversationHistory(
        { sessionId: 'slow', cursor: window.nextPageCursor, limit: 20 },
        TICKS.context,
      ),
    )
    expect(older.order.length).toBeLessThanOrEqual(20)
    expect(older.epoch).toBe(opened.epoch)
    window = older
  }
}
