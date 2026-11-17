// Adapted from dsh-superagent (MIT)
/** Feishu outbound replies through the verified bot CLI, with durable delivery receipts and chat deep links. */
import { createHash } from 'node:crypto'
import type { OutboundMessage } from '../core/index.js'
import { FeishuNotDispatched, FeishuRefusal } from '../infra/commands.js'
import { checkedImText } from '../infra/text.js'
import { KV } from '../kv.js'
import { fetchMessages } from './feishu-client.js'
import { type FeishuIo, requireIdentity } from './feishu-io.js'
import { feishuTriggerId } from './feishu-trigger.js'
import type { SourceContext } from './host.js'
import type { ChannelLink, ChannelLinks } from './kind.js'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/** Only a structured API refusal proves that a target was recalled or removed. */
export const gone = (error: unknown): boolean => error instanceof FeishuRefusal && error.code === 230011
/**
 * Uses a stable provider idempotency key. A durable sending marker prevents an ambiguous crash/timeout being replayed
 * outside the provider's dedupe window; the existing outbox keeps it pending for operator reconciliation.
 */
export async function sendFeishu(
  io: FeishuIo,
  message: OutboundMessage,
  state: SourceContext['state'],
  sent: (messageId: string) => void,
): Promise<'sent' | 'gone'> {
  const { chatId, messageId, botIdentity } = message.channel.address
  if (!chatId || !messageId) throw new Error('Missing Feishu reply target')
  requireIdentity(io, botIdentity)
  const key = KV.feishu.delivery(message.id)
  const previous = state.get(key)
  if (previous === 'sent') return 'sent'
  if (previous)
    throw new Error(
      'Feishu delivery is uncertain; inspect the external reply before reconciling this pending receipt',
    )
  // A message id alone is not a chat boundary: verify the reply target using the same bot first.
  if (!(await fetchMessages(io, chatId, [messageId])).length) return 'gone'
  const text = checkedImText(message.text)
  const deliveryKey = createHash('sha256').update(message.id).digest('hex').slice(0, 50)
  state.set(key, 'sending')
  try {
    // stdin prevents CLI @file expansion of message content and handles multiline text on Windows.
    const result = await io.commands.lark<{ message_id?: string }>(
      [
        'im',
        '+messages-reply',
        '--message-id',
        messageId,
        '--markdown',
        '-',
        '--reply-in-thread',
        '--idempotency-key',
        deliveryKey,
      ],
      undefined,
      text,
    )
    if (!result?.message_id) throw new Error('Feishu reply did not return a message id')
    state.set(key, 'sent')
    sent(result.message_id)
    return 'sent'
  } catch (error) {
    if (
      error instanceof FeishuNotDispatched ||
      (error instanceof FeishuRefusal && error.code !== undefined)
    ) {
      state.set(key, undefined)
      if (gone(error)) return 'gone'
    } else state.set(key, 'uncertain')
    throw error
  }
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''),
  label: { zh: '飞书消息', en: 'Feishu message' },
  ...(address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {}),
})
