import type { DaemonNotice, EventEnvelope, HarnessMeta, UITimeline } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { MessageEvent } from '../src/adapter.js'
import { createFakeClient, FakeChannel } from '../testkit/index.js'

const message = (text = '@bot hello'): MessageEvent => ({
  kind: 'message',
  eventId: 'e1',
  messageId: 'm1',
  accountId: 'account',
  at: '2026-09-11T00:00:00Z',
  text,
  chat: { id: 'c1', type: 'group' },
  sender: { userId: 'u1', raw: { staffId: 'u1', phone: 'secret' } },
  attachments: [],
  mentions: { bot: true, replyToBot: false, quoteBot: false },
})

describe('FakeChannel', () => {
  it('delivers inbound events, maps messages and commands, and whitelists credentials', async () => {
    const received: MessageEvent[] = []
    const channel = new FakeChannel()
    await channel.connect({
      credentials: {},
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.kind === 'message') received.push(event)
      },
      log: { info() {}, warn() {}, error() {} },
    })
    channel.emit(message())
    expect(received).toHaveLength(1)

    const intent = channel.toSession(message(), { tenant: 'tenant', agent: 'agent' })
    expect(intent).toMatchObject({
      sessionKey: 'agnes:tenant:agent:fake:group:c1',
      kind: 'message',
      content: [{ type: 'text', text: 'hello' }],
    })
    expect(intent?.credential.raw).toEqual({ staffId: 'u1' })
    expect(
      channel.toSession(message('/help now please'), { tenant: 'tenant', agent: 'agent' }),
    ).toMatchObject({
      kind: 'command',
      command: { name: 'help', args: ['now', 'please'] },
    })
  })

  it('records send/update, exposes overridden capabilities, and stops delivery after disconnect', async () => {
    const onEvent = vi.fn()
    const channel = new FakeChannel({ caps: { edit: false, card: false } })
    await channel.connect({
      credentials: {},
      signal: new AbortController().signal,
      onEvent,
      log: { info() {}, warn() {}, error() {} },
    })
    const outbound = { blocks: [{ kind: 'text' as const, markdown: 'hi' }] }
    const ref = await channel.send({ chatId: 'c1' }, outbound)
    await channel.update(ref, outbound)
    expect(channel.sent).toEqual([{ target: { chatId: 'c1' }, msg: outbound, ref }])
    expect(channel.updates).toEqual([{ ref, msg: outbound }])
    expect(channel.capabilities()).toMatchObject({ edit: false, card: false })
    expect(channel.manifest.capabilities.edit).toBe(true)

    await channel.disconnect()
    channel.emit(message())
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('returns null for unsupported inbound shapes and malformed actions', () => {
    const channel = new FakeChannel()
    const joined = { ...message(), kind: 'groupJoin' as const }
    expect(channel.toSession(joined, { tenant: 't', agent: 'a' })).toBeNull()
    expect(
      channel.onApprovalAction({ ...message(), kind: 'cardAction', cardBizId: 'c', value: 'bad' }),
    ).toBeNull()
    expect(
      channel.onApprovalAction({
        ...message(),
        kind: 'cardAction',
        cardBizId: 'c',
        value: 'appr:#0:allow_once',
      }),
    ).toBeNull()
    expect(
      channel.onSlotAction?.({ ...message(), kind: 'cardAction', cardBizId: 'c', value: 'slot:0:accept' }),
    ).toBeNull()
  })
})

describe('createFakeClient', () => {
  it('replays SESSION_NOT_FOUND once, creates a session, and records calls', async () => {
    const client = createFakeClient()
    client.fireNotFound('k')
    await expect(client.session.attach('k')).rejects.toMatchObject({ code: -32003 })
    const session = await client.session.new({ cwd: '/workspace', preset: 'channel', sessionKey: 'k' })
    expect(session.id).toBe('k')
    await session.followUp('hello', { commandId: 'cmd-1' })
    expect(client.calls.map((call) => call.method)).toEqual(['session.attach', 'session.new', 'followUp'])
    expect((await client.session.attach('k')).id).toBe('k')
  })

  it('streams pushed events and returns scripted timelines', async () => {
    const client = createFakeClient()
    const session = await client.session.attach('k')
    const timeline: UITimeline = {
      sessionId: 'k',
      upto: 1,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [],
    }
    client.setTimeline('k', timeline)
    expect(await session.projectUI()).toEqual(timeline)

    const iterator = session.events()[Symbol.asyncIterator]()
    client.pushEvent('k', {
      ...(event() as EventEnvelope),
      _meta: meta(),
    })
    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 1 }, done: false })
  })

  it('scripts API and approval failures, claim outcomes, notices, and records facade calls', async () => {
    const client = createFakeClient({
      apis: { families: [{ name: 'custom', methods: ['x'], guidance: 'test' }] },
      decideError: -32008,
    })
    expect((await client.apis()).families[0]?.name).toBe('custom')
    client.claimResults.set('event:e1', false)
    await expect(client.claim.once('event', 'e1')).resolves.toBe(false)
    await expect(client.approval.decide('ticket', 'allowed-once', { kind: 'local' })).rejects.toMatchObject({
      code: -32008,
    })

    const notices: unknown[] = []
    const dispose = client.on('notice', (notice) => notices.push(notice))
    const notice: DaemonNotice = { kind: 'resumed', detail: {}, at: '2026-09-11T00:00:00Z' }
    client.emitNotice(notice)
    dispose()
    client.emitNotice(notice)
    expect(notices).toEqual([notice])
    expect(client.calls.map((call) => call.method)).toEqual(['apis', 'claim.once', 'approval.decide'])
  })
})

function event(): EventEnvelope {
  return {
    seq: 1,
    ts: '2026-09-11T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type: 'turn/start',
    data: { turn: 1, trigger: 'prompt' },
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'principal',
    trust: 'trusted',
  }
}

function meta(): HarnessMeta {
  return {
    promptTurnId: 'turn-1',
    eventSequence: 1,
    generation: 1,
    lane: 'main',
    phase: 'event',
  }
}
