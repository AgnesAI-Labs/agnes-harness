import type { Event, EventInput } from '@agnes/core-common/types'
import { describe, expect, it } from 'vitest'
import {
  INBOX_DELIVERED_BY_EVENT,
  INPUT_DELIVERED_BY_EVENT,
  withoutInlineMarkers,
} from '../../src/log/delivery-marker.js'
import { projectUI } from '../../src/project/ui.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const deliveredBy = { kind: 'bundled-app', appId: '@agnes/superagent/superagent' }

const row = (seq: number, type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({
    seq,
    ts: '2026-11-16T00:00:00Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type,
    data,
    actor,
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
    v: 1,
    ...extra,
  }) as Event
const message = (
  seq: number,
  text: string,
  extra: Record<string, unknown> = {},
  envelope: Partial<Event> = {},
) => row(seq, 'user/message', { content: [{ type: 'text', text }], kind: 'follow_up', ...extra }, envelope)
const named = (seq: number, messageIds: string[], envelope: Partial<Event> = {}) =>
  row(
    seq,
    INPUT_DELIVERED_BY_EVENT,
    { messageIds, deliveredBy },
    {
      origin: 'system',
      trust: 'trusted',
      ignorable: true,
      ...envelope,
    },
  )

async function shown(events: Event[]) {
  return (await projectUI(events, { sessionKey: 'k' })).nodes.flatMap((node) =>
    node.kind === 'user' ? [[node.id, node.deliveredBy]] : [],
  )
}

describe('the delivery marker a reader is shown', () => {
  it("comes from Core's own row naming the message, and from no row anyone else wrote", async () => {
    const a = message(1, 'delivered')
    const b = message(3, 'claimed')
    expect(
      await shown([
        a,
        named(2, [a.id]),
        b,
        // Rows that only look like Core's: an imported one, and one that is not trusted.
        named(4, [b.id], { origin: 'import:agnes', trust: 'untrusted' }),
        named(5, [b.id], { trust: 'untrusted' }),
      ]),
    ).toEqual([
      [a.id, deliveredBy],
      [b.id, undefined],
    ])
  })

  it('takes a marker an earlier release wrote inline only on a row the live daemon writes, never on an import', async () => {
    const live = message(1, 'from the daemon', { deliveredBy })
    const imported = message(
      2,
      'from a file',
      { deliveredBy },
      { origin: 'import:agnes', trust: 'untrusted' },
    )
    expect(await shown([live, imported])).toEqual([
      [live.id, deliveredBy],
      [imported.id, undefined],
    ])
  })
})

describe('what the ledger writes', () => {
  const event = (type: string, data: unknown, register?: string): EventInput =>
    ({
      type,
      data,
      actor,
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      ...(register ? { register } : {}),
    }) as EventInput

  it('moves an inbox item marker an earlier release left inline to a row at the end, and drops a message one', () => {
    const inbox = event(
      'inbox',
      {
        items: [
          { itemId: 'legacy', content: [], deliveredBy },
          { itemId: 'plain', content: [] },
        ],
      },
      'inbox',
    )
    const legacyMessage = event('user/message', { content: [{ type: 'text', text: 'x' }], deliveredBy })
    const after = event('turn/start', { turn: 1, trigger: 'prompt' })
    const written = withoutInlineMarkers([inbox, legacyMessage, after])
    expect(written.map((row) => row.type)).toEqual([
      'inbox',
      'user/message',
      'turn/start',
      INBOX_DELIVERED_BY_EVENT,
    ])
    expect(written[0]?.data).toEqual({
      items: [
        { itemId: 'legacy', content: [] },
        { itemId: 'plain', content: [] },
      ],
    })
    expect(written[1]?.data).toEqual({ content: [{ type: 'text', text: 'x' }] })
    expect(written[3]).toMatchObject({
      origin: 'system',
      trust: 'trusted',
      ignorable: true,
      lane: 'main',
      data: { itemId: 'legacy', deliveredBy },
    })
  })

  it('writes a batch without any inline marker as it came', () => {
    const batch = [event('inbox', { items: [{ itemId: 'plain', content: [] }] }, 'inbox')]
    expect(withoutInlineMarkers(batch)).toBe(batch)
  })
})

describe('DeliveryMarkerIndex', () => {
  it('scans again after a failed first pass instead of keeping the failure', async () => {
    const { DeliveryMarkerIndex } = await import('../../src/log/delivery-marker.js')
    const marked = row(1, INBOX_DELIVERED_BY_EVENT, { itemId: 'item-1', deliveredBy }, { origin: 'system' })
    let calls = 0
    const index = new DeliveryMarkerIndex(async () => {
      calls += 1
      if (calls === 1) throw new Error('read failed once')
      return calls === 2 ? [marked] : []
    })
    await expect(index.get('item-1')).rejects.toThrow('read failed once')
    await expect(index.get('item-1')).resolves.toEqual(deliveredBy)
    await expect(index.get('item-1')).resolves.toEqual(deliveredBy)
    expect(calls).toBeLessThanOrEqual(3)
  })
})
