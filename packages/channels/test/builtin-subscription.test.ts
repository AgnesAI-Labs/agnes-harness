import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEvent, MessageEvent } from '../src/adapter.js'
import { startChannelBridge } from '../src/bridge.js'
import type { ChannelSubscriptionLink, ChannelSubscriptionsPort } from '../src/builtin-subscriptions.js'
import { FAKE_MANIFEST } from '../testkit/index.js'
import { bridgeFixture, groupMessage } from './bridge-fixture.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The Host side of one channel row: claimed chats per instance, delivered events and attached links. */
function subscriptions() {
  const claims = new Set<string>()
  const delivered: [string, ChannelEvent][] = []
  const links = new Map<string, ChannelSubscriptionLink>()
  const port: ChannelSubscriptionsPort = {
    attach(instanceId, link) {
      links.set(instanceId, link)
      return () => {
        if (links.get(instanceId) === link) links.delete(instanceId)
      }
    },
    claimed: (instanceId, chatId) => instanceId === 'first' && claims.has(chatId),
    deliver: (instanceId, event) => void delivered.push([instanceId, event]),
  }
  return { claims, delivered, links, port }
}

type View = { instances: { version: number; targets: { id: string; label: string }[] }[] }
const texts = (events: [string, ChannelEvent][]) =>
  events.map(([instance, event]) => [instance, (event as MessageEvent).text])
const followUps = (client: { calls: { method: string; args: unknown[] }[] }) =>
  client.calls.filter((call) => call.method === 'followUp').map((call) => JSON.stringify(call.args[0]))

it('gives a subscribed group only to its subscriber and leaves other groups and direct chats as they were', async () => {
  const f = await bridgeFixture(cleanups)
  const sub = subscriptions()
  sub.claims.add('group-a')
  sub.claims.add('dm-1')
  const runtime = await startChannelBridge(f.provider, f.init, { ...f.options, subscriptions: sub.port })
  const adapter = f.adapters[0]!
  const client = f.clients[0]!
  const none = { bot: false, replyToBot: false, quoteBot: false }

  adapter.emit(groupMessage('@bot for the app'))
  adapter.emit(groupMessage('unmentioned chatter', { mentions: none }))
  adapter.emit(groupMessage('ci passed', { sender: { userId: 'ci', kind: 'bot', raw: {} } }))
  adapter.emit(groupMessage('@bot group b', { chat: { id: 'group-b', type: 'group' } }))
  adapter.emit(groupMessage('@bot direct', { chat: { id: 'dm-1', type: 'dm' } }))
  // Every event of the claimed group reaches the subscriber, mentioned or not, from a bot or not.
  expect(texts(sub.delivered)).toEqual([
    ['first', '@bot for the app'],
    ['first', 'unmentioned chatter'],
    ['first', 'ci passed'],
  ])

  const session = { id: 'web-session', workspace: f.root }
  const view = (await runtime.session!(session)) as View
  // The claimed group never became a binding target; group B and the direct chat did, as before.
  expect(view.instances[0]!.targets.map((target) => target.label).sort()).toEqual(['group-b', 'user'])
  client.setTimeline(session.id, {
    sessionId: session.id,
    upto: 1,
    generation: 1,
    opState: null,
    turns: [],
    nodes: [],
  })
  const groupB = view.instances[0]!.targets.find((target) => target.label === 'group-b')!
  await runtime.binding!(
    'bind',
    { instanceId: 'first', targetId: groupB.id, expectedVersion: view.instances[0]!.version },
    session,
  )
  adapter.emit(groupMessage('@bot claimed after binding'))
  adapter.emit(groupMessage('@bot bound group', { chat: { id: 'group-b', type: 'group' } }))
  await vi.waitFor(() => expect(followUps(client)).toHaveLength(1))
  expect(followUps(client)[0]).toContain('bound group')
  expect(texts(sub.delivered).at(-1)).toEqual(['first', '@bot claimed after binding'])
  // The Host sees the bound group, so a subscriber cannot claim it until the owner unbinds.
  const link = sub.links.get('first')!
  expect(link.bound('group-b')).toBe(true)
  expect(link.bound('group-a')).toBe(false)

  // A lapsed claim (unsubscribed, or the subscriber's generation ended) returns the group to the
  // ordinary path: it is observed as a binding target again and no longer delivered.
  sub.claims.delete('group-a')
  const before = sub.delivered.length
  adapter.emit(groupMessage('@bot after the claim lapsed'))
  expect(sub.delivered).toHaveLength(before)
  const after = (await runtime.session!(session)) as View
  expect(after.instances[0]!.targets.map((target) => target.label)).toContain('group-a')
  expect(followUps(client).join('\n')).not.toContain('for the app')

  // Claimed again, the group that is now a target cannot be bound to a session either.
  sub.claims.add('group-a')
  const other = { id: 'other-session', workspace: f.root }
  const claimed = (
    (await runtime.session!(other)) as View & {
      instances: { targets: { label: string; unavailable: boolean }[] }[]
    }
  ).instances[0]!
  const groupA = claimed.targets.find((target) => target.label === 'group-a')!
  expect(groupA).toMatchObject({ unavailable: true })
  await expect(
    runtime.binding!(
      'bind',
      { instanceId: 'first', targetId: groupA.id, expectedVersion: claimed.version },
      other,
    ),
  ).rejects.toThrow('subscribed by a bundled app')
  expect(link.bound('group-a')).toBe(false)
})

it('attaches the running adapter for sends and declared reads, and detaches it on stop', async () => {
  const f = await bridgeFixture(cleanups)
  const history = vi.fn(async () => ({ events: [groupMessage('earlier')] }))
  const create = f.provider.create.bind(f.provider)
  // Reads are declared at run time only; the manifest check must still admit the adapter.
  f.provider.create = async (input) => {
    const adapter = await create(input)
    const capabilities = adapter.capabilities()
    return Object.assign(adapter, {
      listHistory: history,
      capabilities: () => ({ ...capabilities, read: { history: true } }),
    })
  }
  const sub = subscriptions()
  await startChannelBridge(f.provider, f.init, { ...f.options, subscriptions: sub.port })
  const link = sub.links.get('first')!
  expect(link.connected()).toBe(true)
  expect(link.capabilities()).toMatchObject({ card: true, read: { history: true } })
  // A reply longer than the channel's text limit is split by the session replies' chunker and
  // throttled per chat: the second part waits for the chat's next send token.
  const long = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`
  const started = Date.now()
  const ref = await link.send(
    { chatId: 'group-a', deliveryKey: 'reply-1' },
    { blocks: [{ kind: 'text', markdown: long }] },
  )
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  const sent = f.adapters[0]!.sent
  // As in a session reply, each message is packed up to the limit at chunker boundaries.
  const parts = sent.map((row) => row.msg.blocks.map((block) => (block as { markdown: string }).markdown))
  expect(parts.map((blocks) => blocks.join('').length)).toEqual([FAKE_MANIFEST.limits.textChars, 1002])
  expect(parts).toEqual([[`${'a'.repeat(1500)}\n\n`, 'b'.repeat(498)], ['b'.repeat(1002)]])
  expect(parts.flat().join('')).toBe(long)
  expect(sent.map((row) => row.target.deliveryKey)).toEqual(['reply-1', 'reply-1:1'])
  expect(ref).toEqual(sent[0]!.ref)
  // Only the read methods the adapter implements are on the link.
  expect(link.reads().fetchMessages).toBeUndefined()
  const page = await link.reads().listHistory!('group-a', {
    start: '2026-11-14T00:00:00Z',
    end: '2026-11-14T00:01:00Z',
  })
  expect(page.events.map((event) => event.text)).toEqual(['earlier'])
  expect(history).toHaveBeenCalledWith('group-a', {
    start: '2026-11-14T00:00:00Z',
    end: '2026-11-14T00:01:00Z',
  })
  await f.stop()
  expect(sub.links.size).toBe(0)
})
