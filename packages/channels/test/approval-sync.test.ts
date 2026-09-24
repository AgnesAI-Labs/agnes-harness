import type { Client, PermissionOutcome, PermissionRequest } from '@agnes/sdk'
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

function approvalAction(
  value: string,
  userId = 'approver',
  chatId = 'chat',
  cardBizId = 'm1',
): CardActionEvent {
  return {
    kind: 'cardAction',
    eventId: `action-${userId}-${value}`,
    accountId: 'account',
    at: '2026-09-12T00:00:00.000Z',
    cardBizId,
    value,
    chat: { id: chatId, type: 'group' },
    sender: { userId, displayName: userId, raw: {} },
  }
}

function message(userId = 'requester'): MessageEvent {
  return {
    kind: 'message',
    eventId: `event-${userId}`,
    messageId: `message-${userId}`,
    accountId: 'account',
    at: '2026-09-12T00:00:00.000Z',
    text: '@bot run it',
    attachments: [],
    chat: { id: 'chat', type: 'group' },
    sender: { userId, displayName: userId, raw: { staffId: userId } },
    mentions: { bot: true, replyToBot: false, quoteBot: false },
  }
}

function request(deadlineMs = Date.now() + 10_000): PermissionRequest {
  return {
    sessionId: 'session',
    toolCall: { name: 'shell', args: { command: 'echo safe' } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    deadlineMs,
  }
}

async function pendingApproval(allowFrom: string[] = []) {
  const client = createFakeClient()
  const adapter = new FakeChannel()
  const session = await client.session.attach('session')
  const approval = new Approval({ adapter, client, cfg: { allowFrom }, log })
  const dispose = approval.watch('session', session, { chatId: 'chat' }, () => 'requester')
  const controller = new AbortController()
  if (!session.permissionHandler) throw new Error('permission handler was not installed')
  const outcome = session.permissionHandler(request(), { signal: controller.signal })
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))
  return { adapter, approval, controller, dispose, outcome }
}

describe('synchronous channel approval', () => {
  it('renders the ACP choices and resolves an offered approval', async () => {
    const state = await pendingApproval()
    expect(state.adapter.sent[0]?.msg.blocks).toEqual([
      expect.objectContaining({
        kind: 'approval',
        requestSeq: 1,
        options: ['allow_once', 'reject_once'],
      }),
    ])

    await expect(state.approval.handleAction(approvalAction('appr:#1:allow_once'))).resolves.toBe(true)
    await expect(state.outcome).resolves.toEqual({ verdict: 'allowed-once' })
    expect(state.adapter.updates[0]?.msg.blocks).toEqual([{ kind: 'text', markdown: '已批准 by approver' }])
    state.dispose()
  })

  it('rejects self approval, unauthorized approvers, unoffered verdicts, and copied actions', async () => {
    const cases = [
      { allowFrom: [] as string[], event: approvalAction('appr:#1:allow_once', 'requester') },
      { allowFrom: ['reviewer'], event: approvalAction('appr:#1:allow_once', 'outsider') },
      { allowFrom: [] as string[], event: approvalAction('appr:#1:allow_always') },
      { allowFrom: [] as string[], event: approvalAction('appr:#1:allow_once', 'approver', 'other') },
      {
        allowFrom: [] as string[],
        event: approvalAction('appr:#1:allow_once', 'approver', 'chat', 'old-card'),
      },
    ]

    for (const testCase of cases) {
      const state = await pendingApproval(testCase.allowFrom)
      await expect(state.approval.handleAction(testCase.event)).resolves.toBe(true)
      expect(state.adapter.updates).toHaveLength(0)
      expect(state.adapter.sent.at(-1)?.msg.ephemeral).toBe(true)
      state.dispose()
      await expect(state.outcome).resolves.toEqual({ verdict: 'rejected' })
    }
  })

  it('uses an absolute deadline and rejects aborts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const client = createFakeClient()
      const adapter = new FakeChannel()
      const session = await client.session.attach('session')
      const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })
      approval.watch('session', session, { chatId: 'chat' }, () => 'requester')
      if (!session.permissionHandler) throw new Error('permission handler was not installed')

      const timed = session.permissionHandler(request(1_010), { signal: new AbortController().signal })
      await vi.advanceTimersByTimeAsync(10)
      await expect(timed).resolves.toEqual({ verdict: 'rejected' })
      expect(adapter.updates.at(-1)?.msg.blocks).toEqual([{ kind: 'text', markdown: '审批已超时' }])

      const controller = new AbortController()
      const aborted = session.permissionHandler(request(11_000), { signal: controller.signal })
      await Promise.resolve()
      controller.abort()
      await expect(aborted).resolves.toEqual({ verdict: 'rejected' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not lose a click racing the card send acknowledgement', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const originalSend = adapter.send.bind(adapter)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    adapter.send = vi.fn(async (target, content) => {
      if (content.ephemeral === true) return originalSend(target, content)
      await gate
      return originalSend(target, content)
    })
    const session = await client.session.attach('session')
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })
    approval.watch('session', session, { chatId: 'chat' }, () => 'requester')
    if (!session.permissionHandler) throw new Error('permission handler was not installed')

    const outcome = session.permissionHandler(request(), { signal: new AbortController().signal })
    const clicked = approval.handleAction(approvalAction('appr:#1:allow_once'))
    let outcomeSettled = false
    let clickSettled = false
    void outcome.then(
      () => {
        outcomeSettled = true
      },
      () => {
        outcomeSettled = true
      },
    )
    void clicked.then(
      () => {
        clickSettled = true
      },
      () => {
        clickSettled = true
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect({ clickSettled, outcomeSettled }).toEqual({ clickSettled: false, outcomeSettled: false })
    release()
    await expect(clicked).resolves.toBe(true)
    await expect(outcome).resolves.toEqual({ verdict: 'allowed-once' })
    expect(adapter.updates).toHaveLength(1)
  })

  it('cannot approve when the card send fails', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    let rejectSend!: (error: Error) => void
    adapter.send = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectSend = reject
        }),
    )
    const session = await client.session.attach('session')
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })
    approval.watch('session', session, { chatId: 'chat' }, () => 'requester')
    if (!session.permissionHandler) throw new Error('permission handler was not installed')

    const outcome = session.permissionHandler(request(), { signal: new AbortController().signal })
    const clicked = approval.handleAction(approvalAction('appr:#1:allow_once'))
    await Promise.resolve()
    rejectSend(new Error('send failed'))
    await expect(clicked).resolves.toBe(true)
    await expect(outcome).resolves.toEqual({ verdict: 'rejected' })
    expect(adapter.updates).toHaveLength(0)
  })

  it('cannot approve when abort wins before the card send settles', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const originalSend = adapter.send.bind(adapter)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    adapter.send = vi.fn(async (target, content) => {
      await gate
      return originalSend(target, content)
    })
    const session = await client.session.attach('session')
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })
    approval.watch('session', session, { chatId: 'chat' }, () => 'requester')
    if (!session.permissionHandler) throw new Error('permission handler was not installed')
    const controller = new AbortController()

    const outcome = session.permissionHandler(request(), { signal: controller.signal })
    const clicked = approval.handleAction(approvalAction('appr:#1:allow_once'))
    controller.abort()
    await expect(outcome).resolves.toEqual({ verdict: 'rejected' })
    release()
    await expect(clicked).resolves.toBe(true)
    expect(adapter.updates).toHaveLength(0)
  })

  it('cannot approve when the absolute deadline wins before the card send settles', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const originalSend = adapter.send.bind(adapter)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    adapter.send = vi.fn(async (target, content) => {
      await gate
      return originalSend(target, content)
    })
    const session = await client.session.attach('session')
    const approval = new Approval({ adapter, client, cfg: { allowFrom: [] }, log })
    approval.watch('session', session, { chatId: 'chat' }, () => 'requester')
    if (!session.permissionHandler) throw new Error('permission handler was not installed')

    const outcome = session.permissionHandler(request(Date.now() - 1), {
      signal: new AbortController().signal,
    })
    const clicked = approval.handleAction(approvalAction('appr:#1:allow_once'))
    await expect(outcome).resolves.toEqual({ verdict: 'rejected' })
    release()
    await expect(clicked).resolves.toBe(true)
    expect(adapter.updates).toHaveLength(1)
    expect(adapter.updates[0]?.msg.blocks).toEqual([{ kind: 'text', markdown: '审批已超时' }])
  })

  it('round-trips through the runner in under ten seconds and sends only channel credentials server-side', async () => {
    const client = createFakeClient({
      apis: {
        families: [
          {
            name: 'session',
            methods: ['_agnes/v1/session.attach', '_agnes/v1/participant.join'],
            guidance: '',
          },
        ],
      },
    })
    const call = vi.fn(async () => ({ seq: 1 })) as unknown as Client['call']
    const clientWithCall = Object.assign(client, { call })
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client: clientWithCall, log })
    const startedAt = Date.now()
    try {
      await runner.start()
      adapter.emit(message())
      await vi.waitFor(() => {
        expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
      })
      expect(call).toHaveBeenCalledWith('_agnes/v1/participant.join', {
        sessionId: 'agnes:tenant:agent:fake:group:chat',
        credential: expect.objectContaining({ kind: 'channel', userId: 'requester' }),
      })
      expect(vi.mocked(call).mock.calls[0]?.[1]).not.toHaveProperty('actor')

      const key = 'agnes:tenant:agent:fake:group:chat'
      const session = await client.session.attach(key)
      if (!session.permissionHandler) throw new Error('runner did not install a permission handler')
      const outcome: Promise<PermissionOutcome> = session.permissionHandler(request(), {
        signal: new AbortController().signal,
      })
      await vi.waitFor(() =>
        expect(
          adapter.sent.some((entry) => entry.msg.blocks.some((block) => block.kind === 'approval')),
        ).toBe(true),
      )
      adapter.emit(approvalAction('appr:#1:allow_once'))
      await expect(outcome).resolves.toEqual({ verdict: 'allowed-once' })
      expect(Date.now() - startedAt).toBeLessThan(10_000)
    } finally {
      await runner.stop()
    }
  })
})
