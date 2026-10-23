import { underMultiplexer } from './links.js'

/** The two inline image protocols a terminal can speak. */
export type ImageProtocol = 'kitty' | 'iterm2'
export type ImageKind = 'png' | 'jpeg' | 'gif'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_ROWS = 12

/**
 * Terminals confirmed to draw inline images, by the variables each exports: the iTerm2 protocol in iTerm2
 * and WezTerm (both document it), the kitty graphics protocol in kitty and Ghostty (both document it).
 * WezTerm speaks both; it is given the iTerm2 one, which takes JPEG and GIF as well as PNG. tmux, screen and
 * every unknown terminal get nothing: a multiplexer needs passthrough set up, and nothing else is known.
 */
export function imageProtocol(env: NodeJS.ProcessEnv): ImageProtocol | undefined {
  if (underMultiplexer(env)) return undefined
  if (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iterm2'
  if (env.TERM_PROGRAM === 'WezTerm' || env.WEZTERM_PANE) return 'iterm2'
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID) return 'kitty'
  if (env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR)
    return 'kitty'
  return undefined
}

/** What each protocol takes as is. The kitty protocol decodes only PNG itself (JPEG and GIF would need a decoder here). */
const ACCEPTS: Record<ImageProtocol, readonly ImageKind[]> = {
  kitty: ['png'],
  iterm2: ['png', 'jpeg', 'gif'],
}

/** The format of image bytes by their magic number: the declared MIME type is not trusted. */
export function imageKind(bytes: Uint8Array): ImageKind | undefined {
  const at = (...head: number[]) => head.every((b, i) => bytes[i] === b)
  if (at(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    return 'gif'
  return undefined
}

export const protocolAccepts = (protocol: ImageProtocol, kind: ImageKind): boolean =>
  ACCEPTS[protocol].includes(kind)

/** Whether a declared MIME type is worth fetching for: the check before any bytes are read. */
export const mimeAccepted = (protocol: ImageProtocol, mime: string): boolean =>
  ACCEPTS[protocol].some((kind) => mime.toLowerCase() === `image/${kind}`)

/** Pixel size from the header, or undefined when the header is cut or odd. */
export function imageSize(bytes: Uint8Array, kind: ImageKind): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let size: { width: number; height: number } | undefined
  if (kind === 'png' && bytes.length >= 24) size = { width: view.getUint32(16), height: view.getUint32(20) }
  else if (kind === 'gif' && bytes.length >= 10)
    size = { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  else if (kind === 'jpeg') {
    // Walk the segments to the first start-of-frame marker (C0-CF except DHT C4, JPG C8 and DAC CC).
    for (let at = 2; at + 9 <= bytes.length; ) {
      if (bytes[at] !== 0xff) break
      const marker = bytes[at + 1] as number
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        size = { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
        break
      }
      at += 2 + view.getUint16(at + 2)
    }
  }
  return size && size.width > 0 && size.height > 0 ? size : undefined
}

/**
 * Cells an image takes: at most MAX_IMAGE_ROWS tall and `maxCols` wide, in its own proportions.
 * ponytail: a cell is assumed twice as tall as wide (the usual 8x16); the terminal's real cell size
 * would need a CSI 16 t query, add it when a font with other proportions shows a visibly stretched image.
 */
export function fitCells(
  size: { width: number; height: number },
  maxCols: number,
  maxRows = MAX_IMAGE_ROWS,
): { cols: number; rows: number } {
  const limit = Math.max(1, maxCols)
  let rows = maxRows
  let cols = Math.max(1, Math.round((rows * 2 * size.width) / size.height))
  if (cols > limit) {
    cols = limit
    rows = Math.max(1, Math.min(maxRows, Math.round((cols * size.height) / (2 * size.width))))
  }
  return { cols, rows }
}

const CHUNK = 4096

/** kitty graphics: store the PNG under `id` without showing it (`a=t`), in chunks of at most 4096 bytes; q=2 mutes replies. */
export function kittyTransmit(id: number, base64: string): string {
  let out = ''
  for (let at = 0; at < base64.length || at === 0; at += CHUNK) {
    const more = at + CHUNK < base64.length ? 1 : 0
    const head = at === 0 ? `a=t,f=100,i=${id},q=2,` : 'q=2,'
    out += `\x1b_G${head}m=${more};${base64.slice(at, at + CHUNK)}\x1b\\`
  }
  return out
}

/** kitty graphics: show image `id` at the cursor, `cols` x `rows` cells, without moving the cursor (`C=1`). */
export const kittyPut = (id: number, cols: number, rows: number): string =>
  `\x1b_Ga=p,i=${id},c=${cols},r=${rows},C=1,q=2\x1b\\`

/** kitty graphics: remove every placement of image `id`; `free` also drops its stored data. */
export const kittyDelete = (id: number, free: boolean): string =>
  `\x1b_Ga=d,d=${free ? 'I' : 'i'},i=${id},q=2\x1b\\`

/** iTerm2 inline image: draws at the cursor, fitted inside `cols` x `rows` cells with its proportions kept. */
export const iterm2Image = (base64: string, bytes: number, cols: number, rows: number): string =>
  `\x1b]1337;File=inline=1;size=${bytes};width=${cols};height=${rows};preserveAspectRatio=1:${base64}\x07`
