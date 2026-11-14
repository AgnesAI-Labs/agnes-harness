// Adapted from dsh-superagent (MIT)
/** Reads the image attachments of Feishu messages through the channel and commits them as model-visible attachments. */
import { channelRead, type FeishuIo } from './feishu-io.js'
import type { FeishuRef } from './feishu-read.js'
import { IMAGE_KEY } from './feishu-trigger.js'
import type { ImageMediaType, ImageSink } from './kind.js'

/**
 * Extracts the image keys a message's text names (`[image img_att_<n>]`, one per image attachment), so a key stays
 * paired with the message it came with; no other id is accepted.
 */
export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_att_[1-9][0-9]*\b/g) ?? [])]
}

export interface AdmissionImage {
  source_message_id: string
  image_key: string
  /** Reference to the stored attachment, as the sink returned it. */
  image: unknown
}

const MEDIA_TYPES: Record<string, { type: ImageMediaType; extension: string }> = {
  'image/png': { type: 'image/png', extension: '.png' },
  'image/jpeg': { type: 'image/jpeg', extension: '.jpg' },
  'image/jpg': { type: 'image/jpeg', extension: '.jpg' },
  'image/webp': { type: 'image/webp', extension: '.webp' },
  'image/gif': { type: 'image/gif', extension: '.gif' },
}

/**
 * Reads one image of the message `ref` names: the key must be one its text names, the session's model must take images,
 * and the channel must give the attachment's bytes, of a supported type and within the size the sink takes.
 */
export async function readAdmissionImage(
  sink: ImageSink,
  io: FeishuIo,
  ref: FeishuRef,
  text: string,
  imageKey: string,
): Promise<AdmissionImage> {
  const signal = io.signal ?? new AbortController().signal
  const position = IMAGE_KEY.exec(imageKey)
  if (!position || !admissionImageKeys(text).includes(imageKey))
    throw new Error('Choose an image key from this source message')
  const { maxBytes } = await sink.check(signal)
  signal.throwIfAborted()
  const [event] = await channelRead(io, 'messages', (channels, channel) =>
    channels.fetchMessages(channel, ref.chatId, [ref.messageId]),
  )
  if (!event || event.messageId !== ref.messageId || event.chat.id !== ref.chatId)
    throw new Error('The source Feishu message is unavailable')
  const attachment = event.attachments[Number(position[1]) - 1]
  const media = attachment ? MEDIA_TYPES[attachment.mime.toLowerCase()] : undefined
  if (!attachment || !media) throw new Error('The attachment is not a supported PNG/JPEG/WebP/GIF image')
  if (!attachment.bytes) throw new Error('The Feishu channel gave the image without its bytes')
  if (attachment.bytes.byteLength > maxBytes)
    throw new Error('The image exceeds the byte limit of the session model')
  const image = await sink.save({
    data: attachment.bytes,
    mediaType: media.type,
    name: `${imageKey}${media.extension}`,
  })
  signal.throwIfAborted()
  return { source_message_id: ref.messageId, image_key: imageKey, image }
}
