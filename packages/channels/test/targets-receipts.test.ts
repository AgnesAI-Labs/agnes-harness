import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ChannelInstance,
  ChannelProvider,
  ChannelTargetEvent,
  ProfileManagedInit,
} from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEvent } from '../src/adapter.js'
import { startChannelBridge } from '../src/bridge.js'
import type { ChannelTargetsPort } from '../src/targets.js'
import { createFakeClient, FAKE_MANIFEST, FakeChannel } from '../testkit/index.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A memory stand-in for the Host receipt store behind the pairing port. */
function receiptTargets() {
  const pairings: { id: string; accountId: string; chatId: string; userId: string; instance: string }[] = []
  const receipts = new Map<string, { receiptId: string; state: 'pending' | 'acked' | 'parked' }>()
  const received: string[] = []
  const attempts: string[] = []
  const interactions: string[] = []
  const delivered: ChannelTargetEvent[] = []
  const state = { code: 'ABCD-EFGH' as string | undefined, fail: 0 }
  const port: ChannelTargetsPort = {
    retain: () => {},
    attach: () => () => {},
    expectsCode: (_instanceId, text) => !!state.code && /^[A-Z2-9]{8}$/i.test(text.replace(/[\s-]/g, '')),
    confirm: (instance, text, chat) => {
      if (text.replace(/[\s-]/g, '').toUpperCase() !== state.code?.replace('-', '')) return undefined
      state.code = undefined
      pairings.push({ ...chat, instance })
      return { label: 'Desk' }
    },
    find: (instance, chatId) => pairings.find((p) => p.instance === instance && p.chatId === chatId),
    interact: async (_pairing, event) => {
      interactions.push(event.eventId)
      return event.value.startsWith('appr:')
    },
    receive: (_pairing, event) => {
      received.push(event.eventId)
      if (event.kind === 'action' && event.actionId.startsWith('old:')) return 'unrecorded'
      const existing = receipts.get(event.eventId)
      if (existing) return { ...existing }
      const receipt = { receiptId: `r-${event.eventId}`, state: 'pending' as const }
      receipts.set(event.eventId, receipt)
      return { ...receipt }
    },
    deliver: async (_pairing, event) => {
      attempts.push(event.eventId)
      if (state.fail-- > 0) throw new Error('service stopped')
      delivered.push(event)
      const receipt = event.receiptId === undefined ? undefined : receipts.get(event.eventId)
      if (receipt) receipt.state = 'acked'
    },
    drop: () => {},
    paired: (instance, id) => pairings.some((p) => p.instance === instance && p.id === id),
    pairings: () => [],
  }
  return { port, pairings, receipts, received, attempts, interactions, delivered, state }
}

async function paired() {
  const root = await mkdtemp(join(tmpdir(), 'agh-channel-receipts-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stored = new Map<string, import('@agnes/protocol').JsonValue>()
  let shutdown: Parameters<ProfileManagedInit['onShutdown']>[0] | undefined
  const instance: ChannelInstance = {
    id: 'first',
    workspace: root,
    agent: '@example/agent#main',
    credentialRefs: {},
    allowFrom: [],
    requireMention: true,
  }
  const init = {
    store: {
      scan: ({ prefix, limit }: { prefix: string; limit: number }) => ({
        rows: [...stored]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit)
          .map(([key, value]) => ({ key, value })),
      }),
      delete: (key: string) => stored.delete(key),
      transaction: <T>(work: () => T) => work(),
      get: (key: string) => stored.get(key),
      set: (key: string, value: import('@agnes/protocol').JsonValue) =>
        stored.set(key, structuredClone(value)),
    },
    signal: new AbortController().signal,
    config: { instances: [{ ...instance, allowFrom: ['owner'] }] },
    assertCurrent: vi.fn(),
    ready: vi.fn(),
    onShutdown: (fn: typeof shutdown) => {
      shutdown = fn
    },
  } as unknown as ProfileManagedInit
  const adapters: FakeChannel[] = []
  const clients: ReturnType<typeof createFakeClient>[] = []
  const provider: ChannelProvider = {
    id: 'fake',
    version: '1.0.0',
    manifest: FAKE_MANIFEST,
    create() {
      const adapter = new FakeChannel()
      adapters.push(adapter)
      return adapter
    },
  }
  const targets = receiptTargets()
  const runtime = await startChannelBridge(provider, init, {
    owner: 'plugin/example',
    stateDirectory: join(root, 'state'),
    resolveSecret: vi.fn(() => 'synthetic-secret'),
    createClient: vi.fn(() => {
      const client = createFakeClient()
      clients.push(client)
      return client
    }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    targets: targets.port,
    targetBackoff: { baseMs: 1, maxMs: 1 },
  })
  cleanups.push(async () => shutdown?.('disable'))
  const adapter = adapters[0]!
  const client = clients[0]!
  adapter.emit(dm('ABCD-EFGH', { eventId: 'pairing-code' }))
  await vi.waitFor(() => expect(targets.pairings).toHaveLength(1))
  const claimed = (eventId: string) =>
    client.calls.some(
      (call) =>
        call.method === 'claim.once' &&
        call.args[0] === 'channel-event' &&
        call.args[1] === `fake:account:${eventId}`,
    )
  return { adapter, client, targets, claimed, runtime, root }
}

const dm = (text: string, over: Record<string, unknown> = {}) =>
  ({
    kind: 'message',
    eventId: `event-${Math.random()}`,
    messageId: 'message-1',
    accountId: 'account',
    text,
    attachments: [],
    at: '2026-11-14T00:00:00Z',
    chat: { id: 'owner-chat', type: 'dm' },
    sender: { userId: 'owner', displayName: 'Owner', raw: {} },
    mentions: { bot: false, replyToBot: false, quoteBot: false },
    ...over,
  }) as ChannelEvent

const click = (value: string, eventId: string) =>
  ({
    kind: 'cardAction',
    eventId,
    accountId: 'account',
    at: '2026-11-14T00:00:01Z',
    chat: { id: 'owner-chat', type: 'dm' },
    sender: { userId: 'owner', raw: {} },
    cardBizId: 'm-card',
    value,
  }) as ChannelEvent

const texts = (adapter: FakeChannel) =>
  adapter.sent
    .flatMap((row) => row.msg.blocks)
    .flatMap((block) => (block.kind === 'text' ? [block.markdown] : []))

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

it('a paired message writes a receipt instead of claim.once and is delivered with receiptId', async () => {
  const { targets, adapter, claimed } = await paired()
  adapter.emit(dm('hello desk', { eventId: 'm1' }))
  await vi.waitFor(() => expect(targets.delivered.map((event) => event.eventId)).toContain('m1'))
  expect(targets.received).toEqual(['m1'])
  expect(claimed('m1'), 'the receipt is the claim').toBe(false)
  expect(targets.delivered[0]).toMatchObject({ kind: 'message', text: 'hello desk', receiptId: 'r-m1' })
  expect(targets.receipts.get('m1')?.state).toBe('acked')
})

it('platform redelivery of an acked event does not reach the service again', async () => {
  const { targets, adapter, claimed } = await paired()
  adapter.emit(dm('hello desk', { eventId: 'm1' }))
  await vi.waitFor(() => expect(targets.receipts.get('m1')?.state).toBe('acked'))
  adapter.emit(dm('hello desk', { eventId: 'm1' }))
  await vi.waitFor(() => expect(targets.received).toEqual(['m1', 'm1']))
  await settle()
  expect(targets.attempts).toEqual(['m1'])
  expect(claimed('m1')).toBe(false)
})

it('approval clicks in a paired chat keep claim.once and the session approval path', async () => {
  const { targets, adapter, claimed } = await paired()
  adapter.emit(click('appr:#1:allow_once', 'approval'))
  adapter.emit(click('pick:1', 'pick'))
  await vi.waitFor(() => expect(targets.delivered.map((event) => event.eventId)).toEqual(['pick']))
  expect(targets.interactions.sort()).toEqual(['approval', 'pick'])
  expect(claimed('approval')).toBe(true)
  expect(claimed('pick'), 'a click is claimed before the approval path sees it').toBe(true)
  expect(targets.received, 'only a click the session approval path left gets a receipt').toEqual(['pick'])
  expect(targets.delivered[0]).toMatchObject({ kind: 'action', actionId: 'pick:1', receiptId: 'r-pick' })
})

it('session-bound chats still use claim.once', async () => {
  const { targets, adapter, client, claimed, runtime, root } = await paired()
  adapter.emit(dm('first contact', { eventId: 'contact', chat: { id: 'other-chat', type: 'dm' } }))
  const session = { id: 'web-session', workspace: root }
  await vi.waitFor(async () => {
    const view = (await runtime.session!(session)) as { instances: { targets: unknown[] }[] }
    expect(view.instances[0]!.targets.length).toBeGreaterThan(0)
  })
  const view = (await runtime.session!(session)) as {
    instances: { id: string; version: number; targets: { id: string; unavailable?: boolean }[] }[]
  }
  const row = view.instances[0]!
  const target = row.targets.find((candidate) => !candidate.unavailable)!
  client.setTimeline(session.id, {
    sessionId: session.id,
    upto: 1,
    generation: 1,
    opState: null,
    turns: [],
    nodes: [],
  })
  await runtime.binding!(
    'bind',
    { instanceId: row.id, targetId: target.id, expectedVersion: row.version },
    session,
  )
  adapter.emit(dm('to the session', { eventId: 's1', chat: { id: 'other-chat', type: 'dm' } }))
  await vi.waitFor(() => expect(client.calls.some((call) => call.method === 'followUp')).toBe(true))
  expect(claimed('s1')).toBe(true)
  expect(targets.received).toEqual([])
  expect(targets.attempts).toEqual([])
})

it('service not running: the notice says it will be handed over, and the receipt stays pending', async () => {
  const { targets, adapter } = await paired()
  targets.state.fail = 1
  adapter.emit(dm('while stopped', { eventId: 'm2' }))
  await vi.waitFor(() => expect(texts(adapter).some((text) => text.includes('自动转交'))).toBe(true))
  await settle()
  expect(
    texts(adapter).some((text) => text.includes('稍后再发')),
    'never ask for a resend',
  ).toBe(false)
  expect(targets.receipts.get('m2')?.state).toBe('pending')
  expect(targets.attempts, 'the Host redelivers; the bridge does not retry in process').toEqual(['m2'])
})

it('a click on a card whose buttons were never recorded tells the owner instead of dropping it silently', async () => {
  const { targets, adapter, claimed } = await paired()
  adapter.emit(click('old:1', 'stale'))
  await vi.waitFor(() =>
    expect(texts(adapter).some((text) => text.includes('最新的卡片') && text.includes('网页'))).toBe(true),
  )
  expect(claimed('stale')).toBe(true)
  expect(targets.received).toEqual(['stale'])
  expect(targets.attempts, 'never delivered').toEqual([])
  expect(targets.receipts.size).toBe(0)
})
