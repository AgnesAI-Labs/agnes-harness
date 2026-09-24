import type { Client } from '@agnes/sdk'
import { JsonRpcError } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { CardActionEvent, MessageEvent } from '../src/adapter.js'
import { Approval } from '../src/runner/approval.js'
import type { RunnerConfig } from '../src/runner/config.js'
import { createRunner } from '../src/runner/runner.js'
import { createFakeClient, FakeChannel } from '../testkit/index.js'

const log = { info() {}, warn() {}, error() {} }
const config: RunnerConfig = {
  channel: 'fake',
  connect: { kind: 'unix', path: '/tmp/agnes.sock' },
  tenant: 'tenant',
  agent: 'agent',
  credentialsFile: '/dev/null',
  allowFrom: [],
  requireMention: true,
  ackReaction: 'off',
  workspace: '/workspace',
  outbound: { costLine: true },
  directory: { sync: false },
  healthz: { enabled: false, port: 9877 },
}

function action(
  value: string,
  userId = 'reviewer',
  options: { cardBizId?: string; eventId?: string; chatId?: string } = {},
): CardActionEvent {
  return {
    kind: 'cardAction',
    eventId: options.eventId ?? `${userId}-${value}`,
    accountId: 'account',
    at: '2026-09-12T00:00:00.000Z',
    chat: { id: options.chatId ?? 'chat', type: 'group' },
    sender: { userId, displayName: userId, raw: { staffId: userId } },
    cardBizId: options.cardBizId ?? 'parked-card',
    value,
  }
}

function text(value: string, userId = 'reviewer'): MessageEvent {
  return {
    kind: 'message',
    eventId: `${userId}-${value}`,
    messageId: `message-${value}`,
    accountId: 'account',
    at: '2026-09-12T00:00:00.000Z',
    chat: { id: 'chat', type: 'group' },
    sender: { userId, displayName: userId, raw: { staffId: userId } },
    text: value,
    attachments: [],
    mentions: { bot: false, replyToBot: false, quoteBot: false },
  }
}

function rpcApprovalError(reason: string): JsonRpcError {
  return new JsonRpcError({
    code: -32009,
    message: 'APPROVAL_REJECTED',
    data: { code: 'APPROVAL_REJECTED', reason },
  })
}

describe('parked approval, text protocol, and slot actions', () => {
  it('submits a credential, never an Actor, after forty minutes without runner state', async () => {
    let now = 1_000
    const client = createFakeClient()
    const adapter = new FakeChannel()
    adapter.onApprovalAction = () => ({
      ticket: 'abcdef123456',
      requestSeq: 7,
      verdict: 'allowed-once',
      approverCredential: { kind: 'local' },
    })
    const credentialOf = adapter.credentialOf.bind(adapter)
    adapter.credentialOf = (event) => ({
      ...credentialOf(event),
      raw: { staffId: 'reviewer', secret: 'must-not-leave' },
    })
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log, clock: () => now })
    now += 40 * 60_000

    await expect(approval.handleAction(action('ignored'))).resolves.toBe(true)
    const call = client.calls.find((entry) => entry.method === 'approval.decide')
    expect(call?.args.slice(0, 2)).toEqual(['abcdef123456', 'allowed-once'])
    expect(call?.args[2]).toEqual(expect.objectContaining({ kind: 'channel', userId: 'reviewer' }))
    expect(call?.args[2]).not.toHaveProperty('actor')
    expect(call?.args[2]).toHaveProperty('raw', { staffId: 'reviewer' })
    expect(adapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '已提交审批' }])
  })

  it('denies a durable-grant verdict on the ticket path instead of forwarding it', async () => {
    // ApprovalAction's wire type carries the full protocol verdict set, including
    // 'allowed-permanent' for the durable-grant flow other surfaces support. Channels never
    // renders a button for it (OFFERED_OPTION_KINDS has no counterpart), so a card action
    // claiming that verdict must be treated as unauthorized, not passed through to
    // client.approval.decide.
    const client = createFakeClient()
    const adapter = new FakeChannel()
    adapter.onApprovalAction = () => ({
      ticket: 'abcdef123456',
      verdict: 'allowed-permanent',
      approverCredential: { kind: 'local' },
    })
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })

    await expect(approval.handleAction(action('ignored'))).resolves.toBe(true)
    expect(client.calls.filter((entry) => entry.method === 'approval.decide')).toHaveLength(0)
    expect(adapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '无权审批' }])
  })

  it('keeps allowFrom as a local nuisance gate without calling the server', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const approval = new Approval({ adapter, client, cfg: { allowFrom: ['reviewer'] }, log })

    await approval.handleAction(action('appr:abcdef123456:allow_once', 'outsider'))
    expect(client.calls.filter((entry) => entry.method === 'approval.decide')).toHaveLength(0)
    expect(adapter.sent.at(-1)?.msg).toMatchObject({ ephemeral: true })
  })

  it('coalesces parked callbacks and claims only a completed decision', async () => {
    const client = createFakeClient()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const decide = vi.fn(async () => {
      await gate
      return { seq: 1 }
    })
    client.approval.decide = decide
    const adapter = new FakeChannel()
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })
    const callback = action('appr:abcdef123456:allow_once')

    const first = approval.handleAction(callback)
    const repeated = approval.handleAction(callback)
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    release()
    await expect(Promise.all([first, repeated])).resolves.toEqual([true, true])
    expect(client.calls.filter((entry) => entry.method === 'claim.once')).toHaveLength(1)
    expect(adapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '已处理' }])

    const retryClient = createFakeClient()
    retryClient.approval.decide = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ seq: 2 })
    retryClient.claim.once = vi.fn(async () => true)
    const retryAdapter = new FakeChannel()
    const retry = new Approval({ adapter: retryAdapter, client: retryClient, cfg: { allowFrom: [] }, log })
    await expect(retry.handleAction(callback)).rejects.toThrow('offline')
    expect(retryClient.claim.once).not.toHaveBeenCalled()
    await expect(retry.handleAction(callback)).resolves.toBe(true)
    expect(retryClient.approval.decide).toHaveBeenCalledTimes(2)
    expect(retryClient.claim.once).toHaveBeenCalledTimes(1)

    retryClient.claim.once = vi.fn(async () => {
      throw new Error('claim unavailable')
    })
    vi.mocked(retryClient.approval.decide).mockResolvedValue({ seq: 3 })
    await expect(retry.handleAction(action('appr:second-ticket:allow_once'))).resolves.toBe(true)
    expect(retryAdapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '已提交审批' }])
  })

  it.each([
    ['self-approval', '不能自批'],
    ['ticket expired', '审批已过期'],
    ['unknown ticket', '审批无效'],
  ])('maps -32009 reason %s to stable channel copy', async (reason, expected) => {
    const client = createFakeClient()
    client.approval.decide = vi.fn(async () => {
      throw rpcApprovalError(reason)
    })
    const adapter = new FakeChannel()
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })

    await expect(approval.handleAction(action('appr:abcdef123456:reject_once'))).resolves.toBe(true)
    expect(adapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: expected }])
  })

  it('resolves a unique pending ticket prefix and leaves unmatched text as ordinary input', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const session = await client.session.attach('session')
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })

    await expect(approval.handleText('session', session, text('同意 abcdef'))).resolves.toBe(false)
    client.setTimeline('session', {
      sessionId: 'session',
      upto: 5,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [
        {
          kind: 'approval',
          id: 'approval',
          seq: 5,
          state: 'pending',
          summary: 'Export',
          risk: 'always',
          options: ['allow_once', 'reject_once'],
          ticket: 'abcdef999',
        },
      ],
    })
    await expect(approval.handleText('session', session, text('拒绝 abcdef'))).resolves.toBe(true)
    expect(client.calls.find((entry) => entry.method === 'approval.decide')?.args.slice(0, 2)).toEqual([
      'abcdef999',
      'rejected',
    ])
  })

  it('requires a full ticket when a six-character prefix is ambiguous', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const session = await client.session.attach('session')
    client.setTimeline('session', {
      sessionId: 'session',
      upto: 6,
      generation: 1,
      opState: null,
      turns: [],
      nodes: ['1', '12'].map((suffix, index) => ({
        kind: 'approval' as const,
        id: `approval-${suffix}`,
        seq: index + 1,
        state: 'pending' as const,
        summary: 'Export',
        risk: 'always' as const,
        options: ['allow_once' as const],
        ticket: `abcdef${suffix}`,
      })),
    })
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })

    await expect(approval.handleText('session', session, text('同意 abcdef'))).resolves.toBe(true)
    expect(adapter.sent.at(-1)?.msg.blocks).toEqual([
      { kind: 'text', markdown: '匹配到多条审批，请提供完整 ticket' },
    ])
    expect(client.calls.filter((entry) => entry.method === 'approval.decide')).toHaveLength(0)

    await expect(approval.handleText('session', session, text('同意 abcdef1'))).resolves.toBe(true)
    expect(client.calls.find((entry) => entry.method === 'approval.decide')?.args[0]).toBe('abcdef1')
  })

  it('coalesces concurrent slot repeats and retries after a failed submission', async () => {
    const client = createFakeClient()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const callMock = vi.fn(async () => {
      await gate
      return { seq: 1 }
    })
    const call = callMock as unknown as Client['call']
    const adapter = new FakeChannel()
    const approval = new Approval({
      adapter,
      client: Object.assign(client, { call }),
      cfg: { allowFrom: [] },
      log,
      validateSlotAction: async () => 'session',
    })

    const first = approval.handleSlotAction('session', action('slot:7:export'))
    const repeated = approval.handleSlotAction('session', action('slot:7:export'))
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledTimes(1))
    release()
    await expect(Promise.all([first, repeated])).resolves.toEqual([true, true])
    expect(adapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '已处理' }])

    callMock.mockRejectedValueOnce(new Error('offline'))
    await expect(approval.handleSlotAction('session', action('slot:8:download'))).rejects.toThrow('offline')
    callMock.mockResolvedValueOnce({ seq: 2 })
    await expect(approval.handleSlotAction('session', action('slot:8:download'))).resolves.toBe(true)
    expect(callMock).toHaveBeenCalledTimes(3)
    expect(callMock).toHaveBeenLastCalledWith('_agnes/v1/ext.ui.response', expect.any(Object), {
      timeoutMs: 10_000,
    })
  })

  it('rejects forged slot credentials, bindings, and oversized callback fields', async () => {
    const client = createFakeClient()
    const call = vi.fn(async () => ({ seq: 1 })) as unknown as Client['call']
    const adapter = new FakeChannel()
    const validateSlotAction = vi.fn(async () => 'session' as string | false)
    const approval = new Approval({
      adapter,
      client: Object.assign(client, { call }),
      cfg: { allowFrom: ['reviewer'] },
      log,
      validateSlotAction,
    })

    await approval.handleSlotAction('session', action('slot:7:export', 'outsider'))
    expect(validateSlotAction).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()

    validateSlotAction.mockResolvedValueOnce(false)
    await approval.handleSlotAction('session', action('slot:7:export'))
    expect(call).not.toHaveBeenCalled()

    await approval.handleSlotAction('session', action(`slot:7:${'x'.repeat(129)}`))
    await approval.handleAction(action(`appr:${'x'.repeat(129)}:allow_once`))
    await approval.handleAction(action(`slot:7:${'x'.repeat(600)}`))
    expect(call).not.toHaveBeenCalled()
    expect(client.calls.filter((entry) => entry.method === 'approval.decide')).toHaveLength(0)
    expect(adapter.sent.slice(-3).map(({ msg }) => msg.blocks[0])).toEqual([
      { kind: 'text', markdown: '无效操作' },
      { kind: 'text', markdown: '审批无效' },
      { kind: 'text', markdown: '无效操作' },
    ])
  })

  it('keeps pending slot work across TTL and capacity pressure, then cancels it on stop', async () => {
    let now = 0
    const abort = new AbortController()
    const never = new Promise<never>(() => undefined)
    const call = vi.fn(() => never) as unknown as Client['call']
    const client = Object.assign(createFakeClient(), { call })
    const adapter = new FakeChannel()
    const approval = new Approval({
      adapter,
      client,
      cfg: { allowFrom: [] },
      log,
      clock: () => now,
      signal: abort.signal,
      slotActionTimeoutMs: 60_000,
      validateSlotAction: async () => 'session',
    })

    const first = approval.handleSlotAction('session', action('slot:7:export'))
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    now = 10 * 60_000
    const repeated = approval.handleSlotAction('session', action('slot:7:export'))
    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(1)

    const recent = (
      approval as unknown as {
        recentSlotActions: Map<string, { at: number; pending: boolean; work: Promise<void> }>
      }
    ).recentSlotActions
    for (let index = recent.size; index < 4_096; index++) {
      recent.set(`pending-${index}`, { at: 0, pending: true, work: never })
    }
    await expect(approval.handleSlotAction('session', action('slot:8:download'))).resolves.toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(adapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '操作繁忙，请稍后重试' }])

    abort.abort()
    await expect(first).rejects.toThrow('cancelled')
    await expect(repeated).rejects.toThrow('cancelled')
  })

  it('sets an RPC deadline and releases timed-out slot actions for a later retry', async () => {
    const never = new Promise<never>(() => undefined)
    const call = vi.fn(() => never) as unknown as Client['call']
    const adapter = new FakeChannel()
    const approval = new Approval({
      adapter,
      client: Object.assign(createFakeClient(), { call }),
      cfg: { allowFrom: [] },
      log,
      slotActionTimeoutMs: 5,
      validateSlotAction: async () => 'session',
    })

    await expect(approval.handleSlotAction('session', action('slot:7:export'))).rejects.toThrow('timed out')
    await expect(approval.handleSlotAction('session', action('slot:7:export'))).rejects.toThrow('timed out')
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenLastCalledWith('_agnes/v1/ext.ui.response', expect.any(Object), {
      timeoutMs: 5,
    })
  })

  it('wires unmentioned text approval and slot actions through the runner', async () => {
    const client = createFakeClient()
    const call = vi.fn(async () => ({ seq: 1 })) as unknown as Client['call']
    const clientWithCall = Object.assign(client, { call })
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client: clientWithCall, log })
    try {
      await runner.start()
      const session = await client.session.attach('agnes:tenant:agent:fake:group:chat')
      adapter.emit({
        ...text('hello'),
        eventId: 'setup-event',
        messageId: 'setup-message',
        mentions: { bot: true, replyToBot: false, quoteBot: false },
      })
      await vi.waitFor(() =>
        expect(client.calls.filter((entry) => entry.method === 'followUp')).toHaveLength(1),
      )
      client.setTimeline(session.id, {
        sessionId: session.id,
        upto: 2,
        generation: 1,
        opState: null,
        turns: [],
        nodes: [
          {
            kind: 'slot',
            id: 'export-slot',
            seq: 2,
            fill: {
              slot: 'tool.card.inline',
              extId: 'reports',
              requestSeq: 7,
              payload: { title: 'Export', actions: [{ id: 'export', label: 'Export' }] },
            },
          },
        ],
      })
      client.emit('gap', { sessionId: session.id })
      await vi.waitFor(() => expect(adapter.sent.some(({ msg }) => msg.ephemeral !== true)).toBe(true))
      const slotRef = adapter.sent.find(({ msg }) =>
        msg.blocks.some((block) => block.kind === 'card' && block.requestSeq === 7),
      )?.ref
      expect(slotRef).toBeDefined()
      if (slotRef === undefined) throw new Error('slot card was not delivered')
      client.setTimeline(session.id, {
        sessionId: session.id,
        upto: 2,
        generation: 1,
        opState: null,
        turns: [],
        nodes: [
          {
            kind: 'approval',
            id: 'approval',
            seq: 1,
            state: 'pending',
            summary: 'Export',
            risk: 'always',
            options: ['allow_once'],
            ticket: 'abcdef-ticket',
          },
          {
            kind: 'slot',
            id: 'export-slot',
            seq: 2,
            fill: {
              slot: 'tool.card.inline',
              extId: 'reports',
              requestSeq: 7,
              payload: { title: 'Export', actions: [{ id: 'export', label: 'Export' }] },
            },
          },
        ],
      })

      adapter.emit(text('同意 abcdef'))
      await vi.waitFor(() =>
        expect(client.calls.some((entry) => entry.method === 'approval.decide')).toBe(true),
      )
      adapter.emit(action('slot:7:export'))
      await vi.waitFor(() =>
        expect(adapter.sent.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '无效操作' }]),
      )
      adapter.emit(
        action('slot:7:export', 'reviewer', {
          cardBizId: slotRef.messageId,
          chatId: 'other-chat',
        }),
      )
      await vi.waitFor(() =>
        expect(
          adapter.sent.filter(
            ({ msg }) => msg.blocks[0]?.kind === 'text' && msg.blocks[0].markdown === '无效操作',
          ),
        ).toHaveLength(2),
      )
      adapter.emit(
        action('slot:7:delete', 'reviewer', {
          cardBizId: slotRef.messageId,
        }),
      )
      adapter.emit(
        action('slot:8:export', 'reviewer', {
          cardBizId: slotRef.messageId,
        }),
      )
      await vi.waitFor(() =>
        expect(
          adapter.sent.filter(
            ({ msg }) => msg.blocks[0]?.kind === 'text' && msg.blocks[0].markdown === '无效操作',
          ),
        ).toHaveLength(4),
      )
      expect(call).not.toHaveBeenCalled()
      adapter.emit(action('slot:7:export', 'reviewer', { cardBizId: slotRef.messageId }))
      await vi.waitFor(() =>
        expect(call).toHaveBeenCalledWith(
          '_agnes/v1/ext.ui.response',
          {
            sessionId: session.id,
            requestSeq: 7,
            action: 'accept',
            data: { id: 'export' },
          },
          { timeoutMs: 10_000 },
        ),
      )
      expect(client.calls.filter((entry) => entry.method === 'followUp')).toHaveLength(1)
    } finally {
      await runner.stop()
    }
  })
})
