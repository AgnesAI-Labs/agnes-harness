import type { ChannelCredential as ProtocolChannelCredential } from '@agnes/protocol'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type ChannelCredential, sessionKeyFor, whitelistCredential } from '../src/adapter.js'

const credential: ChannelCredential = {
  kind: 'channel',
  channel: 'dingtalk',
  accountId: 'acc',
  userId: 'u1',
  unionId: 'union-1',
  chatId: 'c1',
  chatType: 'group',
  displayName: 'Li',
  raw: { staffId: 'u1', senderNick: 'Li', phone: '138', dept: 'sales' },
}

describe('ChannelCredential', () => {
  it('reuses the protocol credential shape', () => {
    expectTypeOf<ChannelCredential>().toEqualTypeOf<ProtocolChannelCredential>()
  })
})

describe('sessionKeyFor', () => {
  it('builds dm, group and thread routing keys', () => {
    expect(
      sessionKeyFor({
        tenant: 'xinwei',
        agent: 'sales',
        channel: 'dingtalk',
        chat: { id: 'c1', type: 'dm' },
      }),
    ).toBe('agnes:xinwei:sales:dingtalk:dm:c1')
    expect(
      sessionKeyFor({
        tenant: 'xinwei',
        agent: 'sales',
        channel: 'dingtalk',
        chat: { id: 'c1', type: 'group' },
      }),
    ).toBe('agnes:xinwei:sales:dingtalk:group:c1')
    expect(
      sessionKeyFor({
        tenant: 'xinwei',
        agent: 'sales',
        channel: 'dingtalk',
        chat: { id: 'c1', type: 'thread', threadId: 't9' },
      }),
    ).toBe('agnes:xinwei:sales:dingtalk:group:c1:thread:t9')
  })

  it.each([
    ['tenant', { tenant: 'a:b', agent: 's', channel: 'dingtalk', chat: { id: 'c', type: 'dm' as const } }],
    ['agent', { tenant: 'a', agent: '', channel: 'dingtalk', chat: { id: 'c', type: 'dm' as const } }],
    ['channel', { tenant: 'a', agent: 's', channel: 'ding:talk', chat: { id: 'c', type: 'dm' as const } }],
    ['chat', { tenant: 'a', agent: 's', channel: 'dingtalk', chat: { id: 'c:1', type: 'dm' as const } }],
  ])('rejects an invalid %s segment', (_name, input) => {
    expect(() => sessionKeyFor(input)).toThrow(/session key segment/)
  })

  it('rejects a thread without a thread id instead of colliding with its group key', () => {
    expect(() =>
      sessionKeyFor({
        tenant: 'a',
        agent: 's',
        channel: 'dingtalk',
        chat: { id: 'c', type: 'thread' },
      }),
    ).toThrow(/thread/)
  })
})

describe('whitelistCredential', () => {
  it('keeps only exposed raw keys, reports dropped keys and does not mutate input', () => {
    const result = whitelistCredential(credential, ['staffId', 'senderNick'])

    expect(result.cred.raw).toEqual({ staffId: 'u1', senderNick: 'Li' })
    expect(result.dropped.sort()).toEqual(['dept', 'phone'])
    expect(credential.raw).toEqual({
      staffId: 'u1',
      senderNick: 'Li',
      phone: '138',
      dept: 'sales',
    })
  })

  it('never drops fixed identity and routing fields', () => {
    const result = whitelistCredential(credential, [])

    expect(result.cred).toMatchObject({
      kind: 'channel',
      channel: 'dingtalk',
      accountId: 'acc',
      userId: 'u1',
      unionId: 'union-1',
      chatId: 'c1',
      chatType: 'group',
      displayName: 'Li',
    })
    expect(result.cred.raw).toEqual({})
  })

  it('does not leak an unlisted credential value through the returned object', () => {
    const result = whitelistCredential(credential, ['staffId'])
    const serialized = JSON.stringify(result.cred)

    expect(serialized).not.toContain('138')
    expect(serialized).not.toContain('sales')
    expect(serialized).not.toContain('phone')
    expect(serialized).not.toContain('dept')
  })
})
