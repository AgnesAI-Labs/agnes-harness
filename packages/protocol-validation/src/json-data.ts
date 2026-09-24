export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export const DEFAULT_JSON_DATA_MAX_BYTES = 65536
const encoder = new TextEncoder()

/** Validates a data-only snapshot without invoking user getters or toJSON methods. */
export function inspectJsonData(
  value: unknown,
  maxBytes = DEFAULT_JSON_DATA_MAX_BYTES,
): { ok: true; bytes: number; value: JsonValue } | { ok: false; reason: string } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false, reason: 'invalid byte limit' }
  const active = new Set<object>()
  const reject = (reason: string): never => {
    throw new Error(reason)
  }
  const walk = (v: unknown, depth: number): JsonValue => {
    if (depth > 32) return reject('nesting exceeds 32')
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number') return Number.isFinite(v) ? v : reject('non-finite number')
    if (typeof v !== 'object') return reject(`unsupported ${typeof v}`)
    if (active.has(v)) return reject('cycle')
    if ((JSON as typeof JSON & { isRawJSON?: (x: unknown) => boolean }).isRawJSON?.(v))
      return reject('raw JSON')
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v)
    if (array ? proto !== Array.prototype : proto !== null && proto !== Object.prototype)
      return reject('non-plain object')
    const descriptors = Object.getOwnPropertyDescriptors(v)
    if (Object.getOwnPropertySymbols(v).length) return reject('symbol key')
    if (
      array &&
      (Object.keys(descriptors).length !== v.length + 1 ||
        Object.keys(descriptors)
          .filter((k) => k !== 'length')
          .some((k, i) => k !== String(i)))
    )
      return reject('sparse or decorated array')
    active.add(v)
    const result: JsonValue[] | { [key: string]: JsonValue } = array ? [] : Object.create(null)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue
      if (!descriptor.enumerable || !('value' in descriptor)) return reject('non-data property')
      const child = walk(descriptor.value, depth + 1)
      Object.defineProperty(result, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    active.delete(v)
    return result
  }
  try {
    const snapshot = walk(value, 0)
    const bytes = encoder.encode(JSON.stringify(snapshot)).byteLength
    return bytes <= maxBytes
      ? { ok: true, bytes, value: snapshot }
      : { ok: false, reason: `size ${bytes} > ${maxBytes}` }
  } catch {
    return { ok: false, reason: 'payload is not bounded JSON data' }
  }
}
