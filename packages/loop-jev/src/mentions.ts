import { viewPath } from './observations.js'
import type { ViewReference } from './types.js'
import { utf8Bytes } from './util.js'

/*
 * Paths a user named in this turn's message. Only the user's own words are read (the goal text of the
 * turn): never tool output, file contents or assistant text. A mention is a hint for a candidate, never a
 * fact: it is not checked for existence, does not count as read, and every call built from it still
 * passes the same availability, duplicate, workspace-boundary and approval checks as any other call.
 */

/** The most paths one turn's message contributes. */
export const MENTION_CAP = 8
const MENTION_MAX_BYTES = 256
/** Qualifying words kept before the best MENTION_CAP are picked, so a huge message costs a bounded scan. */
const SCAN_CAP = 64
/** Runs of path characters; anything else (spaces, quotes, backticks, brackets, punctuation) ends a word. */
const RUN = /[A-Za-z0-9_.\-/@+]+/g
/** Prose that looks like a file name: abbreviations and the domains of a link. */
const NOT_FILES: ReadonlySet<string> = new Set(['e.g', 'i.e'])
const DOMAIN_SUFFIXES: ReadonlySet<string> = new Set(['com', 'org', 'net', 'io', 'dev', 'ai', 'app', 'cn'])
const DOT_DOT_SEGMENT = /(^|\/)\.\.(\/|$)/
/** Han, kana, hangul and the CJK and full-width punctuation blocks: text that may sit right against a path. */
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u

/**
 * Whether the character next to a run lets the run stand as a whole word. Spaces, punctuation and the
 * ASCII delimiters do. CJK text does when the run ends on a letter or digit there (`config/app.toml的`).
 * Anything else (a control character such as NUL, a `$` or `~` of a variable or home path, an accented
 * letter) means the path continues into characters the run cannot hold, so the word is rejected whole
 * rather than cut short.
 */
function bounded(next: string | undefined, edge: string | undefined): boolean {
  if (next === undefined || edge === undefined) return true
  if (/\s/u.test(next)) return true
  if (next.charCodeAt(0) < 0x80) return !/[\u0000-\u0008\u000e-\u001f\u007f$~\\]/.test(next)
  if (CJK.test(next))
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(next)
      ? /[A-Za-z0-9]/.test(edge)
      : true
  return /[\p{P}\p{S}\p{Z}]/u.test(next)
}

/** The file or directory a path-like word names, or null when the word does not read as a relative path. */
function wordPath(word: string): ViewReference | null {
  // A `..` segment is judged on the word as written, before trailing dots are taken for punctuation.
  if (DOT_DOT_SEGMENT.test(word)) return null
  // `./a/b` is `a/b`; a trailing `.`/`-` is sentence punctuation; a leading flag dash is not part of a path.
  const token = word
    .replace(/^(?:\.\/)+/, '')
    .replace(/^[-+]+/, '')
    .replace(/[.\-+@]+$/, '')
  if (token === '' || utf8Bytes(token) > MENTION_MAX_BYTES) return null
  if (token.startsWith('/') || token.includes('//') || !/[A-Za-z]/.test(token)) return null
  if (token.lastIndexOf('@') > 0) return null
  const directory = token.endsWith('/')
  const body = directory ? token.slice(0, -1) : token
  if (directory) {
    const value = viewPath(body, 'directory')
    return value === null || value === '.' ? null : { kind: 'directory', value }
  }
  const last = body.slice(body.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  const extension = dot > 0 ? last.slice(dot + 1) : ''
  const hasExtension = /^[A-Za-z0-9]{1,6}$/.test(extension) && /[A-Za-z]/.test(extension)
  if (!body.includes('/')) {
    if (!hasExtension || NOT_FILES.has(body.toLowerCase())) return null
    if (DOMAIN_SUFFIXES.has(extension.toLowerCase())) return null
  }
  const value = viewPath(body, 'file')
  return value === null ? null : { kind: 'file', value }
}

/** How strongly a word reads as a path: 0 a directory or a path with an extension, 1 a bare file name, 2 a slash word with no extension. */
function signal(ref: ViewReference): number {
  if (ref.kind === 'directory') return 0
  const last = ref.value.slice(ref.value.lastIndexOf('/') + 1)
  const dotted = /\.[A-Za-z0-9]{1,6}$/.test(last)
  if (ref.value.includes('/')) return dotted ? 0 : 2
  return 1
}

/**
 * The relative paths a message names, without duplicates, at most MENTION_CAP, in order of appearance.
 * A word with a `/` or a 1 to 6 character extension (with a letter) is a file; a word ending in `/` is a
 * directory. Absolute paths, `..` segments, URLs, oversized words, words holding characters outside the
 * path set and bare extensions (`.md`) are not paths. When more than MENTION_CAP words qualify, the ones
 * that read most like paths are kept (directories and slash paths with an extension, then bare file
 * names, then extensionless slash words such as `and/or`).
 */
export function mentionedPaths(text: string): ViewReference[] {
  const found: ViewReference[] = []
  for (const match of text.matchAll(RUN)) {
    const [word] = match
    const at = match.index ?? 0
    // A piece of a backslash path (`C:\x\y.txt`) is not a relative POSIX path.
    if (text[at - 1] === '\\' || text[at + word.length] === '\\') continue
    const before = [...text.slice(Math.max(0, at - 2), at)].at(-1)
    const after = [...text.slice(at + word.length, at + word.length + 2)][0]
    if (!bounded(before, word[0]) || !bounded(after, word.at(-1))) continue
    const ref = wordPath(word)
    if (ref === null || found.some((item) => item.kind === ref.kind && item.value === ref.value)) continue
    found.push(ref)
    if (found.length >= SCAN_CAP) break
  }
  if (found.length <= MENTION_CAP) return found
  const keep = new Set(
    found
      .map((ref, index) => ({ ref, index, rank: signal(ref) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, MENTION_CAP)
      .map((item) => item.ref),
  )
  return found.filter((ref) => keep.has(ref))
}
