import { JsonRpcError } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { parseCommand, runCommand } from '../src/runner/commands.js'
import { createFakeClient } from '../testkit/index.js'

describe('parseCommand', () => {
  it('recognises exactly the five channel commands', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: [] })
    expect(parseCommand(' /preset   code  ')).toEqual({ name: 'preset', args: ['code'] })
    expect(parseCommand('/deploy now')).toBeNull()
    expect(parseCommand('/STATUS')).toBeNull()
    expect(parseCommand('hello /help')).toBeNull()
  })
})

describe('runCommand', () => {
  it('status asks the SDK session for projected state and budget', async () => {
    const client = createFakeClient()
    const session = await client.session.attach('k')
    client.setTimeline('k', {
      sessionId: 'k',
      upto: 9,
      generation: 1,
      opState: { turn: 2, step: 4, phase: 'tools' },
      turns: [],
      nodes: [],
    })
    session.budget = vi.fn(async () => ({
      state: null,
      ledger: [
        { seq: 1, credits: 1.25, creditSource: 'gateway' as const },
        { seq: 2, creditSource: 'estimated' as const },
      ],
    }))

    const result = await runCommand({ name: 'status', args: [] }, { session, newSession: async () => {} })

    expect(result).toContain('第 2 轮第 4 步')
    expect(result).toContain('credits 1.25')
    expect(client.calls).toContainEqual({
      method: 'projectUI',
      args: [undefined, { surface: 'channel' }],
    })
    expect(session.budget).toHaveBeenCalledOnce()
  })

  it('status reports a parked ticket without exposing the whole ticket', async () => {
    const client = createFakeClient()
    const session = await client.session.attach('k')
    client.setTimeline('k', {
      sessionId: 'k',
      upto: 9,
      generation: 1,
      opState: {
        turn: 2,
        step: 4,
        phase: 'parked',
        parked: { ticket: 'abcdef123', expiresAt: 'T' },
      },
      turns: [],
      nodes: [],
    })

    const result = await runCommand({ name: 'status', args: [] }, { session, newSession: async () => {} })

    expect(result).toContain('等待审批 abcdef')
    expect(result).not.toContain('abcdef123')
  })

  it('dispatches cancel, new, help, and preset to their real ports', async () => {
    const client = createFakeClient()
    const session = await client.session.attach('k')
    const newSession = vi.fn(async () => {})
    const context = { session, newSession }

    expect(await runCommand({ name: 'cancel', args: [] }, context)).toBe('已取消当前任务')
    expect(await runCommand({ name: 'new', args: [] }, context)).toBe('已开始新会话')
    expect(await runCommand({ name: 'help', args: [] }, context)).toContain('/status')
    expect(await runCommand({ name: 'preset', args: ['code'] }, context)).toBe('已切换到 code')

    expect(newSession).toHaveBeenCalledOnce()
    expect(client.calls.map((call) => call.method)).toContain('cancel')
    expect(client.calls).toContainEqual({ method: 'setPreset', args: ['code'] })
  })

  it('echoes only the structured preset rejection reason', async () => {
    const client = createFakeClient()
    const session = await client.session.attach('k')
    session.setPreset = async () => {
      throw new JsonRpcError({
        code: -32008,
        message: 'PRESET_SWITCH_REJECTED',
        data: { code: 'PRESET_SWITCH_REJECTED', reason: 'minimal-rl is frozen' },
      })
    }

    const context = { session, newSession: async () => {} }
    expect(await runCommand({ name: 'preset', args: ['minimal-rl'] }, context)).toBe(
      '无法切换：minimal-rl is frozen',
    )
    expect(await runCommand({ name: 'preset', args: [] }, context)).toBe('用法：/preset <名字>')
  })
})
