import type { JsonValue } from './json-data.js'

export type CanonicalJsonLimits = { maxBytes: number; maxDepth: number; maxMembers: number }
export class CanonicalJsonError extends Error {
  constructor(readonly limit?: keyof CanonicalJsonLimits) {
    super(limit ? `JSON exceeds ${limit}` : 'invalid JCS input')
  }
}

/** Counts Unicode scalar UTF-8 bytes without replacement or allocating an encoded copy. */
export function scalarUtf8Bytes(value: string, maxBytes = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new CanonicalJsonError()
      bytes += 4
    } else {
      if (code >= 0xdc00 && code <= 0xdfff) throw new CanonicalJsonError()
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    }
    if (bytes > maxBytes) throw new CanonicalJsonError('maxBytes')
  }
  return bytes
}

/** The single RFC 8785 engine used by bounded snapshots and the historical jcs entry point. */
function encodeCanonicalJson(
  value: unknown,
  limits?: CanonicalJsonLimits,
  snapshot = true,
): { json: JsonValue; canonical: string; bytes: number } {
  let bytes = 0
  let members = 0
  const chunks: string[] = []
  const active = new Set<object>()
  const append = (text: string): void => {
    bytes += scalarUtf8Bytes(text, limits ? limits.maxBytes - bytes : Number.MAX_SAFE_INTEGER)
    chunks.push(text)
  }
  const string = (text: string): void => {
    append('"')
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + 1024, text.length)
      const last = text.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff && end < text.length) end++
      const part = text.slice(start, end)
      scalarUtf8Bytes(part)
      append(JSON.stringify(part).slice(1, -1))
      start = end
    }
    append('"')
  }
  const walk = (item: unknown, depth: number): JsonValue => {
    if (limits && depth > limits.maxDepth) throw new CanonicalJsonError('maxDepth')
    if (item === null) {
      append('null')
      return null
    }
    if (typeof item === 'string') {
      string(item)
      return item
    }
    if (typeof item === 'boolean') {
      append(item ? 'true' : 'false')
      return item
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new CanonicalJsonError()
      append(JSON.stringify(item))
      return item
    }
    if (typeof item !== 'object' || active.has(item)) throw new CanonicalJsonError()
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new CanonicalJsonError()
    const keys = Reflect.ownKeys(item)
    if (keys.some((key) => typeof key !== 'string')) throw new CanonicalJsonError()
    const count = keys.length - (array ? 1 : 0)
    members += count
    if (limits && members > limits.maxMembers) throw new CanonicalJsonError('maxMembers')
    if (limits && count && depth >= limits.maxDepth) throw new CanonicalJsonError('maxDepth')
    const get = (key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(item, key)
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw new CanonicalJsonError()
      return property.value
    }
    active.add(item)
    try {
      if (array) {
        if (keys.length !== item.length + 1) throw new CanonicalJsonError()
        const result: JsonValue[] | undefined = snapshot ? [] : undefined
        append('[')
        for (let index = 0; index < item.length; index++) {
          if (index) append(',')
          const child = walk(get(String(index)), depth + 1)
          result?.push(child)
        }
        append(']')
        return result ?? (item as JsonValue[])
      }
      const result: { [key: string]: JsonValue } | undefined = snapshot ? Object.create(null) : undefined
      append('{')
      for (const [index, key] of (keys as string[]).sort().entries()) {
        if (index) append(',')
        string(key)
        append(':')
        const child = walk(get(key), depth + 1)
        if (result) result[key] = child
      }
      append('}')
      return result ?? (item as { [key: string]: JsonValue })
    } finally {
      active.delete(item)
    }
  }
  const json = walk(value, 0)
  return { json, canonical: chunks.join(''), bytes }
}

export function canonicalJsonSnapshot(value: unknown, limits: CanonicalJsonLimits) {
  return encodeCanonicalJson(value, limits)
}

/** Duplicate raw JSON keys remain the parser's responsibility. No new default limits apply. */
export function jcs(value: unknown): string {
  try {
    return encodeCanonicalJson(value, undefined, false).canonical
  } catch {
    throw new Error('invalid JCS input')
  }
}
