import { createHash } from 'node:crypto'
import type { MemoryFile, MemorySettings } from '@agnes/extension-api'

export const defaults: MemorySettings = Object.freeze({
  mode: 'off',
  indexMaxBytes: 16 * 1024,
  indexMaxLines: 200,
  topicMaxBytes: 32 * 1024,
  totalMaxBytes: 256 * 1024,
  // Injection limits in UTF-8 bytes (the field names are kept for compatibility): what the agent is shown
  // of workspace and user memory, the fixed header aside.
  tokenBudget: 8192,
  userTokenBudget: 2048,
  userEnabled: false,
})

export function fault(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
export const hash = (content: string): string => createHash('sha256').update(content).digest('hex')
export function file(path: string, content: string): MemoryFile {
  return Object.freeze({
    path,
    content,
    hash: hash(content),
    bytes: Buffer.byteLength(content),
    lines: content ? content.split('\n').length : 0,
  })
}

export function settings(input: Partial<MemorySettings>): MemorySettings {
  for (const key of Object.keys(input))
    if (!Object.hasOwn(defaults, key)) throw fault('MEMORY_INVALID_SETTINGS')
  const result = { ...defaults, ...input }
  if (!['off', 'ask', 'auto'].includes(result.mode) || typeof result.userEnabled !== 'boolean')
    throw fault('MEMORY_INVALID_SETTINGS')
  for (const key of [
    'indexMaxBytes',
    'indexMaxLines',
    'topicMaxBytes',
    'totalMaxBytes',
    'tokenBudget',
    'userTokenBudget',
  ] as const) {
    if (
      !Number.isSafeInteger(result[key]) ||
      result[key] < (key === 'tokenBudget' || key === 'userTokenBudget' ? 128 : 1) ||
      result[key] > 1024 * 1024
    )
      throw fault('MEMORY_INVALID_SETTINGS')
  }
  return Object.freeze(result)
}

/** Conservative rejection of common credentials; not a universal secret detector. */
export function validateContent(value: MemoryFile, limits: MemorySettings, index: boolean): void {
  if (
    value.bytes > (index ? limits.indexMaxBytes : limits.topicMaxBytes) ||
    (index && value.lines > limits.indexMaxLines)
  )
    throw fault('MEMORY_CONSOLIDATION_REQUIRED')
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i.test(
      value.content,
    )
  )
    throw fault('MEMORY_SECRET_LIKE_CONTENT')
}

export function diff(before: string, after: string): string {
  // Whole-file replacement: every byte under review is represented, with no hidden truncation.
  return [
    '--- current',
    '+++ proposed',
    ...before.split('\n').map((line) => `-${line}`),
    ...after.split('\n').map((line) => `+${line}`),
  ].join('\n')
}

/** The injection limits stored before 8 KiB / 2 KiB became the defaults; read as not set. */
const OLD_DEFAULTS = { tokenBudget: 2048, userTokenBudget: 512 } as const

/**
 * Stored settings as they apply now. Every settings change writes the whole set, so a workspace that ever
 * had memory switched on stores the old default limits; those two together read as the new defaults.
 */
export function storedSettings(input: Partial<MemorySettings>): MemorySettings {
  const old =
    input.tokenBudget === OLD_DEFAULTS.tokenBudget && input.userTokenBudget === OLD_DEFAULTS.userTokenBudget
  return settings(
    old ? { ...input, tokenBudget: defaults.tokenBudget, userTokenBudget: defaults.userTokenBudget } : input,
  )
}

/** Paragraphs (runs of non-blank lines) in a text. */
export function omissionLine(count: number): string {
  return `[${count} task-experience paragraphs omitted: expired or unverifiable]`
}

const OMISSION_LINE = /^\[\d+ task-experience paragraphs omitted: expired or unverifiable\]$/u

// Paragraphs of text left out, not counting a line that only says paragraphs were left out.
const paragraphsIn = (text: string) =>
  text.split(/\n\s*\n/u).filter((part) => part.trim() && !OMISSION_LINE.test(part.trim())).length

/**
 * `content` cut to at most `maxBytes` UTF-8 bytes at a whole line, with a closing line that says how much
 * was left out: paragraphs and about how many KB, and, given `at`, from which line of which file, so the
 * agent can read the rest. A line that alone does not fit is left out whole; a character is never split.
 */
export function fitBytes(
  content: string,
  maxBytes: number,
  notice: (left: { paragraphs: number; kb: string; offset: number }) => string,
  brief = '[Memory truncated at the size limit.]',
): { content: string; omitted: boolean } {
  if (Buffer.byteLength(content) <= maxBytes) return { content, omitted: false }
  const closing = (offset: number) => {
    const left = content.slice(offset)
    return notice({
      paragraphs: Math.max(1, paragraphsIn(left)),
      kb: (Buffer.byteLength(left) / 1024).toFixed(1),
      offset,
    })
  }
  // Room is kept for the longest the closing line can be, so the lines are fitted in one pass and
  // the line is written once, for where the cut falls.
  const room =
    maxBytes -
    Buffer.byteLength(
      notice({
        paragraphs: Math.max(1, paragraphsIn(content)),
        kb: (Buffer.byteLength(content) / 1024).toFixed(1),
        offset: content.length,
      }),
    )
  let used = 0
  let offset = 0
  for (const line of content.split('\n')) {
    const next = used + Buffer.byteLength(line) + 1
    if (next > room) break
    used = next
    offset += line.length + 1
  }
  const text = `${content.slice(0, offset)}${closing(offset)}`
  // A limit too small for the full notice still gets one that fits.
  return { content: Buffer.byteLength(text) <= maxBytes ? text : brief, omitted: true }
}
