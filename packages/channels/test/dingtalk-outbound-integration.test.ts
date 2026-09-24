import { fileURLToPath } from 'node:url'
import type { EventEnvelope, HarnessMeta } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { FakeDingtalkGateway } from '../src/adapters/dingtalk/gateway-fake.js'
import { createDingtalkAdapter } from '../src/adapters/dingtalk/index.js'
import type { RunnerConfig } from '../src/runner/config.js'
import { createRunner } from '../src/runner/runner.js'
import { createFakeClient } from '../testkit/index.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))
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

const meta: HarnessMeta = {
  promptTurnId: 'turn-1',
  eventSequence: 2,
  generation: 1,
  lane: 'main',
  phase: 'event',
}

function event(seq: number): EventEnvelope & { _meta: HarnessMeta } {
  return {
    seq,
    ts: '2026-09-12T00:00:00.000Z',
    id: `event-${seq}`,
    type: 'assistant/message',
    data: {},
    actor: { id: 'assistant', org: 'local', role: 'agent', deptPath: [], attrs: {} },
    origin: 'model',
    trust: 'untrusted',
    _meta: { ...meta, eventSequence: seq },
  } as EventEnvelope & { _meta: HarnessMeta }
}

describe('DingTalk runner outbound integration', () => {
  it('catches up through the real Outbound after reconnect and does not resend on gap recovery', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    let starts = 0
    let releaseReconnect!: () => void
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve
    })
    gateway.start = vi.fn(async (handlers, signal) => {
      starts++
      if (starts === 2) await reconnectGate
      return originalStart(handlers, signal)
    })
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
      rate: { perChatPerMin: 6_000 },
    })
    const client = createFakeClient()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: { clientId: 'app-key', clientSecret: 'app-secret' },
      client,
      log: { info() {}, warn() {}, error() {} },
    })
    const key = 'agnes:tenant:agent:dingtalk:group:conversation-1'
    await runner.start()
    gateway.emitMessage({
      msgId: 'message-1',
      conversationId: 'conversation-1',
      conversationType: '2',
      senderStaffId: 'staff-1',
      msgtype: 'text',
      text: { content: '@bot hello' },
      isInAtList: true,
      createAt: 1_700_000_000_000,
      robotCode: 'robot-1',
    })
    await vi.waitFor(() => expect(client.calls.some((call) => call.method === 'followUp')).toBe(true))

    gateway.emitDisconnect(new Error('offline'))
    await vi.waitFor(() => expect(starts).toBe(2))
    client.setTimeline(key, {
      sessionId: key,
      upto: 2,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [{ kind: 'assistant', id: 'assistant-1', seq: 2, text: 'done' }],
    })
    client.pushEvent(key, event(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(gateway.sent).toHaveLength(0)

    releaseReconnect()
    await vi.waitFor(() => expect(gateway.sent).toHaveLength(1))
    expect(gateway.sent[0]).toMatchObject({ kind: 'card', target: { conversationId: 'conversation-1' } })

    const projections = client.calls.filter((call) => call.method === 'projectUI').length
    client.emit('gap', { sessionId: key, earliestSeq: 1 })
    await vi.waitFor(() =>
      expect(client.calls.filter((call) => call.method === 'projectUI').length).toBeGreaterThan(projections),
    )
    expect(gateway.sent).toHaveLength(1)
    await runner.stop()
  })
})
