// Adapted from dsh-superagent (MIT)
/** Reading the image attachments of Feishu messages through the AGH channel (source `sources/feishu-image.ts`). */
import type { Attachment } from '@agnes/extension-api/channel-contract'
import { describe, expect, it, vi } from 'vitest'
import { admissionImageKeys, readAdmissionImage } from '../src/sources/feishu-image.js'
import { feishuLink, linkIo } from '../src/sources/feishu-io.js'
import type { ImageSink } from '../src/sources/kind.js'
import { fakeChannels, message } from './sources/fake-channels.js'

const png = new Uint8Array([137, 80, 78, 71])
const ref = { triggerId: 't', chatId: 'oc_team', messageId: 'om_1' }
const text = 'see\n[image img_att_2]'
const sink = (maxBytes = 1024) => ({
  check: vi.fn(async () => ({ maxBytes })),
  save: vi.fn(async (image: { name: string }) => ({ path: `/images/${image.name}` })),
})
const channels = (attachments: Attachment[]) =>
  fakeChannels({ history: [message('om_1', { text: 'see', attachments })] })
const io = (fake: ReturnType<typeof fakeChannels>) => linkIo(feishuLink(fake.channels), 'feishu')

describe('feishu-image', () => {
  it('keeps the source-message pairing and commits the image the channel gave as an attachment reference', async () => {
    const fake = channels([
      { name: 'notes.txt', mime: 'text/plain' },
      { name: 'shot.png', mime: 'image/png', bytes: png },
    ])
    const images = sink()
    expect(admissionImageKeys(text)).toEqual(['img_att_2'])
    expect(await readAdmissionImage(images, io(fake), ref, text, 'img_att_2')).toEqual({
      source_message_id: 'om_1',
      image_key: 'img_att_2',
      image: { path: '/images/img_att_2.png' },
    })
    expect(images.save).toHaveBeenCalledWith({ data: png, mediaType: 'image/png', name: 'img_att_2.png' })
    expect(fake.calls('fetchMessages').map((call) => call.args)).toEqual([['oc_team', ['om_1']]])
  })
  it('rejects keys the message does not name and models without images before reading anything', async () => {
    const fake = channels([{ name: 'shot.png', mime: 'image/png', bytes: png }])
    await expect(readAdmissionImage(sink(), io(fake), ref, text, 'img_att_1')).rejects.toThrow(
      'Choose an image key from this source message',
    )
    await expect(readAdmissionImage(sink(), io(fake), ref, text, 'img_v3_other')).rejects.toThrow(
      'Choose an image key',
    )
    const blind: ImageSink = {
      check: async () => {
        throw new Error('The current model cannot read images')
      },
      save: vi.fn(),
    }
    await expect(readAdmissionImage(blind, io(fake), ref, text, 'img_att_2')).rejects.toThrow(
      'cannot read images',
    )
    expect(fake.calls('fetchMessages')).toEqual([])
  })
  it('returns no image when the read fails, the message is gone, or the channel cannot read messages', async () => {
    const images = sink()
    const failing = channels([])
    failing.channels.fetchMessages = async () => {
      throw new Error('rate limited')
    }
    await expect(readAdmissionImage(images, io(failing), ref, text, 'img_att_2')).rejects.toThrow(
      'rate limited',
    )
    await expect(readAdmissionImage(images, io(fakeChannels()), ref, text, 'img_att_2')).rejects.toThrow(
      'source Feishu message is unavailable',
    )
    const blind = fakeChannels({ reads: { messages: false } })
    await expect(readAdmissionImage(images, io(blind), ref, text, 'img_att_2')).rejects.toThrow(
      'does not support reading messages',
    )
    expect(images.save).not.toHaveBeenCalled()
  })
  it('refuses an image over the byte limit, an unsupported type, and an attachment without its bytes', async () => {
    const refuse = async (attachment: Attachment, max: number, why: string) => {
      const images = sink(max)
      const fake = channels([{ name: 'a', mime: 'text/plain' }, attachment])
      await expect(readAdmissionImage(images, io(fake), ref, text, 'img_att_2')).rejects.toThrow(why)
      expect(images.save).not.toHaveBeenCalled()
    }
    await refuse({ name: 'big.png', mime: 'image/png', bytes: png }, 3, 'exceeds the byte limit')
    await refuse(
      { name: 'shot.bmp', mime: 'image/bmp', bytes: png },
      1024,
      'not a supported PNG/JPEG/WebP/GIF',
    )
    await refuse({ name: 'remote.png', mime: 'image/png' }, 1024, 'without its bytes')
  })
})
