import { createHash } from 'node:crypto'
import type { MemoryFile, MemorySettings } from '@agnes/extension-api'

export const defaults: MemorySettings = Object.freeze({
  mode: 'off',
  indexMaxBytes: 16 * 1024,
  indexMaxLines: 200,
  topicMaxBytes: 32 * 1024,
  totalMaxBytes: 256 * 1024,
  tokenBudget: 2048,
  userTokenBudget: 512,
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

/** A UTF-8 byte is a conservative upper bound for tokenizer token count. */
export function fit(content: string, tokens: number): { content: string; used: number; omitted: boolean } {
  const bytes = Buffer.byteLength(content)
  if (bytes <= tokens) return { content, used: bytes, omitted: false }
  const marker = '\n[Memory omitted: token budget exceeded; read topic files on demand.]'
  if (tokens < Buffer.byteLength(marker)) return { content: '', used: 0, omitted: true }
  let result = ''
  for (const character of content) {
    if (Buffer.byteLength(result + character + marker) > tokens) break
    result += character
  }
  return { content: result + marker, used: Buffer.byteLength(result + marker), omitted: true }
}
