import type { JsonValue } from '@agnes/jev-runtime'

/** Snapshot lossless JSON at a model or durable-record boundary. */
export function durableJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(durableJson)
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('Model data must be lossless JSON')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, durableJson(item)]))
}

export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freezeJson(member)
    Object.freeze(value)
  }
  return value
}
