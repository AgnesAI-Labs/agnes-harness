import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../src/adapter.js'
import { approvalValue, buildCard, cardBizIdFor, slotValue } from '../src/adapters/dingtalk/cards.js'
import { FakeDingtalkGateway } from '../src/adapters/dingtalk/gateway-fake.js'
import { createDingtalkAdapter } from '../src/adapters/dingtalk/index.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))

describe('DingTalk card rendering', () => {
  it('builds stable bounded identifiers and callback values', () => {
    expect(cardBizIdFor('agnes:t:a:dingtalk:group:c', 'n1')).toMatch(/^[0-9a-f]{32}$/)
    expect(cardBizIdFor('k', 'n')).toBe(cardBizIdFor('k', 'n'))
    expect(approvalValue({ ticket: 'abc' }, 'allow_once')).toBe('appr:abc:allow_once')
    expect(approvalValue({ requestSeq: 7 }, 'reject_once')).toBe('appr:#7:reject_once')
    expect(slotValue(3, 'export')).toBe('slot:3:export')
  })

  it('maps tables, fields, slot actions and approval actions to a card', () => {
    const { cardData, bytes } = buildCard(
      [
        {
          kind: 'table',
          title: '销售',
          columns: ['战区', '金额'],
          rows: [['华东', '10']],
        },
        {
          kind: 'card',
          title: '销售',
          body: '本月',
          fields: [['单位', '万元']],
          actions: [{ id: 'export', label: '导出' }],
          requestSeq: 3,
        },
        {
          kind: 'approval',
          title: '需要审批',
          summary: '删除临时文件',
          risk: 'destructive',
          options: ['allow_once', 'reject_once'],
          ticket: 'tk1',
        },
      ],
      { cardBizId: 'track' },
      65_536,
    )
    const params = cardData.cardParamMap as Record<string, string>
    expect(params.title).toBe('销售')
    expect(params.markdown).toContain('| 战区 | 金额 |')
    expect(params.markdown).toContain('- 单位: 万元')
    expect(JSON.parse(params.buttons ?? '[]')).toEqual([
      { text: '导出', value: 'slot:3:export', color: 'blue' },
      { text: '同意', value: 'appr:tk1:allow_once', color: 'blue' },
      { text: '拒绝', value: 'appr:tk1:reject_once', color: 'red' },
    ])
    expect(bytes).toBeLessThan(65_536)
  })

  it('truncates by encoded bytes without splitting unicode scalars', () => {
    const full = buildCard(
      [{ kind: 'text', markdown: `报告${'🚀'.repeat(30_000)}` }],
      { cardBizId: 'track' },
      65_536,
    )
    const markdown = (full.cardData.cardParamMap as { markdown: string }).markdown
    expect(full.bytes).toBeLessThanOrEqual(65_536)
    expect(markdown.endsWith('（已截断）')).toBe(true)
    expect(markdown).not.toContain('�')
  })
})

describe('DingtalkAdapter outbound', () => {
  it('routes direct-message replies to the sender staff id rather than the conversation id', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      rate: { perChatPerMin: 6_000, perAccountPerSec: 1_000 },
    })
    let markReceived!: () => void
    const received = new Promise<void>((resolve) => {
      markReceived = resolve
    })
    await adapter.connect({
      credentials: { clientId: 'key', clientSecret: 'secret' },
      signal: new AbortController().signal,
      onEvent: markReceived,
      log: { info() {}, warn() {}, error() {} },
    })
    gateway.emitMessage({
      msgId: 'dm-1',
      conversationId: 'conversation-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      msgtype: 'text',
      text: { content: 'hello' },
      createAt: 1_700_000_000_000,
    })
    await received

    await adapter.send(
      { chatId: 'conversation-1' },
      { blocks: [{ kind: 'text', markdown: 'reply' }], ephemeral: true },
    )
    expect(gateway.sent[0]).toMatchObject({
      kind: 'markdown',
      target: { conversationId: 'conversation-1', conversationType: '1', userIds: ['staff-1'] },
    })
    await adapter.disconnect()
  })

  it('applies one account limiter to durable, ephemeral and update traffic across chats', async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeDingtalkGateway()
      const adapter = await createDingtalkAdapter(manifestPath, {
        gateway,
        rate: { perChatPerMin: 6_000, perAccountPerSec: 1 },
      })
      const first = await adapter.send(
        { chatId: 'chat-1', deliveryKey: 'first' },
        { blocks: [{ kind: 'text', markdown: 'one' }] },
      )
      const ephemeral = adapter.send(
        { chatId: 'chat-2' },
        { blocks: [{ kind: 'text', markdown: 'command result' }], ephemeral: true },
      )
      const update = adapter.update(first, { blocks: [{ kind: 'text', markdown: 'one v2' }] })

      await vi.advanceTimersByTimeAsync(999)
      expect(gateway.sent).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await ephemeral
      expect(gateway.sent).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1_000)
      await update
      expect(gateway.sent).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends all durable messages as cards and updates the same card in place', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      rate: { perChatPerMin: 6_000 },
    })
    const message: ChannelMessage = { blocks: [{ kind: 'text', markdown: 'hello' }] }
    const reference = await adapter.send({ chatId: 'chat-1' }, message)
    expect(reference.cardBizId).toMatch(/^[0-9a-f]{32}$/)
    expect(gateway.sent[0]).toMatchObject({
      kind: 'card',
      outTrackId: reference.cardBizId,
      target: { conversationId: 'chat-1', conversationType: '2' },
    })

    await adapter.update(reference, { blocks: [{ kind: 'text', markdown: 'hello v2' }] })
    expect(gateway.sent[1]).toMatchObject({ kind: 'cardUpdate', outTrackId: reference.cardBizId })
  })

  it('uses markdown only for ephemeral output and rejects attempts to edit it', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      rate: { perChatPerMin: 6_000 },
    })
    const reference = await adapter.send(
      { chatId: 'chat-1' },
      {
        blocks: [
          { kind: 'text', markdown: '无权限' },
          {
            kind: 'approval',
            title: '审批',
            summary: '发布',
            risk: 'always',
            options: ['allow_once', 'reject_once'],
            ticket: 'ticket-1',
          },
        ],
        ephemeral: true,
      },
    )
    expect(reference).not.toHaveProperty('cardBizId')
    expect(gateway.sent[0]).toMatchObject({ kind: 'markdown' })
    expect((gateway.sent[0] as { payload: { markdown: string } }).payload.markdown).toContain(
      '回复「同意 ticket」',
    )
    await expect(
      adapter.update(reference, { blocks: [{ kind: 'text', markdown: '不可更新' }] }),
    ).rejects.toMatchObject({ code: 'E_NOT_IMPLEMENTED' })
  })

  it('reuses a remote card identity when a persisted delivery attempt is retried', async () => {
    const gateway = new FakeDingtalkGateway()
    const realCreate = gateway.createCard.bind(gateway)
    let attempts = 0
    gateway.createCard = async (...args) => {
      attempts++
      await realCreate(...args)
      if (attempts === 1) throw new Error('response lost after remote acceptance')
    }
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      rate: { perChatPerMin: 6_000 },
    })
    const target = { chatId: 'chat-1', deliveryKey: 'session/node/part/content' }
    const message: ChannelMessage = { blocks: [{ kind: 'text', markdown: 'retry me' }] }

    await expect(adapter.send(target, message)).rejects.toThrow('response lost')
    await adapter.send(target, message)
    expect(gateway.sent).toHaveLength(2)
    expect(gateway.sent[0]).toMatchObject({ kind: 'card' })
    expect(gateway.sent[1]).toMatchObject({
      kind: 'card',
      outTrackId: (gateway.sent[0] as { outTrackId: string }).outTrackId,
    })
  })

  it('renders an approval with the explicit ticket taking precedence', async () => {
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway: new FakeDingtalkGateway(),
    })
    expect(
      adapter.renderApproval(
        {
          ticket: 'old',
          requestSeq: 8,
          summary: '发布',
          risk: 'always',
          options: ['allow_once', 'reject_once'],
          expiresAt: '2026-09-12T10:00:00Z',
        },
        'new',
      ),
    ).toEqual({
      blocks: [
        {
          kind: 'approval',
          title: '需要审批',
          ticket: 'new',
          requestSeq: 8,
          summary: '发布',
          risk: 'always',
          options: ['allow_once', 'reject_once'],
          expiresAt: '2026-09-12T10:00:00Z',
        },
      ],
    })
  })
})
