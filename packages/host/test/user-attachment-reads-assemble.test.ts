import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { ContentBlock, InferenceEvent, ModelRecord } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createAttachmentStore } from '../src/attachment-store.js'
import type { Host } from '../src/host.js'
import { composeProductionRequestMedia } from '../src/request-media-runtime.js'
import { createTestHost } from '../testkit/index.js'

const roots: string[] = []
const hosts: Host[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// An 8x8 PNG and a 1x1 PNG thumbnail.
const PNG8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const TEXT = Buffer.from('kept by reference\n')
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const read = (args: Record<string, string>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name: 'read', args, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]
const done: InferenceEvent[] = [{ type: 'text_delta', delta: 'done' }]

/** A host with the bundled tools; each model call takes the next queued answer, then says done. */
async function open(storeAttachmentsByReference: boolean, limits?: Record<string, number>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-attach-reads-')))
  roots.push(root)
  const answers: InferenceEvent[][] = []
  let provider: ScriptedProvider | undefined
  /** The route's image limits, as the model records hold them; a case may change them between turns. */
  const imageLimits: { inputLimits?: ModelRecord['inputLimits'] } = {}
  const artifacts = new Map<string, Uint8Array>()
  const { host } = await createTestHost({
    dataDir: root,
    storeAttachmentsByReference,
    ...(limits ? { limits } : {}),
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    // The test route's models, able to take images.
    provider: (profile) =>
      (provider = new ScriptedProvider({
        scripts: [() => answers.shift() ?? done],
        models: (profile.provider.routes ?? [])
          .flatMap((route) => route.models ?? [])
          .map((model) =>
            Object.defineProperty({ ...model, input: ['text', 'image'] }, 'inputLimits', {
              enumerable: true,
              get: () => imageLimits.inputLimits,
            }),
          ),
      })),
    approval: async () => 'allowed-once',
    // A reloaded original is put as an artifact; the result names it by its real digest.
    seams: {
      artifacts: {
        put: async (bytes, meta) => {
          artifacts.set(hex(bytes), bytes)
          return { sha256: hex(bytes), size: bytes.length, mime: meta?.mime ?? 'image/png' }
        },
      },
    },
    // As a worker assembles it: what lets a request carrying images be bounded and sent.
    requestMedia: composeProductionRequestMedia({
      readArtifact: async ({ sha256 }) => artifacts.get(sha256),
      surfaceLimits: {
        maxLedgerEvents: 10_000,
        maxSurfaceNodes: 2_048,
        maxContentBlocks: 4_096,
        maxManifestEntries: 8,
        maxCandidateBytes: 8 * 1024 * 1024,
        maxCandidatePixels: 8 * 1456 * 1456,
      },
      mediaLimits: {
        maxManifestEntries: 8,
        maxSelectedImages: 4,
        maxSelectedBlocks: 8,
        maxBytesPerImage: 1024 * 1024,
        maxDimensionPerImage: 1456,
        maxPixelsPerImage: 1456 * 1456,
        maxSelectedBytes: 4 * 1024 * 1024,
        maxSelectedPixels: 4 * 1456 * 1456,
      },
    }),
  })
  hosts.push(host)
  const store = createAttachmentStore({ dataDir: root })
  const session = async (key: string) => {
    const s = await host.createSession({ cwd: root, key })
    /** Answers the last user message with a turn whose model makes these reads; resolves to each tool result as JSON. */
    const turn = async (...calls: InferenceEvent[][]) => {
      answers.push(...calls)
      const from = s.lastSeq
      await s.run({ until: 'turn-end', signal: new AbortController().signal })
      return (await s.scan({ type: 'tool/result', fromSeq: from + 1, toSeq: s.lastSeq })).map((r) =>
        JSON.stringify(r.data),
      )
    }
    /** Queues one input and claims it, so it is a user message; resolves to its seq. */
    const message = async (content: ContentBlock[]) => {
      const from = s.lastSeq
      await s.enqueue('next-turn', { actor: s.d.actor, content })
      expect(await s.acceptInput()).toBe(true)
      const [row] = await s.scan({ type: 'user/message', fromSeq: from + 1, toSeq: s.lastSeq })
      if (!row) throw new Error('no user message')
      return { seq: row.seq, content: (row.data as { content: ContentBlock[] }).content }
    }
    const window = (seq: number, kind: 'image' | 'file', thumbnail = false) =>
      s.readAttachmentRange({ seq, kind, index: 1, offset: 0, length: 1024 * 1024, thumbnail })
    return { s, turn, message, window }
  }
  /** Every request the model was sent, as JSON. */
  const sent = () => (provider?.calls ?? []).map((request) => JSON.stringify(request))
  return { root, store, session, sent, imageLimits }
}

const upload = async (
  store: ReturnType<typeof createAttachmentStore>,
  bytes: Buffer,
  mimeType: string,
  receiptFor?: string,
) => {
  const object = await store.put(bytes, { kind: 'user-attachment', mimeType })
  await store.markUserAttachment(object, { mimeType, ...(receiptFor ? { receiptFor } : {}) })
  return object
}

describe('user attachment reads in an assembled host', () => {
  it('keeps a copy of an old inline attachment only when there is room for it, and reads it either way', async () => {
    for (const [limits, copied] of [
      [{ 'attachments.global_quota_bytes': 1 }, false],
      [{}, true],
    ] as const) {
      const { store, session } = await open(false, limits)
      const a = await session('reads-cache')
      const inline = await a.message([
        { type: 'file', mimeType: 'text/plain', name: 'notes.txt', data: TEXT.toString('base64') },
      ])
      expect(inline.content).toMatchObject([{ data: TEXT.toString('base64') }])
      const [result] = await a.turn(read({ path: `session-file://${inline.seq}/1` }))
      expect(result).toContain('kept by reference')
      expect(result).toContain('"isError":false')
      expect((await store.stat(hex(TEXT))) !== undefined).toBe(copied)
      if (copied) expect(await store.userAttachment(hex(TEXT))).toMatchObject({ receipts: [] })
    }
  })

  it('keeps references readable when storing by reference is off, and inline input inline', async () => {
    const { store, session } = await open(false)
    const a = await session('reads-off')
    const object = await upload(store, TEXT, 'text/plain')
    // A reference the session holds from before the switch was turned off.
    const {
      seqs: [seq],
    } = await a.s.append([
      a.s.ev('user/message', {
        content: [{ type: 'file', mimeType: 'text/plain', name: 'notes.txt', attachment: object }],
      }),
    ])
    await a.message([{ type: 'text', text: 'read it' }])
    const [result] = await a.turn(read({ path: `session-file://${seq}/1` }))
    expect(result).toContain('kept by reference')
    expect(result).toContain('"isError":false')
    const page = await a.window(seq as number, 'file')
    expect(Buffer.from(page.bytes).equals(TEXT)).toBe(true)
    expect(page).toMatchObject({ mimeType: 'text/plain', totalBytes: TEXT.byteLength })

    const inline = { type: 'file' as const, mimeType: 'text/plain', name: 'n.txt', data: 'QUJD' }
    expect((await a.message([inline])).content).toEqual([inline])
    expect(await store.stat(hex(Buffer.from('ABC')))).toBeUndefined()
  })

  it('reads an attachment stored when it was queued, refuses it once unmarked, and keeps it from other sessions', async () => {
    const { root, store, session } = await open(true)
    const a = await session('reads-a')
    const file = await a.message([
      { type: 'file', mimeType: 'text/plain', name: 'notes.txt', data: TEXT.toString('base64') },
    ])
    const ref = {
      type: 'file',
      mimeType: 'text/plain',
      name: 'notes.txt',
      attachment: { sha256: hex(TEXT), bytes: TEXT.byteLength },
    } as ContentBlock
    expect(file.content).toEqual([ref])
    // Stored at enqueue: marked as a user attachment, with no upload receipt.
    expect(await store.userAttachment(hex(TEXT))).toMatchObject({ receipts: [] })
    const [text, saved] = await a.turn(
      read({ path: `session-file://${file.seq}/1` }),
      read({ path: `session-file://${file.seq}/1`, saveTo: 'copy.txt' }),
    )
    expect(text).toContain('kept by reference')
    expect(saved).toContain('"isError":false')
    expect(readFileSync(join(root, 'copy.txt')).equals(TEXT)).toBe(true)
    expect(Buffer.from((await a.window(file.seq, 'file')).bytes).equals(TEXT)).toBe(true)
    const image = await a.message([{ type: 'image', mimeType: 'image/png', data: PNG8.toString('base64') }])
    expect(image.content).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        attachment: { sha256: hex(PNG8), bytes: PNG8.byteLength },
        width: 8,
        height: 8,
      },
    ])
    expect(Buffer.from((await a.window(image.seq, 'image')).bytes).equals(PNG8)).toBe(true)

    // Another session cannot name the object without a claim on it, and cannot reach this session's rows.
    const b = await session('reads-b')
    await expect(b.s.enqueue('next-turn', { actor: b.s.d.actor, content: [ref] })).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
    })
    await expect(b.window(file.seq, 'file')).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_FOUND' },
    })
    // An upload to that session gives it the claim; then it reads the same object.
    await upload(store, TEXT, 'text/plain', 'reads-b')
    const own = await b.message([ref])
    expect(Buffer.from((await b.window(own.seq, 'file')).bytes).equals(TEXT)).toBe(true)

    // Without its marker the object is refused exactly as an absent one is.
    rmSync(join(root, 'artifacts', 'user-attachment-meta', hex(TEXT).slice(0, 2), `${hex(TEXT)}.json`))
    const [unmarked] = await b.turn(read({ path: `session-file://${own.seq}/1` }))
    expect(unmarked).toContain('"isError":true')
    expect(unmarked).toContain('missing')
    expect(unmarked).not.toContain('kept by reference')
    await expect(a.window(file.seq, 'file')).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_MISSING' },
    })
    rmSync(join(root, 'artifacts', 'sha256', hex(PNG8).slice(0, 2), hex(PNG8)))
    await expect(a.window(image.seq, 'image')).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_MISSING' },
    })
  })

  it('sends a stored image to the model and reads it back through the read tool', async () => {
    const { store, session, sent } = await open(true)
    const a = await session('reads-image-turn')
    const image = await a.message([{ type: 'image', mimeType: 'image/png', data: PNG8.toString('base64') }])
    expect(image.content).toMatchObject([{ attachment: { sha256: hex(PNG8), bytes: PNG8.byteLength } }])
    const [result] = await a.turn(read({ path: `session-image://${image.seq}/1` }))
    expect(result).toContain('"isError":false')
    expect(result).not.toContain('cannot be read')
    // The turn's requests carried the image's bytes, read from the store.
    const requests = sent()
    expect(requests.length).toBeGreaterThanOrEqual(2)
    for (const request of requests) {
      expect(request).toContain(PNG8.toString('base64'))
      expect(request).not.toContain('"data":"undefined"')
    }
    expect(await store.userAttachment(hex(PNG8))).toBeDefined()
    // A history image whose object is gone becomes a note, and the next turn still goes out.
    rmSync(join(store.root, 'sha256', hex(PNG8).slice(0, 2), hex(PNG8)))
    await a.message([{ type: 'text', text: 'and again' }])
    await a.turn()
    const last = JSON.parse(sent().at(-1) ?? '{}') as {
      messages: Array<{ role: string; content: unknown[] }>
    }
    const user = last.messages.filter((m) => m.role === 'user').flatMap((m) => m.content)
    expect(user.filter((b) => (b as { type: string }).type === 'image')).toEqual([])
    expect(JSON.stringify(user)).toContain(`session-image://${image.seq}/1; original not included`)
  })

  it('asks the request version cache for a stored image larger than the route allows', async () => {
    const { store, session, imageLimits } = await open(true)
    const a = await session('reads-image-version')
    const image = await a.message([{ type: 'image', mimeType: 'image/png', data: PNG8.toString('base64') }])
    await a.turn()
    // The route now takes images at most 4 pixels wide, so the 8x8 image needs a smaller version. Its
    // object is gone (its marker is not): the cache reads it to make the version and finds it missing.
    imageLimits.inputLimits = { images: { resize: { maxWidth: 4 } } }
    rmSync(join(store.root, 'sha256', hex(PNG8).slice(0, 2), hex(PNG8)))
    await a.message([{ type: 'text', text: 'once more' }])
    await a.turn()
    const [header] = (
      await a.s.scan({ type: 'request/header', fromSeq: image.seq, toSeq: a.s.lastSeq })
    ).slice(-1)
    // Without the cache the image would only be counted as one the route cannot take (omitted: 1).
    expect((header?.data as { userImages?: unknown } | undefined)?.userImages).toEqual({
      included: [],
      omitted: 0,
      missing: [`${image.seq}/1`],
    })
  })

  it('serves a thumbnail admitted with its image, and admits only a marked one', async () => {
    const { store, session } = await open(false)
    const a = await session('reads-thumb')
    const image = await upload(store, PNG8, 'image/png', 'reads-thumb')
    const unmarked = await store.put(PNG1, { kind: 'thumbnail', mimeType: 'image/png' })
    const block = (thumbnail: { sha256: string; bytes: number }) =>
      ({
        type: 'image',
        mimeType: 'image/png',
        attachment: image,
        width: 8,
        height: 8,
        thumbnail: { ...thumbnail, width: 1, height: 1 },
      }) as ContentBlock
    await expect(
      a.s.enqueue('next-turn', { actor: a.s.d.actor, content: [block(unmarked)] }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' } })
    const thumbnail = await upload(store, PNG1, 'image/png', 'reads-thumb')
    const { seq } = await a.message([block(thumbnail)])
    const page = await a.window(seq, 'image', true)
    expect(Buffer.from(page.bytes).equals(PNG1)).toBe(true)
    expect(page).toMatchObject({ mimeType: 'image/png', totalBytes: PNG1.byteLength, sha256: hex(PNG1) })
  })
})
