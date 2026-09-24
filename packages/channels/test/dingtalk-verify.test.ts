import { describe, expect, it } from 'vitest'
import { parseVerifyArgs, verifyCard, verifyInbound, verifyReconnect } from '../scripts/dingtalk-verify.js'
import { FakeDingtalkGateway } from '../src/adapters/dingtalk/gateway-fake.js'

describe('dingtalk live verification helpers', () => {
  it('parses bounded, explicit arguments', () => {
    expect(parseVerifyArgs(['--config', 'c.yaml', '--chat', 'cid1', '--simulate-disconnect'])).toEqual({
      config: 'c.yaml',
      chat: 'cid1',
      simulateDisconnect: true,
      timeoutMs: 120_000,
    })
    expect(() => parseVerifyArgs(['--config', 'c.yaml', '--timeout', '0'])).toThrow('--timeout')
    expect(() => parseVerifyArgs(['--config', 'c.yaml', '--unknown'])).toThrow('unknown')
  })

  it('passes inbound only after a group mention and cleans up on timeout', async () => {
    const gateway = new FakeDingtalkGateway()
    const pending = verifyInbound(gateway, 500)
    await new Promise((resolve) => setTimeout(resolve, 5))
    gateway.emitMessage({
      msgId: 'm',
      conversationId: 'c',
      conversationType: '2',
      senderStaffId: 'u',
      msgtype: 'text',
      text: { content: '@bot hi' },
      isInAtList: true,
      createAt: 1,
    })
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(gateway.started).toBe(false)

    const timedOut = new FakeDingtalkGateway()
    await expect(verifyInbound(timedOut, 10)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('timeout'),
    })
    expect(timedOut.started).toBe(false)
  })

  it('passes a card only for the matching callback', async () => {
    const gateway = new FakeDingtalkGateway()
    const pending = verifyCard(gateway, { conversationId: 'c', conversationType: '2' }, 500)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const sent = gateway.sent.find((entry) => entry.kind === 'card')
    gateway.emitCard({
      outTrackId: 'other',
      userId: 'attacker',
      cardPrivateData: { actionIds: ['verify:ok'], params: {} },
    })
    gateway.emitCard({
      outTrackId: sent?.kind === 'card' ? sent.outTrackId : '',
      userId: 'u',
      cardPrivateData: { actionIds: ['verify:ok'], params: {} },
    })
    await expect(pending).resolves.toEqual({ ok: true, detail: 'userId=u' })
    expect(gateway.started).toBe(false)
  })

  it('passes a simulated disconnect only after a successful restart', async () => {
    const gateway = new FakeDingtalkGateway()
    await expect(verifyReconnect(gateway, { simulate: true, waitMs: 1 })).resolves.toMatchObject({
      ok: true,
    })
    expect(gateway.started).toBe(false)
  })
})
