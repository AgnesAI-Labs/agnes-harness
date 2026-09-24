/** RFC 8785 serialization of an already-parsed JSON value. Duplicate raw JSON keys must be
 * rejected by its parser; they cannot be recovered from a JavaScript object. */
export function jcs(value: unknown): string {
  const invalid = () => new Error('invalid JCS input')
  const active = new Set<object>()
  const string = (text: string): string => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid()
      } else if (code >= 0xdc00 && code <= 0xdfff) throw invalid()
    }
    return JSON.stringify(text)
  }
  const encode = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string') return string(item)
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalid()
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || active.has(item)) throw invalid()
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
        const values: string[] = []
        for (let i = 0; i < item.length; i++) values.push(encode(get(String(i))))
        return `[${values.join(',')}]`
      }
      return `{${(keys as string[])
        .sort()
        .map((key) => `${string(key)}:${encode(get(key))}`)
        .join(',')}}`
    } finally {
      active.delete(item)
    }
  }
  try {
    return encode(value)
  } catch {
    throw invalid()
  }
}
