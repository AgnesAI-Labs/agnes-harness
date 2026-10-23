import { createHash } from 'node:crypto'
import {
  ARTIFACT_READ_RPC_MAX_BYTES,
  type ArtifactReadResult,
  type ArtifactRef,
  storedAttachment,
  type UINode,
} from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { Component } from './component.js'
import {
  fitCells,
  type ImageKind,
  type ImageProtocol,
  imageKind,
  imageSize,
  iterm2Image,
  kittyDelete,
  kittyPut,
  kittyTransmit,
  MAX_IMAGE_BYTES,
  mimeAccepted,
  protocolAccepts,
} from './image-protocol.js'
import { tt } from './locale-extended.js'
import { readPrefs, updatePrefs } from './prefs.js'

// A row of an image block carries `MARK id:row:rows MARK`. The renderer takes the marks out of the frame
// before anything else sees it and draws the image where a whole block is on screen. NUL cannot come out of
// escapeControl'd text, so no message can forge one.
const MARK = '\x00'
// biome-ignore lint/suspicious/noControlCharactersInRegex: the NUL delimiters are the point
const MARK_RE = /\x00IMG([^\x00:]+):(\d+):(\d+)\x00/
export type ImageMark = { row: number; col: number; id: string; index: number; rows: number }

/** What one drawn image needs: its bytes as base64 and the cells it covers. */
type Payload = { base64: string; bytes: number; cols: number; rows: number }
type Placement = { row: number; col: number; payload: Payload }

/** Parses a frame row's image mark; `col` is where it sat among the row's text. */
export function takeMark(line: string, widthOf: (s: string) => number): { text: string; mark?: ImageMark } {
  const found = MARK_RE.exec(line)
  if (!found) return { text: line }
  const [whole, id, index, rows] = found as unknown as [string, string, string, string]
  return {
    text: line.replace(whole, ''),
    mark: { row: -1, col: widthOf(line.slice(0, found.index)), id, index: Number(index), rows: Number(rows) },
  }
}

/**
 * The terminal side of inline images: which blocks are fully on screen now, and the sequences that make
 * the screen match. kitty keeps images apart from text, so a placement that left is deleted by image id.
 * iTerm2 paints an image into cells, so what covered one is repainted as text and an image whose rows
 * were rewritten is drawn again.
 */
export class ImageLayer {
  private readonly payloads = new Map<string, Payload>()
  private readonly numbers = new Map<string, number>()
  private readonly sent = new Set<string>()
  private placed = new Map<string, Placement>()

  constructor(
    readonly protocol: ImageProtocol,
    /** Called as each frame is drawn: the cache's clock. */
    private readonly onFrame?: () => void,
  ) {}

  register(id: string, payload: Payload): void {
    const have = this.payloads.get(id)
    // The same object while nothing changed: a placement is compared by it.
    if (have?.base64 !== payload.base64 || have.cols !== payload.cols || have.rows !== payload.rows)
      this.payloads.set(id, payload)
    if (!this.numbers.has(id)) this.numbers.set(id, this.numbers.size + 1)
  }

  has(id: string): boolean {
    return this.payloads.has(id)
  }

  /**
   * Compares this frame's complete blocks with the last frame's. `changed` holds the rows the renderer is
   * about to rewrite as text. Returns what to write before the rows (`before`), after them (`after`), and the
   * rows that held an image and must be rewritten even though their text did not change (`repaint`).
   */
  frame(
    marks: readonly ImageMark[],
    changed: ReadonlySet<number>,
  ): { before: string; after: string; repaint: Set<number> } {
    this.onFrame?.()
    const now = new Map<string, Placement>()
    for (const [at, mark] of marks.entries()) {
      const payload = this.payloads.get(mark.id)
      if (!payload || mark.index !== 0 || now.has(mark.id) || mark.rows !== payload.rows) continue
      const run = marks.slice(at, at + mark.rows)
      const whole =
        run.length === mark.rows &&
        run.every(
          (m, i) => m.id === mark.id && m.index === i && m.row === mark.row + i && m.rows === mark.rows,
        )
      if (whole) now.set(mark.id, { row: mark.row, col: mark.col, payload })
    }
    let before = ''
    let after = ''
    const repaint = new Set<number>()
    const covers = (p: Placement) => Array.from({ length: p.payload.rows }, (_, i) => p.row + i)
    for (const [id, old] of this.placed) {
      const next = now.get(id)
      if (next && next.row === old.row && next.col === old.col && next.payload === old.payload) continue
      if (this.protocol === 'kitty') before += kittyDelete(this.numbers.get(id) as number, false)
      else for (const row of covers(old)) repaint.add(row)
    }
    for (const [id, next] of now) {
      const old = this.placed.get(id)
      const same = old && old.row === next.row && old.col === next.col && old.payload === next.payload
      // iTerm2 paints into cells: rewriting any of them as text wiped the image.
      if (same && (this.protocol === 'kitty' || !covers(next).some((row) => changed.has(row)))) continue
      const { base64, bytes, cols, rows } = next.payload
      const at = `\x1b[${next.row + 1};${next.col + 1}H`
      if (this.protocol === 'kitty') {
        const number = this.numbers.get(id) as number
        if (!this.sent.has(id)) {
          after += kittyTransmit(number, base64)
          this.sent.add(id)
        }
        after += at + kittyPut(number, cols, rows)
      } else after += at + iterm2Image(base64, bytes, cols, rows)
    }
    this.placed = now
    return { before, after, repaint }
  }

  /** Forgets what is on screen (a resize, a full redraw, leaving the screen); kitty's stored images are freed too. */
  reset(): string {
    let out = ''
    if (this.protocol === 'kitty')
      for (const id of this.sent) out += kittyDelete(this.numbers.get(id) as number, true)
    this.sent.clear()
    this.placed = new Map()
    return out
  }
}

/** The bytes of a stored attachment through the bounded `artifact.read` RPC, checked against its reference. */
export async function readArtifactBytes(
  client: Pick<Session['client'], 'call'>,
  sessionId: string,
  laneId: string,
  artifact: ArtifactRef,
): Promise<Buffer> {
  const parts: Buffer[] = []
  for (let start = 0; start < artifact.size; start += ARTIFACT_READ_RPC_MAX_BYTES) {
    const end = Math.min(start + ARTIFACT_READ_RPC_MAX_BYTES, artifact.size)
    const range = artifact.size > ARTIFACT_READ_RPC_MAX_BYTES ? `bytes=${start}-${end - 1}` : undefined
    const result = await client.call<ArtifactReadResult>('_agnes/v1/artifact.read', {
      sessionId,
      laneId,
      artifact,
      ...(range ? { range } : {}),
    })
    if (!result.ok || result.artifact.sha256 !== artifact.sha256 || result.contentLength !== end - start)
      throw new Error('image unavailable')
    parts.push(Buffer.from(result.base64, 'base64'))
  }
  const bytes = Buffer.concat(parts)
  if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
    throw new Error('image digest mismatch')
  return bytes
}

/** Where an image's bytes come from: inline in the message, or a stored artifact read through the daemon. */
export type ImageSource = { key: string; mime: string; size: number; load: () => Promise<Uint8Array> }
type Ready = { base64: string; bytes: number; kind: ImageKind; width: number; height: number }
type Entry = { status: 'loading' } | { status: 'failed' } | ({ status: 'ready' } & Ready)

/** `/images`, the loaded images, and the layer the renderer draws them through. Absent where no protocol is confirmed. */
export class InlineImages {
  readonly layer: ImageLayer | undefined
  private enabled: boolean
  // Bounded by the bytes held. Map order is least recently asked first. Every block of the loaded window asks
  // for its entry on every frame, so an entry asked for in the last two frames is pinned: only the rest is
  // evicted. When the pinned images alone fill the cap the newcomer is not drawn (text) instead of evicting one.
  private readonly cache = new Map<string, Entry>()
  private readonly asked = new Map<string, number>()
  private held = 0
  private frames = 0

  constructor(
    private readonly o: {
      protocol: ImageProtocol | undefined
      path?: string | undefined
      raw(): boolean
      /** Cap on the base64 bytes held; default 64MB. */
      cacheBytes?: number
      session(): Session
      /** The picture changed: draw the screen again. */
      repaint(): void
    },
  ) {
    this.layer = o.protocol ? new ImageLayer(o.protocol, () => this.frames++) : undefined
    this.enabled = readPrefs(o.path).images !== false
  }

  /** Images are drawn now: a confirmed terminal, `/images` on, and not the copy-friendly `/raw` view. */
  get active(): boolean {
    return this.layer !== undefined && this.enabled && !this.o.raw()
  }

  /** A switched session shows other images: drops what was read for the last one. */
  reset(): void {
    this.cache.clear()
    this.asked.clear()
    this.held = 0
  }

  /** Bytes of image data held now. */
  get cachedBytes(): number {
    return this.held
  }

  private store(key: string, entry: Entry): void {
    const old = this.cache.get(key)
    if (old?.status === 'ready') this.held -= old.base64.length
    this.cache.set(key, entry)
    if (entry.status === 'ready') this.held += entry.base64.length
  }

  /** Makes room for a ready entry by dropping the least recently asked ones that are not pinned; false if it cannot fit. */
  private fits(key: string, size: number): boolean {
    const cap = this.o.cacheBytes ?? 64 * 1024 * 1024
    for (const [other, entry] of this.cache) {
      if (this.held + size <= cap) break
      if (other === key || entry.status !== 'ready' || (this.asked.get(other) ?? 0) >= this.frames - 1)
        continue
      this.held -= entry.base64.length
      this.cache.delete(other)
      this.asked.delete(other)
    }
    return this.held + size <= cap
  }

  /** `/images [on|off]`. */
  command(args: readonly string[], locale: string): string {
    const [arg] = args
    if (args.length > 1 || (arg !== undefined && arg !== 'on' && arg !== 'off'))
      return tt('images.usage', locale)
    if (arg !== undefined) {
      this.enabled = arg === 'on'
      const saved = updatePrefs(this.o.path, { images: this.enabled })
      this.o.repaint()
      return tt(this.enabled ? 'images.on' : 'images.off', locale) + this.notes(locale, !saved)
    }
    return `${tt(this.enabled ? 'images.on' : 'images.off', locale)}${this.notes(locale, false)} · ${tt('images.usage', locale)}`
  }

  private notes(locale: string, unsaved: boolean): string {
    return (
      (this.layer ? '' : tt('images.unsupported', locale)) + (unsaved ? tt('images.unsaved', locale) : '')
    )
  }

  /** The image blocks of a node: the ones the open session's terminal can draw; the rest stay `[image: ...]` text. */
  blocks(node: UINode): ImageBlock[] {
    const protocol = this.o.protocol
    if (!protocol) return []
    const sources: ImageSource[] = []
    const stored = (artifact: ArtifactRef) => ({
      key: artifact.sha256,
      mime: artifact.mime,
      size: artifact.size,
      load: () => readArtifactBytes(this.o.session().client, this.o.session().id, 'main', artifact),
    })
    if (node.kind === 'artifact') sources.push(stored(node.ref))
    else if (node.kind === 'user')
      for (const block of node.content) {
        if (block.type === 'image')
          sources.push({
            key: `inline:${createHash('sha256').update(block.data).digest('hex')}`,
            mime: block.mimeType,
            size: Math.floor((block.data.length * 3) / 4),
            load: async () => Buffer.from(block.data, 'base64'),
          })
        else if (storedAttachment(block) && block.attachment.image)
          sources.push(stored(block.attachment.artifact))
      }
    return sources
      .filter((src) => src.size <= MAX_IMAGE_BYTES && mimeAccepted(protocol, src.mime))
      .map((src, i) => new ImageBlock(this, src, `${node.id}.${i}`))
  }

  /** The loaded image for `src`; the first ask starts the read, and a finished one repaints the screen. */
  entry(src: ImageSource): Entry {
    const have = this.cache.get(src.key)
    this.asked.set(src.key, this.frames)
    if (have) {
      this.cache.delete(src.key)
      this.cache.set(src.key, have)
      return have
    }
    const protocol = this.o.protocol as ImageProtocol
    this.cache.set(src.key, { status: 'loading' })
    void src.load().then(
      (bytes) => {
        const kind = bytes.length <= MAX_IMAGE_BYTES ? imageKind(bytes) : undefined
        const size = kind && imageSize(bytes, kind)
        const base64 =
          kind && size && protocolAccepts(protocol, kind) ? Buffer.from(bytes).toString('base64') : undefined
        this.store(
          src.key,
          kind && size && base64 !== undefined && this.fits(src.key, base64.length)
            ? { status: 'ready', base64, bytes: bytes.length, kind, ...size }
            : { status: 'failed' },
        )
        this.o.repaint()
      },
      () => {
        this.store(src.key, { status: 'failed' })
      },
    )
    return { status: 'loading' }
  }
}

/** One image under its message: blank rows carrying marks, or nothing while it loads or when it cannot be shown. */
export class ImageBlock implements Component {
  constructor(
    private readonly images: InlineImages,
    private readonly src: ImageSource,
    private readonly id: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const layer = this.images.layer
    if (!layer || !this.images.active) return []
    const entry = this.images.entry(this.src)
    if (entry.status !== 'ready') return []
    const indent = width >= 8 ? 3 : 0
    const { cols, rows } = fitCells(entry, width - indent)
    layer.register(this.id, { base64: entry.base64, bytes: entry.bytes, cols, rows })
    return Array.from(
      { length: rows },
      (_, i) => `${' '.repeat(indent)}${MARK}IMG${this.id}:${i}:${rows}${MARK}`,
    )
  }
}

/** A node's own view with its images beneath; the plain forms (pager, exit transcript) keep the text alone. */
export class WithImages implements Component {
  constructor(
    private readonly base: Component,
    private readonly images: readonly Component[],
  ) {}

  invalidate(): void {
    this.base.invalidate()
  }

  render(width: number): string[] {
    return [...this.base.render(width), ...this.images.flatMap((image) => image.render(width))]
  }

  transcript(width: number): string[] {
    return this.base.transcript?.(width) ?? this.base.render(width)
  }
}
