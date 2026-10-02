import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { validateAgainst } from '@agnes/protocol'
import { UIOpeningResult } from '@agnes/protocol/gen/agnes-v1'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { UIProjectionCell } from '../../src/project/ui.js'
import { fail } from '../../src/runtime/projection/commands.js'
import {
  createProjectionProvider,
  type NativeConversation,
  type ProjectionAccess,
  type ProjectionDomain,
} from '../../src/runtime/providers/projection.js'
import type { Event } from '../../src/types.js'

type Suite = {
  createProjectionFixture(): {
    domain: ProjectionDomain & { commandStateSchema: Wire.SchemaRef }
    gate: ProjectionAccess
  }
  domainEvent(
    eventId: string,
    type: string,
    sessionId: string,
    payload: Record<string, string>,
  ): Wire.DomainEvent
  callContext(): CallContext
}
const loadSuite = async () =>
  (await import(
    new URL('../../../extension-api/testkit/runtime/contracts/projection.ts', import.meta.url).href
  )) as Suite

const SESSION = 'native-session'
const NO_READS = {
  query: async () => fail('unsupported', 'no selector reads in this test'),
  resolveData: async () => fail('unsupported', 'no selector reads in this test'),
}
const BINDING = {
  bindingId: 'native',
  contract: 'agh.projection',
  logicalName: 'tasks',
  providerId: 'default',
}

function ledger() {
  let seq = 0
  const event = (type: string, data: Event['data']): Event => {
    seq += 1
    return {
      seq,
      ts: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(),
      id: `01K0000000000000000000${String(seq).padStart(4, '0')}`,
      type,
      data,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
    }
  }
  return (turn: number, text: string) => [
    event('user/message', { content: [{ type: 'text', text }] }),
    event('turn/start', { turn, trigger: 'prompt' }),
    event('assistant/message', {
      content: [{ type: 'text', text: `${text} answered` }],
      stopReason: 'end_turn',
    }),
    event('turn/end', { reason: 'completed', lastAssistantSeq: seq }),
  ]
}

const info = (start: number, total: number): Wire.UIOpeningResult['history'] =>
  start > 0
    ? { hasEarlier: true, cursor: `legacy-${start}`, startIndex: start, totalNodes: total }
    : { hasEarlier: false, startIndex: start, totalNodes: total }

/** The native window as the existing opening and history reads build it from the core cell. */
function nativeOf(cell: UIProjectionCell): NativeConversation {
  return {
    head: () => ({ generation: 1, upto: cell.upto }),
    async page(_sessionId, beforeIndex, limit): Promise<Outcome<Wire.UIOpeningResult>> {
      const live = await cell.opening({ maxNodes: beforeIndex === null ? limit : 0, maxBytes: 1 << 20 })
      const timeline = { ...live.timeline, generation: 1 }
      if (beforeIndex === null)
        return { ok: true, value: { timeline, history: info(live.startIndex, live.totalNodes) } }
      const older = cell.history(cell.upto, beforeIndex, limit, 1 << 20)
      return {
        ok: true,
        value: {
          timeline: { ...timeline, nodes: older.nodes, turns: older.turns },
          history: info(older.startIndex, older.totalNodes),
        },
      }
    },
  }
}

async function compatibility() {
  const suite = await loadSuite()
  const fixture = suite.createProjectionFixture()
  const cell = new UIProjectionCell(SESSION, 'main')
  const turns = ledger()
  const native = nativeOf(cell)
  const records: Wire.DomainEventRecord[] = []
  const provider = createProjectionProvider({
    binding: BINDING,
    reads: NO_READS,
    domain: fixture.domain,
    access: fixture.gate,
    native,
    turnOf: () => cell.turnList.at(-1)?.id ?? null,
    journal: async (after, limit) => records.filter((record) => record.sequence > after).slice(0, limit),
    owner: {
      namespace: 'conformance.tasks',
      authorityId: 'native-authority',
      aggregate: { typeId: 'conformance.tasks/board@1', id: 'board' },
      source: BINDING,
      stateSchema: fixture.domain.commandStateSchema,
      destination: 'runtime-inbox',
      storage: {
        transaction: async () => {
          throw new Error('commands are not used here')
        },
      },
      clock: { now: () => '2026-10-01T00:00:00Z', newId: () => 'unused' },
    },
  })
  const context = suite.callContext()
  return {
    cell,
    native,
    context,
    say: (turn: number, text: string) => cell.apply(turns(turn, text)),
    async add(taskId: string) {
      const sequence = records.length + 1
      records.push({
        event: suite.domainEvent(`native-${taskId}`, 'added', SESSION, {
          taskId,
          board: 'open',
          title: taskId,
        }),
        authorityId: 'native-authority',
        sequence,
        aggregate: {
          authorityId: 'native-authority',
          typeId: 'conformance.tasks/board@1',
          id: 'board',
          revision: sequence,
        },
        fingerprint: canonicalJsonDigest(sequence),
      })
      expect(await provider.refresh()).toBeNull()
    },
    async open(limit: number) {
      const window = await provider.openConversation({ sessionId: SESSION, limit }, context)
      if (!window.ok) throw new Error(window.error.message)
      return window.value
    },
    provider,
  }
}

const opening = async (
  native: NativeConversation,
  before: number | null,
  limit: number,
  context: CallContext,
) => {
  const page = await native.page(SESSION, before, limit, context)
  if (!page.ok) throw new Error(page.error.message)
  return page.value
}

describe('native conversation compatibility', () => {
  it('passes the native opening through unchanged when no domain entry shares the page', async () => {
    const h = await compatibility()
    h.say(1, 'first')
    h.say(2, 'second')
    const window = await h.open(3)
    expect(window.native).toEqual(await opening(h.native, null, 3, h.context))
    expect(validateAgainst(UIOpeningResult, window.native).ok).toBe(true)
    expect(validateRuntime('RuntimeConversationWindow', window).ok).toBe(true)
    expect(window.order).toEqual(
      window.native.timeline.nodes.map((node) => ({ kind: 'native', id: node.id })),
    )
    expect(window.domains).toEqual([])
  })

  it('keeps native ids, seq, turns and the legacy cursor while domain entries stay outside the native timeline', async () => {
    const h = await compatibility()
    h.say(1, 'first')
    await h.add('card')
    h.say(2, 'second')
    const all = await opening(h.native, null, 50, h.context)
    const window = await h.open(3)
    const kept = window.order.filter((item) => item.kind === 'native').length
    expect(window.native).toEqual(await opening(h.native, null, kept, h.context))
    expect(window.native.timeline.upto).toBe(h.cell.upto)
    for (const node of window.native.timeline.nodes)
      expect(all.timeline.nodes.find((candidate) => candidate.id === node.id)).toEqual(node)
    expect(window.native.timeline.nodes.some((node) => node.id.startsWith('domain:'))).toBe(false)
    const older = await h.provider.conversationHistory(
      { sessionId: SESSION, cursor: window.nextPageCursor ?? '', limit: 3 },
      h.context,
    )
    if (!older.ok) throw new Error(older.error.message)
    const [entry] = window.domains
    expect(entry?.turnId).toBe(all.timeline.turns[0]?.id)
    expect(all.timeline.turns.map((turn) => turn.id)).toContain(entry?.turnId)
    // The legacy native cursor stays inside native.history; the window pages with its own cursor.
    const legacy = window.native.history.hasEarlier ? window.native.history.cursor : null
    expect(legacy).toBe('legacy-2')
    expect([window.nextPageCursor, window.orderCursor, older.value.nextPageCursor]).not.toContain(legacy)
    const chronological = [...older.value.order, ...window.order].map((item) => item.id)
    const nativeIds = all.timeline.nodes.map((node) => node.id)
    expect(chronological.filter((id) => !id.startsWith('domain:'))).toEqual(nativeIds)
    expect(chronological.indexOf(entry?.id ?? '')).toBe(2)
  })
})
