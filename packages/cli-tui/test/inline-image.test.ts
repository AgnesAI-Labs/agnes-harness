import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactRef, UINode } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import type { Component } from '../src/component.js'
import {
  fitCells,
  type ImageProtocol,
  imageKind,
  imageProtocol,
  imageSize,
  mimeAccepted,
} from '../src/image-protocol.js'
import { InlineImages, WithImages } from '../src/inline-image.js'
import { tt } from '../src/locale-extended.js'
import { nodeView } from '../src/node-view.js'
import { Renderer } from '../src/renderer.js'
import { FakeTerminal } from '../src/terminal.js'
import { TuiTheme } from '../src/theme.js'

const png = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}
const gif = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(20)
  bytes.write('GIF89a')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}
const jpeg = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(40)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(bytes)
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]).copy(bytes, 20)
  bytes.writeUInt16BE(height, 25)
  bytes.writeUInt16BE(width, 27)
  return bytes
}

const userNode = (data: Buffer, mimeType = 'image/png'): UINode => ({
  kind: 'user',
  id: 'u1',
  seq: 1,
  content: [{ type: 'image', data: data.toString('base64'), mimeType }],
})

function setup(
  protocol: ImageProtocol | undefined,
  options: { raw?: boolean; path?: string; cacheBytes?: number } = {},
) {
  const repaint = vi.fn()
  const call = vi.fn()
  const images = new InlineImages({
    protocol,
    path: options.path,
    raw: () => options.raw ?? false,
    ...(options.cacheBytes ? { cacheBytes: options.cacheBytes } : {}),
    session: () => ({ id: 'sess', client: { call } }) as unknown as Session,
    repaint,
  })
  return { images, repaint, call }
}

/** A screen that shows rows `from..from+rows` of the given content, like the timeline's viewport. */
class Viewport implements Component {
  from = 0
  constructor(
    private readonly content: () => string[],
    private readonly rows: number,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    void width
    return this.content().slice(this.from, this.from + this.rows)
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('imageProtocol', () => {
  it.each([
    [{ TERM_PROGRAM: 'iTerm.app' }, 'iterm2'],
    [{ LC_TERMINAL: 'iTerm2' }, 'iterm2'],
    [{ TERM_PROGRAM: 'WezTerm' }, 'iterm2'],
    [{ TERM: 'xterm-kitty' }, 'kitty'],
    [{ KITTY_WINDOW_ID: '3' }, 'kitty'],
    [{ TERM_PROGRAM: 'ghostty' }, 'kitty'],
    [{ GHOSTTY_RESOURCES_DIR: '/x' }, 'kitty'],
  ])('confirms %j as %s', (env, protocol) => expect(imageProtocol(env)).toBe(protocol))

  it.each([
    [{}],
    [{ TERM: 'xterm-256color' }],
    [{ TERM_PROGRAM: 'Apple_Terminal' }],
    [{ TERM_PROGRAM: 'vscode' }],
    [{ WT_SESSION: 'x' }],
    [{ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux-1/default,1,0' }],
    [{ TERM: 'xterm-kitty', STY: '1.pts' }],
    [{ KITTY_WINDOW_ID: '1', TERM: 'screen-256color' }],
  ])('gives %j nothing', (env) => expect(imageProtocol(env)).toBeUndefined())
})

describe('image bytes', () => {
  it('knows the format from the magic number, and the size from the header', () => {
    expect(imageKind(png(30, 20))).toBe('png')
    expect(imageSize(png(30, 20), 'png')).toEqual({ width: 30, height: 20 })
    expect(imageKind(gif(5, 6))).toBe('gif')
    expect(imageSize(gif(5, 6), 'gif')).toEqual({ width: 5, height: 6 })
    expect(imageKind(jpeg(64, 48))).toBe('jpeg')
    expect(imageSize(jpeg(64, 48), 'jpeg')).toEqual({ width: 64, height: 48 })
    expect(imageKind(Buffer.from('<svg></svg>'))).toBeUndefined()
    expect(imageSize(png(0, 0), 'png')).toBeUndefined()
  })

  it('takes JPEG and GIF only through the iTerm2 protocol', () => {
    expect(mimeAccepted('kitty', 'image/png')).toBe(true)
    expect(mimeAccepted('kitty', 'image/jpeg')).toBe(false)
    expect(mimeAccepted('iterm2', 'image/JPEG')).toBe(true)
    expect(mimeAccepted('iterm2', 'image/gif')).toBe(true)
    expect(mimeAccepted('iterm2', 'image/webp')).toBe(false)
    expect(mimeAccepted('iterm2', 'image/svg+xml')).toBe(false)
  })

  it('fits at most 12 rows tall and the timeline width, in the image proportions', () => {
    expect(fitCells({ width: 100, height: 1000 }, 80)).toEqual({ cols: 2, rows: 12 })
    expect(fitCells({ width: 1000, height: 100 }, 20)).toEqual({ cols: 20, rows: 1 })
    expect(fitCells({ width: 400, height: 300 }, 80)).toEqual({ cols: 32, rows: 12 })
    expect(fitCells({ width: 400, height: 300 }, 10)).toEqual({ cols: 10, rows: 4 })
  })
})

describe('inline images', () => {
  it('draws through the kitty protocol, once, and deletes it by id when it scrolls out', async () => {
    const { images } = setup('kitty')
    const [block] = images.blocks(userNode(png(400, 300)))
    const view = new Viewport(() => ['above', ...(block?.render(40) ?? []), 'below'], 20)
    const term = new FakeTerminal({ columns: 40, rows: 20 })
    const renderer = new Renderer(term, view, false, undefined, true, undefined, images.layer)
    renderer.start()
    // Loading: nothing is drawn yet.
    expect(term.writes.join('')).not.toContain('\x1b_G')
    await settle()
    term.writes.length = 0
    renderer.renderNow()
    const out = term.writes.join('')
    const data = png(400, 300).toString('base64')
    expect(out).toContain(`\x1b_Ga=t,f=100,i=1,q=2,m=0;${data}\x1b\\`)
    // Cell 3 of row 2 (after the 3-column indent): below the 'above' row.
    expect(out).toContain('\x1b[2;4H\x1b_Ga=p,i=1,c=32,r=12,C=1,q=2\x1b\\')
    term.writes.length = 0
    renderer.renderNow()
    expect(term.writes).toEqual([])
    // Part of the block leaves the viewport: the placement is deleted, the data is kept.
    view.from = 5
    renderer.renderNow()
    expect(term.writes.join('')).toContain('\x1b_Ga=d,d=i,i=1,q=2\x1b\\')
    // Back in full: placed again without sending the bytes a second time.
    term.writes.length = 0
    view.from = 0
    renderer.renderNow()
    expect(term.writes.join('')).not.toContain('a=t')
    expect(term.writes.join('')).toContain('\x1b_Ga=p,i=1,')
    // Leaving the screen frees the stored image.
    term.writes.length = 0
    renderer.stop()
    expect(term.writes.join('')).toContain('\x1b_Ga=d,d=I,i=1,q=2\x1b\\')
  })

  it('cuts a long base64 payload into chunks of 4096 for kitty', async () => {
    const { images } = setup('kitty')
    const big = Buffer.concat([png(400, 300), Buffer.alloc(9000, 7)])
    const [block] = images.blocks(userNode(big))
    block?.render(40)
    await settle()
    const view = new Viewport(() => block?.render(40) ?? [], 20)
    const term = new FakeTerminal({ columns: 40, rows: 20 })
    new Renderer(term, view, false, undefined, true, undefined, images.layer).start()
    const chunks = term.writes
      .join('')
      .split('\x1b\\')
      .filter((c) => c.includes('\x1b_G'))
      .map((c) => c.slice(c.indexOf('\x1b_G')))
    const transmit = chunks.filter((c) => !c.includes('a=p'))
    expect(transmit.map((c) => c.match(/m=(\d)/)?.[1])).toEqual(['1', '1', '0'])
    expect(transmit[0]).toContain('a=t,f=100,i=1')
    expect(transmit[1]).not.toContain('a=')
    expect(transmit.every((c) => (c.split(';')[1] ?? '').length <= 4096 + 2)).toBe(true)
  })

  it('draws through the iTerm2 protocol, and paints text over it when it scrolls out', async () => {
    const { images } = setup('iterm2')
    const bytes = jpeg(640, 480)
    const [block] = images.blocks(userNode(bytes, 'image/jpeg'))
    const view = new Viewport(() => ['above', ...(block?.render(40) ?? []), 'below'], 20)
    const term = new FakeTerminal({ columns: 40, rows: 20 })
    const renderer = new Renderer(term, view, false, undefined, true, undefined, images.layer)
    renderer.start()
    await settle()
    term.writes.length = 0
    renderer.renderNow()
    const out = term.writes.join('')
    expect(out).toContain(
      `\x1b[2;4H\x1b]1337;File=inline=1;size=${bytes.length};width=32;height=12;preserveAspectRatio=1:${bytes.toString('base64')}\x07`,
    )
    term.writes.length = 0
    renderer.renderNow()
    expect(term.writes).toEqual([])
    // Scrolled out: every row the image covered is rewritten, even those whose text did not change.
    view.from = 8
    renderer.renderNow()
    const after = term.writes.join('')
    expect(after).not.toContain('1337')
    for (const row of [2, 3, 4, 13]) expect(after).toContain(`\x1b[${row};1H`)
  })

  it('leaves an unchanged iTerm2 image alone when only other rows change', async () => {
    const { images } = setup('iterm2')
    const [block] = images.blocks(userNode(gif(40, 40), 'image/gif'))
    let label = 'one'
    const view = new Viewport(() => [...(block?.render(40) ?? []), label], 20)
    const term = new FakeTerminal({ columns: 40, rows: 20 })
    const renderer = new Renderer(term, view, false, undefined, true, undefined, images.layer)
    renderer.start()
    await settle()
    renderer.renderNow()
    term.writes.length = 0
    label = 'two'
    renderer.renderNow()
    expect(term.writes.join('')).not.toContain('1337')
  })

  it('shows nothing of a block the viewport cuts through, so no image lands on the rows below it', async () => {
    const { images } = setup('kitty')
    const [block] = images.blocks(userNode(png(400, 300)))
    block?.render(40)
    await settle()
    const rows = [...(block?.render(40) ?? []), 'composer']
    const term = new FakeTerminal({ columns: 40, rows: 20 })
    // The block's last row is hidden by something drawn over it.
    const cut = [...rows.slice(0, -2), 'overlay', 'composer']
    new Renderer(term, new Viewport(() => cut, 20), false, undefined, true, undefined, images.layer).start()
    expect(term.writes.join('')).not.toContain('a=p')
  })

  it('falls back to the text label where no protocol is confirmed, for raw, when off, and past the limits', async () => {
    const node = userNode(png(40, 40))
    expect(setup(undefined).images.blocks(node)).toEqual([])
    // /raw: nothing is drawn and no read is started.
    const raw = setup('kitty', { raw: true })
    const [rawBlock] = raw.images.blocks(node)
    expect(rawBlock?.render(40)).toEqual([])
    // Declared over 5MB, or a type the protocol cannot take: no block at all.
    const huge = {
      ...userNode(png(1, 1)),
      content: [{ type: 'image', data: 'A'.repeat(7_000_000), mimeType: 'image/png' }],
    }
    expect(setup('kitty').images.blocks(huge as UINode)).toEqual([])
    expect(setup('kitty').images.blocks(userNode(jpeg(10, 10), 'image/jpeg'))).toEqual([])
    expect(setup('kitty').images.blocks(userNode(png(10, 10), 'image/webp'))).toEqual([])
    // The MIME type is not trusted: bytes that are not a PNG are never drawn.
    const liar = setup('kitty')
    const [lying] = liar.images.blocks(userNode(jpeg(10, 10), 'image/png'))
    lying?.render(40)
    await settle()
    expect(lying?.render(40)).toEqual([])
    // A PNG whose bytes are more than 5MB is refused after the read too.
    const over = setup('kitty')
    const [bigBlock] = over.images.blocks({
      ...userNode(png(1, 1)),
      content: [
        {
          type: 'image',
          data: Buffer.concat([png(1, 1), Buffer.alloc(5 * 1024 * 1024)]).toString('base64'),
          mimeType: 'image/png',
        },
      ],
    } as UINode)
    expect(bigBlock).toBeUndefined()
  })

  it('does nothing in a block that is still loading, and asks for a repaint when it is ready', async () => {
    const { images, repaint } = setup('kitty')
    const [block] = images.blocks(userNode(png(40, 40)))
    expect(block?.render(40)).toEqual([])
    expect(repaint).not.toHaveBeenCalled()
    await settle()
    expect(repaint).toHaveBeenCalledTimes(1)
    expect(block?.render(40)?.length).toBeGreaterThan(0)
  })

  it('reads a stored attachment through the bounded artifact.read call and checks its digest', async () => {
    const bytes = png(200, 100)
    const artifact: ArtifactRef = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mime: 'image/png',
    }
    const node: UINode = {
      kind: 'user',
      id: 'u2',
      seq: 2,
      content: [
        {
          type: 'resource_link',
          uri: `artifact://${artifact.sha256}`,
          name: 'shot.png',
          mimeType: 'image/png',
          attachment: { artifact, image: { width: 200, height: 100 } },
        },
      ],
    }
    const { images, call } = setup('kitty')
    call.mockResolvedValue({
      ok: true,
      status: 200,
      artifact,
      acceptRanges: 'bytes',
      contentLength: bytes.length,
      etag: `"${artifact.sha256}"`,
      base64: bytes.toString('base64'),
    })
    const [block] = images.blocks(node)
    block?.render(40)
    await settle()
    expect(call).toHaveBeenCalledWith('_agnes/v1/artifact.read', {
      sessionId: 'sess',
      laneId: 'main',
      artifact,
    })
    expect(block?.render(40)?.length).toBe(9)
    // A body that does not match the reference is not drawn.
    const bad = setup('kitty')
    bad.call.mockResolvedValue({
      ok: true,
      status: 200,
      artifact,
      contentLength: bytes.length,
      base64: png(1, 1).toString('base64'),
    })
    const [badBlock] = bad.images.blocks(node)
    badBlock?.render(40)
    await settle()
    expect(badBlock?.render(40)).toEqual([])
    // An artifact node (a file the agent produced) is drawn the same way.
    const produced: UINode = { kind: 'artifact', id: 'a1', seq: 3, name: 'plot.png', ref: artifact }
    expect(setup('kitty').images.blocks(produced)).toHaveLength(1)
    expect(
      setup('kitty').images.blocks({ ...produced, ref: { ...artifact, size: 6 * 1024 * 1024 } }),
    ).toEqual([])
  })

  it('reads each image once however many blocks are on screen, and again only after a switch', async () => {
    const { images, repaint } = setup('kitty')
    const blocks = Array.from(
      { length: 12 },
      (_, i) => images.blocks({ ...userNode(png(40 + i, 40)), id: `u${i}` } as UINode)[0],
    )
    for (let frame = 0; frame < 4; frame++) {
      for (const block of blocks) block?.render(40)
      await settle()
    }
    expect(repaint).toHaveBeenCalledTimes(12)
    expect(blocks.every((block) => (block?.render(40)?.length ?? 0) > 0)).toBe(true)
    images.reset()
    expect(blocks[0]?.render(40)).toEqual([])
  })

  it('holds at most the cap, never evicts what is on screen, and reads each visible image once', async () => {
    // Each image is 300 bytes, 400 base64 characters: two fit in a cap of 1000.
    const bytes = (n: number) => Buffer.concat([png(40 + n, 40), Buffer.alloc(260)])
    const { images, call } = setup('kitty', { cacheBytes: 1000 })
    const sources = [0, 1, 2, 3].map((n) => ({ key: `k${n}`, mime: 'image/png', size: 300, bytes: bytes(n) }))
    const blocks = sources.map(
      (s, n) =>
        images.blocks({
          ...userNode(s.bytes),
          id: `u${n}`,
        } as UINode)[0],
    )
    const frame = async (shown: number[]) => {
      for (const n of shown) blocks[n]?.render(40)
      await settle()
      images.layer?.frame([], new Set())
    }
    // Four visible images exceed the cap: two are drawn, two stay text, and nothing is evicted or reloaded.
    for (let i = 0; i < 3; i++) await frame([0, 1, 2, 3])
    expect(images.cachedBytes).toBeLessThanOrEqual(1000)
    expect(blocks.map((b) => (b?.render(40).length ?? 0) > 0)).toEqual([true, true, false, false])
    // The inline source reads no RPC; count loads through the entry cache instead: still two cached entries.
    expect(images.cachedBytes).toBe(800)
    // Only 2 and 3 are on screen now: 0 and 1 are not asked for, age out, and make room for them.
    for (let i = 0; i < 3; i++) await frame([2, 3])
    expect(images.cachedBytes).toBeLessThanOrEqual(1000)
    expect(call).not.toHaveBeenCalled()
  })

  it('reads a stored image once per entry across frames, even past the cap', async () => {
    const make = (n: number) => {
      const bytes = Buffer.concat([png(40 + n, 40), Buffer.alloc(260)])
      const artifact: ArtifactRef = {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mime: 'image/png',
      }
      return { bytes, artifact }
    }
    const items = [0, 1, 2].map(make)
    const { images, call } = setup('kitty', { cacheBytes: 1000 })
    call.mockImplementation(async (_method: string, params: { artifact: ArtifactRef }) => {
      const item = items.find((i) => i.artifact.sha256 === params.artifact.sha256) as (typeof items)[number]
      return {
        ok: true,
        status: 200,
        artifact: item.artifact,
        contentLength: item.bytes.length,
        base64: item.bytes.toString('base64'),
      }
    })
    const blocks = items.map(
      ({ artifact }, n) =>
        images.blocks({ kind: 'artifact', id: `a${n}`, seq: n, name: 'x.png', ref: artifact } as UINode)[0],
    )
    for (let i = 0; i < 4; i++) {
      for (const block of blocks) block?.render(40)
      await settle()
      images.layer?.frame([], new Set())
    }
    expect(call).toHaveBeenCalledTimes(3)
    expect(call.mock.calls.map(([, params]) => params.artifact.sha256).sort()).toEqual(
      items.map((i) => i.artifact.sha256).sort(),
    )
    expect(images.cachedBytes).toBeLessThanOrEqual(1000)
  })

  it('puts the images of a user message under its text, and leaves the label alone without them', async () => {
    const theme = new TuiTheme('mono')
    const { images } = setup('kitty')
    const host = { ansi: theme.ansi(createAnsi('none')), locale: 'en', theme, accent: 'accent' } as never
    const view = nodeView({ ...(host as object), images } as never)(userNode(png(400, 300)))
    expect(view.render(40).some((row) => row.includes('\x00'))).toBe(false)
    await settle()
    const rows = view.render(40)
    expect(rows.filter((row) => row.includes('\x00IMGu1.0:'))).toHaveLength(12)
    expect(rows.some((row) => row.includes('[image]'))).toBe(true)
    expect(view.transcript?.(40).some((row) => row.includes('\x00'))).toBe(false)
    const plain = nodeView(host as never)(userNode(png(400, 300)))
    expect(plain.render(40).some((row) => row.includes('\x00'))).toBe(false)
  })

  it('keeps the plain forms free of image rows', async () => {
    const { images } = setup('kitty')
    const blocks = images.blocks(userNode(png(40, 40)))
    blocks[0]?.render(40)
    await settle()
    const text: Component = { render: () => ['label'], invalidate: () => {} }
    const view = new WithImages(text, blocks)
    expect(view.render(40).length).toBeGreaterThan(1)
    expect(view.transcript(40)).toEqual(['label'])
  })

  it('/images switches it on and off, saves the choice, and says when the terminal cannot show images', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-images-'))
    try {
      const path = join(dir, 'prefs.json')
      const { images } = setup('kitty', { path })
      expect(images.active).toBe(true)
      expect(images.command(['off'], 'en')).toBe(tt('images.off', 'en'))
      expect(images.active).toBe(false)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ images: false })
      expect(setup('kitty', { path }).images.active).toBe(false)
      expect(images.command(['on'], 'en')).toBe(tt('images.on', 'en'))
      expect(setup('kitty', { path }).images.active).toBe(true)
      expect(images.command(['maybe'], 'en')).toBe(tt('images.usage', 'en'))
      const bare = setup(undefined, { path })
      expect(bare.images.active).toBe(false)
      expect(bare.images.command(['on'], 'zh-CN')).toContain(tt('images.unsupported', 'zh-CN'))
      expect(images.command([], 'en')).toContain(tt('images.on', 'en'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
