import { createHash } from 'node:crypto'
import type { JsonValue } from './types.js'

// Python's sort_keys orders keys by code point; a plain JS sort compares UTF-16 code units, which
// differ for characters outside the Basic Multilingual Plane.
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const delta = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
    if (delta !== 0) return delta
  }
  return x.length - y.length
}

function serialize(value: JsonValue, item: string, pair: string): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry, item, pair)).join(item)}]`
  const record = value as { [key: string]: JsonValue | undefined }
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}${pair}${serialize(record[key] as JsonValue, item, pair)}`)
  return `{${fields.join(item)}}`
}

/** Sorted keys, no whitespace. */
export function canonicalJson(value: JsonValue): string {
  return serialize(value, ',', ':')
}

/** The text of Python `json.dumps(value, ensure_ascii=False, sort_keys=True)`. */
export function pyJson(value: JsonValue): string {
  return serialize(value, ', ', ': ')
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** First 32 hex digits of sha256: of a string as given, of any other value as canonical JSON. */
export function fingerprint(value: JsonValue | string): string {
  return sha256(typeof value === 'string' ? value : canonicalJson(value)).slice(0, 32)
}

/** First 16 hex digits of sha256 over the canonical JSON. */
export function digest16(value: JsonValue): string {
  return sha256(canonicalJson(value)).slice(0, 16)
}

/** UTF-8 length; a lone surrogate counts as the 3 bytes of its replacement character. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** The first `max` UTF-16 code units. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max))
}

/** The last `max` UTF-16 code units. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 0 ? '' : text.slice(text.length - max)
}

/** The string `code` of a thrown value, if it has one. */
export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
