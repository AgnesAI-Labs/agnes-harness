/** Bounded JSON evidence with explicit JSON pointers to shortened text or collections. */
import type { JsonValue } from './types.js'

/**
 * Measure the serialized model input, including JSON escaping.
 * @param value - JSON input.
 * @returns UTF-8 byte length.
 */
export function jsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

interface BoundedValue {
  value: JsonValue
  truncatedPaths: string[]
}

function prefix(text: string, end: number): string {
  const last = text.charCodeAt(end - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

function bounded(value: JsonValue, limit: number, path: string): BoundedValue | undefined {
  if (jsonBytes(value) <= limit) return { value, truncatedPaths: [] }
  if (typeof value === 'string' && limit >= 2) {
    let low = 0
    let high = value.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (jsonBytes(prefix(value, middle)) <= limit) low = middle
      else high = middle - 1
    }
    return { value: prefix(value, low), truncatedPaths: [path] }
  }
  if (value === null || typeof value !== 'object' || limit < 2) return undefined
  const result: BoundedValue = { value: Array.isArray(value) ? [] : {}, truncatedPaths: [] }
  let remaining = limit - 2
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    const cost = (count > 0 ? 1 : 0) + (Array.isArray(value) ? 0 : jsonBytes(key) + 1)
    const child = bounded(
      item,
      remaining - cost,
      `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    )
    if (child === undefined) {
      result.truncatedPaths.push(path)
      break
    }
    if (Array.isArray(result.value)) result.value.push(child.value)
    else if (result.value !== null && typeof result.value === 'object') {
      Object.defineProperty(result.value, key, { value: child.value, enumerable: true, configurable: true })
    }
    result.truncatedPaths.push(...child.truncatedPaths)
    remaining -= cost + jsonBytes(child.value)
    count++
  }
  return result
}

/**
 * Retain JSON types and source order; shorten text and collection tails only when required.
 * @param value - complete recorded evidence.
 * @param limit - maximum serialized bytes allocated to the displayed value.
 * @returns value plus projection metadata; an empty pointer means the root was shortened or omitted.
 */
export function decisionEvidence(
  value: JsonValue,
  limit: number,
): {
  value: JsonValue
  projection: { truncated: boolean; truncatedPaths: string[]; originalBytes: number }
} {
  const result = bounded(value, limit, '') ?? { value: null, truncatedPaths: [''] }
  return {
    value: result.value,
    projection: {
      truncated: result.truncatedPaths.length > 0,
      truncatedPaths: result.truncatedPaths,
      originalBytes: jsonBytes(value),
    },
  }
}
