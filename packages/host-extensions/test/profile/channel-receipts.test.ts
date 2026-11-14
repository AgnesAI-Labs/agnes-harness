import { createHash } from 'node:crypto'
import type { ChannelTargetEvent, PersistenceMetadataNamespace } from '@agnes/extension-api'
import type { CardBlock, TextBlock } from '@agnes/extension-api/channel-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PARKED_LIST_LIMIT,
  RECEIPT_ACK_TTL_MS,
  RECEIPT_ATTEMPTS,
  RECEIPT_RETRY_DELAYS_MS,
  REDELIVERY_INTERVAL_MS,
  type ReceiptRow,
} from '../../src/profile/channel-receipts.js'
import { type ChannelTargetLink, ChannelTargets } from '../../src/profile/channel-targets.js'

const CHANNEL = '@sample/chat#plugin/aa'
const DESK = { owner: '@sample/desk#plugin/bb', service: 'desk' }
const OTHER = { owner: '@sample/other#plugin/cc', service: 'desk' }
const PAIR_ID = 'a'.repeat(32)
const OTHER_PAIR_ID = 'b'.repeat(32)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
/** Handler runs in one delivery: the first try and the in-process retries. */
const TRIES = RECEIPT_RETRY_DELAYS_MS.length + 1

function namespace(): PersistenceMetadataNamespace & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    get: (key) => structuredClone(map.get(key)),
    set: (key, value) => void map.set(key, structuredClone(value)),
    delete: (key) => void map.delete(key),
    entries: () => [...map].map(([key, value]) => ({ key, value: structuredClone(value) })),
    transaction: (work) => work(),
  }
}

function link(): ChannelTargetLink {
  let next = 0
  return {
    provider: 'chat',
    textChars: 1000,
    card: true,
    cardBytes: 4000,
    rendered: (block: TextBlock | CardBlock) =>
      block.kind === 'text' ? block.markdown.length : block.body.length,
    connected: () => true,
    update: async () => {},
    async send(_chat, block) {
      next++
      return block.kind === 'card' && next === 2
        ? { messageId: `m-${next}`, cardBizId: `biz-${next}` }
        : { messageId: `m-${next}` }
    },
  }
}

const chatOf = (id: string, chatId: string) => ({
  id,
  accountId: 'app-1',
  credentials: 'fp-1',
  route: `route-${chatId}`,
  chatId,
  userId: 'owner',
  label: 'Owner',
})

afterEach(() => {
  vi.useRealTimers()
})
const flush = () => new Promise((resolve) => setImmediate(resolve))
const thrown = (work: () => unknown) => {
  try {
    work()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

/** A paired desk service on a controllable clock; `handler` is registered only when the test asks. */
/** In-process retries wait nothing unless a test asks for the real delays. */
function setup(retryDelaysMs: readonly number[] | 'real' = [0, 0]) {
  const store = namespace()
  let now = Date.parse('2026-11-14T00:00:00.000Z')
  const clock = {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
  const targets = new ChannelTargets(store, clock.now, retryDelaysMs === 'real' ? undefined : retryDelaysMs)
  const bridge = targets.bridge(CHANNEL)
  bridge.attach('desk-bot', link())
  const start = (target = DESK) => {
    const abort = new AbortController()
    const port = targets.port({
      ...target,
      packageId: target.owner.split('#')[0]!,
      signal: abort.signal,
      assertCurrent() {},
    })
    return { abort, port }
  }
  const pair = (target = DESK, id = PAIR_ID, chatId = 'dm-1') => {
    const { code } = targets.mint({ channel: CHANNEL, instanceId: 'desk-bot' }, target)
    expect(bridge.confirm('desk-bot', code, chatOf(id, chatId))).toBeTruthy()
    return bridge.find('desk-bot', chatId)!
  }
  const desk = start()
  const pairing = pair()
  return { store, clock, targets, bridge, desk, pairing, start, pair }
}

const message = (
  pairingId: string,
  eventId: string,
  text = 'hello',
  chatId = 'dm-1',
): ChannelTargetEvent => ({
  kind: 'message',
  origin: 'owner',
  pairingId,
  instanceId: 'desk-bot',
  eventId,
  messageId: `om-${eventId}`,
  at: '2026-11-14T00:00:00.000Z',
  chat: { id: chatId, type: 'dm' },
  sender: { userId: 'owner' },
  text,
})

const click = (
  pairingId: string,
  eventId: string,
  messageId: string,
  actionId: string,
): ChannelTargetEvent => ({
  kind: 'action',
  origin: 'owner',
  pairingId,
  instanceId: 'desk-bot',
  eventId,
  messageId,
  at: '2026-11-14T00:00:01.000Z',
  chat: { id: 'dm-1', type: 'dm' },
  sender: { userId: 'owner' },
  actionId,
})

const row = (store: ReturnType<typeof namespace>, owner: string, receiptId: string) =>
  store.get(`r:${owner}:${receiptId}`) as ReceiptRow | undefined

/** Writes the receipt and hands the event to the service, the way the channel bridge does. */
async function ingest(
  bridge: ReturnType<ChannelTargets['bridge']>,
  pairing: NonNullable<ReturnType<ReturnType<ChannelTargets['bridge']>['find']>>,
  event: ChannelTargetEvent,
) {
  const receipt = bridge.receive(pairing, event)
  if (typeof receipt === 'string') throw new Error(receipt)
  await bridge.deliver(pairing, { ...event, receiptId: receipt.receiptId }).catch(() => undefined)
  return receipt.receiptId
}

describe('channel receipts', () => {
  it('first event writes a pending receipt; the same event again returns its state; a different digest returns conflict', () => {
    const { store, bridge, pairing } = setup()
    const event = message(pairing.id, 'e1', 'hi', 'dm-1')
    const first = bridge.receive(pairing, event)
    const receiptId = sha256(`${CHANNEL}\0desk-bot\0app-1\0e1`)
    expect(first).toEqual({ receiptId, state: 'pending' })
    expect(row(store, DESK.owner, receiptId)).toEqual({
      receiptId,
      pairingId: pairing.id,
      pairedAt: pairing.pairedAt,
      target: DESK,
      instance: { channel: CHANNEL, instanceId: 'desk-bot' },
      eventId: 'e1',
      messageId: 'om-e1',
      sender: { userId: 'owner' },
      chat: { id: 'dm-1', type: 'dm' },
      at: '2026-11-14T00:00:00.000Z',
      kind: 'message',
      text: 'hi',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: 'pending',
      attempts: 0,
      updatedAt: '2026-11-14T00:00:00.000Z',
    })
    expect(bridge.receive(pairing, event)).toEqual({ receiptId, state: 'pending' })
    expect(bridge.receive(pairing, { ...event, text: 'changed' } as ChannelTargetEvent)).toBe('conflict')
    expect(
      bridge.receive(pairing, { ...event, sender: { userId: 'stranger' } }),
      'only the paired owner in the paired chat gets a receipt',
    ).toBe('dropped')
    expect(bridge.receive({ ...pairing, pairedAt: 'old' }, message(pairing.id, 'e2'))).toBe('dropped')
  })

  it('a resolved onEvent acks; a throw keeps it pending and counts an attempt; the fifth failure parks', async () => {
    const { store, bridge, desk, pairing } = setup()
    const seen: ChannelTargetEvent[] = []
    let fail = false
    desk.port.onEvent(async (event) => {
      seen.push(event)
      if (fail) throw new Error('poison')
    })
    const acked = await ingest(bridge, pairing, message(pairing.id, 'e1'))
    expect(seen.at(-1)).toMatchObject({ eventId: 'e1', receiptId: acked })
    expect(row(store, DESK.owner, acked)).toMatchObject({ state: 'acked', attempts: 0 })
    expect(bridge.receive(pairing, message(pairing.id, 'e1'))).toEqual({ receiptId: acked, state: 'acked' })
    await bridge.deliver(pairing, { ...message(pairing.id, 'e1'), receiptId: acked })
    expect(seen, 'an acked receipt never reaches the service again').toHaveLength(1)

    fail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const poison = message(pairing.id, 'e2', 'secret words')
    const receiptId = await ingest(bridge, pairing, poison)
    expect(row(store, DESK.owner, receiptId)).toMatchObject({ state: 'pending', attempts: 1 })
    for (let attempt = 2; attempt < RECEIPT_ATTEMPTS; attempt++) {
      await expect(bridge.deliver(pairing, { ...poison, receiptId })).rejects.toThrow('poison')
      expect(row(store, DESK.owner, receiptId)).toMatchObject({ state: 'pending', attempts: attempt })
    }
    expect(warn).not.toHaveBeenCalled()
    await expect(bridge.deliver(pairing, { ...poison, receiptId })).rejects.toThrow('poison')
    expect(row(store, DESK.owner, receiptId)).toMatchObject({ state: 'parked', attempts: RECEIPT_ATTEMPTS })
    // The operator is told once, by receipt and service, never with the text.
    expect(warn.mock.calls).toEqual([
      [
        `Channel receipt ${receiptId.slice(0, 12)} for desk parked: its service failed ${RECEIPT_ATTEMPTS} deliveries; the owner can redeliver or discard it in the Web`,
      ],
    ])
    warn.mockRestore()
    expect(bridge.receive(pairing, poison)).toEqual({ receiptId, state: 'parked' })
    await bridge.deliver(pairing, { ...poison, receiptId })
    expect(seen.filter((event) => event.eventId === 'e2')).toHaveLength(RECEIPT_ATTEMPTS * TRIES)
  })

  it('onEvent registration and the five-minute sweep redeliver pending receipts with the same receiptId', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { store, bridge, desk, pairing } = setup()
    const receiptId = await ingest(bridge, pairing, message(pairing.id, 'e1'))
    expect(
      row(store, DESK.owner, receiptId),
      'a service without a handler is not running: no attempt is counted',
    ).toMatchObject({ state: 'pending', attempts: 0 })

    const seen: ChannelTargetEvent[] = []
    let fail = true
    desk.port.onEvent(async (event) => {
      seen.push(event)
      if (fail) throw new Error('not yet')
    })
    expect(seen, 'redelivery waits until onEvent has returned').toHaveLength(0)
    await flush()
    expect(row(store, DESK.owner, receiptId)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(seen[0]).toEqual({ ...message(pairing.id, 'e1'), receiptId })

    fail = false
    expect(seen, 'one burst of in-process tries, counted as one attempt').toHaveLength(TRIES)
    await vi.advanceTimersByTimeAsync(REDELIVERY_INTERVAL_MS - 1)
    expect(seen).toHaveLength(TRIES)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(row(store, DESK.owner, receiptId)).toMatchObject({ state: 'acked', attempts: 1 })
    expect(seen).toHaveLength(TRIES + 1)
    expect(seen.at(-1)).toEqual(seen[0])
    await vi.advanceTimersByTimeAsync(REDELIVERY_INTERVAL_MS)
    expect(seen, 'the sweep skips acked receipts').toHaveLength(TRIES + 1)
  })

  it('a throwing handler is retried in process with short backoff, and one burst counts one attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { store, bridge, desk, pairing } = setup('real')
    expect(RECEIPT_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBe(10_000)
    let failures = 2
    let runs = 0
    desk.port.onEvent(async () => {
      runs++
      if (failures-- > 0) throw new Error('transient')
    })
    const event = message(pairing.id, 'e1')
    const first = bridge.receive(pairing, event) as { receiptId: string }
    const delivery = bridge.deliver(pairing, { ...event, receiptId: first.receiptId })
    await flush()
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await delivery
    expect(runs).toBe(3)
    expect(row(store, DESK.owner, first.receiptId)).toMatchObject({ state: 'acked', attempts: 0 })

    failures = Number.POSITIVE_INFINITY
    const poison = message(pairing.id, 'e2')
    const second = bridge.receive(pairing, poison) as { receiptId: string }
    const failed = bridge.deliver(pairing, { ...poison, receiptId: second.receiptId })
    const outcome = failed.then(
      () => 'resolved',
      () => 'rejected',
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await outcome).toBe('rejected')
    expect(runs).toBe(3 + TRIES)
    expect(row(store, DESK.owner, second.receiptId), 'left pending for the sweep').toMatchObject({
      state: 'pending',
      attempts: 1,
    })
  })

  it('a click on a card sent before buttons were recorded gets no receipt and is reported unrecorded', async () => {
    const { store, bridge, desk, pairing } = setup()
    const card = await desk.port.send(pairing.id, {
      deliveryKey: 'old-card',
      text: 'pick one',
      actions: [{ id: 'pick:1', label: 'Ship it' }],
    })
    const [ledger] = [...store.map].find(
      ([, value]) => (value as { messageId?: string }).messageId === card.messageId,
    )!
    const { actions: _, ...legacy } = store.map.get(ledger) as Record<string, unknown>
    store.set(ledger, legacy as never)
    expect(bridge.receive(pairing, click(pairing.id, 'old', card.messageId, 'pick:1'))).toBe('unrecorded')
    expect(
      [...store.map.keys()].filter((key) => key.startsWith('r:')),
      'no receipt for it',
    ).toEqual([])
    expect(bridge.receive(pairing, click(pairing.id, 'unknown', 'm-unknown', 'pick:1'))).toBe('dropped')
  })

  it('a pending receipt whose pairing changed is parked, not delivered', async () => {
    const { store, clock, bridge, desk, pairing, pair } = setup()
    const receiptId = await ingest(bridge, pairing, message(pairing.id, 'e1'))
    await desk.port.unpair(pairing.id)
    clock.advance(1000)
    const again = pair()
    expect(again.id).toBe(pairing.id)
    expect(again.pairedAt).not.toBe(pairing.pairedAt)
    const handler = vi.fn(async () => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    desk.port.onEvent(handler)
    await vi.waitFor(() => expect(row(store, DESK.owner, receiptId)).toMatchObject({ state: 'parked' }))
    expect(handler).not.toHaveBeenCalled()
    expect(warn.mock.calls).toEqual([
      [
        `Channel receipt ${receiptId.slice(0, 12)} for desk parked: its pairing changed; the owner can redeliver or discard it in the Web`,
      ],
    ])
    warn.mockRestore()
  })

  it('prune deletes admitted receipts at once, acked unadmitted ones after 30 days, never parked ones', async () => {
    const { store, clock, targets, bridge, desk, pairing } = setup()
    let fail = false
    desk.port.onEvent(async () => {
      if (fail) throw new Error('poison')
    })
    const admitted = await ingest(bridge, pairing, message(pairing.id, 'e1'))
    const kept = await ingest(bridge, pairing, message(pairing.id, 'e2'))
    fail = true
    const parked = await ingest(bridge, pairing, message(pairing.id, 'e3'))
    for (let attempt = 1; attempt < RECEIPT_ATTEMPTS; attempt++)
      await bridge
        .deliver(pairing, { ...message(pairing.id, 'e3'), receiptId: parked })
        .catch(() => undefined)
    expect(row(store, DESK.owner, parked)?.state).toBe('parked')

    targets.receipts.admitted(DESK.owner, admitted)
    expect(row(store, DESK.owner, admitted)).toBeUndefined()

    clock.advance(RECEIPT_ACK_TTL_MS - 1)
    targets.receipts.prune()
    expect(row(store, DESK.owner, kept)?.state).toBe('acked')
    clock.advance(1)
    targets.receipts.prune()
    expect(row(store, DESK.owner, kept)).toBeUndefined()
    clock.advance(10 * RECEIPT_ACK_TTL_MS)
    targets.receipts.prune()
    expect(row(store, DESK.owner, parked)?.state).toBe('parked')
  })

  it('a click gets a receipt only on a message this service sent; its text is the button label recorded at send', async () => {
    const { store, bridge, desk, pairing } = setup()
    const actions = [
      { id: 'pick:1', label: 'Ship it' },
      { id: 'pick:2', label: 'Hold', style: 'danger' as const },
    ]
    const plain = await desk.port.send(pairing.id, { deliveryKey: 'plain', text: 'note' })
    const card = await desk.port.send(pairing.id, { deliveryKey: 'card', text: 'pick one', actions })
    expect(card.messageId).toBe('m-2')

    const receipt = bridge.receive(pairing, click(pairing.id, 'c1', 'biz-2', 'pick:2'))
    expect(receipt).toMatchObject({ state: 'pending' })
    const written = row(store, DESK.owner, (receipt as { receiptId: string }).receiptId)
    expect(written).toMatchObject({ kind: 'action', actionId: 'pick:2', text: 'Hold', messageId: 'm-2' })
    expect(written).not.toHaveProperty('quotedMessageId')

    expect(bridge.receive(pairing, click(pairing.id, 'c2', 'm-2', 'pick:9')), 'not a button it offered').toBe(
      'dropped',
    )
    expect(bridge.receive(pairing, click(pairing.id, 'c3', plain.messageId, 'pick:1'))).toBe('dropped')
    expect(bridge.receive(pairing, click(pairing.id, 'c4', 'm-unknown', 'pick:1'))).toBe('dropped')

    await desk.port.update(pairing.id, card.messageId, { text: 'settled' })
    expect(
      bridge.receive(pairing, click(pairing.id, 'c5', 'm-2', 'pick:1')),
      'an update without buttons takes the recorded ones away',
    ).toBe('dropped')
    await desk.port.update(pairing.id, card.messageId, {
      text: 'again',
      actions: [{ id: 'redo', label: 'Redo' }],
    })
    expect(bridge.receive(pairing, click(pairing.id, 'c6', 'm-2', 'redo'))).toMatchObject({
      state: 'pending',
    })
  })

  it('resolve reports receiptUnknown for another owner or service and pairingChanged after re-pairing', async () => {
    const { clock, targets, bridge, desk, pairing, pair } = setup()
    const receiptId = await ingest(bridge, pairing, message(pairing.id, 'e1', 'ship the fix'))
    expect(targets.receipts.resolve(DESK, receiptId)).toEqual({
      kind: 'receipt',
      receiptId,
      text: 'ship the fix',
      contentDigest: sha256('ship the fix'),
      source: {
        instanceId: 'desk-bot',
        pairingId: pairing.id,
        eventId: 'e1',
        messageId: 'om-e1',
        kind: 'message',
        at: '2026-11-14T00:00:00.000Z',
      },
    })
    const unknown = { kind: 'unresolved', receiptId, reason: 'receiptUnknown' }
    expect(targets.receipts.resolve(OTHER, receiptId)).toEqual(unknown)
    expect(targets.receipts.resolve({ owner: DESK.owner, service: 'other' }, receiptId)).toEqual(unknown)
    expect(targets.receipts.resolve(DESK, 'f'.repeat(64))).toMatchObject({ reason: 'receiptUnknown' })
    expect(targets.receipts.resolve(DESK, 'not-a-receipt')).toMatchObject({ reason: 'receiptUnknown' })

    await desk.port.unpair(pairing.id)
    expect(targets.receipts.resolve(DESK, receiptId)).toEqual({ ...unknown, reason: 'pairingChanged' })
    clock.advance(1000)
    pair()
    expect(targets.receipts.resolve(DESK, receiptId)).toEqual({ ...unknown, reason: 'pairingChanged' })
  })

  it('the list across owners sends at most PARKED_LIST_LIMIT receipts, oldest first, and a smaller limit when asked', () => {
    const { store, targets } = setup()
    const parkedRow = (index: number): ReceiptRow => ({
      receiptId: sha256(`r${index}`),
      pairingId: PAIR_ID,
      pairedAt: '2026-11-14T00:00:00.000Z',
      target: index % 2 ? DESK : OTHER,
      instance: { channel: CHANNEL, instanceId: 'desk-bot' },
      eventId: `e${index}`,
      messageId: `m${index}`,
      sender: { userId: 'owner' },
      chat: { id: 'dm-1', type: 'dm' },
      at: new Date(
        Date.parse('2026-11-14T00:00:00.000Z') + (PARKED_LIST_LIMIT + 5 - index) * 1000,
      ).toISOString(),
      kind: 'message',
      text: `parked ${index}`,
      digest: sha256(`d${index}`),
      state: 'parked',
      attempts: RECEIPT_ATTEMPTS,
      updatedAt: '2026-11-14T00:00:00.000Z',
    })
    for (let index = 0; index < PARKED_LIST_LIMIT + 5; index++) {
      const value = parkedRow(index)
      store.set(`r:${value.target.owner}:${value.receiptId}`, value)
    }
    const all = targets.receipts.command({ op: 'parkedAll' }) as { receipts: { text: string; at: string }[] }
    expect(all.receipts).toHaveLength(PARKED_LIST_LIMIT)
    // Oldest event first: the highest indexes carry the earliest times.
    expect(all.receipts[0]?.text).toBe(`parked ${PARKED_LIST_LIMIT + 4}`)
    expect(all.receipts.map((r) => r.at)).toEqual([...all.receipts.map((r) => r.at)].sort())
    const few = targets.receipts.command({ op: 'parkedAll', limit: 3 }) as { receipts: unknown[] }
    expect(few.receipts).toHaveLength(3)
    const capped = targets.receipts.command({ op: 'parkedAll', limit: 10_000 }) as { receipts: unknown[] }
    expect(capped.receipts).toHaveLength(PARKED_LIST_LIMIT)
  })

  it("parked lists one owner's receipts; redeliver resets attempts; discard deletes", async () => {
    const { store, targets, bridge, desk, pairing, start, pair } = setup()
    const other = start(OTHER)
    const otherPairing = pair(OTHER, OTHER_PAIR_ID, 'dm-2')
    let fail = true
    const seen: string[] = []
    const handler = async (event: ChannelTargetEvent) => {
      seen.push(event.eventId)
      if (fail) throw new Error('poison')
    }
    desk.port.onEvent(handler)
    other.port.onEvent(handler)
    const park = async (p: typeof pairing, event: ChannelTargetEvent) => {
      const receiptId = await ingest(bridge, p, event)
      for (let attempt = 1; attempt < RECEIPT_ATTEMPTS; attempt++)
        await bridge.deliver(p, { ...event, receiptId }).catch(() => undefined)
      return receiptId
    }
    const first = await park(pairing, message(pairing.id, 'e1', 'first'))
    const second = await park(pairing, message(pairing.id, 'e2', 'second'))
    await park(otherPairing, message(otherPairing.id, 'e3', 'elsewhere', 'dm-2'))

    const listed = targets.receipts.command({ op: 'parked', owner: DESK.owner }) as {
      receipts: { receiptId: string }[]
    }
    expect(listed.receipts.map((r) => r.receiptId).sort()).toEqual([first, second].sort())
    expect(listed.receipts.find((r) => r.receiptId === first)).toEqual({
      receiptId: first,
      service: 'desk',
      kind: 'message',
      text: 'first',
      at: '2026-11-14T00:00:00.000Z',
      attempts: RECEIPT_ATTEMPTS,
    })
    // The owner's list across services names each receipt's owner.
    const all = targets.receipts.command({ op: 'parkedAll' }) as {
      receipts: { owner: string; text: string }[]
    }
    expect(all.receipts.map((r) => [r.owner, r.text]).sort()).toEqual(
      [
        [DESK.owner, 'first'],
        [DESK.owner, 'second'],
        [OTHER.owner, 'elsewhere'],
      ].sort(),
    )

    fail = false
    expect(targets.receipts.command({ op: 'redeliver', owner: DESK.owner, receiptId: first })).toEqual({
      receipt: 'pending',
    })
    await vi.waitFor(() =>
      expect(row(store, DESK.owner, first)).toMatchObject({ state: 'acked', attempts: 0 }),
    )
    expect(seen.filter((id) => id === 'e1')).toHaveLength(RECEIPT_ATTEMPTS * TRIES + 1)
    expect(targets.receipts.command({ op: 'discard', owner: DESK.owner, receiptId: second })).toEqual({
      receipt: 'discarded',
    })
    expect(row(store, DESK.owner, second)).toBeUndefined()
    expect(targets.receipts.command({ op: 'parked', owner: DESK.owner })).toEqual({ receipts: [] })

    expect(() => targets.receipts.command({ op: 'discard', owner: OTHER.owner, receiptId: first })).toThrow()
    expect(() => targets.receipts.command({ op: 'redeliver', owner: DESK.owner, receiptId: first })).toThrow()
    expect(thrown(() => targets.receipts.command({ op: 'drop', owner: DESK.owner }))).toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    expect(
      thrown(() => targets.receipts.command({ op: 'discard', owner: DESK.owner, receiptId: 'x' })),
    ).toMatchObject({ data: { code: 'INVALID_PARAMS' } })
  })
})
