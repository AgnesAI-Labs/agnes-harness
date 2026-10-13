import { randomBytes } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import type { ContentBlock, ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { MemoryStorage } from '../src/log/memory-storage.js'
import { MAX_ATTACHMENT_ROW_BYTES, type UserAttachmentPort } from '../src/step/attachment-admission.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const model: ModelRecord = {
  id: 'default',
  route: 'default',
  name: 'Image model',
  api: 'openai-completions',
  baseUrl: 'https://test.invalid',
  input: ['text', 'image'],
  reasoning: false,
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.byteLength, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** A real PNG of noise, so it does not compress: about 400 KiB of bytes. */
function noisePng(width = 256, height = 534): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) randomBytes(width * 3).copy(raw, y * (width * 3 + 1) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', new Uint8Array()),
  ])
}

function fakePort(over: Partial<UserAttachmentPort> = {}) {
  const calls = { store: 0, authorize: [] as Array<{ sha256: string; sessionKey: string }> }
  const port: UserAttachmentPort = {
    storeByReference: true,
    async store({ bytes }) {
      calls.store++
      return { sha256: 'a'.repeat(64), bytes: bytes.byteLength }
    },
    async authorize({ sha256, sessionKey }) {
      calls.authorize.push({ sha256, sessionKey })
      return sha256 === 'a'.repeat(64) ? 'ok' : 'unauthorized'
    },
    async read() {
      return new Uint8Array()
    },
    ...over,
  }
  return { port, calls }
}

async function imageSession(port: UserAttachmentPort) {
  const provider = fakeProvider([])
  provider.models = () => [model]
  return openSession({ provider, attachments: port })
}

const rowBytes = (row: unknown) => Buffer.byteLength(JSON.stringify(row))
const formatVersion = async (storage: MemoryStorage) =>
  (await storage.open('k', { writerRunId: 'r1', ttlMs: 60_000 })).formatVersion

describe('enqueue stores inline attachments by reference', () => {
  it('writes only references to the inbox row and to the user message it becomes', async () => {
    const png = noisePng()
    expect(png.byteLength).toBeGreaterThan(400 * 1024)
    const { port, calls } = fakePort()
    const { session, log } = await imageSession(port)
    await session.enqueue('next-turn', {
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      ],
      actor,
    })
    expect(calls.store).toBe(1)
    const [inbox] = await log.scan({ type: 'inbox', limit: 5 })
    const item = (inbox?.data as { items: Array<{ content: ContentBlock[] }> } | undefined)?.items[0]
    expect(item?.content).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'image',
        mimeType: 'image/png',
        attachment: { sha256: 'a'.repeat(64), bytes: png.byteLength },
        width: 256,
        height: 534,
      },
    ])
    expect(rowBytes(inbox)).toBeLessThanOrEqual(MAX_ATTACHMENT_ROW_BYTES)

    expect(await session.acceptInput()).toBe(true)
    const [message] = await log.scan({ type: 'user/message', limit: 5 })
    expect((message?.data as { content: ContentBlock[] } | undefined)?.content).toEqual(item?.content)
    expect(rowBytes(message)).toBeLessThanOrEqual(MAX_ATTACHMENT_ROW_BYTES)
    expect(JSON.stringify(await log.scan({ fromSeq: 1, limit: 50 }))).not.toContain('"data":"iVBOR')
  })

  it('writes no row at all when the store refuses', async () => {
    const { port } = fakePort({
      store: async () =>
        Promise.reject(Object.assign(new Error('Attachment storage is full.'), { code: 'UPLOAD_QUOTA' })),
    })
    const { session, log, storage } = await imageSession(port)
    const before = await log.scan({ fromSeq: 1, limit: 50 })
    await expect(
      session.enqueue('next-turn', {
        content: [{ type: 'file', mimeType: 'application/zip', name: 'a.zip', data: 'UEsDBA==' }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'UPLOAD_QUOTA' } })
    expect(await log.scan({ fromSeq: 1, limit: 50 })).toEqual(before)
    expect(await formatVersion(storage)).toBe(1)
  })

  // Every kind of queued input (prompt, steer, follow-up, a job's prompt) reaches the ledger through
  // enqueue, so this is the one place a forged reference has to be refused.
  it.each([
    ['next-turn', 'prompt'],
    ['next-step', 'steer'],
    ['next-turn', 'follow_up'],
  ] as const)('refuses a forged reference on %s %s before anything is appended', async (target, kind) => {
    const { port, calls } = fakePort()
    const { session, log, storage } = await imageSession(port)
    const before = await log.scan({ fromSeq: 1, limit: 50 })
    const forged = { sha256: 'f'.repeat(64), bytes: 10 }
    await expect(
      session.enqueue(target, {
        content: [{ type: 'file', mimeType: 'application/zip', name: 'a.zip', attachment: forged }],
        actor,
        kind,
      }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' } })
    expect(calls.authorize).toEqual([{ sha256: 'f'.repeat(64), sessionKey: 'k' }])
    expect(await log.scan({ fromSeq: 1, limit: 50 })).toEqual(before)
    // The first reference raises the ledger format for good; a refused one must not.
    expect(await formatVersion(storage)).toBe(1)

    const receipted = { sha256: 'a'.repeat(64), bytes: 10 }
    await session.enqueue(target, {
      content: [{ type: 'file', mimeType: 'application/zip', name: 'a.zip', attachment: receipted }],
      actor,
      kind,
    })
    const inbox = session.latest('inbox') as { items: Array<{ content: ContentBlock[] }> }
    expect(inbox.items[0]?.content).toEqual([
      { type: 'file', mimeType: 'application/zip', name: 'a.zip', attachment: receipted },
    ])
    expect(await formatVersion(storage)).toBe(2)
  })

  it('refuses a reference when the runtime has no attachment store', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    const before = await log.scan({ fromSeq: 1, limit: 50 })
    await expect(
      session.enqueue('next-turn', {
        content: [
          { type: 'file', mimeType: 'a/b', name: 'n', attachment: { sha256: 'a'.repeat(64), bytes: 1 } },
        ],
        actor,
      }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' } })
    expect(await log.scan({ fromSeq: 1, limit: 50 })).toEqual(before)
  })

  it('keeps inline attachments inline when the switch is off', async () => {
    const { port, calls } = fakePort({ storeByReference: false })
    const { session } = await imageSession(port)
    const file = { type: 'file' as const, mimeType: 'a/b', name: 'n', data: 'QUJD' }
    await session.enqueue('next-turn', { content: [file], actor })
    expect(calls.store).toBe(0)
    expect(session.latest('inbox')).toMatchObject({ items: [{ content: [file] }] })
  })

  it('still applies the model image check to a stored image', async () => {
    const { port } = fakePort()
    const provider = fakeProvider([])
    provider.models = () => [{ ...model, input: ['text'] }]
    const { session, log } = await openSession({ provider, attachments: port })
    const before = await log.scan({ fromSeq: 1, limit: 50 })
    await expect(
      session.enqueue('next-turn', {
        content: [{ type: 'image', mimeType: 'image/png', data: noisePng(4, 4).toString('base64') }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    expect(await log.scan({ fromSeq: 1, limit: 50 })).toEqual(before)
  })

  it('checks the image as it was sent, so the model byte limit still applies', async () => {
    const { port } = fakePort()
    const provider = fakeProvider([])
    provider.models = () => [{ ...model, inputLimits: { images: { resize: { maxBytes: 64 } } } }]
    const { session, log } = await openSession({ provider, attachments: port })
    const before = await log.scan({ fromSeq: 1, limit: 50 })
    await expect(
      session.enqueue('next-turn', {
        content: [{ type: 'image', mimeType: 'image/png', data: noisePng(4, 4).toString('base64') }],
        actor,
      }),
    ).rejects.toThrow(/Base64 limit/)
    expect(await log.scan({ fromSeq: 1, limit: 50 })).toEqual(before)
  })
})
