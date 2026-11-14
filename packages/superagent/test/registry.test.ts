// Adapted from dsh-superagent (MIT)
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type SourceContextDeps, sourceContextOf } from '../src/app/source-context.js'
import type { OutboundMessage } from '../src/core/index.js'
import type { Commands } from '../src/infra/commands.js'
import { HealthBoard } from '../src/infra/health.js'
import { SettingsSchema } from '../src/policy.js'
import { feishuKind } from '../src/sources/feishu.js'
import { feishuChannel, feishuTrigger, feishuTriggerId } from '../src/sources/feishu-trigger.js'
import { githubKind } from '../src/sources/github.js'
import type { ImageSink, SourceKind } from '../src/sources/kind.js'
import { SourceRegistry } from '../src/sources/registry.js'
import { testDeployment } from './fixtures/deployment.js'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe',
  title: { zh: '探针', en: 'Probe' },
  description: { zh: '', en: '' },
  health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
}

describe('Source registry', () => {
  it('lists every installed kind with defaults, in id order, followed by stored instances whose kind is not installed', () => {
    const settings = SettingsSchema.parse({
      sources: {
        probe: { enabled: false, config: { interval: 9 } },
        retired: { enabled: true, config: { x: 1 } },
      },
    })
    const sources = new SourceRegistry(() => settings)
    sources.register(probe)
    sources.register(githubKind)
    expect(sources.instances()).toEqual([
      {
        id: 'github',
        kind: 'github',
        enabled: true,
        config: {
          repository: '',
          cli: '',
          pollSeconds: 60,
          failuresBeforeError: 3,
          observeIssues: false,
          observePulls: false,
          observeComments: false,
          observeCi: false,
        },
        installed: true,
      },
      { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9 }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
    ])
  })
  it('validates submitted instances with the kind schema and refuses kinds that are not installed', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(probe)
    expect(sources.validate('probe', { enabled: true, config: {} })).toEqual({
      enabled: true,
      config: { interval: 5 },
    })
    expect(() => sources.validate('probe', { enabled: true, config: { interval: 0 } })).toThrow()
    expect(() => sources.validate('missing', { enabled: true, config: {} })).toThrow('not installed')
  })
  it("sends, links and reads a kind's Threads through its own channel and context, and nothing for a kind without them", async () => {
    const sources = new SourceRegistry(() =>
      SettingsSchema.parse({ sources: { probe: { enabled: true, config: { interval: 7 } } } }),
    )
    const sent: OutboundMessage[] = []
    const read: unknown[] = []
    sources.register({
      ...probe,
      channel: {
        send: async (_host, message) => {
          sent.push(message)
          return 'sent'
        },
        link: (address) => ({ url: `https://probe/${address.room}`, label: { zh: '探针', en: 'Probe' } }),
      },
      threadContext: {
        messageId: (trigger) => String(trigger.meta.id),
        read: async (_commands, trigger, part, cursor, config) => {
          read.push([trigger.id, part, cursor, config.interval])
          return { messages: [{ id: 'm1', from: 'u', at: '1', text: '' }], body: { page: cursor ?? 'first' } }
        },
      },
    })
    const commands = {} as Commands
    const message = (source: string): OutboundMessage => ({
      id: 'r1',
      channel: { source, thread: 'probe:1', address: { room: 'r' } },
      text: 'hi',
      kind: 'reply',
    })
    expect(await sources.send(message('probe'), commands)).toBe('sent')
    expect(sent).toEqual([message('probe')])
    // A kind that is not installed keeps its replies waiting; links to it have no page.
    expect(await sources.send(message('retired'), commands)).toBe('waiting')
    expect(sources.link(message('probe').channel, {})).toEqual({
      url: 'https://probe/r',
      label: { zh: '探针', en: 'Probe' },
    })
    expect(sources.link(message('retired').channel, {})).toEqual({
      url: '',
      label: { zh: 'retired', en: 'retired' },
    })
    const trigger = {
      id: 't1',
      source: 'probe',
      threads: [{ source: 'probe', id: '1' }],
      actor: { source: 'probe', id: 'u' },
      human: true,
      at: '',
      text: 'hi',
      meta: { id: 'm1' },
    }
    const context = sources.threadContext(trigger)!
    expect(context.messageId).toBe('m1')
    expect(await context.read(commands, 'thread', '2')).toMatchObject({ body: { page: '2' } })
    expect(read).toEqual([['t1', 'thread', '2', 7]])
    expect(context.images('img_x')).toEqual([])
    await expect(
      context.image(
        {} as ImageSink,
        commands,
        { id: 'm1', text: '' },
        'img_x',
        '',
        new AbortController().signal,
      ),
    ).rejects.toThrow('no images')
    // A kind without a channel or a context has neither.
    sources.register({ ...probe, kind: 'quiet' })
    expect(await sources.send(message('quiet'), commands)).toBe('gone')
    expect(sources.threadContext({ ...trigger, source: 'quiet' })).toBeUndefined()
  })
  it('refuses a kind that declares a health entry another kind or dsh-superagent itself reports, and gives up its entries at unregister', () => {
    const board = new HealthBoard()
    // Pre-claim built-in health entries; sync:* entries are reserved for settings sync.
    for (const name of ['runtime', 'reply']) board.claim(name)
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const unregister = sources.register(githubKind)
    expect(() => sources.register({ ...probe, health: ['github'] })).toThrow(
      'declares the health entry github',
    )
    for (const name of ['runtime', 'reply', 'sync:github'])
      expect(() => sources.register({ ...probe, health: ['probe', name] })).toThrow(name)
    expect(sources.kind('probe')).toBeUndefined()
    sources.register({ ...probe, health: ['probe'] })
    const context = (kind: { kind: string; health: readonly string[] }) =>
      sourceContextOf({ sources } as unknown as SourceContextDeps, kind)
    const first = context(githubKind)
    first.report('github', { state: 'ready', detail: 'ok' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => first.report('probe', { state: 'ready', detail: '' })).toThrow('has no health entry probe')
    // A report sent after its kind unregisters (such as from an exiting CLI listener) is ignored and does not affect a later registration.
    unregister()
    expect(() => first.report('github', { state: 'error', detail: 'WARN exiting' })).not.toThrow()
    expect(board.all.github).toBeUndefined()
    sources.register(githubKind)
    first.report('github', { state: 'error', detail: 'late' })
    expect(board.all.github).toEqual({ state: 'starting', detail: '' })
    context(githubKind).report('github', { state: 'ready', detail: 'again' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'again' })
  })
  it("names the Trigger whose message a Trigger's message answers, where its kind can", () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind)
    sources.register(githubKind)
    const reply = feishuTrigger(
      {
        message_id: 'om_2',
        chat_id: 'oc_1',
        chat_type: 'group',
        sender_id: 'ou_alice',
        sender_type: 'user',
        content: 'yes',
        create_time: '1757376000000',
        parent_id: 'om_1',
      },
      'ou_bot',
      'cli_bot',
    )!
    expect(sources.repliesTo(reply)).toBe(feishuTriggerId('om_1'))
    expect(sources.repliesTo({ ...reply, meta: { ...reply.meta, parentId: undefined } })).toBeUndefined()
    expect(sources.repliesTo({ ...reply, source: 'github' })).toBeUndefined()
  })
  it("finds what a search query names in each kind's terms", () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind)
    sources.register(githubKind)
    expect(sources.find('#12')).toEqual({ threads: ['github:12'], terms: [] })
    expect(sources.find('https://github.com/acme/widgets/pull/7#issuecomment-3')).toEqual({
      threads: ['github:7'],
      terms: [],
    })
    expect(sources.find('see om_abc and om_abc, om_def')).toEqual({
      threads: [],
      terms: ['om_abc', 'om_def'],
    })
    expect(sources.find('login fails')).toEqual({ threads: [], terms: [] })
    expect(feishuKind.policy!.unnamed).toEqual({
      person: { zh: '飞书用户', en: 'Feishu user' },
      bot: { zh: '飞书机器人', en: 'Feishu bot' },
    })
  })
  it('refuses a second registration of one kind and forgets a kind after its disposer runs', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const dispose = sources.register(probe)
    expect(() => sources.register(probe)).toThrow('already registered')
    dispose()
    expect(sources.instance('probe')).toBeUndefined()
  })
  it("validates each Source's part of the Policy with its kind, keeping parts of kinds that are not installed as stored", () => {
    const sources = new SourceRegistry(() =>
      SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } }),
    )
    sources.register(feishuKind)
    sources.register(githubKind)
    expect(
      sources.validatePolicy({
        feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] },
        retired: { allowed: [], x: 1 },
      }),
    ).toEqual({
      feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: '', admission: {} },
      retired: { allowed: [], x: 1 },
    })
    expect(() => sources.validatePolicy({ feishu: { allowed: [{ id: 'alice' }] } })).toThrow()
    expect(sources.policyPart('feishu')).toEqual({
      allowed: [{ id: 'ou_alice' }],
      syncChat: '',
      admission: {},
    })
    expect(sources.policyPart('github')).toEqual({ allowed: [], admission: {} })
    sources.register(probe)
    expect(sources.policyPart('probe')).toBeUndefined()
  })
  it('allows a reply only on a Channel whose Source still listens to its chat', () => {
    const settings = SettingsSchema.parse({
      sources: {
        feishu: {
          enabled: true,
          config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }], directMessages: false },
        },
      },
    })
    const sources = new SourceRegistry(() => settings)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(false)
    sources.register(feishuKind)
    sources.register(githubKind)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_other' } })).toBe(false)
    // A direct chat's id starts with oc_ too; the address says it is direct, and with direct messages off it gets no reply.
    expect(sources.channelAllowed(feishuChannel('oc_dm', 'om_1', true))).toBe(false)
    expect(sources.channelAllowed({ source: 'github', address: { number: '7' } })).toBe(true)
  })
  it.todo('delivers a reply to a direct message under the default settings')
})
