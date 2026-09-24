import type { Attachment, MessageEvent } from '../../adapter.js'
import type { DingtalkGateway, RawRobotMessage } from './gateway.js'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const MESSAGE_TYPES = new Set<RawRobotMessage['msgtype']>(['text', 'picture', 'file', 'audio', 'richText'])

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`invalid DingTalk ${field}`)
  }
  return value
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, field, maxLength)
}

function textOf(message: RawRobotMessage): string {
  if (message.msgtype === 'text') {
    return typeof message.text?.content === 'string' ? message.text.content : ''
  }
  if (message.msgtype !== 'richText') return ''
  const richText = (message as unknown as { content?: { richText?: unknown } }).content?.richText
  if (!Array.isArray(richText)) return ''
  return richText
    .map((part) =>
      typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
        ? ((part as { text: string }).text ?? '')
        : '',
    )
    .join('')
}

function checkDiscriminants(message: RawRobotMessage): void {
  if (message.conversationType !== '1' && message.conversationType !== '2') {
    throw new TypeError('invalid DingTalk conversationType')
  }
  if (!MESSAGE_TYPES.has(message.msgtype)) throw new TypeError('invalid DingTalk msgtype')
}

export function isSafeAttachmentUrl(value: string): boolean {
  if (value.length > 4096) return false
  if ([...value].some((character) => (character.codePointAt(0) ?? 0) <= 32)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function defaultName(message: RawRobotMessage): string {
  if (message.msgtype === 'picture') return `${message.msgId}.png`
  if (message.msgtype === 'audio') return `${message.msgId}.amr`
  return message.msgId
}

export function safeAttachmentName(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value.replaceAll('\\', '/').split('/').at(-1) : undefined
  const clean = (input: string) =>
    [...input]
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0
        return code > 31 && code !== 127
      })
      .join('')
      .trim()
  return [...(clean(candidate ?? '') || clean(fallback) || 'attachment')].slice(0, 256).join('')
}

export function safeAttachmentMime(value: unknown, fallback = 'application/octet-stream'): string {
  return typeof value === 'string' && value.length <= 128 && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value)
    ? value
    : fallback
}

export function toEvent(
  message: RawRobotMessage,
  botUserId: string,
  attachments: Attachment[],
): MessageEvent {
  checkDiscriminants(message)
  const messageId = requiredString(message.msgId, 'msgId', 512)
  const conversationId = requiredString(message.conversationId, 'conversationId', 256)
  const staffId = requiredString(message.senderStaffId, 'senderStaffId', 256)
  const senderNick = optionalString(message.senderNick, 'senderNick', 256)
  const senderCorpId = optionalString(message.senderCorpId, 'senderCorpId', 1024)
  const unionId = optionalString((message as unknown as { senderId?: unknown }).senderId, 'senderId', 256)
  const robotCode = optionalString(message.robotCode, 'robotCode', 128)
  if (!Number.isFinite(message.createAt)) throw new TypeError('invalid DingTalk createAt')
  const at = new Date(message.createAt).toISOString()
  const raw: Record<string, string> = {
    staffId,
    conversationId,
    conversationType: message.conversationType,
  }
  if (unionId !== undefined) raw.unionId = unionId
  if (senderNick !== undefined) raw.senderNick = senderNick
  if (senderCorpId !== undefined) raw.senderCorpId = senderCorpId

  return {
    kind: 'message',
    eventId: messageId,
    messageId,
    accountId: robotCode ?? 'dingtalk',
    at,
    chat: { id: conversationId, type: message.conversationType === '1' ? 'dm' : 'group' },
    sender: {
      userId: staffId,
      ...(unionId === undefined ? {} : { unionId }),
      ...(senderNick === undefined ? {} : { displayName: senderNick }),
      raw,
    },
    text: textOf(message),
    attachments: attachments.map((attachment) => ({ ...attachment })),
    mentions: {
      bot:
        message.isInAtList === true ||
        (botUserId.length > 0 &&
          (message.atUsers ?? []).some((candidate) => candidate.dingtalkId === botUserId)),
      replyToBot: false,
      quoteBot: false,
    },
  }
}

export async function attachmentsOf(
  message: RawRobotMessage,
  download: DingtalkGateway['download'],
): Promise<Attachment[]> {
  checkDiscriminants(message)
  if (message.msgtype !== 'picture' && message.msgtype !== 'file' && message.msgtype !== 'audio') {
    return []
  }
  const downloadCode = message.content?.downloadCode
  if (typeof downloadCode !== 'string' || downloadCode.length === 0) return []
  const name = safeAttachmentName(message.content?.fileName, defaultName(message))
  const result = await download(downloadCode, MAX_ATTACHMENT_BYTES)
  const fallbackMime = message.msgtype === 'audio' ? 'audio/amr' : 'application/octet-stream'
  if ('url' in result) {
    if (!isSafeAttachmentUrl(result.url)) throw new TypeError('DingTalk attachment URL must be HTTPS')
    return [{ name, mime: fallbackMime, url: result.url }]
  }
  if (!(result.bytes instanceof Uint8Array) || result.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new RangeError('DingTalk attachment exceeds the size limit')
  }
  return [
    {
      name,
      mime: message.msgtype === 'audio' ? 'audio/amr' : safeAttachmentMime(result.mime),
      bytes: new Uint8Array(result.bytes),
      sizeBytes: result.bytes.length,
    },
  ]
}
