import { JsonRpcError } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelCredential, MessageEvent } from '../src/adapter.js'
import { commandIdFor, Inbound, SessionCache } from '../src/runner/inbound.js'
import { createFakeClient, FakeChannel } from '../testkit/index.js'

const config = {
  allowFrom: [],
  requireMention: true,
  tenant: 'tenant',
  agent: 'agent',
}

function message(id: string, text = '@bot hello', extra: Partial<MessageEvent> = {}): MessageEvent {
  return {
    kind: 'message',
    eventId: `event-${id}`,
    messageId: `message-${id}`,
    accountId: 'account',
    at: '2026-09-11T00:00:00.000Z',
    text,
    attachments: [],
    chat: { id: 'chat-1', type: 'group' },
    sender: { userId: 'user-1', raw: { staffId: 'staff-1', phone: 'not-exposed' } },
    mentions: { bot: true, replyToBot: false, quoteBot: false },
    ...extra,
  }
}

function setup() {
  const client = createFakeClient()
  const adapter = new FakeChannel()
  const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
  const warn = vi.fn()
  const inbound = new Inbound({
    adapter,
    claim: client.claim,
    joinParticipant: async (sessionKey, credential) => {
      await client.participant.join(sessionKey, credential)
    },
    cache,
    config,
    log: { info() {}, warn, error() {} },
  })
  return { adapter, cache, client, inbound, warn }
}

describe('SessionCache', () => {
  it('notifies removal exactly once across invalidate, evict and stop without trusting the observer', async () => {
    const client = createFakeClient()
    const removed = vi.fn(() => {
      throw new Error('observer failed')
    })
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' }, { onRemove: removed })
    const invalidated = (await cache.get('invalidated')).session
    const evicted = (await cache.get('evicted')).session
    const stopped = (await cache.get('stopped')).session

    expect(() => cache.invalidate('invalidated')).not.toThrow()
    cache.invalidate('invalidated')
    await expect(cache.evict('evicted')).resolves.toBe(true)
    await expect(cache.evict('evicted')).resolves.toBe(true)
    await expect(cache.stop()).resolves.toBeUndefined()
    await expect(cache.stop()).resolves.toBeUndefined()

    expect(removed.mock.calls).toEqual([
      ['invalidated', invalidated],
      ['evicted', evicted],
      ['stopped', stopped],
    ])
  })

  it('bounds unique slow openings while coalescing the same key and cleans them up on stop', async () => {
    const client = createFakeClient()
    const originalAttach = client.session.attach.bind(client.session)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    client.session.attach = vi.fn(async (key, options) => {
      await gate
      return originalAttach(key, options)
    })
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' }, { maxPendingKeys: 2 })

    const first = cache.get('first')
    const duplicate = cache.get('first')
    const second = cache.get('second')
    await vi.waitFor(() => expect(client.session.attach).toHaveBeenCalledTimes(2))
    await expect(cache.get('flood')).rejects.toThrow('opening capacity')

    await cache.stop()
    release()
    await expect(first).rejects.toThrow('stopped')
    await expect(duplicate).rejects.toThrow('stopped')
    await expect(second).rejects.toThrow('stopped')
    expect(cache.keys()).toEqual([])
  })

  it('attaches first and creates with the stable session key only on SESSION_NOT_FOUND', async () => {
    const client = createFakeClient()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const key = 'agnes:tenant:agent:fake:group:chat-1'
    client.fireNotFound(key)

    const opened = await cache.get(key)

    expect(opened.created).toBe(true)
    expect(client.calls.map((call) => call.method)).toEqual([
      'session.attach',
      'session.new',
      'session.attach',
    ])
    expect(client.calls[0]?.args[1]).toEqual({ filter: { acpUpdates: false } })
    expect(client.calls[1]?.args[0]).toEqual({
      cwd: '/workspace',
      preset: 'channel',
      sessionKey: key,
    })
    expect((await cache.get(key)).created).toBe(false)
  })

  it('coalesces concurrent opens and does not convert unrelated errors into session creation', async () => {
    const client = createFakeClient()
    const originalAttach = client.session.attach.bind(client.session)
    client.session.attach = vi.fn(async (key, options) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return originalAttach(key, options)
    })
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })

    const [left, right] = await Promise.all([cache.get('same'), cache.get('same')])

    expect(left.session).toBe(right.session)
    expect(client.session.attach).toHaveBeenCalledOnce()

    client.session.attach = vi.fn(async () => {
      throw new JsonRpcError({
        code: -32002,
        message: 'SESSION_BUSY',
        data: { code: 'SESSION_BUSY' },
      })
    })
    await expect(cache.get('other')).rejects.toMatchObject({ code: -32002 })
    expect(client.calls.filter((call) => call.method === 'session.new')).toHaveLength(0)
  })

  it('renews a routed channel session under a unique append-only session key', async () => {
    const client = createFakeClient()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const old = (await cache.get('route-key')).session

    const renewed = await cache.renew('route-key')

    expect(renewed.id).toMatch(/^route-key:thread:[0-9a-f-]{36}$/)
    expect((await cache.get('route-key')).session).toBe(renewed)
    expect(client.calls.find((call) => call.method === 'session.new')?.args[0]).toEqual({
      cwd: '/workspace',
      preset: 'channel',
      sessionKey: renewed.id,
    })
    expect(client.calls.some((call) => call.method === 'detach')).toBe(true)
    expect(renewed).not.toBe(old)
  })

  it('does not let an evicted in-flight open overwrite the current cache owner', async () => {
    const client = createFakeClient()
    const originalAttach = client.session.attach.bind(client.session)
    const current = await originalAttach('race')
    const stale = { ...current, detach: vi.fn(async () => undefined) }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    client.session.attach = vi.fn(async (key, options) => {
      calls++
      if (calls === 1) {
        await gate
        return stale
      }
      return originalAttach(key, options)
    })
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })

    const opening = cache.get('race')
    await vi.waitFor(() => expect(client.session.attach).toHaveBeenCalledOnce())
    await cache.evict('race')
    release()
    await expect(opening).rejects.toThrow('ownership changed')

    expect(stale.detach).toHaveBeenCalledOnce()
    const opened = await cache.get('race')
    expect(opened.session).toBe(current)
    expect(cache.owns('race', current)).toBe(true)
  })

  it('rechecks renew ownership after previous detach and conditionally evicts only the expected owner', async () => {
    const client = createFakeClient()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const previous = (await cache.get('route')).session
    let releaseDetach!: () => void
    const detachGate = new Promise<void>((resolve) => {
      releaseDetach = resolve
    })
    previous.detach = vi.fn(async () => {
      await detachGate
    })

    const renewing = cache.renew('route')
    await vi.waitFor(() => expect(cache.current('route')).not.toBe(previous))
    const installed = cache.current('route')
    if (installed === undefined) throw new Error('expected installed renewal')
    expect(await cache.evict('route', previous)).toBe(false)
    expect(cache.current('route')).toBe(installed)
    expect(await cache.evict('route', installed)).toBe(true)
    releaseDetach()

    await expect(renewing).rejects.toThrow('ownership changed')
    expect(cache.current('route')).toBeUndefined()
  })

  it('never returns a detached session when two renewals for the same key interleave', async () => {
    const client = createFakeClient()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const previous = (await cache.get('route')).session
    let releasePrevious!: () => void
    const previousGate = new Promise<void>((resolve) => {
      releasePrevious = resolve
    })
    previous.detach = vi.fn(async () => {
      await previousGate
    })

    const firstRenewal = cache.renew('route')
    await vi.waitFor(() => expect(cache.current('route')).not.toBe(previous))
    const first = cache.current('route')
    if (first === undefined) throw new Error('expected first renewal')
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    first.detach = vi.fn(async () => {
      await firstGate
    })

    const secondRenewal = cache.renew('route')
    await vi.waitFor(() => expect(cache.current('route')).not.toBe(first))
    const second = cache.current('route')
    if (second === undefined) throw new Error('expected second renewal')

    releasePrevious()
    await vi.waitFor(() => expect(first.detach).toHaveBeenCalledTimes(2))
    releaseFirst()

    await expect(firstRenewal).rejects.toThrow('ownership changed')
    await expect(secondRenewal).resolves.toBe(second)
    expect(cache.current('route')).toBe(second)
    expect(cache.owns('route', second)).toBe(true)
  })
})

describe('Inbound', () => {
  it('acknowledges only fresh messages selected by the configured reaction policy', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const inbound = new Inbound({
      adapter,
      claim: client.claim,
      cache,
      config: { ...config, requireMention: false, ackReaction: 'group-mentions' },
      log: { info() {}, warn() {}, error() {} },
    })

    await inbound.handle(message('mentioned'))
    await inbound.handle(
      message('plain', 'hello', {
        mentions: { bot: false, replyToBot: false, quoteBot: false },
      }),
    )
    client.claimResults.set('channel-event:fake:account:event-duplicate', false)
    await inbound.handle(message('duplicate'))

    expect(adapter.reactions).toEqual([
      { ref: { chatId: 'chat-1', messageId: 'message-mentioned' }, emoji: '👀' },
    ])
  })

  it('degrades a failed or unavailable reaction without blocking message dispatch', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    adapter.react = vi.fn(async () => {
      throw new Error('remote reaction failed')
    })
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const warn = vi.fn()
    const inbound = new Inbound({
      adapter,
      claim: client.claim,
      cache,
      config: { ...config, ackReaction: 'all' },
      log: { info() {}, warn, error() {} },
    })

    await inbound.handle(message('failed-reaction'))

    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('channel acknowledgement reaction failed', {
      eventId: 'event-failed-reaction',
    })

    const noCapability = new FakeChannel({ caps: { reactions: false } })
    noCapability.react = vi.fn(async () => undefined)
    const noCapabilityInbound = new Inbound({
      adapter: noCapability,
      claim: client.claim,
      cache,
      config: { ...config, ackReaction: 'all' },
      log: { info() {}, warn() {}, error() {} },
    })
    await noCapabilityInbound.handle(message('no-capability'))
    expect(noCapability.react).not.toHaveBeenCalled()
  })

  it('does not let a never-settling acknowledgement block durable message dispatch', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    adapter.react = vi.fn(() => new Promise<void>(() => undefined))
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const inbound = new Inbound({
      adapter,
      claim: client.claim,
      cache,
      config: { ...config, ackReaction: 'all' },
      log: { info() {}, warn() {}, error() {} },
      ackTimeoutMs: 5,
    })

    await inbound.handle(message('pending-reaction'))

    expect(adapter.react).toHaveBeenCalledOnce()
    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
  })

  it('finishes a freshly claimed dispatch when stop wins the pending claim, without starting ack', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const abort = new AbortController()
    let resolveClaim!: (fresh: boolean) => void
    const claim = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveClaim = resolve
        }),
    )
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const inbound = new Inbound({
      adapter,
      claim: { once: claim },
      cache,
      config: { ...config, ackReaction: 'all' },
      log: { info() {}, warn() {}, error() {} },
      signal: abort.signal,
    })

    const handling = inbound.handle(message('stop-during-claim'))
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce())
    abort.abort()
    resolveClaim(true)
    await handling

    expect(adapter.reactions).toEqual([])
    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
  })

  it('does not dispatch when a pending claim settles stale after stop', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const abort = new AbortController()
    let resolveClaim!: (fresh: boolean) => void
    const claim = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveClaim = resolve
        }),
    )
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const inbound = new Inbound({
      adapter,
      claim: { once: claim },
      cache,
      config: { ...config, ackReaction: 'all' },
      log: { info() {}, warn() {}, error() {} },
      signal: abort.signal,
    })

    const handling = inbound.handle(message('stale-during-stop'))
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce())
    abort.abort()
    resolveClaim(false)
    await handling

    expect(adapter.reactions).toEqual([])
    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(0)
  })

  it('dispatches followUp while idle and steer while busy with deterministic command ids', async () => {
    const { cache, client, inbound } = setup()
    const key = 'agnes:tenant:agent:fake:group:chat-1'

    await inbound.handle(message('1'))
    expect(client.calls.find((call) => call.method === 'followUp')?.args[1]).toEqual({
      commandId: commandIdFor(key, 'message-1'),
    })

    cache.markTurn(key, true)
    await inbound.handle(message('2'))
    expect(client.calls.find((call) => call.method === 'steer')?.args[1]).toEqual({
      commandId: commandIdFor(key, 'message-2'),
    })
  })

  it('finishes an admitted busy dispatch through followUp when stop occurs during steer', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const key = 'agnes:tenant:agent:fake:group:chat-1'
    const session = (await cache.get(key)).session
    cache.markTurn(key, true)
    let rejectSteer!: (error: Error) => void
    session.steer = vi.fn(
      () =>
        new Promise<number>((_resolve, reject) => {
          rejectSteer = reject
        }),
    )
    const stop = new AbortController()
    const inbound = new Inbound({
      adapter,
      claim: client.claim,
      cache,
      config,
      signal: stop.signal,
      log: { info() {}, warn() {}, error() {} },
    })

    const handling = inbound.handle(message('busy-stop'))
    await vi.waitFor(() => expect(session.steer).toHaveBeenCalledOnce())
    stop.abort()
    rejectSteer(
      new JsonRpcError({
        code: -32002,
        message: 'SESSION_BUSY',
        data: { code: 'SESSION_BUSY' },
      }),
    )
    await handling

    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
  })

  it('drops observe and duplicate events before opening a session', async () => {
    const { client, inbound } = setup()
    client.claimResults.set('channel-event:fake:account:event-1', false)

    await inbound.handle(message('1'))
    await inbound.handle(
      message('2', 'no mention', {
        mentions: { bot: false, replyToBot: false, quoteBot: false },
      }),
    )

    expect(client.calls.some((call) => call.method === 'session.attach')).toBe(false)
    expect(client.calls.some((call) => call.method === 'followUp')).toBe(false)
  })

  it('fails closed when claim is unavailable without logging its untrusted error', async () => {
    const { client, inbound, warn } = setup()
    client.claim.once = vi.fn(async () => {
      throw new Error('backend says app-secret')
    })

    await inbound.handle(message('1'))

    expect(client.calls.some((call) => call.method === 'session.attach')).toBe(false)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('app-secret')
  })

  it('joins each participant once with a whitelisted credential', async () => {
    const { client, inbound } = setup()

    await inbound.handle(message('1'))
    await inbound.handle(message('2'))

    const joins = client.calls.filter((call) => call.method === 'participant.join')
    expect(joins).toHaveLength(1)
    const joined = joins[0]
    if (joined === undefined) throw new Error('participant join was not recorded')
    expect((joined.args[1] as ChannelCredential).raw).toEqual({ staffId: 'staff-1' })
  })

  it('retries participant binding after a transient join failure', async () => {
    const client = createFakeClient()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const joinParticipant = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
    const inbound = new Inbound({
      adapter: new FakeChannel(),
      claim: client.claim,
      joinParticipant,
      cache,
      config,
      log: { info() {}, warn() {}, error() {} },
    })

    await inbound.handle(message('1'))
    await inbound.handle(message('2'))

    expect(joinParticipant).toHaveBeenCalledTimes(2)
  })

  it('falls back from a busy steer rejection to one followUp', async () => {
    const { cache, client, inbound } = setup()
    const key = 'agnes:tenant:agent:fake:group:chat-1'
    const { session } = await cache.get(key)
    cache.markTurn(key, true)
    session.steer = vi.fn(async () => {
      throw new JsonRpcError({
        code: -32002,
        message: 'SESSION_BUSY',
        data: { code: 'SESSION_BUSY' },
      })
    })

    await inbound.handle(message('1'))

    expect(session.steer).toHaveBeenCalledOnce()
    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
  })

  it('claims and runs known commands through the SDK session, then replies ephemerally', async () => {
    const { adapter, client, inbound } = setup()

    await inbound.handle(
      message('1', '/cancel', { chat: { id: 'chat-1', type: 'thread', threadId: 'thread-1' } }),
    )

    expect(client.calls).toContainEqual({
      method: 'claim.once',
      args: ['channel-event', 'fake:account:event-1'],
    })
    expect(client.calls.some((call) => call.method === 'cancel')).toBe(true)
    expect(client.calls.some((call) => call.method === 'followUp')).toBe(false)
    expect(adapter.sent).toEqual([
      {
        target: { chatId: 'chat-1', threadId: 'thread-1' },
        msg: {
          blocks: [{ kind: 'text', markdown: '已取消当前任务' }],
          ephemeral: true,
        },
        ref: { chatId: 'chat-1', messageId: 'm1' },
      },
    ])
  })

  it('dispatches new through the injected session lifecycle and unknown slash text normally', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
    const onNewSession = vi.fn(async () => {})
    const inbound = new Inbound({
      adapter,
      claim: client.claim,
      cache,
      config,
      log: { info() {}, warn() {}, error() {} },
      onNewSession,
    })

    await inbound.handle(message('1', '/new'))
    await inbound.handle(message('2', '/deploy now'))

    expect(onNewSession).toHaveBeenCalledWith('agnes:tenant:agent:fake:group:chat-1')
    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
    expect(client.calls.find((call) => call.method === 'followUp')?.args[0]).toEqual([
      { type: 'text', text: '/deploy now' },
    ])
  })

  it('serializes each session lane, runs different sessions concurrently, and survives a rejected item', async () => {
    const { client, inbound } = setup()
    const order: string[] = []
    const originalAttach = client.session.attach.bind(client.session)
    client.session.attach = async (key, options) => {
      order.push(`start:${key}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end:${key}`)
      return originalAttach(key, options)
    }

    await Promise.all([
      inbound.handle(message('1')),
      inbound.handle(message('2')),
      inbound.handle(message('3', '@bot other', { chat: { id: 'chat-2', type: 'group' } })),
    ])
    expect(order.filter((entry) => entry.endsWith(':chat-1'))).toEqual([
      'start:agnes:tenant:agent:fake:group:chat-1',
      'end:agnes:tenant:agent:fake:group:chat-1',
    ])
    expect(order.some((entry) => entry.endsWith(':chat-2'))).toBe(true)

    const key = 'agnes:tenant:agent:fake:group:chat-1'
    const { session } = await new SessionCache(client, {
      cwd: '/workspace',
      preset: 'channel',
    }).get(key)
    session.followUp = vi.fn().mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce(1)
    const isolated = new Inbound({
      adapter: new FakeChannel(),
      claim: client.claim,
      cache: {
        get: async () => ({ session, created: false }),
        busy: () => false,
        markParticipant: () => false,
        unmarkParticipant: () => undefined,
      },
      config,
      log: { info() {}, warn() {}, error() {} },
    })
    await expect(isolated.handle(message('4'))).rejects.toThrow('first failed')
    await expect(isolated.handle(message('5'))).resolves.toBeUndefined()
  })
})
