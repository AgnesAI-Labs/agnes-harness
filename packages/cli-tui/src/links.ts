import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { displayWidth } from './terminal.js'

/** Inside tmux or screen the outer terminal's variables say nothing about what the multiplexer passes on. */
export const underMultiplexer = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.TMUX || env.STY || /^(tmux|screen)/.test(env.TERM ?? ''))

/**
 * Terminals whose own documentation (Alhadis/OSC8-Adoption, which tracks each project) says they draw
 * OSC 8 hyperlinks: iTerm2 3.1+, WezTerm, kitty 0.19+, Ghostty, the VS Code terminal 1.72+ and Windows
 * Terminal 1.4+. Detected by the variables each exports. tmux and screen are never linked: they only
 * pass OSC 8 on when configured to, and the outer terminal's variables say nothing about that.
 */
export function supportsOsc8(env: NodeJS.ProcessEnv): boolean {
  if (underMultiplexer(env)) return false
  return (
    ['iTerm.app', 'WezTerm', 'ghostty', 'vscode'].includes(env.TERM_PROGRAM ?? '') ||
    env.LC_TERMINAL === 'iTerm2' ||
    env.TERM === 'xterm-kitty' ||
    env.TERM === 'xterm-ghostty' ||
    Boolean(env.WT_SESSION || env.KITTY_WINDOW_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR)
  )
}

const SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'file:'])
const MAX_TARGET = 2000
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

/** A link target that is safe to put inside an OSC 8 sequence, or undefined: http, https and file only, bounded. */
export function linkTarget(raw: string): string | undefined {
  const text = raw.replace(CONTROL, '')
  if (text.length > MAX_TARGET) return undefined
  try {
    const url = new URL(text)
    // href is percent-encoded, so nothing left in it can end the sequence early.
    return SCHEMES.has(url.protocol) && url.href.length <= MAX_TARGET ? url.href : undefined
  } catch {
    return undefined
  }
}

// ASCII only, so a box-drawing border next to a URL is not swallowed.
const URL_RE = /https?:\/\/[\x21-\x7e]+/g
const PATH_RE =
  /(?<![\p{L}\p{N}_/.~:-])(?:\/|[A-Za-z]:[\\/])(?:[\p{L}\p{N}_.@+~-]+[\\/])*[\p{L}\p{N}_.@+~-]+(?::\d+(?::\d+)?)?/gu
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte starts a style sequence
const SGR_SPLIT = /(\x1b\[[0-9;]*m)/
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte starts a style sequence
const SGR = /\x1b\[[0-9;]*m/g

type Span = { start: number; end: number; uri: string }

const count = (s: string, ch: string): number => s.split(ch).length - 1

/** Drops what a sentence puts after a URL: closing punctuation, and a `)` with no `(` to close. */
function trimUrl(url: string): string {
  let out = url
  for (;;) {
    const last = out.at(-1) ?? ''
    if (/[.,;:!?'"\]}]/.test(last) || (last === ')' && count(out, ')') > count(out, '(')))
      out = out.slice(0, -1)
    else return out
  }
}

/**
 * Wraps http(s) URLs, absolute paths that exist and `path:line` in OSC 8 links. Styles in the row are kept
 * and stay in place; the link sequences take no columns. Text touching the right edge of a full row is left
 * alone: it may be the start of a URL that wraps, and half a URL is a wrong link.
 */
export function createLinker(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): ((row: string, columns: number) => string) | undefined {
  if (!supportsOsc8(env)) return undefined
  // Paths come and go while the agent works; a short memory keeps repainting from hitting the disk.
  const known = new Map<string, { at: number; yes: boolean }>()
  const there = (path: string): boolean => {
    const now = Date.now()
    const hit = known.get(path)
    if (hit && now - hit.at < 3000) return hit.yes
    if (known.size > 500) known.clear()
    let yes = false
    try {
      yes = exists(path)
    } catch {
      /* Unreadable counts as absent. */
    }
    known.set(path, { at: now, yes })
    return yes
  }
  return (row, columns) => {
    if (!/[/\\]/.test(row)) return row
    const plain = row.replace(SGR, '')
    const full = displayWidth(plain) >= columns
    const spans: Span[] = []
    const taken = (start: number, end: number): boolean => spans.some((s) => start < s.end && end > s.start)
    for (const m of plain.matchAll(URL_RE)) {
      const text = trimUrl(m[0])
      const end = m.index + text.length
      const uri = full && end >= plain.length ? undefined : linkTarget(text)
      if (uri) spans.push({ start: m.index, end, uri })
    }
    for (const m of plain.matchAll(PATH_RE)) {
      if (taken(m.index, m.index + m[0].length) || (full && m.index + m[0].length >= plain.length)) continue
      const body = m[0].replace(/:\d+(?::\d+)?$/, '').replace(/\.+$/, '')
      if (body.length < 2 || !there(body)) continue
      const uri = linkTarget(pathToFileURL(body).href)
      if (uri) spans.push({ start: m.index, end: m.index + body.length, uri })
    }
    if (spans.length === 0) return row
    spans.sort((a, b) => a.start - b.start)
    let out = ''
    let at = 0
    let open: Span | undefined
    let next = 0
    for (const part of row.split(SGR_SPLIT)) {
      if (part.startsWith('\x1b[') && part.endsWith('m')) {
        out += part
        continue
      }
      let from = 0
      while (from < part.length) {
        const span = open ?? spans[next]
        let cut = part.length
        if (open) cut = Math.min(part.length, open.end - at + from)
        else if (span && span.start < at + (part.length - from)) {
          cut = span.start - at + from
          if (cut > from) {
            out += part.slice(from, cut)
            at += cut - from
            from = cut
          }
          open = span
          next++
          out += `\x1b]8;;${span.uri}\x1b\\`
          continue
        }
        out += part.slice(from, cut)
        at += cut - from
        from = cut
        if (open && at >= open.end) {
          out += '\x1b]8;;\x1b\\'
          open = undefined
        }
      }
    }
    return open ? `${out}\x1b]8;;\x1b\\` : out
  }
}
