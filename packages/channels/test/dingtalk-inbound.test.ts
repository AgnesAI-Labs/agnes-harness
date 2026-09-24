import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelEvent, MessageEvent } from '../src/adapter.js'
import { attachmentsOf, MAX_ATTACHMENT_BYTES, toEvent } from '../src/adapters/dingtalk/events.js'
import type { RawRobotMessage } from '../src/adapters/dingtalk/gateway.js'
import { FakeDingtalkGateway } from '../src/adapters/dingtalk/gateway-fake.js'
import { createDingtalkAdapter } from '../src/adapters/dingtalk/index.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))

type TestRaw = RawRobotMessage & {
  senderId?: string
  content?: RawRobotMessage['content'] & { richText?: Array<{ text?: string }> }
}

function raw(override: Partial<TestRaw> = {}): TestRaw {
  return {
    msgId: 'message-1',
    conversationId: 'conversation-1',
    conversationType: '2',
    senderStaffId: 'staff-1',
    senderNick: '李四',
    senderCorpId: 'corp-secret',
    senderId: 'union-1',
    msgtype: 'text',
    text: { content: '@助理 统计本月销售' },
    isInAtList: true,
    createAt: 1_700_000_000_000,
    robotCode: 'robot-1',
    ...override,
  }
}

describe('DingTalk inbound event mapping', () => {
  it('maps identity, group text and stable delivery identifiers without widening raw credentials', () => {
    const event = toEvent(raw(), 'bot-1', [])

    expect(event).toMatchObject({
      kind: 'message',
      eventId: 'message-1',
      messageId: 'message-1',
      accountId: 'robot-1',
      at: '2023-11-14T22:13:20.000Z',
      chat: { id: 'conversation-1', type: 'group' },
      text: '@助理 统计本月销售',
      mentions: { bot: true, replyToBot: false, quoteBot: false },
      sender: {
        userId: 'staff-1',
        unionId: 'union-1',
        displayName: '李四',
        raw: {
          staffId: 'staff-1',
          unionId: 'union-1',
          conversationId: 'conversation-1',
          conversationType: '2',
          senderNick: '李四',
          senderCorpId: 'corp-secret',
        },
      },
    })
  })

  it('maps direct messages, rich text and both documented mention signals', () => {
    expect(toEvent(raw({ conversationType: '1', isInAtList: false }), 'bot-1', []).chat.type).toBe('dm')
    expect(
      toEvent(raw({ isInAtList: false, atUsers: [{ dingtalkId: 'bot-1' }] }), 'bot-1', []).mentions.bot,
    ).toBe(true)
    expect(
      toEvent(raw({ isInAtList: false, atUsers: [{ dingtalkId: 'other' }] }), 'bot-1', []).mentions.bot,
    ).toBe(false)
    expect(
      toEvent(
        raw({
          msgtype: 'richText',
          content: { richText: [{ text: '第一段' }, {}, { text: '第二段' }] },
        }),
        'bot-1',
        [],
      ).text,
    ).toBe('第一段第二段')
  })

  it('fails closed for values outside the raw message discriminant unions', () => {
    expect(() =>
      toEvent(raw({ conversationType: '3' as RawRobotMessage['conversationType'] }), 'bot-1', []),
    ).toThrow(/conversationType/)
    expect(() => toEvent(raw({ msgtype: 'video' as RawRobotMessage['msgtype'] }), 'bot-1', [])).toThrow(
      /msgtype/,
    )
  })
})

describe('DingTalk inbound attachments', () => {
  it('downloads supported media with the exact cap and preserves bounded bytes', async () => {
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }))

    await expect(
      attachmentsOf(raw({ msgtype: 'picture', content: { downloadCode: 'small' } }), download),
    ).resolves.toEqual([
      {
        name: 'message-1.png',
        mime: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        sizeBytes: 3,
      },
    ])
    expect(download).toHaveBeenCalledWith('small', MAX_ATTACHMENT_BYTES)
  })

  it('uses an HTTPS reference for over-limit media and forces the documented audio MIME', async () => {
    const gateway = new FakeDingtalkGateway()
    gateway.downloads.set('large', {
      bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      mime: 'application/octet-stream',
    })
    gateway.downloads.set('audio', { url: 'https://download.example/audio' })

    await expect(
      attachmentsOf(
        raw({ msgtype: 'file', content: { downloadCode: 'large', fileName: 'report.zip' } }),
        (code, maxBytes) => gateway.download(code, maxBytes),
      ),
    ).resolves.toEqual([
      { name: 'report.zip', mime: 'application/octet-stream', url: 'https://dl.example/large' },
    ])
    await expect(
      attachmentsOf(raw({ msgtype: 'audio', content: { downloadCode: 'audio' } }), (code, maxBytes) =>
        gateway.download(code, maxBytes),
      ),
    ).resolves.toEqual([{ name: 'message-1.amr', mime: 'audio/amr', url: 'https://download.example/audio' }])
  })

  it('rejects unsafe URLs and a gateway that violates the byte limit', async () => {
    await expect(
      attachmentsOf(raw({ msgtype: 'file', content: { downloadCode: 'bad' } }), async () => ({
        url: 'file:///etc/passwd',
      })),
    ).rejects.toThrow(/HTTPS/)
    await expect(
      attachmentsOf(raw({ msgtype: 'file', content: { downloadCode: 'bad' } }), async () => ({
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
        mime: 'application/octet-stream',
      })),
    ).rejects.toThrow(/size limit/)
  })

  it('does not call the gateway for text or media without a download code', async () => {
    const download = vi.fn()
    await expect(attachmentsOf(raw(), download)).resolves.toEqual([])
    await expect(attachmentsOf(raw({ msgtype: 'picture', content: {} }), download)).resolves.toEqual([])
    expect(download).not.toHaveBeenCalled()
  })
})

describe('DingtalkAdapter.toSession and credentialOf', () => {
  it('builds a group session, strips a real bot mention and applies the manifest credential whitelist', async () => {
    const adapter = await createDingtalkAdapter(manifestPath, { gateway: new FakeDingtalkGateway() })
    const intent = adapter.toSession(toEvent(raw(), 'bot-1', []), {
      tenant: 'xinwei',
      agent: 'sales',
    })

    expect(intent).toMatchObject({
      sessionKey: 'agnes:xinwei:sales:dingtalk:group:conversation-1',
      eventId: 'message-1',
      messageId: 'message-1',
      kind: 'message',
      content: [{ type: 'text', text: '统计本月销售' }],
      credential: {
        kind: 'channel',
        channel: 'dingtalk',
        accountId: 'robot-1',
        userId: 'staff-1',
        unionId: 'union-1',
        chatId: 'conversation-1',
        chatType: 'group',
        displayName: '李四',
      },
    })
    expect(Object.keys(intent?.credential.raw ?? {}).sort()).toEqual([
      'conversationId',
      'conversationType',
      'senderNick',
      'staffId',
      'unionId',
    ])
    expect(JSON.stringify(intent?.credential)).not.toContain('corp-secret')
  })

  it('keeps thread identity in the session key and does not strip an unverified @ prefix', async () => {
    const adapter = await createDingtalkAdapter(manifestPath, { gateway: new FakeDingtalkGateway() })
    const base = toEvent(raw({ isInAtList: false, atUsers: [] }), 'bot-1', [])
    const thread: MessageEvent = {
      ...base,
      chat: { id: 'conversation-1', type: 'thread', threadId: 'thread-9' },
      text: '@alice keep this',
      mentions: { bot: false, replyToBot: false, quoteBot: false },
    }

    expect(adapter.toSession(thread, { tenant: 't', agent: 'a' })).toMatchObject({
      sessionKey: 'agnes:t:a:dingtalk:group:conversation-1:thread:thread-9',
      content: [{ type: 'text', text: '@alice keep this' }],
      credential: { chatType: 'thread' },
    })
  })

  it('recognizes only the five command names and preserves attachment trust boundaries', async () => {
    const adapter = await createDingtalkAdapter(manifestPath, { gateway: new FakeDingtalkGateway() })
    const bytes = new Uint8Array([1, 2, 3])
    const event = toEvent(raw({ text: { content: '/preset code' } }), 'bot-1', [
      { name: 'local.bin', mime: 'application/octet-stream', bytes },
      { name: 'remote.txt', mime: 'text/plain', url: 'https://download.example/remote' },
      { name: 'unsafe', mime: 'text/plain', url: 'file:///etc/passwd' },
      { name: 'missing', mime: 'text/plain' },
    ])
    const intent = adapter.toSession(event, { tenant: 't', agent: 'a' })

    expect(intent).toMatchObject({
      kind: 'command',
      command: { name: 'preset', args: ['code'] },
    })
    expect(intent?.content).toEqual([
      { type: 'text', text: '/preset code' },
      {
        type: 'resource_link',
        uri: `attachment://${createHash('sha256').update(bytes).digest('hex')}`,
        name: 'local.bin',
        mimeType: 'application/octet-stream',
      },
      {
        type: 'resource_link',
        uri: 'https://download.example/remote',
        name: 'remote.txt',
        mimeType: 'text/plain',
      },
    ])

    const unknownCommand = adapter.toSession(
      toEvent(raw({ text: { content: '/deploy now' } }), 'bot-1', []),
      {
        tenant: 't',
        agent: 'a',
      },
    )
    expect(unknownCommand).toMatchObject({ kind: 'message' })
    expect(unknownCommand).not.toHaveProperty('command')
  })

  it('returns null for non-message events and an empty message without attachments', async () => {
    const adapter = await createDingtalkAdapter(manifestPath, { gateway: new FakeDingtalkGateway() })
    const message = toEvent(raw({ text: { content: '   ' } }), 'bot-1', [])
    const card: ChannelEvent = {
      kind: 'cardAction',
      eventId: 'card-1',
      accountId: 'robot-1',
      at: message.at,
      chat: message.chat,
      sender: message.sender,
      cardBizId: 'card-1',
      value: 'approve',
    }

    expect(adapter.toSession(message, { tenant: 't', agent: 'a' })).toBeNull()
    expect(adapter.toSession(card, { tenant: 't', agent: 'a' })).toBeNull()
  })
})

describe('DingtalkAdapter inbound delivery', () => {
  it('preserves repeated delivery ids for downstream claim.once deduplication', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })
    const events: ChannelEvent[] = []
    await adapter.connect({
      credentials: { clientId: 'app-key', clientSecret: 'app-secret' },
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      log: { info() {}, warn() {}, error() {} },
    })

    gateway.emitMessage(raw())
    gateway.emitMessage(raw())
    await vi.waitFor(() => expect(events).toHaveLength(2))

    expect(events.map((event) => event.eventId)).toEqual(['message-1', 'message-1'])
    await adapter.disconnect()
  })

  it('preserves same-chat order across attachment downloads and redacts failures by omission', async () => {
    const gateway = new FakeDingtalkGateway()
    let release: (() => void) | undefined
    gateway.download = vi.fn(async (code) => {
      if (code === 'slow') await new Promise<void>((resolve) => (release = resolve))
      if (code === 'secret-error') throw new Error('app-secret leaked from backend')
      return { bytes: new Uint8Array([1]), mime: 'image/png' }
    })
    const events: MessageEvent[] = []
    const warn = vi.fn()
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })
    await adapter.connect({
      credentials: { clientId: 'app-key', clientSecret: 'app-secret' },
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.kind === 'message') events.push(event)
      },
      log: { info() {}, warn, error() {} },
    })

    gateway.emitMessage(raw({ msgId: 'first', msgtype: 'picture', content: { downloadCode: 'slow' } }))
    gateway.emitMessage(raw({ msgId: 'second', text: { content: 'second' } }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(events).toHaveLength(0)
    release?.()
    await vi.waitFor(() => expect(events.map((event) => event.messageId)).toEqual(['first', 'second']))

    gateway.emitMessage(raw({ msgId: 'third', msgtype: 'file', content: { downloadCode: 'secret-error' } }))
    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(events[2]?.attachments).toEqual([])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('app-secret')
    await adapter.disconnect()
  })

  it('drops a stale pending event without blocking the next connection epoch', async () => {
    const gateway = new FakeDingtalkGateway()
    let release: (() => void) | undefined
    gateway.download = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return { bytes: new Uint8Array([1]), mime: 'image/png' }
    })
    const events: MessageEvent[] = []
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })
    const connect = () =>
      adapter.connect({
        credentials: { clientId: 'app-key', clientSecret: 'app-secret' },
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.kind === 'message') events.push(event)
        },
        log: { info() {}, warn() {}, error() {} },
      })
    await connect()
    gateway.emitMessage(raw({ msgId: 'stale', msgtype: 'picture', content: { downloadCode: 'slow' } }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    await adapter.disconnect()
    await connect()
    gateway.emitMessage(raw({ msgId: 'fresh', text: { content: 'fresh' } }))
    await vi.waitFor(() => expect(events.map((event) => event.messageId)).toEqual(['fresh']))

    release?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events.map((event) => event.messageId)).toEqual(['fresh'])
    await adapter.disconnect()
  })

  it('does not deliver an in-flight attachment after the connection signal aborts', async () => {
    const gateway = new FakeDingtalkGateway()
    let release: (() => void) | undefined
    gateway.download = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return { bytes: new Uint8Array([1]), mime: 'image/png' }
    })
    const events: ChannelEvent[] = []
    const controller = new AbortController()
    const adapter = await createDingtalkAdapter(manifestPath, { gateway })
    await adapter.connect({
      credentials: { clientId: 'app-key', clientSecret: 'app-secret' },
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      log: { info() {}, warn() {}, error() {} },
    })
    gateway.emitMessage(raw({ msgId: 'pending', msgtype: 'picture', content: { downloadCode: 'slow' } }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    controller.abort()
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(events).toEqual([])
    expect(gateway.started).toBe(false)
  })
})
