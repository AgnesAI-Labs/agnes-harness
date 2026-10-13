import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { TOOLS_CORE } from '@agnes/base'
import { fakeToolContext } from '@agnes/base/testkit'
import { testFsPolicy } from '@agnes/core/testkit'
import type { ToolContext, ToolDef, ToolResult } from '@agnes/extension-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFs } from '../../src/adapters/fs.js'

// The tools-core image tests run on a memory file system, which returns stored bytes for a windowed
// read. The real adapter decodes a windowed read as text and re-encodes it, which mangles every
// image, and it follows links and resolves `..` before the policy decides. These cases run `read`
// on the real adapter and a real directory, so the pixels and the workspace boundary are the ones
// a session actually gets.

const read = TOOLS_CORE.find((tool) => tool.name === 'read') as ToolDef
const text = (result: ToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
/** An 8-bit RGB PNG of a horizontal gradient: bytes over 0x7f everywhere, which a text round trip destroys. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2], 8)
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 3; x++) rows[y * (width * 3 + 1) + 1 + x] = 128 + ((x * 7 + y) % 128)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ])
}
const pngSize = (bytes: Uint8Array): [number, number] => {
  const view = Buffer.from(bytes)
  return [view.readUInt32BE(16), view.readUInt32BE(20)]
}
// 24x16 baseline JPEG.
const JPEG = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAQF/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgNBCAA//9k=',
  'base64',
)

type Sent = { bytes: Uint8Array; mimeType: string; name: string }

describe('read on workspace images through the real file system adapter', () => {
  let parent: string
  let root: string
  beforeEach(() => {
    parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-read-image-')))
    root = join(parent, 'ws')
    mkdirSync(root)
  })
  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  const session = () => {
    const sent: Sent[] = []
    const base = fakeToolContext({ cwd: root })
    const ctx = Object.assign(base, {
      fs: createFs(() => ({ policy: testFsPolicy(root), caseSensitive: true })),
      session: {
        ...base.session,
        imageInputPolicy: async () => ({
          supported: true,
          maxWidth: 1456,
          maxHeight: 1456,
          maxBytes: 4 * 1024 * 1024,
          maxPixels: 1456 * 1456,
        }),
        imageInput: async (input: Sent): Promise<ToolResult> => {
          sent.push(input)
          return { content: [{ type: 'text', text: 'image accepted' }] }
        },
      },
    }) as ToolContext
    return { ctx, sent }
  }
  const run = (args: Record<string, unknown>, ctx: ToolContext) => read.execute(args as never, ctx)

  it('hands the model the PNG and JPEG pixels the file holds, not a text round trip of them', async () => {
    writeFileSync(join(root, 'a.png'), png(40, 30))
    writeFileSync(join(root, 'b.jpg'), JPEG)
    const { ctx, sent } = session()
    expect((await run({ path: 'a.png' }, ctx)).isError).toBeUndefined()
    expect((await run({ path: 'b.jpg', max_edge: 64 }, ctx)).isError).toBeUndefined()
    expect(sent.map((s) => [s.mimeType, s.name])).toEqual([
      ['image/png', 'a.png'],
      ['image/jpeg', 'b.jpg'],
    ])
    expect(pngSize((sent[0] as Sent).bytes)).toEqual([40, 30])
    expect([...(sent[1] as Sent).bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  })

  it('recognises images by the bytes a windowed read leaves of them, whatever their names', async () => {
    writeFileSync(join(root, 'a.bin'), png(40, 30))
    writeFileSync(join(root, 'b.dat'), JPEG)
    const { ctx, sent } = session()
    // What the text path's first read gets: every byte that is not UTF-8 turned into U+FFFD.
    const first = async (path: string) =>
      Buffer.from(
        (await ctx.fs.read(path, { offset: 0, limit: 4 * 1024 * 1024 + 1 })).subarray(0, 10),
      ).toString('hex')
    expect(await first('a.bin')).toBe('efbfbd504e470d0a1a0a')
    expect((await first('b.dat')).slice(0, 18)).toBe('efbfbdefbfbdefbfbd')
    await run({ path: 'a.bin' }, ctx)
    await run({ path: 'b.dat' }, ctx)
    expect(sent.map((s) => s.mimeType)).toEqual(['image/png', 'image/jpeg'])
  })

  it('follows a link that stays inside the workspace, and a path through `..` that does', async () => {
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.png'), png(16, 16))
    symlinkSync(join(root, 'sub', 'a.png'), join(root, 'link.png'))
    const { ctx, sent } = session()
    await run({ path: 'link.png' }, ctx)
    await run({ path: 'sub/../sub/a.png' }, ctx)
    expect(sent.map((s) => pngSize(s.bytes))).toEqual([
      [16, 16],
      [16, 16],
    ])
  })

  it('refuses an image reached through a link or `..` that leaves the workspace', async () => {
    writeFileSync(join(parent, 'outside.png'), png(16, 16))
    symlinkSync(join(parent, 'outside.png'), join(root, 'escape.png'))
    const { ctx, sent } = session()
    for (const path of ['escape.png', '../outside.png', join(parent, 'outside.png')]) {
      const result = await run({ path }, ctx)
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/^read failed: .*outside every allow rule/)
    }
    expect(sent).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('never opens a FIFO a second time', async () => {
    const fifo = join(root, 'pipe.png')
    execFileSync('mkfifo', [fifo])
    const { ctx, sent } = session()
    // One writer, so the first open sees the image and EOF; a second open would wait forever.
    const writer = writeFile(fifo, png(16, 16))
    const result = await run({ path: 'pipe.png' }, ctx)
    await writer
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^binary file \(\d+ bytes\); use shell tools to inspect it$/)
    expect(sent).toEqual([])
  })

  it('reads text files as before, including one that starts with an image signature byte', async () => {
    writeFileSync(join(root, 'notes.txt'), 'one\ntwo\n')
    writeFileSync(join(root, 'odd.txt'), Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\nnext\n')]))
    const { ctx, sent } = session()
    expect(await run({ path: 'notes.txt' }, ctx)).toEqual({
      content: [{ type: 'text', text: '1\tone\n2\ttwo' }],
    })
    expect(await run({ path: 'odd.txt' }, ctx)).toEqual({
      content: [{ type: 'text', text: '1\t�PNG\n2\tnext' }],
    })
    expect(sent).toEqual([])
  })
})
