import { readFileSync } from 'node:fs'
import { checkToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { type FakeToolContext, fakeToolContext } from '../../../testkit/tool-context.js'

// These cases are sized against an 8 KiB limit, so they ask for it explicitly rather than taking the
// deployment default.
const ctxOf = (o: Parameters<typeof fakeToolContext>[0] = {}) =>
  fakeToolContext({ outputMaxBytes: 8192, ...o })

import { byteLength, outputLimits, spillLocator } from '../src/guards/output.js'
import { MAX_ARTIFACT_READ_BYTES, MAX_READ_BYTES, readTool } from '../src/tools/read.js'

const textOf = (r: { content: { type: string }[] }): string =>
  (r.content[0] as { type: 'text'; text: string }).text

describe('read', () => {
  it('has a complete definition', () => {
    expect(checkToolDef(readTool)).toEqual({ ok: true })
    expect(readTool.name).toBe('read')
  })

  it('declares itself read-only, replay-safe and never in need of approval', () => {
    expect(readTool.meta).toEqual({
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: {},
      deferLoading: false,
      requiresApproval: 'never',
    })
  })

  it('reads a real repository PNG through the filesystem and immutable artifact port', async () => {
    const bytes = readFileSync(new URL('../../../../../docs/assets/readme/banner.png', import.meta.url))
    const ctx = ctxOf({ files: { 'picture.png': bytes } })
    const result = await readTool.execute({ path: 'picture.png' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toMatchObject({ type: 'image', mime: 'image/png' })
    expect(ctx.calls.read[0]?.path).toBe('picture.png')
    expect(ctx.calls.artifacts).toHaveLength(1)
    expect(result.structured).toMatchObject({ image: { mime: 'image/png', size: bytes.length } })
  })

  it.each(['truncated', 'oversize', 'offset', 'gif'] as const)(
    'refuses %s images before storing any artifact',
    async (kind) => {
      const original = readFileSync(new URL('../../../../../docs/assets/readme/banner.png', import.meta.url))
      const bytes =
        kind === 'truncated'
          ? original.subarray(0, 30)
          : kind === 'oversize'
            ? new Uint8Array(MAX_READ_BYTES + 1)
            : kind === 'gif'
              ? new Uint8Array(Buffer.from(`GIF89a${'x'.repeat(20)}`))
              : original
      if (kind === 'oversize') bytes.set(original.subarray(0, 30))
      const ctx = ctxOf({ files: { picture: bytes } })
      const result = await readTool.execute(
        { path: 'picture', ...(kind === 'offset' ? { offset: 1 } : {}) },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content[0]?.type).toBe('text')
      expect(ctx.calls.artifacts).toHaveLength(0)
    },
  )

  it('returns numbered lines and honours offset/limit', async () => {
    const ctx = ctxOf({ files: { 'a.txt': 'l1\nl2\nl3\nl4' } })
    const all = await readTool.execute({ path: 'a.txt' }, ctx)
    expect(all.content[0]).toEqual({ type: 'text', text: '1\tl1\n2\tl2\n3\tl3\n4\tl4' })
    expect(all.structured).toEqual({
      codec: 'agnes-host-tool-fact-v1',
      tool: 'read',
      target: { kind: 'file', path: '/work/proj/a.txt', workspaceRelativePath: 'a.txt' },
      request: { offset: 1 },
      page: { firstLine: 1, lastLine: 4, availableLines: 4, totalLines: 4 },
      coverage: {
        complete: true,
        sourceTruncated: false,
        pageLimited: false,
        continuationSafe: true,
        outputTruncated: false,
        lineContentTruncated: false,
        truncatedLineCount: 0,
      },
    })
    const part = await readTool.execute({ path: 'a.txt', offset: 2, limit: 2 }, ctx)
    expect(part.content[0]).toEqual({ type: 'text', text: '2\tl2\n3\tl3' })
    expect(part.structured).toMatchObject({
      request: { offset: 2, limit: 2 },
      page: { firstLine: 2, lastLine: 3, totalLines: 4, nextOffset: 4 },
      coverage: { complete: false, pageLimited: true, continuationSafe: true },
    })
  })

  it('treats a trailing newline as ending the last line, not starting an empty one', async () => {
    const ctx = ctxOf({ files: { 'a.txt': 'l1\nl2\n', 'b.txt': 'l1\nl2\n\n' } })
    expect(textOf(await readTool.execute({ path: 'a.txt' }, ctx))).toBe('1\tl1\n2\tl2')
    // A genuinely blank final line is still shown; only the terminator is dropped.
    expect(textOf(await readTool.execute({ path: 'b.txt' }, ctx))).toBe('1\tl1\n2\tl2\n3\t')
  })

  it('keeps carriage returns instead of guessing at line endings', async () => {
    const ctx = ctxOf({ files: { 'a.txt': 'l1\r\nl2\r\n' } })
    expect(textOf(await readTool.execute({ path: 'a.txt' }, ctx))).toBe('1\tl1\r\n2\tl2\r')
  })

  it('reports a range past the end of the file instead of returning nothing', async () => {
    const ctx = ctxOf({ files: { 'a.txt': 'l1\nl2' } })
    const r = await readTool.execute({ path: 'a.txt', offset: 9 }, ctx)
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe('[no lines at offset 9; the file has 2 lines]')
  })

  it('reports missing file and binary file as errors', async () => {
    const ctx = ctxOf({ files: { 'b.bin': 'ab\u0000cd' } })
    const missing = await readTool.execute({ path: 'nope' }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.structured).toBeUndefined()
    expect(textOf(missing)).toContain('ENOENT')
    const bin = await readTool.execute({ path: 'b.bin' }, ctx)
    expect(bin.isError).toBe(true)
    expect(bin.structured).toBeUndefined()
    expect(bin.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('binary') })
    expect(textOf(bin)).toContain('5 bytes')
  })

  it('scans only the first 8 KB for the NUL that marks a binary file', async () => {
    // The bound is what keeps the check cheap on a large file. It is pinned rather than left
    // implicit: a NUL past it is not detected, and that is a known consequence, not an accident.
    const ctx = ctxOf({
      files: { 'late.bin': `${'a'.repeat(8192)}\u0000`, 'early.bin': `${'a'.repeat(8191)}\u0000` },
    })
    expect((await readTool.execute({ path: 'late.bin' }, ctx)).isError).toBeUndefined()
    expect((await readTool.execute({ path: 'early.bin' }, ctx)).isError).toBe(true)
  })

  it('hands the filesystem the path it was given, unchanged', async () => {
    // Rewriting the path here would mean the layer that enforces the workspace boundary checks one
    // string while the tool opens another.
    const ctx = ctxOf({ files: { '/work/proj/a.txt': 'x' } })
    await readTool.execute({ path: './a.txt' }, ctx)
    expect(ctx.calls.read[0]?.path).toBe('./a.txt')
  })

  it('bounds how many bytes it pulls off the filesystem', async () => {
    const ctx = ctxOf({ files: { 'big.txt': 'a'.repeat(MAX_READ_BYTES + 100) } })
    const r = await readTool.execute({ path: 'big.txt' }, ctx)
    // The read itself is capped, so the process never holds the whole file.
    expect(ctx.calls.read[0]?.opts?.limit).toBe(MAX_READ_BYTES + 1)
    expect(textOf(r)).toContain(`only the first ${MAX_READ_BYTES} bytes`)
    expect(r.structured).toMatchObject({
      coverage: { complete: false, sourceTruncated: true, continuationSafe: false },
    })
    expect((r.structured as { page: Record<string, unknown> }).page).not.toHaveProperty('totalLines')
    expect(byteLength(textOf(r))).toBeLessThanOrEqual(outputLimits(8192).maxBytes)
  })

  it('cuts the byte-capped text back to a line boundary instead of showing a half line', async () => {
    // The cap lands wherever 4 MiB lands, almost always mid-line. Numbering that fragment as if it
    // were a whole line invites an edit against text the file does not contain, so it is dropped.
    const width = 10
    const line = 'x'.repeat(width - 1)
    const lastWhole = Math.floor(MAX_READ_BYTES / width)
    expect(Number.isInteger(MAX_READ_BYTES / width)).toBe(false)
    const ctx = ctxOf({ files: { 'big.txt': `${line}\n`.repeat(lastWhole + 10) } })
    const page = textOf(await readTool.execute({ path: 'big.txt', offset: lastWhole - 2 }, ctx))
    expect(page.slice(page.lastIndexOf('\n') + 1)).toBe(`${lastWhole}\t${line}`)
    // The line the cap fell inside is absent entirely, not shown truncated.
    expect(page).not.toContain(`${lastWhole + 1}\t`)
  })

  it('pages a long file instead of cutting it, and never stores it', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `row ${i + 1} ${'a'.repeat(80)}`)
    const ctx = ctxOf({ files: { 'long.txt': lines.join('\n') } })
    const first = textOf(await readTool.execute({ path: 'long.txt' }, ctx))
    expect(byteLength(first)).toBeLessThanOrEqual(outputLimits(8192).maxBytes)
    expect(first).not.toContain('[truncated')
    const next = Number(/call read again with offset=(\d+) to continue\]$/.exec(first)?.[1])
    // The next page starts at the line after the last one shown: nothing is lost in between.
    expect(first).toContain(`${next - 1}\trow ${next - 1} `)
    expect(textOf(await readTool.execute({ path: 'long.txt', offset: next, limit: 1 }, ctx))).toBe(
      `${next}\t${lines[next - 1]}`,
    )
    expect(ctx.calls.artifacts).toHaveLength(0)
    // The page is as large as the context allows, not a fixed 8 KiB.
    const wide = ctxOf({ outputMaxBytes: 16384, files: { 'long.txt': lines.join('\n') } })
    const page = textOf(await readTool.execute({ path: 'long.txt' }, wide))
    expect(byteLength(page)).toBeGreaterThan(8192)
    expect(byteLength(page)).toBeLessThanOrEqual(16384)
  })

  it('cuts a line too long for a page and says so, keeping real line numbers', async () => {
    const ctx = ctxOf({ files: { 'min.js': `a\n${'z'.repeat(5000)}\nc` } })
    const page = textOf(await readTool.execute({ path: 'min.js' }, ctx))
    expect(page).toContain('2\tzzz')
    expect(page).toContain('[line cut at 2048 of 5000 bytes]')
    expect(page.endsWith('3\tc')).toBe(true)
    const result = await readTool.execute({ path: 'min.js' }, ctx)
    expect(result.structured).toMatchObject({
      coverage: {
        complete: false,
        lineContentTruncated: true,
        truncatedLineCount: 1,
        continuationSafe: false,
      },
    })
  })

  it('does not attach a ref when the output fits', async () => {
    const ctx = ctxOf({ files: { 'a.txt': 'short' } })
    const r = await readTool.execute({ path: 'a.txt' }, ctx)
    expect(r.content).toHaveLength(1)
  })

  it('decodes invalid utf-8 instead of throwing', async () => {
    const ctx = ctxOf({ files: { 'a.txt': new Uint8Array([0xff, 0xfe, 0x41]) } })
    const r = await readTool.execute({ path: 'a.txt' }, ctx)
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('A')
  })
})

describe('read of an artifact the output guard stored', () => {
  const enc = new TextEncoder()
  const store = async (ctx: FakeToolContext, text: string | Uint8Array): Promise<string> =>
    spillLocator(
      await ctx.artifacts.put(typeof text === 'string' ? enc.encode(text) : text, { mime: 'text/plain' }),
    )
  const sha = 'a'.repeat(64)

  // Reads to the end the way a model would: follow the continuation hint until there is none. Every
  // page has to fit the output limit.
  async function readAll(ctx: FakeToolContext, path: string): Promise<string[]> {
    const rows: string[] = []
    for (let offset = 1; ; ) {
      const text = textOf(await readTool.execute({ path, offset }, ctx))
      expect(byteLength(text)).toBeLessThanOrEqual(outputLimits(8192).maxBytes)
      rows.push(
        ...text
          .split('\n')
          .filter((l) => /^\d+\t/.test(l))
          .map((l) => l.replace(/^\d+\t/, '')),
      )
      const next = /offset=(\d+) to continue\]$/.exec(text)
      if (!next) return rows
      offset = Number(next[1])
    }
  }

  it('pages a stored output back in full: many lines, a few huge lines, wide characters', async () => {
    const ctx = ctxOf()
    const many = Array.from({ length: 133 }, (_, i) => `line ${i + 1} ${'x'.repeat(70)}`).join('\n')
    expect((await readAll(ctx, await store(ctx, many))).join('\n')).toBe(many)
    // A JSON result is tens of KB on a handful of lines: paging by line alone would leave most of it
    // out of reach, so long lines are shown as several.
    const huge = Array.from({ length: 8 }, (_, i) => `${i}:${'ab'.repeat(2400)}`).join('\n')
    expect((await readAll(ctx, await store(ctx, huge))).join('')).toBe(huge.replaceAll('\n', ''))
    const wide = '中'.repeat(5000)
    expect((await readAll(ctx, await store(ctx, wide))).join('')).toBe(wide)
    expect(ctx.calls.read).toHaveLength(0)
    expect(ctx.calls.artifacts).toHaveLength(3) // the pages were not put back into the store
  })

  it('honours offset and limit and reports a range past the end', async () => {
    const ctx = ctxOf()
    const path = await store(ctx, 'a\nb\nc\nd')
    const result = await readTool.execute({ path, offset: 2, limit: 2 }, ctx)
    expect(textOf(result)).toBe('2\tb\n3\tc')
    expect(result.structured).toMatchObject({
      codec: 'agnes-host-tool-fact-v1',
      tool: 'read',
      target: { kind: 'artifact', path },
      request: { offset: 2, limit: 2 },
      page: { firstLine: 2, lastLine: 3, availableLines: 4, totalLines: 4, nextOffset: 4 },
      coverage: { complete: false, sourceTruncated: false, continuationSafe: true },
    })
    expect(textOf(await readTool.execute({ path, offset: 9 }, ctx))).toBe(
      '[no lines at offset 9; the artifact has 4 lines]',
    )
  })

  it.each([
    ['a locator without its size', `artifact://${sha}`, 'missing its ?size=', 0],
    ['a locator with a stray parameter', `artifact://${sha}?size=3&x=1`, 'artifact locator', 0],
    ['a size no number holds exactly', `artifact://${sha}?size=99999999999999999999`, 'artifact locator', 0],
    ['an artifact that is not stored', `artifact://${sha}?size=3`, 'artifact not found', 1],
    [
      'an artifact too large to hold',
      `artifact://${sha}?size=${MAX_ARTIFACT_READ_BYTES + 1}`,
      'too large',
      0,
    ],
  ])('refuses %s', async (_why, path, message, asked) => {
    const ctx = ctxOf()
    const r = await readTool.execute({ path }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(message)
    // A refusal that can be decided from the locator alone never reaches the store.
    expect(ctx.calls.artifactGets).toHaveLength(asked)
  })

  it('refuses a stored size that is wrong and content that is not text', async () => {
    const ctx = ctxOf()
    const wrongSize = (await store(ctx, 'hello')).replace(/size=5$/, 'size=6')
    expect(textOf(await readTool.execute({ path: wrongSize }, ctx))).toContain('size mismatch')
    const binary = await readTool.execute({ path: await store(ctx, new Uint8Array([97, 0, 98])) }, ctx)
    expect(binary.isError).toBe(true)
    expect(textOf(binary)).toContain('binary')
    // A store may reject with something that is not an Error; that must come back as a failed read,
    // not escape execute() and end the turn.
    ctx.artifacts.get = () => Promise.reject(null)
    const hostile = await readTool.execute({ path: `artifact://${sha}?size=3` }, ctx)
    expect(hostile.isError).toBe(true)
    expect(textOf(hostile)).toContain('read failed')
  })
})
