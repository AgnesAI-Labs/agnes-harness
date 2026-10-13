import { crc32, deflateSync } from 'node:zlib'
import { USER_IMAGE_SEND_BUDGET } from '@agnes/protocol-validation'
import { describe, expect, it } from 'vitest'
import { USER_IMAGE_BUDGET } from '../src/request/user-images.js'
import { validateUserMessageImages } from '../src/request/user-message-images.js'
import {
  admitAttachments,
  checkUserImageBudget,
  MAX_ATTACHMENT_ROW_BYTES,
  type UserAttachmentPort,
} from '../src/step/attachment-admission.js'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const signal = new AbortController().signal
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const chunk = (type: string, data: Buffer) => {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  return Buffer.concat([u32(data.length), typed, u32(crc32(typed))])
}
/** A valid 1-bit PNG of the given size. */
const blankPng = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([1, 0, 0, 0, 0])])),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (Math.ceil(width / 8) + 1)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
function port(over: Partial<UserAttachmentPort> = {}): UserAttachmentPort & { stored: number } {
  const p = {
    stored: 0,
    storeByReference: true,
    async store({ bytes }: { bytes: Uint8Array }) {
      p.stored++
      return { sha256: 'b'.repeat(64), bytes: bytes.byteLength }
    },
    async authorize() {
      return 'ok' as const
    },
    async isUserAttachment() {
      return true
    },
    async read() {
      return new Uint8Array()
    },
    ...over,
  }
  return p
}
const base = { sessionKey: 'k', referenced: () => false, sessionBytes: () => 0, signal }

describe('admitAttachments', () => {
  it('stores inline images and files and replaces them with references', async () => {
    const p = port()
    const out = await admitAttachments({
      ...base,
      port: p,
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', mimeType: 'image/png', data: PNG_1X1 },
        { type: 'file', mimeType: 'application/zip', name: 'a.zip', data: 'UEsDBA==' },
      ],
    })
    expect(out).toEqual([
      { type: 'text', text: 'see' },
      {
        type: 'image',
        mimeType: 'image/png',
        // The fixture decodes to 68 bytes.
        attachment: { sha256: 'b'.repeat(64), bytes: 68 },
        width: 1,
        height: 1,
      },
      {
        type: 'file',
        mimeType: 'application/zip',
        name: 'a.zip',
        attachment: { sha256: 'b'.repeat(64), bytes: 4 },
      },
    ])
    expect(p.stored).toBe(2)
  })

  it('keeps everything inline when the switch is off or no port exists', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', data: PNG_1X1 }]
    expect(await admitAttachments({ ...base, port: port({ storeByReference: false }), content })).toEqual(
      content,
    )
    expect(await admitAttachments({ ...base, port: undefined, content })).toEqual(content)
  })

  it('refuses a client reference it cannot authorize, or whose object is missing', async () => {
    const ref = {
      type: 'file' as const,
      mimeType: 'application/zip',
      name: 'a.zip',
      attachment: { sha256: 'c'.repeat(64), bytes: 9 },
    }
    await expect(
      admitAttachments({ ...base, port: port({ authorize: async () => 'unauthorized' }), content: [ref] }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' } })
    await expect(
      admitAttachments({ ...base, port: port({ authorize: async () => 'missing' }), content: [ref] }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_MISSING' } })
    await expect(admitAttachments({ ...base, port: undefined, content: [ref] })).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
    })
  })

  it('refuses an image reference whose stored header disagrees with its declared size', async () => {
    const bytes = Uint8Array.from(Buffer.from(PNG_1X1, 'base64'))
    const ref = {
      type: 'image' as const,
      mimeType: 'image/png' as const,
      attachment: { sha256: 'd'.repeat(64), bytes: bytes.byteLength },
      width: 2,
      height: 1,
    }
    await expect(
      admitAttachments({ ...base, port: port({ read: async () => bytes }), content: [ref] }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE' })
  })

  it('keeps the attachment part of a row within 64 KiB', async () => {
    const refs = Array.from({ length: 50 }, (_, i) => ({
      type: 'file' as const,
      mimeType: 'application/octet-stream',
      name: `${'n'.repeat(250)}${i}`,
      attachment: { sha256: 'e'.repeat(64), bytes: 1 },
    }))
    await expect(admitAttachments({ ...base, port: port(), content: refs })).resolves.toHaveLength(50)
    expect(MAX_ATTACHMENT_ROW_BYTES).toBe(65_536)
  })

  it('surfaces a store failure without writing anything', async () => {
    await expect(
      admitAttachments({
        ...base,
        port: port({
          store: async () =>
            Promise.reject(Object.assign(new Error('UPLOAD_QUOTA'), { code: 'UPLOAD_QUOTA' })),
        }),
        content: [{ type: 'file', mimeType: 'a/b', name: 'n', data: 'QUJD' }],
      }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'UPLOAD_QUOTA' } })
  })

  it('passes the running byte total to each store so a session quota sees the whole message', async () => {
    const seen: number[] = []
    const p = port({
      async store({ bytes, sessionBytes }) {
        seen.push(sessionBytes)
        return { sha256: 'b'.repeat(64), bytes: bytes.byteLength }
      },
    })
    const file = { type: 'file' as const, mimeType: 'a/b', name: 'n', data: 'QUJD' }
    await admitAttachments({ ...base, sessionBytes: () => 100, port: p, content: [file, file, file] })
    expect(seen).toEqual([100, 103, 106])
  })

  it('checks a reference against what this session already references', async () => {
    const asked: boolean[] = []
    const p = port({
      async authorize({ referenced }) {
        asked.push(referenced)
        return referenced ? 'ok' : 'unauthorized'
      },
    })
    const ref = {
      type: 'file' as const,
      mimeType: 'a/b',
      name: 'n',
      attachment: { sha256: 'f'.repeat(64), bytes: 3 },
    }
    await expect(
      admitAttachments({ ...base, referenced: (sha) => sha === 'f'.repeat(64), port: p, content: [ref] }),
    ).resolves.toEqual([ref])
    expect(asked).toEqual([true])
  })

  it('keeps a large attachment inline when the switch is off: the 64 KiB bound is for references', async () => {
    const content = [{ type: 'file' as const, mimeType: 'a/b', name: 'n', data: 'QUJD'.repeat(40_000) }]
    expect(await admitAttachments({ ...base, port: port({ storeByReference: false }), content })).toEqual(
      content,
    )
    expect(await admitAttachments({ ...base, port: undefined, content })).toEqual(content)
  })

  it('authorizes the thumbnail of an image reference as well', async () => {
    const bytes = Uint8Array.from(Buffer.from(PNG_1X1, 'base64'))
    const thumbnail = { sha256: '9'.repeat(64), bytes: 10, width: 1, height: 1 }
    const ref = {
      type: 'image' as const,
      mimeType: 'image/png' as const,
      attachment: { sha256: 'd'.repeat(64), bytes: bytes.byteLength },
      width: 1,
      height: 1,
      thumbnail,
    }
    const asked: string[] = []
    const p = port({
      read: async () => bytes,
      async authorize({ sha256 }) {
        asked.push(sha256)
        return sha256 === thumbnail.sha256 ? 'unauthorized' : 'ok'
      },
    })
    await expect(admitAttachments({ ...base, port: p, content: [ref] })).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
    })
    expect(asked).toEqual(['d'.repeat(64), thumbnail.sha256])
    await expect(
      admitAttachments({ ...base, port: port({ read: async () => bytes }), content: [ref] }),
    ).resolves.toEqual([ref])
  })

  it('refuses an image reference larger than an image may be without reading it', async () => {
    let reads = 0
    const ref = {
      type: 'image' as const,
      mimeType: 'image/png' as const,
      attachment: { sha256: 'd'.repeat(64), bytes: 100 * 1024 * 1024 + 1 },
      width: 1,
      height: 1,
    }
    const p = port({
      async read() {
        reads++
        return new Uint8Array()
      },
    })
    await expect(admitAttachments({ ...base, port: p, content: [ref] })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
      detail: { code: 'ATTACHMENT_BYTES' },
    })
    expect(reads).toBe(0)
  })

  it('refuses a thumbnail that is too large or not an image of its declared size', async () => {
    const png = Uint8Array.from(Buffer.from(PNG_1X1, 'base64'))
    const zip = Uint8Array.from(Buffer.from('PK\u0003\u0004 not an image'))
    const image = (thumbnail: Record<string, unknown>) => ({
      type: 'image' as const,
      mimeType: 'image/png' as const,
      attachment: { sha256: 'd'.repeat(64), bytes: png.byteLength },
      width: 1,
      height: 1,
      thumbnail,
    })
    const reads: string[] = []
    const p = port({
      async read(sha256) {
        reads.push(sha256)
        return sha256 === '9'.repeat(64) ? zip : png
      },
    })
    const large = { sha256: '8'.repeat(64), bytes: 256 * 1024 + 1, width: 1, height: 1 }
    await expect(
      admitAttachments({ ...base, port: p, content: [image(large) as never] }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_DATA' } })
    expect(reads).toEqual([])
    const notImage = { sha256: '9'.repeat(64), bytes: zip.byteLength, width: 1, height: 1 }
    await expect(
      admitAttachments({ ...base, port: p, content: [image(notImage) as never] }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_DATA' } })
    const wrongSize = { sha256: '7'.repeat(64), bytes: png.byteLength, width: 2, height: 1 }
    await expect(
      admitAttachments({ ...base, port: p, content: [image(wrongSize) as never] }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_DATA' } })
  })

  it('reports a file system failure as unavailable without its message', async () => {
    const leak = Object.assign(new Error('ENOSPC: no space left, open /srv/agh/data/artifacts/staging/x'), {
      code: 'ENOSPC',
    })
    const failure = await admitAttachments({
      ...base,
      port: port({ store: async () => Promise.reject(leak) }),
      content: [{ type: 'file', mimeType: 'a/b', name: 'n', data: 'QUJD' }],
    }).then(
      () => new Error('admitted'),
      (error: unknown) => error as Error,
    )
    expect(failure).toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'UPLOAD_UNAVAILABLE' } })
    expect(failure.message).not.toMatch(/srv|ENOSPC|artifacts/)
    const read = await admitAttachments({
      ...base,
      port: port({ read: async () => Promise.reject(leak) }),
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          attachment: { sha256: 'd'.repeat(64), bytes: 68 },
          width: 1,
          height: 1,
        },
      ],
    }).then(
      () => new Error('admitted'),
      (error: unknown) => error as Error,
    )
    expect(read).toMatchObject({ detail: { code: 'ATTACHMENT_UNAVAILABLE' } })
    expect(read.message).not.toMatch(/srv|ENOSPC|artifacts/)
  })

  it('reports a store that outran its deadline as a timeout, not as unavailable', async () => {
    const late = new DOMException('The operation timed out.', 'TimeoutError')
    const stored = await admitAttachments({
      ...base,
      port: port({ store: async () => Promise.reject(late) }),
      content: [{ type: 'file', mimeType: 'a/b', name: 'n', data: 'QUJD' }],
    }).then(
      () => new Error('admitted'),
      (error: unknown) => error as Error,
    )
    expect(stored).toMatchObject({
      code: 'E_ENVELOPE',
      detail: { code: 'ATTACHMENT_TIMEOUT', reason: 'attachment-timeout' },
    })
    // A read cut off by the deadline rejects with the signal's reason.
    const expired = AbortSignal.timeout(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const read = await admitAttachments({
      ...base,
      signal: expired,
      port: port({ read: async (_sha, _range, s) => Promise.reject(s?.reason) }),
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          attachment: { sha256: 'd'.repeat(64), bytes: 68 },
          width: 1,
          height: 1,
        },
      ],
    }).then(
      () => new Error('admitted'),
      (error: unknown) => error as Error,
    )
    expect(read).toMatchObject({ detail: { code: 'ATTACHMENT_TIMEOUT' } })
  })

  it('refuses a message whose attachment part would exceed 64 KiB', async () => {
    const refs = Array.from({ length: 200 }, (_, i) => ({
      type: 'file' as const,
      mimeType: 'application/octet-stream',
      name: `${'n'.repeat(250)}${i}`,
      attachment: { sha256: 'e'.repeat(64), bytes: 1 },
    }))
    await expect(admitAttachments({ ...base, port: port(), content: refs })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
      detail: { code: 'ATTACHMENT_COUNT' },
    })
  })
})

describe('checkUserImageBudget', () => {
  const MIB = 1024 * 1024
  const ref = (bytes: number, edge = 8, name = 'shot.png') => ({
    type: 'image' as const,
    mimeType: 'image/png',
    name,
    attachment: { sha256: 'a'.repeat(64), bytes },
    width: edge,
    height: edge,
  })
  const refusal = (content: unknown[]) => {
    try {
      checkUserImageBudget(content as never)
      return undefined
    } catch (error) {
      return (error as { detail?: { code?: string; reason?: string } }).detail
    }
  }

  it('refuses one image over 16 MiB with its own code', () => {
    expect(refusal([ref(16 * MIB + 1)])).toEqual({
      code: 'ATTACHMENT_IMAGE_TOO_LARGE',
      reason: 'attachment-image-too-large',
    })
    expect(refusal([ref(16 * MIB)])).toBeUndefined()
  })

  it('refuses images over 16 MiB or 8 million pixels together', () => {
    expect(refusal([ref(9 * MIB), ref(8 * MIB)])?.code).toBe('ATTACHMENT_IMAGE_TOO_LARGE')
    // Four 1456-pixel squares are 8.48 million pixels; three are 6.36 million.
    expect(refusal([1, 2, 3, 4].map(() => ref(MIB, 1456)))?.code).toBe('ATTACHMENT_IMAGE_TOO_LARGE')
    expect(refusal([1, 2, 3].map(() => ref(MIB, 1456)))).toBeUndefined()
    // Inline images count with references.
    const inline = { type: 'image', mimeType: 'image/png', data: PNG_1X1 }
    expect(refusal([...[1, 2, 3].map(() => ref(MIB, 1456)), inline])).toBeUndefined()
    // Exactly 8 million pixels by reference leaves no room for the inline image.
    const full = { ...ref(MIB), width: 4000, height: 2000 }
    expect(refusal([full])).toBeUndefined()
    expect(refusal([full, inline])?.code).toBe('ATTACHMENT_IMAGE_TOO_LARGE')
  })

  it('leaves one image over the per-image pixel limit to the per-image check, not the aggregate message', () => {
    const wide = {
      type: 'image' as const,
      mimeType: 'image/png',
      data: blankPng(1600, 1600).toString('base64'),
    }
    // 2.56 million pixels is over one image's 2.1 million but far under the 8 million together.
    expect(refusal([wide])).toBeUndefined()
    expect(() => validateUserMessageImages([wide])).toThrow(/PIXEL_LIMIT/)
    // The aggregate still trips on its own limit.
    const full = { ...ref(MIB), width: 4000, height: 1700 }
    expect(refusal([full, { ...wide, data: PNG_1X1 }])).toBeUndefined()
    expect(refusal([{ ...ref(MIB), width: 4000, height: 2000 }, wide])?.code).toBe(
      'ATTACHMENT_IMAGE_TOO_LARGE',
    )
  })

  it('uses the request budget: a message admitted at send fits one model request', () => {
    expect(USER_IMAGE_BUDGET.bytes).toBe(USER_IMAGE_SEND_BUDGET.maxAggregateBytes)
    expect(USER_IMAGE_BUDGET.pixels).toBe(USER_IMAGE_SEND_BUDGET.maxAggregatePixels)
  })

  it('does not count files: a 90 MB zip goes through', () => {
    const zip = {
      type: 'file',
      mimeType: 'application/zip',
      name: 'insects.zip',
      attachment: { sha256: 'b'.repeat(64), bytes: 90_000_000 },
    }
    expect(refusal([zip, ref(MIB)])).toBeUndefined()
  })
})
