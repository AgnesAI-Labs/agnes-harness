// The channel bridge and pairing router on an instance a bundled app claimed whole.
import { afterEach, expect, it, vi } from 'vitest'
import { startChannelBridge } from '../src/bridge.js'
import type { ChannelSubscriptionLink, ChannelSubscriptionsPort } from '../src/builtin-subscriptions.js'
import { createTargetRouter } from '../src/targets.js'
import type { FakeChannel } from '../testkit/index.js'
import { bridgeFixture } from './bridge-fixture.js'
import { memoryTargets } from './memory-targets.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const dm = (text: string, over: Record<string, unknown> = {}) =>
  ({
    kind: 'message',
    eventId: `event-${Math.random()}`,
    messageId: 'message-1',
    accountId: 'account',
    text,
    attachments: [],
    at: '2026-11-11T00:00:00Z',
    chat: { id: 'owner-chat', type: 'dm' },
    sender: { userId: 'owner', displayName: 'Owner', raw: {} },
    mentions: { bot: false, replyToBot: false, quoteBot: false },
    ...over,
  }) as import('../src/adapter.js').ChannelEvent

const CLAIMED_REPLY = '这个机器人由随包应用（如 Superagent）整个使用，不能在这里配对。请换一个机器人配对。'
const texts = (adapter: FakeChannel) =>
  adapter.sent
    .flatMap((row) => row.msg.blocks)
    .flatMap((block) => (block.kind === 'text' ? [block.markdown] : []))

/** A pairing router of instance `first` over `targets`, whose platform claim answers `claim`. */
function router(
  targets: ReturnType<typeof memoryTargets>,
  options: { claimed: () => boolean; claim?: () => Promise<boolean>; receive?: () => 'dropped' },
) {
  const sends: string[] = []
  const value = createTargetRouter({
    targets: { ...targets.port, ...(options.receive ? { receive: options.receive } : {}) },
    instanceId: 'first',
    credentials: 'c',
    cfg: { allowFrom: [], requireMention: false } as never,
    adapter: () => ({ toSession: () => ({ sessionKey: 'route' }) }) as never,
    runner: () =>
      ({
        claim: options.claim ?? (async () => true),
        sendDirect: async (_chat: unknown, block: { markdown: string }) => void sends.push(block.markdown),
      }) as never,
    bindings: { serial: (work: () => Promise<void>) => work(), bound: () => false } as never,
    signal: new AbortController().signal,
    claimed: options.claimed,
  })
  return { router: value, sends }
}

it('gives a whole claimed instance to its claimant before group claims and before pairing or sessions', async () => {
  const f = await bridgeFixture(cleanups)
  const targets = memoryTargets()
  const claimant: string[] = []
  const state = { whole: true }
  let link: ChannelSubscriptionLink | undefined
  // The order inside the Host hub is instance, then group; the bridge asks the hub before the router.
  const subscriptions: ChannelSubscriptionsPort = {
    attach: (_instanceId, attached) => {
      link = attached
      return () => {}
    },
    claimedInstance: (instanceId) => instanceId === 'first' && state.whole,
    claimed: (instanceId) => instanceId === 'first' && state.whole,
    deliver: (_instanceId, event) => void claimant.push(event.eventId),
  }
  const runtime = await startChannelBridge(f.provider, f.init, {
    ...f.options,
    targets: targets.port,
    subscriptions,
  })
  const adapter = f.adapters[0]!
  // Even a code-shaped direct message goes to the claimant first (the Host refuses a claim while a code is live).
  adapter.emit(dm('ABCD-EFGH', { eventId: 'code' }))
  adapter.emit(dm('hello', { eventId: 'bot-dm', sender: { userId: 'ci', kind: 'bot', raw: {} } }))
  adapter.emit(dm('@bot group', { eventId: 'group', chat: { id: 'group-chat', type: 'group' } }))
  expect(claimant).toEqual(['code', 'bot-dm', 'group'])
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(targets.pairings, 'no pairing on a claimed instance').toHaveLength(0)
  expect(targets.state.code).toBe('ABCD-EFGH')
  expect(texts(adapter)).toEqual([])
  const session = { id: 'web-session', workspace: f.root }
  const view = (await runtime.session!(session)) as { instances: { targets: unknown[] }[] }
  expect(view.instances[0]!.targets, 'a claimed instance offers no chat to bind').toEqual([])
  // Released, the instance routes as before: the code pairs its direct chat.
  // The Host's pairing side sees the claim too, so it mints no code for this bot.
  expect(targets.links.get('first')?.claimed?.()).toBe(true)
  state.whole = false
  expect(targets.links.get('first')?.claimed?.()).toBe(false)
  expect(link!.occupied(), 'a live pairing code keeps the instance from being claimed whole').toBe(true)
  targets.state.code = undefined
  expect(link!.occupied()).toBe(false)
  targets.state.code = 'ABCD-EFGH'
  adapter.emit(dm('ABCD-EFGH', { eventId: 'after-release' }))
  await vi.waitFor(() => expect(targets.pairings).toHaveLength(1))
  expect(link!.occupied(), 'an owner pairing keeps the instance from being claimed whole').toBe(true)
  expect(claimant).toEqual(['code', 'bot-dm', 'group'])
})

it('creates no pairing and no receipt on an instance claimed whole, even when an event reaches it', async () => {
  const targets = memoryTargets()
  const receive = vi.fn(() => 'dropped' as const)
  targets.pairings.push({
    id: 'p1',
    accountId: 'account',
    chatId: 'owner-chat',
    userId: 'owner',
    instance: 'first',
  })
  const confirm = vi.spyOn(targets.port, 'confirm')
  const { router: claimed } = router(targets, { claimed: () => true, receive })
  expect(claimed.intercept(dm('ABCD-EFGH', { chat: { id: 'other-chat', type: 'dm' } }))).toBe(true)
  expect(claimed.intercept(dm('hello'))).toBe(true)
  await claimed.drain()
  expect(confirm).not.toHaveBeenCalled()
  expect(receive).not.toHaveBeenCalled()
  expect(targets.delivered).toEqual([])
})

it('refuses a pairing when the instance is claimed while the platform claim of the code is awaited', async () => {
  const targets = memoryTargets()
  const confirm = vi.spyOn(targets.port, 'confirm')
  const state = { whole: false }
  let settle: ((value: boolean) => void) | undefined
  const { router: racing, sends } = router(targets, {
    claimed: () => state.whole,
    claim: () => new Promise<boolean>((resolve) => (settle = resolve)),
  })
  expect(racing.intercept(dm('ABCD-EFGH'))).toBe(true)
  await vi.waitFor(() => expect(settle).toBeDefined())
  // A bundled app claims the instance in the gap; the platform claim then answers.
  state.whole = true
  settle?.(true)
  await racing.drain()
  expect(confirm).not.toHaveBeenCalled()
  expect(targets.pairings).toHaveLength(0)
  expect(sends).toEqual([CLAIMED_REPLY])
})

it('writes no receipt for a click when the instance is claimed while its platform claim is awaited', async () => {
  const targets = memoryTargets()
  targets.pairings.push({
    id: 'p1',
    accountId: 'account',
    chatId: 'owner-chat',
    userId: 'owner',
    instance: 'first',
  })
  const receive = vi.fn(() => 'dropped' as const)
  const state = { whole: false }
  let settle: ((value: boolean) => void) | undefined
  const { router: racing } = router(targets, {
    claimed: () => state.whole,
    claim: () => new Promise<boolean>((resolve) => (settle = resolve)),
    receive,
  })
  const click = { ...dm(''), kind: 'cardAction', cardBizId: 'card-1', value: 'pick:1' } as never
  expect(racing.intercept(click)).toBe(true)
  await vi.waitFor(() => expect(settle).toBeDefined())
  state.whole = true
  settle?.(true)
  await racing.drain()
  expect(receive).not.toHaveBeenCalled()
  expect(targets.delivered).toEqual([])
})
