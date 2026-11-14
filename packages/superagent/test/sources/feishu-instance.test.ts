// Adapted from dsh-superagent (MIT)
/**
 * The Feishu Source on a channel instance of its own (`claim: 'instance'`, the default): it claims the whole instance,
 * so direct messages and unlisted chats reach it and the DSH admission table applies to them; with `claim: 'groups'`
 * it subscribes only the listed groups, as on a bot shared with other features.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsView } from '../../src/app/views/settings.js'
import { key } from '../../src/core/index.js'
import { listInstances, OWNER_BUSY } from '../../src/sources/feishu-instances.js'
import { INSTANCES_TIMEOUT_MS, RELEASE_GRACE_MS } from '../../src/sources/feishu-loops.js'
import { fakeChannels, message, PLUGIN, rpc } from './fake-channels.js'
import { type FeishuHost, feishuHost, MEMBER } from './feishu-host.js'

const hosts: FeishuHost[] = []
const open = (...args: Parameters<typeof feishuHost>) => {
  const host = feishuHost(...args)
  hosts.push(host)
  return host
}
afterEach(() => {
  vi.useRealTimers()
  for (const host of hosts.splice(0)) host.close()
})
const DEDICATED = { claim: 'instance', instance: `${PLUGIN}/feishu` }
/** Runs `h`'s loops for `ms` of fake time and returns how to stop them. */
async function started(h: FeishuHost, ms = 10) {
  const stop = new AbortController()
  const running = h.run(stop.signal)
  await vi.advanceTimersByTimeAsync(ms)
  return async () => {
    stop.abort()
    await running
  }
}
const strength = (h: FeishuHost, id: string) => h.engine.candidate(key('feishu', id))?.strength

describe('a channel instance of its own', () => {
  it('claims the whole instance by its plugin and instance id, and subscribes no group', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open({ feishu: DEDICATED })
    const stop = await started(h)
    expect(h.fake.calls('claimInstance').map((call) => call.args)).toEqual([
      [{ pluginId: PLUGIN, instanceId: 'feishu' }],
    ])
    expect(h.fake.calls('subscribe')).toEqual([])
    expect(h.health.feishu).toMatchObject({
      state: 'ready',
      detail: 'Receiving every chat and direct message of feishu',
    })
    expect(h.health.others).toMatchObject({ state: 'ready' })
    expect(h.health.others?.code).toBeUndefined()
    await stop()
    expect(h.fake.calls('release')).toHaveLength(1)
    expect(h.fake.claimed()).toBe(false)
  })

  it('takes a direct message from someone on the list as an explicit request, and one from anyone else as nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open({ feishu: DEDICATED })
    const stop = await started(h)
    expect(h.fake.emit(message('om_dm', { chat: 'oc_dm', direct: true, text: 'fix the login' }))).toBe(true)
    expect(h.fake.emit(message('om_stranger', { chat: 'oc_dm2', direct: true, sender: 'ou_stranger' }))).toBe(
      true,
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(h.trigger('om_dm')).toMatchObject({
      addressed: 'direct',
      actor: { source: 'feishu', id: MEMBER },
      meta: { direct: true, chatId: 'oc_dm' },
    })
    expect(strength(h, 'om_dm')).toBe('explicit')
    expect(strength(h, 'om_stranger')).toBeUndefined()
    // A reply goes back to the direct chat through the claimed instance.
    expect(h.sources.channelAllowed(h.trigger('om_dm')!.channel!)).toBe(true)
    await stop()
  })

  it('takes a direct message in only while direct messages are on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open({ feishu: { ...DEDICATED, directMessages: false } })
    const stop = await started(h)
    h.fake.emit(message('om_dm', { chat: 'oc_dm', direct: true }))
    await vi.advanceTimersByTimeAsync(10)
    expect(strength(h, 'om_dm')).toBeUndefined()
    await stop()
  })

  it('receives an @ in an unlisted chat while other chats are "@ only", and nothing there otherwise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const on = open({ feishu: { ...DEDICATED, otherChats: 'mentions' } })
    let stop = await started(on)
    on.fake.emit(message('om_other', { chat: 'oc_unlisted', mentioned: true }))
    on.fake.emit(message('om_chatter', { chat: 'oc_unlisted' }))
    await vi.advanceTimersByTimeAsync(10)
    expect(strength(on, 'om_other')).toBe('explicit')
    expect(strength(on, 'om_chatter')).toBeUndefined()
    await stop()
    const off = open({ feishu: { ...DEDICATED, otherChats: 'none' } })
    stop = await started(off)
    off.fake.emit(message('om_other', { chat: 'oc_unlisted', mentioned: true }))
    await vi.advanceTimersByTimeAsync(10)
    expect(strength(off, 'om_other')).toBeUndefined()
    await stop()
  })

  it('says in the admission table that direct messages and other chats are received on its own instance', () => {
    const h = open()
    const rows = (config: Record<string, unknown>) =>
      Object.fromEntries(h.kind.policy!.rows!(config).map((row) => [row.id, row.note]))
    expect(rows({ ...DEDICATED, directMessages: true, otherChats: 'mentions' })).toMatchObject({
      direct: { zh: '接收', en: 'Received' },
      other: { zh: '仅 @', en: '@ only' },
    })
  })

  it('reports an instance in use as needing a dedicated bot instance, and one without its plugin as setup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const fake = fakeChannels()
    fake.state.claimRefusal = 'CHANNEL_CLAIMED'
    const h = open({ fake, feishu: DEDICATED })
    const stop = await started(h)
    // At first it may be Superagent's own previous run, which releases the instance within seconds.
    expect(h.health.feishu).toMatchObject({
      state: 'paused',
      code: 'feishuInstanceReleasing',
      values: { channel: 'feishu' },
    })
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 6_000)
    expect(h.health.feishu).toMatchObject({
      state: 'paused',
      code: 'feishuInstanceShared',
      values: { channel: 'feishu' },
    })
    expect(h.health.feishu?.detail).toMatch(/^Setup required: .*use a dedicated bot instance/)
    // An unused pairing code also holds the instance, until it expires; the message says so.
    expect(h.health.feishu?.detail).toContain(
      'or a pairing code for it is still unused (it expires within an hour)',
    )
    for (const entry of ['history', 'members', 'reads', 'others'])
      expect(h.health[entry]).toMatchObject({ state: 'paused', code: 'feishuWaiting' })
    // Retried with backoff, never stealing the instance: it is claimed once the owner frees it.
    fake.state.claimRefusal = undefined
    await vi.advanceTimersByTimeAsync(16_100)
    expect(fake.claimed()).toBe(true)
    expect(h.health.feishu).toMatchObject({ state: 'ready' })
    await stop()

    const bare = open({ feishu: { claim: 'instance', instance: 'feishu' } })
    const ended = await started(bare)
    expect(bare.health.feishu).toMatchObject({ state: 'paused', code: 'feishuPluginUnset' })
    // It names the form the instance picker writes.
    expect(bare.health.feishu?.detail).toContain('as <channel row id>/<instance id>')
    expect(bare.fake.calls('claimInstance')).toEqual([])
    await ended()
  })

  it('claims again on a change of instance, and subscribes the listed groups once set to groups', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open({ feishu: DEDICATED })
    const stop = await started(h)
    const settings = h.store.settings()
    const feishu = settings.sources.feishu!
    h.store.saveSettings({
      ...settings,
      sources: { ...settings.sources, feishu: { ...feishu, config: { ...feishu.config, claim: 'groups' } } },
    })
    await vi.advanceTimersByTimeAsync(5_100)
    expect(h.fake.calls('release')).toHaveLength(1)
    expect(h.fake.subscribed().sort()).toEqual(['oc_observed', 'oc_team'])
    // As before: a direct message does not reach a Source that claims only groups.
    expect(h.fake.emit(message('om_dm', { chat: 'oc_dm', direct: true }))).toBe(false)
    expect(h.health.others).toMatchObject({ state: 'ready', code: 'feishuDedicatedBot' })
    await stop()
  })
})

describe('the note on direct messages and other chats', () => {
  it('follows the settings when direct messages or other chats are switched while the Source listens', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open({ feishu: { directMessages: false, otherChats: 'none' } })
    const stop = await started(h)
    expect(h.health.others).toMatchObject({ state: 'ready', detail: 'Only the listed chats are received' })
    const toggle = (config: Record<string, unknown>) => {
      const settings = h.store.settings()
      const feishu = settings.sources.feishu!
      h.store.saveSettings({
        ...settings,
        sources: { ...settings.sources, feishu: { ...feishu, config: { ...feishu.config, ...config } } },
      })
    }
    toggle({ directMessages: true })
    await vi.advanceTimersByTimeAsync(5_100)
    expect(h.health.others).toMatchObject({ state: 'ready', code: 'feishuDedicatedBot' })
    toggle({ directMessages: false, otherChats: 'mentions' })
    await vi.advanceTimersByTimeAsync(5_100)
    expect(h.health.others).toMatchObject({ state: 'ready', code: 'feishuDedicatedBot' })
    toggle({ otherChats: 'none' })
    await vi.advanceTimersByTimeAsync(5_100)
    expect(h.health.others).toMatchObject({ state: 'ready', detail: 'Only the listed chats are received' })
    // The subscription itself stayed: no setting of these two renews it.
    expect(h.fake.calls('subscribe')).toHaveLength(1)
    await stop()
  })
})

describe('choosing the instance', () => {
  const catalog = {
    providers: [
      { extension: 'plugin/aa', rowId: 'ext:agnes.feishu/main', manifest: { displayName: 'Feishu' } },
      { extension: 'plugin/bb', rowId: 'ext:acme/broken/main', manifest: {} },
    ],
  }
  const call = (overrides: { catalog?: () => unknown } = {}) =>
    vi.fn(async (method: string, params: unknown) => {
      if (method === '_agnes/v1/channels.catalog') return (overrides.catalog ?? (() => catalog))()
      const { extension, service } = params as { extension: string; service: string }
      if (extension === 'plugin/bb') throw rpc('CAPABILITY_DENIED')
      if (service === 'channel.configuration')
        return { output: { instances: [{ id: 'owner-bot' }, { id: 'superagent-bot' }] } }
      return {
        output: {
          instances: [
            { id: 'owner-bot', pairings: [{ id: 'p1' }], bindings: [] },
            { id: 'superagent-bot', pairings: [], bindings: [] },
          ],
        },
      }
    }) as never
  it("lists every running instance as <row id>/<instance id> by plugin name, marking the owner's as busy", async () => {
    expect(await listInstances(call())).toEqual([
      { value: 'ext:agnes.feishu/main/owner-bot', label: 'Feishu · owner-bot', busy: OWNER_BUSY },
      { value: 'ext:agnes.feishu/main/superagent-bot', label: 'Feishu · superagent-bot' },
    ])
    await expect(
      listInstances(
        call({
          catalog: () => {
            throw rpc('CAPABILITY_DENIED')
          },
        }),
      ),
    ).rejects.toMatchObject({ message: 'CAPABILITY_DENIED' })
  })

  it('stores the instances as the choices the settings show, and keeps them when a later read fails', async () => {
    const h = open()
    let fail = false
    h.link.instances = async () => {
      if (fail) throw new Error('daemon away')
      return listInstances(call())
    }
    await h.kind.refreshChoices!(h.host)
    const view = () =>
      settingsView(h.store, h.sources, {}, {}, '/state').sources.find((source) => source.id === 'feishu')!
    expect(view().choices.instance?.map((choice) => choice.value)).toEqual([
      'ext:agnes.feishu/main/owner-bot',
      'ext:agnes.feishu/main/superagent-bot',
    ])
    fail = true
    await expect(h.kind.refreshChoices!(h.host)).rejects.toThrow('daemon away')
    expect(view().choices.instance).toHaveLength(2)
    const field = h.kind.fields.find((spec) => spec.key === 'instance')
    expect(field).toMatchObject({
      type: 'text',
      choices: { unavailableWhen: { key: 'claim', value: 'instance' } },
    })
  })

  it('gives up a read of the instances that does not answer within 10 s, keeps the choices and reads the chats', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open()
    h.link.instances = async () => listInstances(call())
    await h.kind.refreshChoices!(h.host)
    // A channel row that is starting holds the read.
    h.link.instances = () => new Promise(() => {})
    const refreshed = h.kind.refreshChoices!(h.host)
    const failed = expect(refreshed).rejects.toThrow('The channel instances were not read within 10 s')
    await vi.advanceTimersByTimeAsync(INSTANCES_TIMEOUT_MS)
    await failed
    const view = () =>
      settingsView(h.store, h.sources, {}, {}, '/state').sources.find((source) => source.id === 'feishu')!
    expect(view().choices.instance).toHaveLength(2)
    // The minute's loop goes on to the chat names rather than waiting for the instances.
    const stop = await started(h, INSTANCES_TIMEOUT_MS + 100)
    expect(h.fake.calls('listChats').length).toBeGreaterThan(0)
    await stop()
  })
})
