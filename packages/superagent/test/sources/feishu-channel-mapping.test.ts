// Adapted from dsh-superagent (MIT)
/** CLI intake and replies at the existing Trigger/Engine/Outbox contracts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage } from '../../src/core/index.js'
import { FeishuNotDispatched, FeishuRefusal } from '../../src/infra/commands.js'
import { KV } from '../../src/kv.js'
import { feishuKind, feishuTime, messageTrigger, takeIn } from '../../src/sources/feishu.js'
import { liveMessage } from '../../src/sources/feishu-client.js'
import { consumerRetry, pollThreads, rememberReply } from '../../src/sources/feishu-loops.js'
import { BOT, fakeCli, IDENTITY, liveEvent, message } from './fake-cli.js'
import { type FeishuHost, feishuHost } from './feishu-host.js'

const hosts: FeishuHost[] = []
const open = (...args: Parameters<typeof feishuHost>) => {
  const h = feishuHost(...args)
  hosts.push(h)
  return h
}
afterEach(() => {
  for (const h of hosts.splice(0)) h.close()
})
const reply = (id: string): OutboundMessage => ({
  id,
  kind: 'reply',
  text: '@not-a-file\nDone',
  channel: {
    source: 'feishu',
    thread: 'feishu:oc_team',
    address: { chatId: 'oc_team', messageId: 'om_1', botIdentity: IDENTITY },
  },
})

describe('bot CLI messages as existing Triggers', () => {
  it('maps mentions, names, self messages and immutable message identity', async () => {
    const h = open()
    const event = liveMessage(
      {
        ...liveEvent(message('om_1')),
        content: '@_user_1 fix it',
        mentions: [{ id: BOT.botId, key: '@_user_1', name: 'Bot' }],
      },
      h.fake.io,
    )
    await takeIn(h.ctx, h.link, event)
    expect(h.trigger('om_1')).toMatchObject({
      id: key('feishu', 'om_1'),
      addressed: 'mention',
      text: '@Bot fix it',
      meta: { botIdentity: IDENTITY },
      channel: { address: { botIdentity: IDENTITY } },
    })
    expect(h.engine.candidate(key('feishu', 'om_1'))?.strength).toBe('explicit')
    expect(await takeIn(h.ctx, h.link, event)).toBe('duplicate')
    for (const sender of [BOT.botId, BOT.appId])
      expect(await takeIn(h.ctx, h.link, message(`om_${sender}`, { sender, bot: true }))).toBe('own')
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(feishuTime('1757376000000')).toBe('2025-09-09T00:00:00.000Z')
    expect(() => feishuTime('broken')).toThrow()
  })
  it.each([
    ['direct listed', { direct: true }, {}, 'explicit'],
    ['direct outsider', { direct: true, sender: 'ou_guest' }, {}, undefined],
    ['direct disabled', { direct: true }, { directMessages: false }, undefined],
    ['other mentioned', { chat: 'oc_other', mentioned: true }, { otherChats: 'mentions' }, 'explicit'],
    ['other ignored', { chat: 'oc_other', mentioned: true }, {}, undefined],
    ['listed bot', { chat: 'oc_observed', sender: 'cli_ci', bot: true }, {}, 'inferred'],
    ['unlisted bot', { sender: 'cli_unknown', bot: true, mentioned: true }, {}, undefined],
  ])('keeps requester policy: %s', async (_name, fields, config, strength) => {
    const h = open({ feishu: config })
    await takeIn(h.ctx, h.link, message('om_1', fields))
    expect(h.engine.candidate(key('feishu', 'om_1'))?.strength).toBe(strength)
  })
  it('continues topic and quoted-message chains, but refuses to attach a different bot to old work', async () => {
    const h = open({ fake: fakeCli({ history: [message('om_root', { thread: 'omt_1' })] }) })
    await takeIn(h.ctx, h.link, message('om_root', { mentioned: true, thread: 'omt_1' }))
    rememberReply(h.ctx, 'om_sent', 'om_root')
    await takeIn(h.ctx, h.link, message('om_quote', { quoted: 'om_sent' }))
    await takeIn(h.ctx, h.link, message('om_more', { thread: 'omt_1' }))
    expect(h.trigger('om_quote')?.threads[0]?.id).toBe('oc_team:om_root')
    expect(h.trigger('om_more')?.threads[0]?.id).toBe('oc_team:om_root')
    h.deployment.feishu = { ...BOT, botId: 'ou_other' }
    expect(await takeIn(h.ctx, h.link, message('om_changed', { quoted: 'om_root' }))).toBe('ignored')
    expect(h.trigger('om_changed')).toBeUndefined()
    const retained = h.store.threads.get('feishu:oc_team:om_root')!
    h.store.threads.save({
      ...retained,
      key: 'feishu:oc_team:om_lost',
      ref: { ...retained.ref, id: 'oc_team:om_lost' },
    })
    expect(await takeIn(h.ctx, h.link, { ...message('om_orphan'), rootId: 'om_lost' })).toBe('ignored')
  })
  it('opens legacy channel settings without losing chat settings or inferring a CLI', () => {
    const config = feishuKind.schema.parse({
      instance: 'ext:old/main/bot',
      claim: 'groups',
      chats: [{ chatId: 'oc_team', listen: 'all' }],
      directMessages: false,
      otherChats: 'mentions',
    })
    expect(config).toMatchObject({
      cli: '',
      chats: [{ chatId: 'oc_team', listen: 'all' }],
      directMessages: false,
      otherChats: 'mentions',
    })
    expect(config).not.toHaveProperty('instance')
    expect(feishuKind.fields.map((f) => f.key)).toContain('cli')
    expect(feishuKind.fields.map((f) => f.key)).not.toContain('claim')
  })
})

describe('CLI replies', () => {
  const ready = () => open({ fake: fakeCli({ history: [message('om_1', { mentioned: true })] }) })
  it('keeps deliveryKey stable across safe failures and commits successful delivery once', async () => {
    const h = ready(),
      send = () => h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1'))
    h.fake.state.sendErrors.push(new FeishuNotDispatched('identity preflight failed'))
    await expect(send()).rejects.toThrow('preflight')
    expect(h.ctx.state.get(KV.feishu.delivery('r1'))).toBeUndefined()
    h.fake.state.sendErrors.push(new FeishuRefusal('rate limited', 99991400))
    await expect(send()).rejects.toThrow('rate limited')
    expect(await send()).toBe('sent')
    expect(await send()).toBe('sent')
    expect(h.fake.sent).toHaveLength(1)
    expect(h.fake.sent[0]!.input).toBe('@not-a-file\nDone')
    const args = h.fake.calls.filter((args) => args[1] === '+messages-reply')
    expect(args[0]).toEqual(args[1])
    expect(args[0]).toContain('--reply-in-thread')
    expect(h.ctx.state.get(KV.feishu.delivery('r1'))).toBe('sent')
  })
  it('distinguishes a recalled message from uncertain delivery and refuses silent replay', async () => {
    const h = ready(),
      send = (id: string) => h.kind.channel!.send({ commands: h.ctx.commands }, reply(id))
    h.fake.state.sendErrors.push(new FeishuRefusal('recalled', 230011))
    expect(await send('gone')).toBe('gone')
    h.fake.state.sendErrors.push(new Error('timeout: recalled'))
    await expect(send('uncertain')).rejects.toThrow('timeout')
    await expect(send('uncertain')).rejects.toThrow('uncertain')
    expect(h.ctx.state.get(KV.feishu.delivery('uncertain'))).toBe('uncertain')
    h.ctx.state.set(KV.feishu.delivery('crashed'), 'sending')
    await expect(send('crashed')).rejects.toThrow('uncertain')
    const old = reply('old')
    delete old.channel.address.botIdentity
    await expect(h.kind.channel!.send({ commands: h.ctx.commands }, old)).rejects.toThrow(
      'unverified Feishu bot',
    )
  })
})
it('syncs only a complete member list, preserving order and policy names', async () => {
  const h = open({
    fake: fakeCli({
      members: {
        oc_team: [
          { userId: 'ou_bob', displayName: 'Bob' },
          { userId: 'ou_alice', displayName: 'Alice new' },
        ],
      },
    }),
  })
  const part = h.sources.policyPart('feishu')!
  const sync = h.kind.policy!.sync!
  expect((await sync.run(h.host, part, new AbortController().signal)).allowed).toEqual([
    { id: 'ou_alice', name: 'Alice new' },
    { id: 'ou_bob', name: 'Bob' },
  ])
  h.fake.lark.mockResolvedValue({ users: [], has_more: true })
  await expect(sync.run(h.host, part, new AbortController().signal)).rejects.toThrow('incomplete')
  expect(h.sources.policyPart('feishu')!.allowed).toEqual(part.allowed)
})
it('polls beyond the first 50 topic messages and dedupes repeat recovery', async () => {
  const at = (n: number) => new Date(Date.parse('2026-11-14T08:00:00Z') + n * 1000).toISOString()
  const h = open({
    fake: fakeCli({
      history: Array.from({ length: 80 }, (_, n) =>
        message(`om_${n}`, { thread: 'omt_1', at: at(n), mentioned: n === 0 }),
      ),
    }),
  })
  // The root had no topic when received; the bot's later reply created it before the consumer disconnected.
  await takeIn(h.ctx, h.link, message('om_0', { at: at(0), mentioned: true }))
  const thread = h.store.threads.get('feishu:oc_team:om_0')!
  h.store.threads.save({
    ...thread,
    createdAt: at(0),
    lastAt: new Date().toISOString(),
    subscriptions: ['t1'],
    meta: { ...thread.meta },
  })
  await pollThreads(h.ctx, h.link)
  expect(h.trigger('om_1')).toBeDefined()
  expect(h.trigger('om_79')).toBeDefined()
  expect(h.store.threads.get(thread.key)?.meta.threadId).toBe('omt_1')
  h.receive.mockClear()
  await pollThreads(h.ctx, h.link)
  expect(h.receive).not.toHaveBeenCalled()
})
it('backs off reconnects, resetting after a stable minute', () => {
  expect([
    consumerRetry(undefined, 0),
    consumerRetry(1000, 0),
    consumerRetry(60000, 0),
    consumerRetry(60000, 60000),
  ]).toEqual([1000, 2000, 60000, 1000])
})

it.each(['unconfigured', 'disabled', 'legacy'])(
  'keeps %s startup inert without CLI reads or model requests',
  async (mode) => {
    vi.useFakeTimers()
    const h = open({
      configured: () => mode !== 'unconfigured',
      ...(mode === 'legacy' ? { feishu: { cli: '', instance: 'old-bot', claim: 'groups' } } : {}),
    })
    if (mode === 'disabled') {
      const saved = h.store.settings()
      h.store.saveSettings({
        ...saved,
        sources: { ...saved.sources, feishu: { enabled: false, config: { cli: BOT.cli } } },
      })
    }
    const stop = new AbortController()
    const running = h.run(stop.signal)
    try {
      await vi.advanceTimersByTimeAsync(5000)
      expect(h.fake.calls).toEqual([])
      expect(h.assessor.request).not.toHaveBeenCalled()
      expect(h.executor.start).not.toHaveBeenCalled()
    } finally {
      stop.abort()
      await running
      vi.useRealTimers()
    }
  },
)
