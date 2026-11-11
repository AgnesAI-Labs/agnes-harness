import { MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { ChannelTargetEvent, PersistenceMetadataNamespace } from '@agnes/extension-api'
import type { CardBlock, TextBlock } from '@agnes/extension-api/channel-contract'
import type { Actor } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { ServiceRegistry } from '../../src/ext-host/services.js'
import { ProfileActivations } from '../../src/profile/activation.js'
import { CHANNEL_PAIRING_OWNER, createChannelPairingApprovals } from '../../src/profile/channel-pairing.js'
import {
  type ChannelTargetLink,
  ChannelTargets,
  deniedChannelTargets,
} from '../../src/profile/channel-targets.js'
import { createProfileServiceRuntime } from '../../src/profile/runtime.js'

const CHANNEL = '@sample/chat#plugin/aa'
const DESK = { owner: '@sample/desk#plugin/bb', service: 'desk' }
const OTHER = { owner: '@sample/other#plugin/cc', service: 'desk' }
const PAIR_ID = 'a'.repeat(32)
const actor: Actor = { id: 'operator', org: 'local', role: 'user', deptPath: [], attrs: {} }

function namespace(): PersistenceMetadataNamespace {
  const map = new Map<string, unknown>()
  return {
    get: (key) => structuredClone(map.get(key)),
    set: (key, value) => void map.set(key, structuredClone(value)),
    delete: (key) => void map.delete(key),
    entries: () => [...map].map(([key, value]) => ({ key, value: structuredClone(value) })),
    transaction: (work) => work(),
  }
}

type Sent = { chatId: string; block: TextBlock | CardBlock; key: string }

const CHANNEL_CHARS = 1000

/** What a channel without cards receives for a card: the title, body and a numbered button list. */
function cardText(block: CardBlock) {
  const lines = [block.title ? `【${block.title}】` : '', block.body]
  for (const [index, action] of (block.actions ?? []).entries()) lines.push(`${index + 1}. ${action.label}`)
  lines.push(`回复 ${block.actions?.map((_, index) => index + 1).join(' / ')} 选择`)
  return lines.filter((line, index) => index > 0 || line).join('\n')
}

function link(sent: Sent[], over: Partial<ChannelTargetLink> = {}) {
  let next = 0
  const self: ChannelTargetLink = {
    provider: 'chat',
    textChars: CHANNEL_CHARS,
    card: true,
    cardBytes: 400,
    rendered: (block) =>
      block.kind === 'text' ? block.markdown.length : (self.card ? block.body : cardText(block)).length,
    connected: () => true,
    async send(chatId: string, block: TextBlock | CardBlock, key: string) {
      sent.push({ chatId, block, key })
      return { messageId: `m-${++next}` }
    },
    ...over,
  }
  return self
}

const chat = {
  id: PAIR_ID,
  accountId: 'app-1',
  credentials: 'fp-1',
  route: 'route-1',
  chatId: 'dm-1',
  userId: 'owner',
  label: 'Owner',
}
const service = (targets: ChannelTargets, target = DESK, abort = new AbortController()) => ({
  abort,
  port: targets.port({
    ...target,
    packageId: target.owner.split('#')[0]!,
    signal: abort.signal,
    assertCurrent() {},
  }),
})

function paired() {
  const store = namespace()
  const targets = new ChannelTargets(store)
  const sent: Sent[] = []
  const bridge = targets.bridge(CHANNEL)
  bridge.attach('desk-bot', link(sent))
  const desk = service(targets)
  const changed = vi.fn()
  desk.port.onPairingChange(changed)
  const { code } = targets.mint({ channel: CHANNEL, instanceId: 'desk-bot' }, DESK)
  expect(bridge.confirm('desk-bot', code.toLowerCase().replace('-', ' '), chat)).toEqual({
    label: '@sample/desk',
  })
  expect(changed).toHaveBeenCalledOnce()
  return { store, targets, bridge, desk, sent }
}

describe('channel targets', () => {
  it('refuses every call of a service without the reviewed declaration', async () => {
    await expect(deniedChannelTargets.pairing()).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(deniedChannelTargets.send(PAIR_ID, { deliveryKey: 'k', text: 't' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(() => deniedChannelTargets.onEvent(async () => {})).toThrow()
  })

  it('mints a code only for a running unpaired service on a connected instance, and voids it after five misses', () => {
    const targets = new ChannelTargets(namespace())
    const instance = { channel: CHANNEL, instanceId: 'desk-bot' }
    expect(targets.mintRefusal(instance, DESK)).toBe('TARGET_UNAVAILABLE')
    service(targets)
    expect(targets.mintRefusal(instance, DESK)).toBe('CHANNEL_UNAVAILABLE')
    const bridge = targets.bridge(CHANNEL)
    bridge.attach('desk-bot', link([]))
    const { code, expiresAt } = targets.mint(instance, DESK)
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect(bridge.expectsCode('desk-bot', 'hello')).toBe(false)
    expect(bridge.expectsCode('other-bot', code)).toBe(false)
    expect(bridge.expectsCode('desk-bot', code)).toBe(true)
    for (let miss = 0; miss < 5; miss++) expect(bridge.confirm('desk-bot', 'WXYZ-2345', chat)).toBeUndefined()
    expect(bridge.expectsCode('desk-bot', code), 'five misses void the code').toBe(false)
    expect(bridge.confirm('desk-bot', code, chat)).toBeUndefined()
    expect(targets.targets()).toEqual([
      { ...DESK, packageId: '@sample/desk', label: '@sample/desk', paired: false },
    ])
  })

  it('gives the paired service its pairing and owner events, and refuses another package', async () => {
    const { targets, bridge, desk } = paired()
    expect(await desk.port.pairing()).toEqual({
      id: PAIR_ID,
      instanceId: 'desk-bot',
      provider: 'chat',
      userId: 'owner',
      chatId: 'dm-1',
      label: 'Owner',
      running: true,
      textChars: 605,
    })
    const pairing = bridge.find('desk-bot', 'dm-1')!
    await expect(bridge.deliver(pairing, {} as ChannelTargetEvent)).rejects.toMatchObject({
      data: { code: 'CHANNEL_UNAVAILABLE' },
    })
    const events: ChannelTargetEvent[] = []
    desk.port.onEvent(async (event) => void events.push(event))
    await bridge.deliver(pairing, { text: 'hi' } as ChannelTargetEvent)
    expect(events).toEqual([{ text: 'hi' }])
    const other = service(targets, OTHER)
    await expect(other.port.send(PAIR_ID, { deliveryKey: 'k', text: 'x' })).rejects.toMatchObject({
      data: { code: 'NOT_PAIRED' },
    })
    await expect(other.port.delivery(PAIR_ID, 'k')).rejects.toMatchObject({ data: { code: 'NOT_PAIRED' } })
    expect(await other.port.pairing()).toBeUndefined()
    expect(targets.mintRefusal({ channel: CHANNEL, instanceId: 'desk-bot' }, DESK)).toBe('TARGET_PAIRED')
    expect(bridge.paired('desk-bot', PAIR_ID)).toBe(true)
    expect(bridge.pairings('desk-bot')).toMatchObject([
      { id: PAIR_ID, target: { packageId: '@sample/desk' }, running: true },
    ])
  })

  it('sends one message per key, records the ledger and reads it back after a restart', async () => {
    const { store, desk, sent, bridge } = paired()
    await expect(desk.port.send(PAIR_ID, { deliveryKey: 'k1', text: 'x'.repeat(606) })).rejects.toMatchObject(
      {
        data: { code: 'TOO_LARGE' },
      },
    )
    expect(await desk.port.delivery(PAIR_ID, 'k1')).toEqual({ state: 'unknown' })
    expect(await desk.port.send(PAIR_ID, { deliveryKey: 'k1', text: 'remind' })).toEqual({ messageId: 'm-1' })
    expect(await desk.port.send(PAIR_ID, { deliveryKey: 'k1', text: 'remind' })).toEqual({ messageId: 'm-1' })
    expect(sent, 'a repeated key never sends twice').toHaveLength(1)
    expect(sent[0]).toMatchObject({
      chatId: 'dm-1',
      block: { kind: 'text', markdown: 'remind' },
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await desk.port.delivery(PAIR_ID, 'k1')).toEqual({ state: 'delivered', messageId: 'm-1' })

    let release: () => void = () => {}
    bridge.attach('desk-bot', {
      ...link(sent),
      send: () => new Promise((resolve) => (release = () => resolve({ messageId: 'm-slow' }))),
    })
    const slow = desk.port.send(PAIR_ID, { deliveryKey: 'k2', text: 'slow' })
    expect(await desk.port.delivery(PAIR_ID, 'k2')).toEqual({ state: 'pending' })

    // Another process over the same store: pairings stay, a send it did not finish reads as unknown.
    const restarted = new ChannelTargets(store)
    const again = service(restarted)
    expect(await again.port.pairing()).toMatchObject({ id: PAIR_ID, running: false, provider: 'chat' })
    expect(await again.port.delivery(PAIR_ID, 'k1')).toEqual({ state: 'delivered', messageId: 'm-1' })
    expect(await again.port.delivery(PAIR_ID, 'k2')).toEqual({ state: 'unknown' })
    await expect(again.port.send(PAIR_ID, { deliveryKey: 'k3', text: 'x' })).rejects.toMatchObject({
      data: { code: 'CHANNEL_UNAVAILABLE' },
    })
    release()
    await slow

    bridge.attach('desk-bot', {
      ...link(sent),
      send: async () => {
        throw Object.assign(new Error('token=secret body'), { code: 'TARGET_UNCONFIRMED' })
      },
    })
    await expect(desk.port.send(PAIR_ID, { deliveryKey: 'k4', text: 'x' })).rejects.toEqual(
      expect.objectContaining({ data: { code: 'TARGET_UNCONFIRMED' } }),
    )
    expect(await desk.port.delivery(PAIR_ID, 'k4')).toEqual({ state: 'unknown' })
  })

  it('composes a titled text or a card with actions, and refuses invalid actions and an oversize card', async () => {
    const { desk, sent, bridge } = paired()
    await desk.port.send(PAIR_ID, { deliveryKey: 't', text: 'body', title: 'Heads up' })
    expect(sent.at(-1)?.block).toEqual({ kind: 'text', markdown: '**Heads up**\nbody' })
    const actions = [
      { id: 'pick:1', label: 'One', style: 'primary' as const },
      { id: 'pick:new', label: 'New', style: 'default' as const },
      { id: 'drop', label: 'Drop', style: 'danger' as const },
    ]
    await desk.port.send(PAIR_ID, { deliveryKey: 'c', text: 'which?', title: 'Pick', actions })
    expect(sent.at(-1)?.block).toEqual({
      kind: 'card',
      title: 'Pick',
      body: 'which?',
      actions: [
        { id: 'pick:1', label: 'One', style: 'primary' },
        { id: 'pick:new', label: 'New' },
        { id: 'drop', label: 'Drop', style: 'danger' },
      ],
    })
    await desk.port.send(PAIR_ID, { deliveryKey: 'u', text: 'which?', actions: [{ id: 'a', label: 'A' }] })
    expect(sent.at(-1)?.block, 'a card without a title').toEqual({
      kind: 'card',
      title: '',
      body: 'which?',
      actions: [{ id: 'a', label: 'A' }],
    })

    const count = sent.length
    const invalid: unknown[] = [
      [],
      Array.from({ length: 7 }, (_, index) => ({ id: `a${index}`, label: 'A' })),
      [{ id: 'has space', label: 'A' }],
      [{ id: 'x'.repeat(65), label: 'A' }],
      [
        { id: 'same', label: 'A' },
        { id: 'same', label: 'B' },
      ],
      [{ id: 'a', label: '' }],
      [{ id: 'a', label: 'x'.repeat(41) }],
      [{ id: 'a', label: 'two\nlines' }],
      [{ id: 'a', label: 'A', style: 'loud' }],
      'pick',
    ]
    for (const bad of invalid)
      await expect(
        desk.port.send(PAIR_ID, { deliveryKey: 'bad', text: 'x', actions: bad as never }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    for (const title of ['', 'x'.repeat(101), 'two\nlines', 7])
      await expect(
        desk.port.send(PAIR_ID, { deliveryKey: 'bad', text: 'x', title: title as never }),
      ).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    const big = Array.from({ length: 6 }, (_, index) => ({
      id: `${'i'.repeat(60)}${index}`,
      label: 'L'.repeat(40),
    }))
    await expect(
      desk.port.send(PAIR_ID, { deliveryKey: 'big', text: 'x', actions: big }),
      'a composed card over cardBytes',
    ).rejects.toMatchObject({ data: { code: 'TOO_LARGE' } })
    expect(sent, 'nothing refused reaches the channel').toHaveLength(count)
    expect(await desk.port.delivery(PAIR_ID, 'big')).toEqual({ state: 'unknown' })

    bridge.attach('desk-bot', link(sent, { card: false }))
    await desk.port.send(PAIR_ID, { deliveryKey: 'big', text: 'x', actions: big })
    expect(sent.at(-1)?.block.kind, 'a text-only channel degrades the card instead').toBe('card')
  })

  it('keeps what the platform adds around a send inside the channel limit', async () => {
    const { desk, sent, bridge } = paired()
    const limit = (await desk.port.pairing())!.textChars
    expect(limit, 'the reserve is the worst case of a title and six buttons').toBe(CHANNEL_CHARS - 395)
    const receivedLength = (block: TextBlock | CardBlock) =>
      block.kind === 'text' ? block.markdown.length : cardText(block).length

    await desk.port.send(PAIR_ID, { deliveryKey: 'titled', text: 'x'.repeat(limit), title: 'T'.repeat(100) })
    expect(receivedLength(sent.at(-1)!.block)).toBeLessThanOrEqual(CHANNEL_CHARS)

    bridge.attach('desk-bot', link(sent, { card: false }))
    const buttons = Array.from({ length: 6 }, (_, index) => ({ id: `b${index}`, label: 'L'.repeat(40) }))
    await desk.port.send(PAIR_ID, {
      deliveryKey: 'buttons',
      text: 'x'.repeat(limit),
      title: 'T'.repeat(100),
      actions: buttons,
    })
    expect(receivedLength(sent.at(-1)!.block), 'a text-only channel also gets the button list').toBe(
      CHANNEL_CHARS,
    )

    const count = sent.length
    bridge.attach('desk-bot', link(sent, { textChars: 300 }))
    expect((await desk.port.pairing())!.textChars, 'the reserve never drops the limit below one').toBe(1)
    await expect(
      desk.port.send(PAIR_ID, { deliveryKey: 'small', text: 'xx' }),
      'text over the reported limit',
    ).rejects.toMatchObject({ data: { code: 'TOO_LARGE' } })
    bridge.attach('desk-bot', link(sent, { rendered: () => CHANNEL_CHARS + 1 }))
    await expect(
      desk.port.send(PAIR_ID, { deliveryKey: 'long', text: 'x', title: 'Heads up' }),
      'rendered text over the channel limit',
    ).rejects.toMatchObject({ data: { code: 'TOO_LARGE' } })
    expect(sent, 'nothing refused reaches the channel').toHaveLength(count)
    expect(await desk.port.delivery(PAIR_ID, 'long')).toEqual({ state: 'unknown' })
  })

  it('delivers a click only on a message this service sent, under the id its send returned', async () => {
    const { desk, bridge, targets } = paired()
    const events: ChannelTargetEvent[] = []
    desk.port.onEvent(async (event) => void events.push(event))
    bridge.attach('desk-bot', {
      ...link([]),
      send: async () => ({ messageId: 'om-1', cardBizId: 'card-1' }),
    })
    await desk.port.send(PAIR_ID, { deliveryKey: 'c', text: 'which?', actions: [{ id: 'a', label: 'A' }] })
    const pairing = bridge.find('desk-bot', 'dm-1')!
    const click = (messageId: string, eventId: string): ChannelTargetEvent => ({
      kind: 'action',
      origin: 'owner',
      pairingId: PAIR_ID,
      instanceId: 'desk-bot',
      eventId,
      at: '2026-11-12T00:00:00Z',
      chat: { id: 'dm-1', type: 'dm' },
      sender: { userId: 'owner' },
      messageId,
      actionId: 'a',
    })
    await bridge.deliver(pairing, click('card-1', 'by-card-id'))
    await bridge.deliver(pairing, click('om-1', 'by-message-id'))
    await bridge.deliver(pairing, click('om-other', 'not-ours'))
    expect(events.map((event) => event.eventId)).toEqual(['by-card-id', 'by-message-id'])
    expect(events[0]).toMatchObject({ kind: 'action', messageId: 'om-1', actionId: 'a' })

    await desk.port.unpair(PAIR_ID)
    const sibling = service(targets, { owner: DESK.owner, service: 'sibling' })
    const siblingEvents: ChannelTargetEvent[] = []
    sibling.port.onEvent(async (event) => void siblingEvents.push(event))
    const { code } = targets.mint(
      { channel: CHANNEL, instanceId: 'desk-bot' },
      { owner: DESK.owner, service: 'sibling' },
    )
    bridge.confirm('desk-bot', code, chat)
    await bridge.deliver(bridge.find('desk-bot', 'dm-1')!, click('om-1', 'earlier-service'))
    expect(
      siblingEvents,
      'a sibling service paired later never gets clicks on the earlier service message',
    ).toEqual([])
  })

  it('releases pairings and ledger rows when either package is removed, and retains only current instances', async () => {
    const first = paired()
    await first.desk.port.send(PAIR_ID, { deliveryKey: 'k1', text: 'x' })
    first.targets.releasePackage('@sample/desk')
    expect(await first.desk.port.pairing()).toBeUndefined()
    expect(first.store.entries().filter((row) => row.key.startsWith('d:'))).toEqual([])
    const reinstalled = service(first.targets)
    expect(
      await reinstalled.port.pairing(),
      'a reinstalled package with the same id has no pairing',
    ).toBeUndefined()

    const second = paired()
    second.targets.releasePackage('@sample/chat')
    expect(await second.desk.port.pairing()).toBeUndefined()

    const third = paired()
    third.bridge.retain([{ id: 'desk-bot', credentials: 'fp-1' }])
    expect(await third.desk.port.pairing()).toBeDefined()
    third.bridge.retain([{ id: 'desk-bot', credentials: 'fp-2' }])
    expect(await third.desk.port.pairing(), 'changed credential references end the pairing').toBeUndefined()

    const fourth = paired()
    await fourth.desk.port.unpair(PAIR_ID)
    expect(await fourth.desk.port.pairing()).toBeUndefined()
    expect(() => fourth.targets.revoke(PAIR_ID)).toThrow()
  })
})

describe('pairing code approval', () => {
  function fixture() {
    const storage = new MemoryStorage()
    let now = Date.now()
    const targets = new ChannelTargets(namespace(), () => now)
    targets.bridge(CHANNEL).attach('desk-bot', link([]))
    service(targets)
    let runtime: ReturnType<typeof createProfileServiceRuntime> | undefined
    const approvals = createChannelPairingApprovals({
      targets,
      decisions: () => runtime!.hostDecisions('human'),
      clock: () => now,
    })
    runtime = createProfileServiceRuntime({
      profileId: 'default',
      hostOwners: new Map([[CHANNEL_PAIRING_OWNER, approvals.owner]]),
      registry: new ServiceRegistry(),
      activations: new ProfileActivations(namespace()),
      storage,
      metadata: { namespace: () => namespace() },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      seams: fakeSeams({
        principals: {
          resolve: async () => actor,
          authorize: async () => ({ effect: 'allow', decisionId: 'permit', reason: 'fixture' }),
        },
      }),
      clock: () => now,
      signal: new AbortController().signal,
      networkAllow: [],
      audit: () => undefined,
    })
    const request = { instance: { channel: CHANNEL, instanceId: 'desk-bot' }, target: DESK }
    const answer = async (option: string) => {
      const [snapshot] = await runtime!.listDecisions('human')
      await runtime!.answerDecision(
        {
          handle: snapshot!.handle,
          revision: snapshot!.revision,
          commandId: `a:${option}`,
          response: { option, value: null },
        },
        'human',
      )
    }
    return { runtime, approvals, request, answer, targets, time: (ms: number) => (now += ms) }
  }

  it('asks a person first and returns the code once to the approved repeat, never persisting it', async () => {
    const f = fixture()
    const first = await f.approvals.mint(f.request, 'op-1')
    expect(first.receipt).toMatchObject({ state: 'approval-required', decision: { id: expect.any(String) } })
    expect(first.code).toBeUndefined()
    const listed = await f.runtime.listDecisions('human')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.request.spec.presentation).toMatchObject({
      en: { title: 'Create a channel pairing code' },
    })
    expect((await f.approvals.mint(f.request, 'op-1')).receipt.state, 'still waiting').toBe(
      'approval-required',
    )
    await expect(
      f.approvals.mint({ ...f.request, target: OTHER }, 'op-1'),
      'the same operation with other parameters conflicts',
    ).rejects.toMatchObject({ data: { code: 'ID_CONFLICT' } })

    await f.answer('allowed-once')
    const approved = await f.approvals.mint(f.request, 'op-1')
    expect(approved.receipt).toMatchObject({ state: 'completed', output: { expiresAt: expect.any(Number) } })
    expect(approved.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const replay = await f.approvals.mint(f.request, 'op-1')
    expect(replay.code, 'one approval, one code').toBeUndefined()
    expect(replay.receipt.state).toBe('completed')
    const { journal } = await f.runtime.hostDecisions('human')
    expect(JSON.stringify([...journal.operations.values()])).not.toContain(approved.code)
    expect(await f.runtime.listDecisions('human')).toEqual([])
  })

  it('refuses a rejected request and withdraws one whose target was paired meanwhile', async () => {
    const f = fixture()
    await f.approvals.mint(f.request, 'op-1')
    await f.answer('rejected')
    expect((await f.approvals.mint(f.request, 'op-1')).receipt).toMatchObject({
      state: 'refused',
      code: 'APPROVAL_REFUSED',
    })

    await f.approvals.mint(f.request, 'op-2')
    const { code } = f.targets.mint(f.request.instance, DESK)
    f.targets.bridge(CHANNEL).confirm('desk-bot', code, chat)
    expect(await f.runtime.listDecisions('human'), 'a request for a paired target is withdrawn').toEqual([])
    expect((await f.approvals.mint(f.request, 'op-2')).receipt).toMatchObject({
      state: 'refused',
      code: 'APPROVAL_WITHDRAWN',
    })
    await expect(f.approvals.mint(f.request, 'op-3')).rejects.toMatchObject({
      data: { code: 'TARGET_PAIRED' },
    })
  })
})
