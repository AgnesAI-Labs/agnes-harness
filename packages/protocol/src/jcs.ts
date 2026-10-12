/** A bounded encoder stopped before materializing an oversized JSON result. */
export class JcsByteLimitError extends Error {
  constructor() {
    super('JCS byte limit exceeded')
    this.name = 'JcsByteLimitError'
  }
}

/** RFC 8785 serialization of an already-parsed JSON value. Duplicate raw JSON keys must be
 * rejected by its parser; they cannot be recovered from a JavaScript object.
 * An optional UTF-8 byte budget stops encoding at the first oversized token. */
export function jcs(value: unknown, maxBytes?: number): string {
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
