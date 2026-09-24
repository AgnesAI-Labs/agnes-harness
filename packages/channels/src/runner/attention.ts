import type { Attention, ChannelEvent } from '../adapter.js'
import type { RunnerConfig } from './config.js'

export function decideAttention(
  event: ChannelEvent,
  config: Pick<RunnerConfig, 'allowFrom' | 'requireMention'>,
  isCommand: boolean,
): Attention {
  if (config.allowFrom.length > 0 && !config.allowFrom.includes(event.sender.userId)) return 'ignore'
  if (event.kind !== 'message') return 'respond'
  if (event.chat.type === 'dm' || isCommand || !config.requireMention) return 'respond'
  const mention = event.mentions
  return mention.bot || mention.replyToBot || mention.quoteBot ? 'respond' : 'observe'
}
