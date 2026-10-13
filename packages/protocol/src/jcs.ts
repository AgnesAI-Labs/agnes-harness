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

/** RFC 8785 serialization of an already-parsed JSON value. Duplicate raw JSON keys must be
 * rejected by its parser; they cannot be recovered from a JavaScript object. */
export function jcs(value: unknown): string {
  const parts: string[] = []
  jcsWrite(value, (chunk) => parts.push(chunk))
  return parts.join('')
}
