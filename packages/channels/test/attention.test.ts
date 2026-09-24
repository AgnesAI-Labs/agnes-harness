import { describe, expect, it } from 'vitest'
import type { ChannelEvent, MessageEvent } from '../src/adapter.js'
import { decideAttention } from '../src/runner/attention.js'

function message(
  override: Partial<MessageEvent> & { chatType?: 'dm' | 'group' | 'thread' } = {},
): MessageEvent {
  const event: MessageEvent = {
    kind: 'message',
    eventId: 'event-1',
    messageId: 'message-1',
    accountId: 'account-1',
    at: '2026-09-11T00:00:00Z',
    text: 'hello',
    attachments: [],
    chat: { id: 'chat-1', type: override.chatType ?? 'group' },
    sender: { userId: 'u1', raw: {} },
    mentions: { bot: false, replyToBot: false, quoteBot: false },
  }
  const { chatType: _chatType, ...fields } = override
  return { ...event, ...fields }
}

describe('decideAttention', () => {
  it.each([
    ['direct messages respond', message({ chatType: 'dm' }), true, false, 'respond'],
    ['unmentioned group messages observe', message(), true, false, 'observe'],
    [
      'an explicit mention responds',
      message({ mentions: { bot: true, replyToBot: false, quoteBot: false } }),
      true,
      false,
      'respond',
    ],
    [
      'a reply to the bot responds',
      message({ mentions: { bot: false, replyToBot: true, quoteBot: false } }),
      true,
      false,
      'respond',
    ],
    [
      'a quote of the bot responds',
      message({ mentions: { bot: false, replyToBot: false, quoteBot: true } }),
      true,
      false,
      'respond',
    ],
    ['mention gating off responds', message(), false, false, 'respond'],
    ['commands bypass mention gating', message({ text: '/status' }), true, true, 'respond'],
    ['threads use group mention semantics', message({ chatType: 'thread' }), true, false, 'observe'],
  ] as const)('%s', (_name, event, requireMention, isCommand, expected) => {
    expect(decideAttention(event, { allowFrom: [], requireMention }, isCommand)).toBe(expected)
  })

  it('applies allowFrom before every response path, including commands and direct messages', () => {
    const event = message({ chatType: 'dm', text: '/status' })
    expect(decideAttention(event, { allowFrom: ['u2'], requireMention: false }, true)).toBe('ignore')
    expect(decideAttention(event, { allowFrom: ['u1'], requireMention: true }, true)).toBe('respond')
  })

  it('responds to non-message events only when the sender is allowed', () => {
    const event: ChannelEvent = {
      kind: 'cardAction',
      eventId: 'event-1',
      accountId: 'account-1',
      at: '2026-09-11T00:00:00Z',
      chat: { id: 'chat-1', type: 'group' },
      sender: { userId: 'u1', raw: {} },
      cardBizId: 'approval-1',
      value: 'allow_once',
    }
    expect(decideAttention(event, { allowFrom: [], requireMention: true }, false)).toBe('respond')
    expect(decideAttention(event, { allowFrom: ['u2'], requireMention: true }, false)).toBe('ignore')
  })
})
