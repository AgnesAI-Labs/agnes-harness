/** A bounded encoder stopped before materializing an oversized JSON result. */
export class JcsByteLimitError extends Error {
  constructor() {
    super('JCS byte limit exceeded')
    this.name = 'JcsByteLimitError'
  }
}

type WellFormed = { isWellFormed?: () => boolean }
/** RFC 8785 serializes strings exactly as ECMAScript JSON.stringify does, so a well-formed string
 * needs no per-character pass; only a string with a lone surrogate takes the slow path, which rejects it. */
const wellFormed = (text: string): boolean | undefined => (text as unknown as WellFormed).isWellFormed?.()

/** RFC 8785 serialization written as a sequence of chunks; no string token is split across chunks. */
export function jcsWrite(value: unknown, write: (chunk: string) => void): void {
  const invalid = () => new Error('invalid JCS input')
  const active = new Set<object>()
  const string = (text: string): string => {
    const fast = wellFormed(text)
    if (fast === true) return JSON.stringify(text)
    if (fast === false) throw invalid()
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid()
      } else if (code >= 0xdc00 && code <= 0xdfff) throw invalid()
    }
    return JSON.stringify(text)
  }
  const scalar = (item: unknown): string | undefined => {
    if (item === null) return 'null'
    if (typeof item === 'string') return string(item)
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalid()
      return JSON.stringify(item)
    }
    return undefined
  }
  const encode = (item: unknown): void => {
    const text = scalar(item)
    if (text !== undefined) {
      write(text)
      return
    }
    if (typeof item !== 'object' || item === null || active.has(item)) throw invalid()
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw invalid()
    active.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      const keys = Reflect.ownKeys(descriptors)
      if (keys.some((key) => typeof key !== 'string')) throw invalid()
      const get = (key: string): unknown => {
        const property = descriptors[key]
        if (!Object.hasOwn(descriptors, key) || !property?.enumerable || !Object.hasOwn(property, 'value'))
          throw invalid()
        return property.value
      }
      if (array) {
        if (keys.length !== item.length + 1) throw invalid()
        write('[')
        for (let i = 0; i < item.length; i++) {
          if (i) write(',')
          encode(get(String(i)))
        }
        write(']')
        return
      }
      write('{')
      for (const [index, key] of (keys as string[]).sort().entries()) {
        write(`${index ? ',' : ''}${string(key)}:`)
        encode(get(key))
      }
      write('}')
    } finally {
      active.delete(item)
    }
  }
  try {
    encode(value)
  } catch {
    throw invalid()
  }
}

/** Incremental RFC 8785 tokens for cooperative consumers; large strings are split at code-point boundaries. */
export function* jcsChunks(value: unknown): Generator<string> {
  const invalid = () => new Error('invalid JCS input')
  const active = new Set<object>()
  function* string(text: string): Generator<string> {
    yield '"'
    const size = 64 * 1024
    for (let at = 0; at < text.length; ) {
      let end = Math.min(text.length, at + size)
      const code = text.charCodeAt(end - 1)
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--
      const part = text.slice(at, end)
      // Reuse the synchronous encoder's strict surrogate validation and ECMAScript escaping.
      let token = ''
      jcsWrite(part, (value) => {
        token = value
      })
      yield token.slice(1, -1)
      at = end
    }
    yield '"'
  }
  const scalar = (item: unknown): string | undefined => {
    if (item === null) return 'null'
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalid()
      return JSON.stringify(item)
    }
    return undefined
  }
  function* encode(item: unknown): Generator<string> {
    if (typeof item === 'string') {
      yield* string(item)
      return
    }
    const text = scalar(item)
    if (text !== undefined) {
      yield text
      return
    }
    if (typeof item !== 'object' || item === null || active.has(item)) throw invalid()
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw invalid()
    active.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      const keys = Reflect.ownKeys(descriptors)
      if (keys.some((key) => typeof key !== 'string')) throw invalid()
      const get = (key: string): unknown => {
        const property = descriptors[key]
        if (!Object.hasOwn(descriptors, key) || !property?.enumerable || !Object.hasOwn(property, 'value'))
          throw invalid()
        return property.value
      }
      if (array) {
        if (keys.length !== item.length + 1) throw invalid()
        yield '['
        for (let i = 0; i < item.length; i++) {
          if (i) yield ','
          yield* encode(get(String(i)))
        }
        yield ']'
        return
      }
      yield '{'
      for (const [index, key] of (keys as string[]).sort().entries()) {
        if (index) yield ','
        yield* string(key)
        yield ':'
        yield* encode(get(key))
      }
      yield '}'
    } finally {
      active.delete(item)
    }
  }
  try {
    yield* encode(value)
  } catch {
    throw invalid()
  }
}

/** RFC 8785 serialization of an already-parsed JSON value. Duplicate raw JSON keys must be
 * rejected by its parser; they cannot be recovered from a JavaScript object.
 * An optional UTF-8 byte budget stops encoding at the first oversized token. */
export function jcs(value: unknown, maxBytes?: number): string {
  if (maxBytes === undefined) {
    const parts: string[] = []
    jcsWrite(value, (chunk) => parts.push(chunk))
    return parts.join('')
  }
  const invalid = () => new Error('invalid JCS input')
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw invalid()
  const active = new Set<object>()
  const chunks: string[] = []
  let bytes = 0
  const charge = (text: string) => {
    if (maxBytes === undefined) return
    for (const character of text) {
      const code = character.codePointAt(0)!
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
      if (bytes > maxBytes) throw new JcsByteLimitError()
    }
  }
  const append = (text: string) => {
    charge(text)
    chunks.push(text)
  }
  const string = (text: string) => {
    let chunk = ''
    if (maxBytes !== undefined) append('"')
    for (let i = 0; i < text.length; i++) {
      const start = i
      const code = text.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid()
      } else if (code >= 0xdc00 && code <= 0xdfff) throw invalid()
      if (maxBytes !== undefined) {
        const escaped = JSON.stringify(text.slice(start, i + 1)).slice(1, -1)
        charge(escaped)
        chunk += escaped
        if (chunk.length >= 256) {
          chunks.push(chunk)
          chunk = ''
        }
      }
    }
    if (maxBytes === undefined) append(JSON.stringify(text))
    else {
      if (chunk) chunks.push(chunk)
      append('"')
    }
  }
  const encode = (item: unknown): void => {
    if (item === null) {
      append('null')
      return
    }
    if (typeof item === 'string') {
      string(item)
      return
    }
    if (typeof item === 'boolean') {
      append(item ? 'true' : 'false')
      return
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalid()
      append(JSON.stringify(item))
      return
    }
    if (typeof item !== 'object' || active.has(item)) throw invalid()
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw invalid()
    active.add(item)
    try {
      const get = (key: string): unknown => {
        const property = Object.getOwnPropertyDescriptor(item, key)
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw invalid()
        return property.value
      }
      if (array) {
        append('[')
        for (let i = 0; i < item.length; i++) {
          if (i) append(',')
          encode(get(String(i)))
        }
        // Inspect the full key set only after a bounded array has finished encoding.
        if (Reflect.ownKeys(item).length !== item.length + 1) throw invalid()
        append(']')
        return
      }
      const keys = Reflect.ownKeys(item)
      if (keys.some((key) => typeof key !== 'string')) throw invalid()
      append('{')
      for (const [index, key] of (keys as string[]).sort().entries()) {
        if (index) append(',')
        string(key)
        append(':')
        encode(get(key))
      }
      append('}')
    } finally {
      active.delete(item)
    }
  }
  try {
    encode(value)
    return chunks.join('')
  } catch (error) {
    if (error instanceof JcsByteLimitError) throw error
    throw invalid()
  }
}
