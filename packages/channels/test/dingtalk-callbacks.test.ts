import { fileURLToPath } from 'node:url'
import type { Client, PermissionOutcome, PermissionRequest } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { CardActionEvent, ChannelEvent } from '../src/adapter.js'
import type { DingtalkHandlers, RawCardCallback } from '../src/adapters/dingtalk/gateway.js'
import { FakeDingtalkGateway } from '../src/adapters/dingtalk/gateway-fake.js'
import { createDingtalkAdapter } from '../src/adapters/dingtalk/index.js'
import type { RunnerConfig } from '../src/runner/config.js'
import { createRunner } from '../src/runner/runner.js'
import { createFakeClient } from '../testkit/index.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))
const log = { info() {}, warn() {}, error() {} }
const config: RunnerConfig = {
  channel: 'dingtalk',
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

function callback(overrides: Partial<RawCardCallback> = {}): RawCardCallback {
  return {
    outTrackId: 'card-1',
    userId: 'staff-2',
    cardPrivateData: {
      actionIds: ['appr:ticket-1:allow_once'],
      params: { untrustedSecret: 'must-not-become-a-credential' },
    },
    conversationId: 'chat-1',
    conversationType: '2',
    ...overrides,
  }
}

function permissionRequest(): PermissionRequest {
  return {
    sessionId: 'unused-by-channel-runner',
    toolCall: { name: 'shell', args: { command: 'echo safe' } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    deadlineMs: Date.now() + 10_000,
  }
}

function cardActionValue(item: { kind: string; payload?: Record<string, unknown> }): string[] {
  if (item.kind !== 'card') return []
  const params = item.payload?.cardParamMap
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return []
  const buttons = (params as Record<string, unknown>).buttons
  if (typeof buttons !== 'string') return []
  return (JSON.parse(buttons) as Array<{ value: string }>).map(({ value }) => value)
}

async function setup() {
  const gateway = new FakeDingtalkGateway()
  const adapter = await createDingtalkAdapter(manifestPath, { gateway })
  const events: ChannelEvent[] = []
  await adapter.connect({
    credentials: { clientId: 'key', clientSecret: 'secret', robotCode: 'robot-9' },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    log,
  })
  return { gateway, adapter, events }
}

describe('dingtalk card callbacks', () => {
  it('maps sent-card callbacks to bounded actions with whitelisted credentials', async () => {
    const { gateway, adapter, events } = await setup()
    const ref = await adapter.send(
      { chatId: 'chat-1' },
      {
        blocks: [
          {
            kind: 'approval',
            title: 'Approval',
            summary: 'Export',
            risk: 'always',
            options: ['allow_once', 'reject_once'],
            ticket: 'ticket-1',
          },
        ],
      },
    )
    if (ref.cardBizId === undefined) throw new Error('DingTalk card id missing')

    const rememberedCallback = callback({ outTrackId: ref.cardBizId })
    delete rememberedCallback.conversationId
    delete rememberedCallback.conversationType
    gateway.emitCard(rememberedCallback)
    expect(events).toHaveLength(1)
    const approvalEvent = events[0] as CardActionEvent
    expect(approvalEvent).toMatchObject({
      kind: 'cardAction',
      accountId: 'robot-9',
      cardBizId: ref.cardBizId,
      value: 'appr:ticket-1:allow_once',
      sender: { userId: 'staff-2' },
      chat: { id: 'chat-1', type: 'group' },
    })
    expect(adapter.onApprovalAction(approvalEvent)).toMatchObject({
      ticket: 'ticket-1',
      verdict: 'allowed-once',
      approverCredential: {
        kind: 'channel',
        accountId: 'robot-9',
        userId: 'staff-2',
        chatId: 'chat-1',
        raw: { staffId: 'staff-2', conversationId: 'chat-1', conversationType: '2' },
      },
    })
    expect(JSON.stringify(adapter.onApprovalAction(approvalEvent))).not.toContain('untrustedSecret')

    gateway.emitCard(
      callback({
        outTrackId: ref.cardBizId,
        cardPrivateData: { actionIds: ['slot:3:export:csv'], params: {} },
      }),
    )
    expect(adapter.onSlotAction?.(events[1] as CardActionEvent)).toMatchObject({
      requestSeq: 3,
      actionId: 'export:csv',
      credential: { kind: 'channel', userId: 'staff-2' },
    })
  })

  it('derives a stable replay id and rejects malformed, ambiguous, oversized, and cross-card claims callbacks', async () => {
    const { gateway, adapter, events } = await setup()
    const ref = await adapter.send(
      { chatId: 'chat-1' },
      { blocks: [{ kind: 'card', title: 'Export', body: '', actions: [{ id: 'export', label: 'Go' }] }] },
    )
    const known = ref.cardBizId as string
    const same = callback({ outTrackId: known })
    gateway.emitCard(same)
    gateway.emitCard({
      ...same,
      cardPrivateData: { ...same.cardPrivateData, params: { changed: 'ignored' } },
    })
    expect(events).toHaveLength(2)
    expect(events[0]?.eventId).toMatch(/^dingtalk-card:[0-9a-f]{64}$/)
    expect(events[1]?.eventId).toBe(events[0]?.eventId)
    events.length = 0

    const invalid: unknown[] = [
      callback({ outTrackId: '' }),
      callback({ userId: ' ' }),
      callback({ outTrackId: known, cardPrivateData: { actionIds: [], params: {} } }),
      callback({
        outTrackId: known,
        cardPrivateData: { actionIds: ['slot:3:export', 'slot:3:delete'], params: {} },
      }),
      callback({
        outTrackId: known,
        cardPrivateData: { actionIds: ['x'.repeat(513)], params: {} },
      }),
      callback({ outTrackId: known, conversationId: 'other-chat' }),
      callback({ outTrackId: known, conversationType: '1' }),
      { ...callback({ outTrackId: known }), cardPrivateData: { actionIds: [7], params: {} } },
      { ...callback({ outTrackId: known }), conversationType: '3' },
    ]
    for (const item of invalid) gateway.emitCard(item as RawCardCallback)
    expect(events).toHaveLength(0)

    const base = { ...same, kind: 'cardAction' as const, eventId: 'event', accountId: 'robot-9', at: '' }
    const action = {
      kind: base.kind,
      eventId: base.eventId,
      accountId: base.accountId,
      at: base.at,
      chat: { id: 'chat-1', type: 'group' as const },
      sender: { userId: 'staff-2', raw: { staffId: 'staff-2' } },
      cardBizId: known,
      value: '',
    }
    for (const value of [
      'appr::allow_once',
      'appr:#0:allow_once',
      'appr:#9007199254740992:allow_once',
      `appr:${'t'.repeat(129)}:allow_once`,
    ])
      expect(adapter.onApprovalAction({ ...action, value })).toBeNull()
    for (const value of [
      'slot:0:export',
      'slot:9007199254740992:export',
      'slot:7:',
      `slot:7:${'x'.repeat(129)}`,
    ])
      expect(adapter.onSlotAction?.({ ...action, value })).toBeNull()
  })

  it('drops callbacks retained by an old connection epoch', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    const handlers: DingtalkHandlers[] = []
    gateway.start = vi.fn(async (next, signal) => {
      handlers.push(next)
      return originalStart(next, signal)
    })
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      backoff: { baseMs: 1, maxMs: 1 },
    })
    const events: ChannelEvent[] = []
    await adapter.connect({
      credentials: { clientId: 'key', clientSecret: 'secret' },
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      log,
    })
    gateway.emitDisconnect(new Error('offline'))
    await vi.waitFor(() => expect(handlers).toHaveLength(2))

    handlers[0]?.onCard(callback())
    expect(events).toHaveLength(0)
    handlers[1]?.onCard(callback())
    expect(events).toHaveLength(1)
  })

  it('flows real gateway callbacks through synchronous, parked, and slot runner paths and stops intake', async () => {
    const gateway = new FakeDingtalkGateway()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      rate: { perChatPerMin: 60_000, perAccountPerSec: 1_000 },
    })
    const client = createFakeClient()
    const call = vi.fn(async () => ({ seq: 1 })) as unknown as Client['call']
    const decide = vi.spyOn(client.approval, 'decide')
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: { clientId: 'key', clientSecret: 'secret', robotCode: 'robot-9' },
      client: Object.assign(client, { call }),
      log,
    })
    const sessionKey = 'agnes:tenant:agent:dingtalk:group:chat-1'
    try {
      await runner.start()
      gateway.emitMessage({
        msgId: 'message-1',
        conversationId: 'chat-1',
        conversationType: '2',
        senderStaffId: 'requester',
        msgtype: 'text',
        text: { content: '@bot run it' },
        isInAtList: true,
        createAt: Date.now(),
        robotCode: 'robot-9',
      })
      await vi.waitFor(() => expect(client.calls.some(({ method }) => method === 'followUp')).toBe(true))

      const session = await client.session.attach(sessionKey)
      if (session.permissionHandler === undefined) throw new Error('runner did not install approval watcher')
      const outcome: Promise<PermissionOutcome> = session.permissionHandler(permissionRequest(), {
        signal: new AbortController().signal,
      })
      await vi.waitFor(() =>
        expect(gateway.sent.some((item) => cardActionValue(item).includes('appr:#1:allow_once'))).toBe(true),
      )
      const syncCard = gateway.sent.find((item) => cardActionValue(item).includes('appr:#1:allow_once'))
      if (syncCard?.kind !== 'card') throw new Error('sync approval card missing')
      gateway.emitCard(
        callback({
          outTrackId: syncCard.outTrackId,
          userId: 'reviewer',
          cardPrivateData: { actionIds: ['appr:#1:allow_once'], params: {} },
        }),
      )
      await expect(outcome).resolves.toEqual({ verdict: 'allowed-once' })

      const parkedRef = await adapter.send(
        { chatId: 'chat-1' },
        {
          blocks: [
            {
              kind: 'approval',
              title: 'Parked',
              summary: 'Export',
              risk: 'always',
              options: ['allow_once'],
              ticket: 'parked-ticket-1',
            },
          ],
        },
      )
      if (parkedRef.cardBizId === undefined) throw new Error('parked approval card missing')
      const parked = callback({
        outTrackId: parkedRef.cardBizId,
        userId: 'reviewer',
        cardPrivateData: {
          actionIds: ['appr:parked-ticket-1:allow_once'],
          params: { secret: 'drop-me' },
        },
      })
      gateway.emitCard(parked)
      gateway.emitCard(parked)
      await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
      expect(decide).toHaveBeenCalledWith(
        'parked-ticket-1',
        'allowed-once',
        expect.objectContaining({
          kind: 'channel',
          accountId: 'robot-9',
          userId: 'reviewer',
          chatId: 'chat-1',
        }),
      )
      expect(JSON.stringify(decide.mock.calls[0]?.[2])).not.toContain('drop-me')

      client.setTimeline(sessionKey, {
        sessionId: sessionKey,
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
      client.emit('gap', { sessionId: sessionKey })
      await vi.waitFor(() =>
        expect(gateway.sent.some((item) => cardActionValue(item).includes('slot:7:export'))).toBe(true),
      )
      const slotCard = gateway.sent.find((item) => cardActionValue(item).includes('slot:7:export'))
      if (slotCard?.kind !== 'card') throw new Error('slot card missing')
      const slot = callback({
        outTrackId: slotCard.outTrackId,
        userId: 'reviewer',
        cardPrivateData: { actionIds: ['slot:7:export'], params: {} },
      })
      gateway.emitCard(slot)
      gateway.emitCard(slot)
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(call).toHaveBeenCalledWith(
        '_agnes/v1/ext.ui.response',
        { sessionId: sessionKey, requestSeq: 7, action: 'accept', data: { id: 'export' } },
        { timeoutMs: 10_000 },
      )

      runner.stopIntake()
      gateway.emitCard(
        callback({
          outTrackId: parkedRef.cardBizId,
          userId: 'reviewer',
          cardPrivateData: { actionIds: ['appr:parked-ticket-2:allow_once'], params: {} },
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(decide).toHaveBeenCalledTimes(1)
    } finally {
      await runner.stop()
    }
  })
})
