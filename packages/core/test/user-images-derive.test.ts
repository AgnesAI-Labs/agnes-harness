import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import type { ContentBlock, ModelRecord, RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { ScanQuery } from '../src/log/storage.js'
import type { AttachmentReadPort } from '../src/request/attachment-bytes.js'
import type { UserAttachmentPort } from '../src/step/attachment-admission.js'
import { CompactionRunner } from '../src/step/compaction.js'
import { compactionTriggerTokens } from '../src/step/gate.js'
import type { SessionDeps } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const chunk = (type: string, data: Buffer) => {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  return Buffer.concat([u32(data.length), typed, u32(crc32(typed))])
}
/**
 * A valid PNG of the given size whose bytes differ by `marker`. A `noisy` one is 8-bit grayscale
 * stored without compression, so its size is about width x height bytes.
 */
function png(width: number, height: number, marker: number, noisy = false): Buffer {
  const row = noisy ? width + 1 : Math.ceil(width / 8) + 1
  const raw = Buffer.alloc(height * row)
  if (noisy) for (let i = 0; i < raw.length; i++) raw[i] = i % row === 0 ? 0 : (i * 7919 + marker) & 0xff
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([noisy ? 8 : 1, 0, 0, 0, 0])])),
    chunk('tEXt', Buffer.from(`marker\0${marker}`, 'ascii')),
    chunk('IDAT', deflateSync(raw, { level: noisy ? 0 : 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal

const imageModel: ModelRecord = {
  id: 'default',
  route: 'default',
  name: 'Image model',
  api: 'openai-completions',
  baseUrl: 'https://test.invalid',
  input: ['text', 'image'],
  reasoning: false,
  contextWindow: 1_000_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}

/** An attachment store holding marked user attachments, counting reads; admission accepts every reference. */
function store() {
  const objects = new Map<string, Uint8Array>()
  const corrupt = new Set<string>()
  const unmarked = new Set<string>()
  const cache = new Map<string, { sha256: string; bytes: number; rowId: string }>()
  const calls = { read: 0, cacheInline: 0 }
  const port: AttachmentReadPort = {
    isUserAttachment: async (sha256) => !unmarked.has(sha256),
    async read(sha256, range) {
      calls.read++
      if (corrupt.has(sha256)) throw Object.assign(new Error('corrupt'), { code: 'ATTACHMENT_CORRUPT' })
      const bytes = objects.get(sha256)
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ATTACHMENT_MISSING' })
      return range ? bytes.slice(range.offset, range.offset + range.length) : bytes
    },
    async cacheInline(input) {
      calls.cacheInline++
      const sha256 = hex(input.bytes)
      objects.set(sha256, input.bytes)
      cache.set(`${input.sessionKey}/${input.seq}/${input.kind}/${input.index}`, {
        sha256,
        bytes: input.bytes.byteLength,
        rowId: input.rowId,
      })
      return { sha256, bytes: input.bytes.byteLength }
    },
    async cachedInline(sessionKey, seq, kind, index, rowId) {
      const hit = cache.get(`${sessionKey}/${seq}/${kind}/${index}`)
      return hit && hit.rowId === rowId ? { sha256: hit.sha256, bytes: hit.bytes } : undefined
    },
  }
  const session: UserAttachmentPort = {
    storeByReference: false,
    store: async () => {
      throw new Error('not used')
    },
    authorize: async () => 'ok',
    ...port,
  }
  /** Puts an image in the store and returns the reference block a message carries for it. */
  const reference = (bytes: Buffer, width: number, height: number): ContentBlock => {
    objects.set(hex(bytes), Uint8Array.from(bytes))
    return {
      type: 'image',
      mimeType: 'image/png',
      attachment: { sha256: hex(bytes), bytes: bytes.byteLength },
      width,
      height,
    } as ContentBlock
  }
  return { port: session, objects, corrupt, unmarked, calls, reference }
}

async function opened(model: ModelRecord = imageModel, over: Partial<SessionDeps> = {}) {
  const provider = fakeProvider([textTurn('ok')])
  let current = model
  provider.models = () => [current]
  const attachments = store()
  const out = await openSession({
    provider,
    attachments: attachments.port,
    // A provider here cannot count a request with images; this bound stands in for the host's.
    imageInputTokenFallback: ({ imageCount }) => ({ tokens: 1000, imageCount }),
    ...over,
  })
  const scans: ScanQuery[] = []
  const scan = out.session.d.log.scan.bind(out.session.d.log)
  out.session.d.log.scan = (q) => {
    scans.push(q)
    return scan(q)
  }
  /** Sends one message and runs its turn; resolves to the turn's outcome and the message's seq. */
  const say = async (...content: ContentBlock[]) => {
    await out.session.enqueue('next-turn', { content, actor })
    return run()
  }
  const run = async () => {
    const outcome = await out.session.run({ until: 'turn-end', signal: signal() })
    const rows = await scan({ type: 'user/message', limit: 1000 })
    return { outcome, seq: rows.at(-1)?.seq as number }
  }
  const headers = async () =>
    (await scan({ type: 'request/header', limit: 1000 })).map(
      (row) =>
        (row.data as { userImages?: { included: string[]; omitted: number; missing: string[] } }).userImages,
    )
  return {
    ...out,
    provider,
    say,
    headers,
    run,
    scans,
    ...attachments,
    setModel: (next: ModelRecord) => {
      current = next
    },
  }
}

const imagesOf = (request: RequestBody | undefined) =>
  (request?.messages ?? []).flatMap((m) =>
    m.content.flatMap((b) => (b.type === 'image' ? [(b as { data: string }).data] : [])),
  )
const textOf = (request: RequestBody | undefined) => JSON.stringify(request?.messages ?? [])

describe('user images in model requests', () => {
  it('sends a referenced image with bytes read through the store, named in the request header', async () => {
    const t = await opened()
    const bytes = png(8, 8, 1)
    await t.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'look' }, t.reference(bytes, 8, 8)],
      actor,
    })
    // Queueing reads the object once to check it; the request reads it once more.
    const queued = t.calls.read
    const { outcome, seq } = await t.run()
    expect(outcome.reason).toBe('completed')
    expect(imagesOf(t.provider.requests[0])).toEqual([bytes.toString('base64')])
    expect(textOf(t.provider.requests[0])).not.toContain('"data":"undefined"')
    expect(t.calls.read - queued).toBe(1)
    expect((await t.headers()).at(-1)).toEqual({ included: [`${seq}/1`], omitted: 0, missing: [] })
  })

  it('keeps the sent image prefix byte-identical between requests and never adds an omitted image back', async () => {
    const t = await opened({ ...imageModel, inputLimits: { images: { maxPerRequest: 4 } } })
    const sent: string[][] = []
    const all: string[] = []
    for (let i = 1; i <= 7; i++) {
      const bytes = png(8, 8, i)
      all.push(bytes.toString('base64'))
      expect((await t.say(t.reference(bytes, 8, 8))).outcome.reason).toBe('completed')
      sent.push(imagesOf(t.provider.requests.at(-1)))
    }
    expect(sent[3]).toEqual(all.slice(0, 4))
    // The fifth image drops two at once, so the sixth request sends the fifth's images as its prefix.
    expect(sent[4]).toEqual(all.slice(2, 5))
    expect(sent[5]).toEqual(all.slice(2, 6))
    expect(sent[5]?.slice(0, sent[4]?.length)).toEqual(sent[4])
    // The seventh drops two more.
    expect(sent[6]).toEqual(all.slice(4, 7))
    for (const later of sent.slice(5)) for (const gone of all.slice(0, 2)) expect(later).not.toContain(gone)
    expect((await t.headers()).map((h) => h?.omitted)).toEqual([0, 0, 0, 0, 2, 2, 4])
    expect(textOf(t.provider.requests.at(-1))).toContain('original not included in this request')
  })

  it('puts a note in place of a missing history image, and refuses a missing or corrupt image of this turn', async () => {
    const t = await opened()
    const first = png(8, 8, 1)
    const { seq } = await t.say(t.reference(first, 8, 8))
    t.objects.delete(hex(first))
    const second = png(8, 8, 2)
    expect((await t.say(t.reference(second, 8, 8))).outcome.reason).toBe('completed')
    expect(imagesOf(t.provider.requests.at(-1))).toEqual([second.toString('base64')])
    expect(textOf(t.provider.requests.at(-1))).toContain(`session-image://${seq}/1; original not included`)
    expect((await t.headers()).at(-1)?.missing).toEqual([`${seq}/1`])

    // An image of this turn that is gone by the time the request is built fails the turn unsent.
    const calls = t.provider.calls
    await t.session.enqueue('next-turn', { content: [t.reference(png(8, 8, 3), 8, 8)], actor })
    t.objects.clear()
    const missing = await t.run()
    expect(missing.outcome).toMatchObject({ reason: 'error' })
    expect(missing.outcome.error?.message).toMatch(/^E_ENVELOPE: An image of this message is missing/)
    expect(t.provider.calls).toBe(calls)

    const c = await opened()
    const old = png(8, 8, 4)
    const { seq: oldSeq } = await c.say(c.reference(old, 8, 8))
    c.corrupt.add(hex(old))
    const corrupt = await c.say({ type: 'text', text: 'again' })
    expect(corrupt.outcome).toMatchObject({ reason: 'error' })
    expect(corrupt.outcome.error?.message).toBe(
      `E_ENVELOPE: The stored image session-image://${oldSeq}/1 is corrupt; the request was not sent.`,
    )
    expect(c.provider.calls).toBe(1)
  })

  it('gives a text-only model a note for every image and reads none of them', async () => {
    const t = await opened()
    const { seq } = await t.say(t.reference(png(8, 8, 1), 8, 8))
    const reads = t.calls.read
    t.setModel({ ...imageModel, input: ['text'] })
    expect((await t.say({ type: 'text', text: 'and now?' })).outcome.reason).toBe('completed')
    expect(imagesOf(t.provider.requests.at(-1))).toEqual([])
    expect(textOf(t.provider.requests.at(-1))).toContain(`session-image://${seq}/1; original not included`)
    expect(t.calls.read).toBe(reads)
  })

  it('sends no image in a summary request, only the notes', async () => {
    const t = await opened()
    const bytes = png(8, 8, 1)
    const inline = png(8, 8, 2).toString('base64')
    await t.say({ type: 'text', text: 'first' }, t.reference(bytes, 8, 8), {
      type: 'image',
      mimeType: 'image/png',
      data: inline,
    } as ContentBlock)
    await t.say({ type: 'text', text: 'second' })
    t.session.compaction = new CompactionRunner({
      plan: async (payload) => {
        const surface = payload.getSurface()
        return {
          keepFromSeq: surface.at(-1)?.seq as number,
          summarizeRange: [surface[0]?.seq as number, surface.at(-2)?.seq as number],
          prompts: { system: 'summarize', history: 'history' },
          maxTokens: 50,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    const reads = t.calls.read
    await t.session.requestCompaction({ actor, admissionId: 'images-summary' })
    await t.session.run({ until: 'turn-end', signal: signal() })
    const summary = t.provider.requests.find((r) => r.kind === 'summary')
    expect(summary).toBeDefined()
    expect(imagesOf(summary)).toEqual([])
    expect(textOf(summary)).not.toContain(inline)
    expect(textOf(summary)).toContain('original not included in this request')
    expect(t.calls.read).toBe(reads)
  })

  it('reads a large old inline image from its own row once when it is chosen, and keeps a copy', async () => {
    const t = await opened()
    const big = png(600, 600, 1, true)
    const data = big.toString('base64')
    expect(data.length).toBeGreaterThan(262_144)
    const { seq } = await t.say({ type: 'image', mimeType: 'image/png', data } as ContentBlock)
    const node = t.session.surface().find((n) => n.seq === seq)
    expect(JSON.stringify(node?.event.data)).toContain('dataOmitted')
    expect(imagesOf(t.provider.requests[0])).toEqual([data])
    const rowReads = (from: number) =>
      t.scans.slice(from).filter((q) => q.type === 'user/message' && q.fromSeq === seq && q.toSeq === seq)
    // Every read of a message row reads that one row; this one is read for its image and, as the
    // turn's trigger, for its prompt text.
    expect(t.scans.filter((q) => q.type === 'user/message' && q.toSeq !== q.fromSeq)).toEqual([])
    expect(rowReads(0)).toHaveLength(2)
    expect(t.calls.cacheInline).toBe(1)
    const before = t.scans.length
    await t.say({ type: 'text', text: 'again' })
    expect(imagesOf(t.provider.requests.at(-1))).toEqual([data])
    expect(rowReads(before)).toHaveLength(0)
    expect(t.calls.cacheInline).toBe(1)
  })

  it('counts an image by its area in the token estimate, and a large old one without a size as 1600', async () => {
    /** The estimate's growth from one message holding just this image. */
    const added = async (image: (t: Awaited<ReturnType<typeof opened>>) => ContentBlock) => {
      const t = await opened()
      const before = compactionTriggerTokens(t.session)
      await t.session.enqueue('next-turn', { content: [image(t)], actor })
      expect(await t.session.acceptInput()).toBe(true)
      return compactionTriggerTokens(t.session) - before
    }
    expect(await added((t) => t.reference(png(1456, 1456, 1), 1456, 1456))).toBe(
      Math.ceil((1456 * 1456) / 750),
    )
    // An old inline image records no size: a small one is measured from its header, and a large one,
    // whose bytes the surface does not hold, counts as 1600.
    const inline = (bytes: Buffer) => () =>
      ({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }) as ContentBlock
    expect(await added(inline(png(80, 20, 2)))).toBe(Math.ceil((80 * 20) / 750))
    expect(await added(inline(png(600, 600, 3, true)))).toBe(1600)
  })

  it('asks for a request version of a stored image larger than the route allows', async () => {
    const versions: Array<{ source: unknown; maxWidth: number }> = []
    const small = png(512, 4, 9)
    let refuse = false
    const resized = { ...imageModel, inputLimits: { images: { resize: { maxWidth: 512 } } } }
    const t = await opened(imageModel, {
      requestVersions: async (source, target) => {
        versions.push({ source, maxWidth: target.maxWidth })
        if (refuse) throw Object.assign(new Error('resize'), { code: 'IMAGE_RESIZE_REQUIRED' })
        return { bytes: Uint8Array.from(small), mimeType: 'image/png', width: 512, height: 4 }
      },
    })
    // Queued while the route took it as it is; the route then changed to one that needs it smaller.
    const wide = png(1024, 8, 1)
    await t.session.enqueue('next-turn', { content: [t.reference(wide, 1024, 8)], actor })
    t.setModel(resized)
    const { seq } = await t.run()
    expect(versions).toEqual([
      { source: { sha256: hex(wide), bytes: wide.byteLength, mimeType: 'image/png' }, maxWidth: 512 },
    ])
    expect(imagesOf(t.provider.requests[0])).toEqual([small.toString('base64')])

    refuse = true
    expect((await t.say({ type: 'text', text: 'again' })).outcome.reason).toBe('completed')
    expect(imagesOf(t.provider.requests.at(-1))).toEqual([])
    expect(textOf(t.provider.requests.at(-1))).toContain(`session-image://${seq}/1; original not included`)
    // An object the store no longer serves as a user attachment is not handed to the version cache.
    refuse = false
    t.unmarked.add(hex(wide))
    expect((await t.say({ type: 'text', text: 'once more' })).outcome.reason).toBe('completed')
    expect(versions).toHaveLength(2)
    expect((await t.headers()).at(-1)?.missing).toEqual([`${seq}/1`])
    refuse = true
    const calls = t.provider.calls
    t.setModel(imageModel)
    await t.session.enqueue('next-turn', { content: [t.reference(png(1024, 8, 2), 1024, 8)], actor })
    t.setModel(resized)
    const fresh = await t.run()
    expect(fresh.outcome).toMatchObject({ reason: 'error' })
    expect(fresh.outcome.error?.message).toMatch(/^E_ENVELOPE: /)
    expect(t.provider.calls).toBe(calls)
  })

  it('sends several large inline images of this turn, measured from their bytes, not refused for an unknown size', async () => {
    const t = await opened()
    const images = [1, 2, 3, 4].map((i) => png(600, 600, i, true).toString('base64'))
    const { outcome } = await t.say(
      ...images.map((data) => ({ type: 'image', mimeType: 'image/png', data }) as ContentBlock),
    )
    expect(outcome.reason).toBe('completed')
    expect(imagesOf(t.provider.requests[0])).toEqual(images)
  })

  it('counts an old inline image in history by the size in its header', async () => {
    const t = await opened()
    const images: string[] = []
    for (let i = 1; i <= 4; i++) {
      const data = png(8, 8, i).toString('base64')
      images.push(data)
      await t.say({ type: 'image', mimeType: 'image/png', data } as ContentBlock)
    }
    // Four images of unknown size would count as 4 x 1456 x 1456 pixels, over the 8,000,000 budget.
    expect((await t.say({ type: 'text', text: 'all four?' })).outcome.reason).toBe('completed')
    expect(imagesOf(t.provider.requests.at(-1))).toEqual(images)
  })

  it.each([
    ['only a byte limit', { maxBytes: 10_000_000 }],
    ['an edge limit above the image', { maxWidth: 2048 }],
  ])('sends a wide stored image as it is to a route with %s', async (_name, resize) => {
    const versions: unknown[] = []
    const t = await opened(
      { ...imageModel, inputLimits: { images: { resize } } },
      {
        requestVersions: async (source) => {
          versions.push(source)
          throw Object.assign(new Error('resize'), { code: 'IMAGE_RESIZE_REQUIRED' })
        },
      },
    )
    const wide = png(1600, 8, 1)
    const { outcome } = await t.say(t.reference(wide, 1600, 8))
    expect(outcome.reason).toBe('completed')
    expect(versions).toEqual([])
    expect(imagesOf(t.provider.requests[0])).toEqual([wide.toString('base64')])
  })
})
