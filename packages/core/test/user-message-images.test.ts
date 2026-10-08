import { sha256Hex } from '@agnes/core-common/request/hash'
import type { ToolContext } from '@agnes/extension-api'
import { type ModelRecord, USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { readSessionAttachment } from '../src/request/session-files.js'
import { readSessionImages } from '../src/request/session-images.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
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
const image = (data = png) => ({ type: 'image' as const, mimeType: 'image/png', data })
const file = (data = Buffer.from('original attachment content').toString('base64')) => ({
  type: 'file' as const,
  mimeType: 'application/octet-stream',
  name: 'data.bin',
  data,
})

it('snapshots attachment bytes before waiting for the enqueue lock', async () => {
  const { session } = await openSession({ provider: fakeProvider([]) })
  const original = file()
  const content = [original]
  const enqueued = session.enqueue('next-turn', { content, actor })
  original.data = 'corrupted after validation'
  await enqueued
  expect(session.latest('inbox')).toMatchObject({ items: [{ content: [file()] }] })
})

it.each([
  ['invalid Base64', [file('AB==')]],
  ['invalid name', [{ ...file(), name: 'bad\u0000name' }]],
  ['invalid MIME', [{ ...file(), mimeType: 'text/plain\nInjected' }]],
  ['too many attachments', Array.from({ length: 51 }, () => file(''))],
  ['mixed aggregate bytes', [file(Buffer.alloc(100 * 1024 * 1024).toString('base64')), image()]],
])('rejects %s before saving an attachment', async (_label, content) => {
  const { session, log } = await openSession({ provider: fakeProvider([]) })
  await expect(session.enqueue('next-turn', { content, actor })).rejects.toMatchObject({ code: 'E_ENVELOPE' })
  expect(await log.scan({ type: 'inbox', limit: 10 })).toEqual([])
})

it.each(['direct', 'nested'] as const)(
  'keeps file originals outside model context and marks %s reads untrusted',
  async (mode) => {
    const scripts = [textTurn('saved')]
    const provider = fakeProvider(scripts)
    provider.models = () => [{ ...model, input: ['text'] }]
    const registry = new ToolRegistry()
    registry.add(
      {
        name: 'read',
        description: 'read',
        parameters: Type.Object({ path: Type.String() }),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'safe',
          costHint: {},
          deferLoading: false,
          requiresApproval: 'never',
        },
        execute: async (args: unknown, context: ToolContext) => {
          const original = await context.session.readAttachment?.(args as { path: string })
          return {
            content: [
              {
                type: 'text' as const,
                text: original ? new TextDecoder().decode(original.bytes) : 'unavailable',
              },
            ],
          }
        },
      },
      { source: 'agnes/tools-core', trust: 'builtin' },
    )
    registry.add(
      {
        name: 'relay',
        description: 'relay the attachment reader',
        parameters: Type.Object({ path: Type.String() }),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'safe',
          costHint: {},
          deferLoading: false,
          requiresApproval: 'never',
        },
        execute: (args: unknown, context: ToolContext) =>
          context.tools.invoke('read', args as { path: string }),
      },
      { source: 'agnes/tools-core', trust: 'builtin' },
    )
    const { session, log } = await openSession({ provider, registry })
    const content = [file(), { ...file(''), name: 'empty.txt', mimeType: 'text/plain' }]
    await session.enqueue('next-turn', { content, actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const [row] = await log.scan({ type: 'user/message', lane: 'main', limit: 1 })
    if (!row) throw new Error('missing saved message')
    const path = `session-file://${row.seq}/1`
    const request = JSON.stringify(provider.requests[0])
    expect(request).toContain(path)
    expect(request).toContain('<untrusted')
    expect(request).not.toContain(content[0]?.data)
    const read = (path: string) => readSessionAttachment(session, { path }, new AbortController().signal)
    expect(new TextDecoder().decode((await read(path))?.bytes)).toBe('original attachment content')
    expect((await read(`session-file://${row.seq}/2`))?.bytes).toHaveLength(0)
    expect(await read(`${path},${path}`)).toBeUndefined()
    expect(await read('session-file://999999/1')).toBeUndefined()
    const foreign = await log.append([session.ev('user/message', { content: [file()] }, { lane: 'other' })])
    expect(await read(`session-file://${foreign.firstSeq}/1`)).toBeUndefined()
    const list = await readSessionAttachment(
      session,
      { path: 'session-file://list', limit: 1 },
      new AbortController().signal,
    )
    expect(new TextDecoder().decode(list?.bytes)).toContain('offset=2')
    const controller = new AbortController()
    controller.abort()
    await expect(readSessionAttachment(session, { path }, controller.signal)).rejects.toThrow('cancelled')
    scripts.push(toolTurn(mode === 'nested' ? 'relay' : 'read', { path }), textTurn('read'))
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'inspect the attachment' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const toolResults = await log.scan({ type: 'tool/result', limit: 3 })
    expect(toolResults).toHaveLength(mode === 'nested' ? 2 : 1)
    expect(toolResults.every((result) => result.trust === 'untrusted')).toBe(true)
    expect(JSON.stringify(provider.requests.at(-1))).toContain('original attachment content')
    expect((row.data as { content: unknown }).content).toEqual(content)
  },
)

describe('user message images', () => {
  it('refuses image backlog overflow before replacing the durable inbox', async () => {
    const provider = fakeProvider([])
    provider.models = () => [model]
    const { session, log } = await openSession({ provider })
    const bytes = Buffer.alloc(USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes)
    bytes.set([
      0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
    ])
    bytes.set([0xff, 0xd9], bytes.length - 2)
    const backlogImage = { type: 'image' as const, mimeType: 'image/jpeg', data: bytes.toString('base64') }
    const content = [backlogImage]
    await session.enqueue('next-turn', { content, actor })
    await expect(session.enqueue('next-turn', { content, actor })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
    })
    // A known oversized backlog is refused before decoding a second huge, malformed image.
    const malformed = [{ ...backlogImage, data: backlogImage.data.slice(0, -4) + '!!!!' }]
    await expect(session.enqueue('next-turn', { content: malformed, actor })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
      message: expect.stringContaining('Queued inputs are too large'),
    })
    expect(session.latest('inbox')).toMatchObject({ items: [{ content }] })
    expect(await log.scan({ type: 'inbox', limit: 10 })).toHaveLength(1)
  })

  it('accepts valid inline PNG content into the shared session input queue', async () => {
    const provider = fakeProvider([])
    provider.models = () => [model]
    const { session } = await openSession({ provider })
    const content = Array.from({ length: 5 }, () => image())

    await session.enqueue('next-turn', { content, actor })

    expect(session.latest('inbox')).toMatchObject({ items: [{ content }] })
  })

  it('rejects malformed images before they enter the durable inbox', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })

    await expect(
      session.enqueue('next-turn', { content: [image(png.slice(0, 24))], actor }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE' })

    expect(session.latest('inbox')).toBeUndefined()
    expect(await log.scan({ type: 'inbox', limit: 10 })).toHaveLength(0)
  })

  it('enforces raw byte limits before decoding image payloads', async () => {
    const provider = fakeProvider([])
    provider.models = () => [model]
    const { session } = await openSession({ provider })
    const oversizedImage = image(
      'A'.repeat(4 * Math.ceil((USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage + 1) / 3)),
    )

    await expect(session.enqueue('next-turn', { content: [oversizedImage], actor })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
    })
    expect(session.latest('inbox')).toBeUndefined()
  })
})

it.each([
  ['unknown model', undefined],
  ['text-only model', { ...model, input: ['text'] }],
  ['per-message limit', { ...model, inputLimits: { images: { maxPerMessage: 1 } } }],
  ['encoded bytes', { ...model, inputLimits: { images: { resize: { maxBytes: png.length - 1 } } } }],
] as const)('rejects %s before persisting user images', async (_name, record) => {
  const provider = fakeProvider([])
  provider.models = () => (record ? [structuredClone(record) as ModelRecord] : [])
  const { session, log } = await openSession({ provider })
  await expect(session.enqueue('next-turn', { content: [image(), image()], actor })).rejects.toMatchObject({
    code: 'E_ENVELOPE',
  })
  expect(await log.scan({ type: 'inbox', limit: 10 })).toEqual([])
})

it('runs a long image conversation and reloads originals through the existing tool-result media path', async () => {
  const sources = [
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAMTh+PrQAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAMqF3bw4AAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
  ]
  const source = sources[0] as string
  const sourceAt = (i: number) => sources[i === 1 ? 1 : i === 17 ? 2 : 0] as string
  const scripts = Array.from({ length: 40 }, (_, i) => textTurn(`description ${i + 1}`))
  const provider = fakeProvider(scripts)
  provider.models = () => [{ ...model, contextWindow: 128000, inputLimits: { images: { maxPerRequest: 4 } } }]
  const artifacts = new Map<string, Uint8Array>()
  const registry = new ToolRegistry()
  registry.add(
    {
      name: 'read',
      description: 'read',
      parameters: Type.Object({ path: Type.String() }),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: {},
        deferLoading: false,
        requiresApproval: 'never',
      },
      execute: async (args: unknown, ctx: ToolContext) =>
        ctx.session.readImages?.(args as { path: string }) ?? { content: [] },
    },
    { source: 'agnes/tools-core', trust: 'builtin' },
  )
  const { session, log } = await openSession({
    provider,
    registry,
    imageInputTokenFallback: ({ imageCount }) => ({ tokens: 128, imageCount }),
    seams: (await import('./helpers/fake-seams.js')).fakeSeams({
      artifacts: {
        put: async (bytes, meta) => {
          const sha256 = sha256Hex(bytes)
          artifacts.set(sha256, bytes)
          return { sha256, size: bytes.length, mime: meta?.mime ?? 'image/png' }
        },
      },
    }),
    requestMedia: {
      readArtifact: async ({ sha256 }) => artifacts.get(sha256),
      surfaceLimits: {
        maxLedgerEvents: 4096,
        maxSurfaceNodes: 512,
        maxContentBlocks: 4096,
        maxManifestEntries: 32,
        maxCandidateBytes: 1024 * 1024,
        maxCandidatePixels: 8_000_000,
      },
      mediaLimits: {
        maxManifestEntries: 32,
        maxSelectedImages: 4,
        maxSelectedBlocks: 8,
        maxBytesPerImage: 1024 * 1024,
        maxDimensionPerImage: 1456,
        maxPixelsPerImage: 1456 * 1456,
        maxSelectedBytes: 1024 * 1024,
        maxSelectedPixels: 8_000_000,
      },
    },
  })
  for (let i = 0; i < 40; i++) {
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: `picture ${i + 1}` }, image(sourceAt(i))],
      actor,
    })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
  }
  const rows = await log.scan({ type: 'user/message', lane: 'main', limit: 100 })
  const originals = rows.filter((row) =>
    (row.data as { content?: { type: string }[] }).content?.some((b) => b.type === 'image'),
  )
  expect(originals).toHaveLength(40)
  expect(
    provider.requests.at(-1)?.messages.flatMap((m) => m.content.filter((b) => b.type === 'image')),
  ).toHaveLength(3)
  const list = await readSessionImages(
    session,
    { path: 'session-image://list', offset: 18, limit: 2 },
    new AbortController().signal,
  )
  expect(list.content[0]).toMatchObject({
    text: expect.stringContaining(`18. session-image://${originals[17]?.seq}/1`),
  })
  expect(list.content[0]).toMatchObject({ text: expect.stringContaining('offset=20') })
  const reference = `session-image://${originals[1]?.seq}/1,${originals[17]?.seq}/1,${originals[29]?.seq}/1`
  const history = session.surface()
  const end = history[history.findIndex((node) => node.seq === originals[35]?.seq) - 1]?.seq
  if (!end || !originals[0]) throw new Error('missing history')
  scripts.push(toolTurn('read', { path: reference }), textTurn('compared originals'))
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: 'compare pictures 2, 18 and 30' }],
    actor,
  })
  expect(await session.acceptInput()).toBe(true)
  await log.append([
    session.ev(
      'assistant/message',
      {
        content: [
          {
            type: 'text',
            text: 'Earlier pictures described; use read session-image://list to reload originals.',
          },
        ],
        stopReason: 'end_turn',
      },
      {
        surfaceOp: { op: 'replace', start: originals[0].seq, end },
        sourceEventSeqs: history
          .filter((node) => node.seq >= (originals[0]?.seq ?? 0) && node.seq <= end)
          .map((node) => node.seq),
      },
    ),
  ])
  expect(session.surface().some((node) => node.seq === originals[0]?.seq)).toBe(false)
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  const final = provider.requests.at(-1)
  expect(final?.messages.flatMap((m) => m.content.filter((b) => b.type === 'image'))).toHaveLength(4)
  expect(
    final?.messages
      .filter((m) => m.role === 'tool_result')
      .flatMap((m) => m.content.filter((b) => b.type === 'image')),
  ).toHaveLength(3)
  expect(
    final?.messages
      .filter((m) => m.role === 'tool_result')
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'image'),
  ).toEqual([image(sourceAt(1)), image(sourceAt(17)), image(sourceAt(29))])
  for (const path of [
    'session-image://0/1',
    'session-image://1/1',
    `session-image://${session.lastSeq + 1}/1`,
    'session-image://other-session/1',
    `${reference},1/1`,
  ])
    expect((await readSessionImages(session, { path }, new AbortController().signal)).isError).toBe(true)
  const duplicate = await readSessionImages(
    session,
    { path: `session-image://${originals[0]?.seq}/1,${originals[2]?.seq}/1` },
    new AbortController().signal,
  )
  expect(duplicate.content.filter((b) => b.type === 'image')).toHaveLength(1)
  scripts.push(toolTurn('read', { path: reference }), textTurn('compared again'))
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: 'compare those originals again' }],
    actor,
  })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(
    provider.requests
      .at(-1)
      ?.messages.filter((m) => m.role === 'tool_result')
      .flatMap((m) => m.content.filter((b) => b.type === 'image')),
  ).toHaveLength(3)
  const oldBlockLimit = session.d.requestMedia?.mediaLimits.maxSelectedBlocks
  if (!session.d.requestMedia || oldBlockLimit === undefined) throw new Error('missing media limits')
  session.d.requestMedia = {
    ...session.d.requestMedia,
    mediaLimits: { ...session.d.requestMedia.mediaLimits, maxSelectedBlocks: 2 },
  }
  expect((await readSessionImages(session, { path: reference }, new AbortController().signal)).isError).toBe(
    true,
  )
  session.d.requestMedia = {
    ...session.d.requestMedia,
    mediaLimits: { ...session.d.requestMedia.mediaLimits, maxSelectedBlocks: oldBlockLimit },
  }
  scripts.push(textTurn('new originals'))
  await session.enqueue('next-turn', { content: Array.from({ length: 4 }, () => image(source)), actor })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(
    provider.requests.at(-1)?.messages.flatMap((m) => m.content.filter((b) => b.type === 'image')),
  ).toHaveLength(4)
  expect(
    provider.requests
      .at(-1)
      ?.messages.filter((m) => m.role === 'tool_result')
      .flatMap((m) => m.content.filter((b) => b.type === 'image')),
  ).toHaveLength(0)
  provider.models = () => [{ ...model, contextWindow: 128000 }]
  scripts.push(textTurn('six originals supported'))
  await session.enqueue('next-turn', { content: Array.from({ length: 6 }, () => image(source)), actor })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(
    provider.requests
      .at(-1)
      ?.messages.at(-1)
      ?.content.filter((b) => b.type === 'image'),
  ).toHaveLength(6)
  provider.models = () => [{ ...model, input: ['text'] }]
  expect((await readSessionImages(session, { path: reference }, new AbortController().signal)).isError).toBe(
    true,
  )
  scripts.push(textTurn('continued from descriptions'))
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: 'continue from the descriptions' }],
    actor,
  })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(
    provider.requests.at(-1)?.messages.flatMap((m) => m.content.filter((b) => b.type === 'image')),
  ).toEqual([])
  provider.models = () => [{ ...model, input: undefined } as unknown as ModelRecord]
  expect((await readSessionImages(session, { path: reference }, new AbortController().signal)).isError).toBe(
    true,
  )
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    readSessionImages(session, { path: 'session-image://list' }, cancelled.signal),
  ).rejects.toThrow('cancelled')
})
