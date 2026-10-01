import { types } from 'node:util'
import { jcs } from '@agnes/protocol'
import { noteCanonical, profiling } from './profile.js'

const fallback = new Error('canonical-json fallback')

/** RFC 8785 encoding of a parsed JSON value. The text matches `@agnes/protocol` `jcs`.
 * Duplicate raw JSON keys are rejected by the parser and cannot be recovered from an object.
 * A proxy is encoded by `jcs` so the two stay identical. */
export function canonicalJson(value: unknown): string {
  if (!profiling) return encodeCanonical(value)
  const started = performance.now()
  const text = encodeCanonical(value)
  noteCanonical(performance.now() - started, Buffer.byteLength(text))
  return text
}

function encodeCanonical(value: unknown): string {
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
    if (types.isProxy(item)) throw fallback
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw invalid()
    active.add(item)
    try {
      if (Object.getOwnPropertySymbols(item).length !== 0) throw invalid()
      const names = Object.getOwnPropertyNames(item)
      const read = (key: string): unknown => {
        const property = Object.getOwnPropertyDescriptor(item, key)
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw invalid()
        return property.value
      }
      if (array) {
        if (names.length !== item.length + 1) throw invalid()
        const values = new Array<string>(item.length)
        for (let index = 0; index < item.length; index++) values[index] = encode(read(String(index)))
        return `[${values.join(',')}]`
      }
      if (names.length !== Object.keys(item).length) throw invalid()
      names.sort()
      let encoded = '{'
      for (let index = 0; index < names.length; index++) {
        const key = names[index] as string
        if (index > 0) encoded += ','
        encoded += `${string(key)}:${encode(read(key))}`
      }
      return `${encoded}}`
    } finally {
      active.delete(item)
    }
  }
  try {
    return encode(value)
  } catch (error) {
    if (error === fallback) return jcs(value)
    throw invalid()
  }
}
