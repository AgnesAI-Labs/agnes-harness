// Adapted from dsh-superagent (MIT)
/** Feishu outbound channel: replies under the asked message through the AGH channel and builds chat deep links. */
import type { MessageRef } from '@agnes/extension-api/channel-contract'
import type { OutboundMessage } from '../core/index.js'
import { checkedImText } from '../infra/text.js'
import type { FeishuIo } from './feishu-io.js'
import { feishuTriggerId } from './feishu-trigger.js'
import type { ChannelLink, ChannelLinks } from './kind.js'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently refuses a reply because the target message was recalled, withdrawn or not found: its
 * error code 230011, or a 2300xx code that says not found. Timeouts, crashes and other refusals may pass on a retry.
 */
export function gone(error: unknown): boolean {
  const text =
    error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '')
  const data = JSON.stringify((error as { data?: unknown })?.data ?? '')
  const all = `${text} ${data}`
  return (
    /\b230011\b/.test(all) ||
    /withdrawn|recalled/i.test(all) ||
    (/\b2300\d\d\b/.test(all) && /not found/i.test(all))
  )
}
/** Where a reply to a message goes: its topic, or the message itself when it starts none, and its chain's root. */
export interface ReplyPlace {
  threadId?: string | undefined
  root: string
}
/**
 * Replies to the message an outgoing message answers, in its topic, through the channel. The outgoing message's id is
 * the delivery key, so a retried send posts at most one reply. On a channel without replies or topics the reply posts
 * as a new message of the chat with the same key.
 */
export async function sendFeishu(
  io: FeishuIo,
  message: OutboundMessage,
  place: (messageId: string) => ReplyPlace,
  sent: (ref: MessageRef, root: string) => void,
  during: (chatId: string, messageId: string, root: string) => () => void = () => () => {},
): Promise<'sent' | 'gone'> {
  const { chatId, messageId } = message.channel.address
  if (!chatId || !messageId) throw new Error('Missing Feishu reply target')
  if (!io.channel) throw new Error('The Feishu Source has no channel instance set')
  const text = checkedImText(message.text)
  const chatType = message.channel.address.direct === 'true' ? ('dm' as const) : ('group' as const)
  const { threadId, root } = place(messageId)
  let ref: MessageRef
  // A reply in several parts returns only its first part, and parts may come back before it returns.
  const done = during(chatId, messageId, root)
  try {
    ref = await io.channels.send(
      io.channel,
      { chatType, chatId, threadId: threadId ?? root, deliveryKey: message.id },
      { blocks: [{ kind: 'text', markdown: text }], replyTo: { chatId, messageId, chatType } },
    )
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  } finally {
    done()
  }
  sent(ref, root)
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''),
  label: { zh: '飞书消息', en: 'Feishu message' },
  ...(address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {}),
})
