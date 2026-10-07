import { createHash } from 'node:crypto'
import { copyFile, cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { decodeSafeImages } from '@agnes/protocol'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { docx, pdf, zip } from '../../package-manager/test/fixtures/document-reader.js'
import { documentReaderSource, prepareDocumentReader } from '../tools/document-reader.js'

type ImageRef = { sha256: string; size: number; mime: string }
type Result = {
  isError?: boolean
  content: ({ type: 'text'; text: string } | { type: 'image'; ref: ImageRef; mime: string })[]
}
type Args = {
  path: string
  page?: number
  entry?: string
  ocr?: string
  language?: string
  offset?: number
  mode?: string
}
type Context = {
  signal: AbortSignal
  outputMaxBytes: number
  artifacts: { put(bytes: Uint8Array, meta?: { mime?: string }): Promise<ImageRef> }
  session: {
    readAttachment(input: { path: string }): Promise<{ bytes: Uint8Array; mimeType: string } | undefined>
  }
}
type Tool = { execute(args: Args, ctx: Context): Promise<Result> }
let root: string, runtimeDirectory: string, tool: Tool, dispose: () => Promise<void>, scanned: Buffer
const images = new Map<string, Uint8Array>()
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agnes-document-reader-'))
  const original = join(root, 'original'),
    relocated = join(root, 'relocated runtime 文档')
  runtimeDirectory = relocated
  await cp(documentReaderSource, original, {
    recursive: true,
    filter: (path) => !path.includes('node_modules'),
  })
  await prepareDocumentReader(original)
  await rename(original, relocated)
  const { documentReader } = await import(pathToFileURL(join(relocated, 'index.mjs')).href)
  documentReader.apply({
    effect: (factory: () => () => Promise<void>) => {
      dispose = factory()
    },
    extension: () => ({
      registerTool: (registered: Tool) => {
        tool = registered
      },
    }),
  })
  const require = createRequire(join(documentReaderSource, 'package.json'))
  const { PDFiumLibrary } = await import(pathToFileURL(require.resolve('@hyzyla/pdfium')).href)
  const wasm = await readFile(join(relocated, 'src/runtime/assets/pdfium.wasm'))
  const library = await PDFiumLibrary.init({ wasmBinary: Uint8Array.from(wasm).buffer })
  const source = await library.loadDocument(pdf([{ text: 'HELLO DOCUMENT' }]))
  try {
    const bitmap = await source
      .getPage(0)
      .render({ scale: 1, render: 'bitmap', colorSpace: 'BGRA', transparent: false })
    const rgb = new Uint8Array(bitmap.width * bitmap.height * 3)
    for (let pixel = 0; pixel < bitmap.width * bitmap.height; pixel++) {
      rgb[pixel * 3] = bitmap.data[pixel * 4 + 2]
      rgb[pixel * 3 + 1] = bitmap.data[pixel * 4 + 1]
      rgb[pixel * 3 + 2] = bitmap.data[pixel * 4]
    }
    scanned = pdf([{ text: 'FIRST PAGE' }, { image: { width: bitmap.width, height: bitmap.height, rgb } }])
  } finally {
    source.destroy()
    library.destroy()
  }
}, 30000)
afterAll(async () => {
  await dispose?.()
  if (root) await rm(root, { recursive: true, force: true })
})

function context(bytes: Uint8Array, signal = new AbortController().signal): Context {
  return {
    signal,
    outputMaxBytes: 4096,
    artifacts: {
      put: async (bytes, meta) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        images.set(sha256, bytes)
        return { sha256, size: bytes.length, mime: meta?.mime ?? 'image/png' }
      },
    },
    session: {
      readAttachment: async ({ path }) =>
        path === 'session-file://1/1' ? { bytes, mimeType: 'application/octet-stream' } : undefined,
    },
  }
}
const call = (bytes: Uint8Array, args: Partial<Args> = {}, signal?: AbortSignal) =>
  tool.execute({ path: 'session-file://1/1', ...args }, context(bytes, signal))
const text = (result: Result) =>
  result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')

it('reads packaged PDF, DOCX, DOC and ZIP after relocation without source dependencies', async () => {
  for (const [bytes, expected] of [
    [pdf([{ text: 'PDF TEXT' }]), 'PDF TEXT'],
    [docx(), '你好 DOCUMENT'],
    [
      await readFile(
        new URL('../../package-manager/test/fixtures/document-reader/legacy.doc', import.meta.url),
      ),
      'Unicode characters',
    ],
    [zip([{ name: 'test.md', data: Buffer.from('hello') }]), 'test.md'],
  ] as const) {
    const result = await call(bytes)
    expect(result.isError, text(result)).not.toBe(true)
    expect(text(result)).toContain(expected)
  }
  const selected = await call(zip([{ name: 'doc.docx', data: docx() }]), { entry: 'doc.docx' })
  expect(text(selected)).toContain('你好 DOCUMENT')
})

it.each(['eng', 'chi_sim'])(
  'reads mixed/scanned PDF pages with packaged offline OCR: %s',
  async (language) => {
    const first = await call(scanned)
    expect(text(first)).toContain('FIRST PAGE')
    expect(text(first)).toContain('page=2')
    const second = await call(scanned, { page: 2, language })
    expect(second.isError, text(second)).not.toBe(true)
    expect(text(second)).toContain('OCR (may contain recognition errors)')
    expect(text(second)).toMatch(/HELLO\s+DOCUMENT/u)
    const disabled = await call(scanned, { page: 2, ocr: 'off' })
    expect(text(disabled)).not.toContain('HELLO DOCUMENT')
    expect((await call(scanned, { page: 3 })).isError).toBe(true)
  },
  30000,
)

it('recognizes Chinese text and can force OCR on an incomplete text layer', async () => {
  const rgb = inflateSync(
    await readFile(
      new URL(
        '../../package-manager/test/fixtures/document-reader/chinese-scan.rgb.deflate',
        import.meta.url,
      ),
    ),
  )
  const bytes = pdf([{ text: 'PAGE HEADER', image: { width: 600, height: 800, rgb } }])
  expect(text(await call(bytes))).toContain('PAGE HEADER')
  const result = await call(bytes, { ocr: 'always' })
  expect(result.isError, text(result)).not.toBe(true)
  expect(text(result).replace(/\s+/gu, '')).toContain('中文文档测试')
}, 30000)

it.each(['auto', 'image'])(
  'returns a bounded, correctly colored PDF page image in %s mode',
  async (mode) => {
    const rgb = Buffer.alloc(120 * 160 * 3)
    for (let pixel = 0; pixel < 120 * 160; pixel++) rgb[pixel * 3 + (pixel % 120 < 60 ? 0 : 2)] = 255
    const picture = pdf([{ image: { width: 120, height: 160, rgb } }])
    const result = await call(picture, { mode })
    expect(result.isError, text(result)).not.toBe(true)
    expect(text(result)).toContain('image block')
    const block = result.content.find((item) => item.type === 'image')
    if (block?.type !== 'image') throw new Error('PDF page image missing')
    const bytes = images.get(block.ref.sha256)
    if (!bytes) throw new Error('PDF page artifact missing')
    const [decoded] = decodeSafeImages(
      [{ data: Buffer.from(bytes).toString('base64'), mimeType: block.mime }],
      {
        maxBytesPerImage: 4 * 1024 * 1024,
        maxPixelsPerImage: 1456 * 1456,
        maxAggregateBytes: 4 * 1024 * 1024,
        maxAggregatePixels: 1456 * 1456,
      },
    )
    if (!decoded) throw new Error('PDF page could not be decoded')
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1456)
    // The page encoder emits opaque RGB PNG scanlines; sample both halves of this wire image.
    const idat: Uint8Array[] = []
    for (let at = 8; at < bytes.length; ) {
      const size = Buffer.from(bytes).readUInt32BE(at)
      if (Buffer.from(bytes.subarray(at + 4, at + 8)).toString() === 'IDAT')
        idat.push(bytes.subarray(at + 8, at + 8 + size))
      at += size + 12
    }
    const raw = inflateSync(Buffer.concat(idat))
    const pixel = (column: number) => [
      ...raw.subarray(
        Math.floor(decoded.height / 2) * (decoded.width * 3 + 1) + 1 + column * 3,
        Math.floor(decoded.height / 2) * (decoded.width * 3 + 1) + 4 + column * 3,
      ),
    ]
    expect(pixel(Math.floor(decoded.width / 4))).toEqual([255, 0, 0])
    expect(pixel(Math.floor((decoded.width * 3) / 4))).toEqual([0, 0, 255])
    const textOnly = await call(picture, { mode: 'text' })
    expect(textOnly.content.some((item) => item.type === 'image')).toBe(false)
    expect(text(textOnly)).toContain('does not prove the page is blank')
    const selected = await call(zip([{ name: 'picture.pdf', data: picture }]), {
      entry: 'picture.pdf',
      mode: 'image',
    })
    expect(selected.content.some((item) => item.type === 'image')).toBe(true)
    const mixed = await call(pdf([{ text: 'HEADER', image: { width: 120, height: 160, rgb } }]), {
      mode: 'image',
    })
    expect(text(mixed)).toContain('HEADER')
    expect(mixed.content.some((item) => item.type === 'image')).toBe(true)
  },
  30000,
)

it('reads with the shipped fallback OCR binary', async () => {
  const fast = join(runtimeDirectory, 'src/runtime/assets/tesseract-core.wasm')
  const original = await readFile(fast)
  try {
    await copyFile(join(runtimeDirectory, 'src/runtime/assets/tesseract-core-fallback.wasm'), fast)
    const result = await call(scanned, { page: 2, language: 'eng' })
    expect(result.isError, text(result)).not.toBe(true)
    expect(text(result)).toMatch(/HELLO\s+DOCUMENT/u)
  } finally {
    await writeFile(fast, original)
  }
}, 30000)

it('shrinks incompressible page images to fit the existing transport byte limit', async () => {
  const rgb = Buffer.alloc(1092 * 1456 * 3)
  let random = 123456789
  for (let at = 0; at < rgb.length; at++) {
    random ^= random << 13
    random ^= random >>> 17
    random ^= random << 5
    rgb[at] = random & 255
  }
  const result = await call(pdf([{ image: { width: 1092, height: 1456, rgb } }]), { mode: 'image' })
  expect(result.isError, text(result)).not.toBe(true)
  const block = result.content.find((item) => item.type === 'image')
  if (block?.type !== 'image') throw new Error('PDF page image missing')
  const bytes = images.get(block.ref.sha256)
  if (!bytes) throw new Error('PDF page artifact missing')
  const [image] = decodeSafeImages([{ data: Buffer.from(bytes).toString('base64'), mimeType: block.mime }], {
    maxBytesPerImage: 4 * 1024 * 1024,
    maxPixelsPerImage: 1456 * 1456,
    maxAggregateBytes: 4 * 1024 * 1024,
    maxAggregatePixels: 1456 * 1456,
  })
  expect(Math.max(image?.width ?? 0, image?.height ?? 0)).toBe(1024)
}, 30000)

it('terminates a timed-out worker and makes its slot available again', async () => {
  vi.useFakeTimers()
  try {
    const running = call(scanned, { page: 2 })
    await vi.advanceTimersByTimeAsync(90000)
    expect(text(await running)).toContain('DOCUMENT_READ_TIMEOUT')
  } finally {
    vi.useRealTimers()
  }
  expect(text(await call(docx()))).toContain('你好 DOCUMENT')
})

it('rejects arbitrary paths, missing attachments, oversize input and invalid PDFs', async () => {
  for (const [bytes, args] of [
    [Buffer.from('x'), { path: 'file:///private/file' }],
    [Buffer.from('x'), { path: 'session-file://2/1' }],
    [Buffer.alloc(100 * 1024 * 1024 + 1), {}],
    [Buffer.from('%PDF-1.7\nbroken'), {}],
    [scanned, { page: 2, language: '../../outside' }],
    [scanned, { mode: 'invalid' }],
    [docx(), { mode: 'image' }],
    [Buffer.alloc(0), { mode: 'image' }],
  ] as const)
    expect((await call(bytes, args)).isError).toBe(true)
  const bytes = pdf([{ text: 'PAGE' }])
  const ctx = context(bytes)
  ctx.artifacts.put = async () => {
    throw new Error('store unavailable')
  }
  const failed = await tool.execute({ path: 'session-file://1/1', mode: 'image' }, ctx)
  expect(failed.isError).toBe(true)
  expect(failed.content.some((item) => item.type === 'image')).toBe(false)
  const controller = new AbortController()
  const cancelledContext = context(bytes, controller.signal)
  const put = cancelledContext.artifacts.put
  cancelledContext.artifacts.put = async (...args) => {
    const ref = await put(...args)
    controller.abort()
    return ref
  }
  const cancelled = await tool.execute({ path: 'session-file://1/1', mode: 'image' }, cancelledContext)
  expect(cancelled.isError).toBe(true)
  expect(cancelled.content.some((item) => item.type === 'image')).toBe(false)
})

it('stops a running OCR worker on cancellation, permits a retry, and closes on disposal', async () => {
  const controller = new AbortController()
  const other = new AbortController()
  const running = call(scanned, { page: 2 }, controller.signal)
  const second = call(scanned, { page: 2 }, other.signal)
  expect(text(await call(docx()))).toContain('DOCUMENT_READER_BUSY')
  await new Promise((resolve) => setTimeout(resolve, 100))
  controller.abort()
  other.abort()
  expect(text(await running)).toContain('DOCUMENT_READ_CANCELLED')
  expect(text(await second)).toContain('DOCUMENT_READ_CANCELLED')
  expect(text(await call(docx()))).toContain('你好 DOCUMENT')
  const bytes = pdf([{ text: 'PAGE' }])
  const savingContext = context(bytes)
  let release!: () => void
  let started!: () => void
  const savingStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const saveAllowed = new Promise<void>((resolve) => {
    release = resolve
  })
  const put = savingContext.artifacts.put
  savingContext.artifacts.put = async (...args) => {
    started()
    await saveAllowed
    return put(...args)
  }
  const saving = tool.execute({ path: 'session-file://1/1', mode: 'image' }, savingContext)
  await savingStarted
  const pending = call(scanned, { page: 2 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await dispose()
  release()
  expect(text(await saving)).toContain('DOCUMENT_READER_DISABLED')
  expect(text(await pending)).toContain('DOCUMENT_READER_DISABLED')
  expect(text(await call(docx()))).toContain('DOCUMENT_READER_DISABLED')
})
