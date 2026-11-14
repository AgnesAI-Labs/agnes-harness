import type { JsonValue } from '@agnes/protocol'

export type Preparation = {
  signal: AbortSignal
  end: number
  now: () => number
  check(): void
  step(force?: boolean): Promise<void> | undefined
}
export function preparation(signal: AbortSignal, end: number, now = () => Date.now()): Preparation {
  let units = 0
  let yielded = now()
  const check = () => {
    signal.throwIfAborted()
    if (now() >= end) throw new DOMException('Judgment preparation deadline', 'TimeoutError')
  }
  return {
    signal,
    end,
    now,
    check,
    step(force = false) {
      check()
      if (!force && ++units < 64 && now() - yielded < 8) return
      units = 0
      return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        check()
        yielded = now()
      })
    },
  }
}

/** Bounded chunks preserve JSON's complete string context; redaction happens only after collection. */
export function* jsonSnapshot(
  value: unknown,
  maxBytes: number,
  omitRootUndefinedKey?: 'criteria',
): Generator<string, JsonValue> {
  let bytes = 0
  const encoder = new TextEncoder()
  const seen = new Set<object>()
  function* emit(text: string): Generator<string, void> {
    bytes += encoder.encode(text).length
    if (bytes > maxBytes) throw new RangeError('Judgment preparation JSON exceeds byte limit')
    yield text
  }
  function* string(text: string): Generator<string, string> {
    if (text.length > maxBytes - bytes) throw new RangeError('Judgment preparation string exceeds byte limit')
    yield* emit('"')
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + 4096, text.length)
      if (
        end < text.length &&
        /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') &&
        /[\uDC00-\uDFFF]/.test(text[end] ?? '')
      )
        end--
      yield* emit(JSON.stringify(text.slice(start, end)).slice(1, -1))
      start = end
    }
    yield* emit('"')
    return text
  }
  function* walk(item: unknown, depth: number): Generator<string, JsonValue> {
    yield ''
    if (depth > 32) throw new TypeError('Invalid judgment JSON depth')
    if (typeof item === 'string') return yield* string(item)
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      yield* emit(JSON.stringify(item))
      return item
    }
    if (
      !item ||
      typeof item !== 'object' ||
      seen.has(item) ||
      (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
    )
      throw new TypeError('Invalid judgment JSON')
    seen.add(item)
    if (Array.isArray(item)) {
      if (item.length > maxBytes) throw new RangeError('Judgment preparation array exceeds byte limit')
      const out: JsonValue[] = []
      yield* emit('[')
      for (let i = 0; i < item.length; i++) {
        if (i) yield* emit(',')
        out.push(yield* walk(Object.hasOwn(item, i) ? item[i] : null, depth + 1))
      }
      yield* emit(']')
      seen.delete(item)
      return out
    }
    const out: Record<string, JsonValue> = Object.create(null)
    yield* emit('{')
    let first = true
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      if (depth === 0 && key === omitRootUndefinedKey && (item as Record<string, unknown>)[key] === undefined)
        continue
      if (!first) yield* emit(',')
      first = false
      yield* string(key)
      yield* emit(':')
      out[key] = yield* walk((item as Record<string, unknown>)[key], depth + 1)
    }
    yield* emit('}')
    seen.delete(item)
    return out
  }
  return yield* walk(value, 0)
}
export function* serializedJson(
  value: unknown,
  maxBytes: number,
  omitRootUndefinedKey?: 'criteria',
): Generator<void, { value: JsonValue; text: string }> {
  const iterator = jsonSnapshot(value, maxBytes, omitRootUndefinedKey)
  const text: string[] = []
  for (;;) {
    yield
    const next = iterator.next()
    if (next.done) return { value: next.value, text: text.join('') }
    text.push(next.value)
  }
}
export async function cooperate<T>(iterator: Generator<void, T>, scope: Preparation): Promise<T> {
  for (;;) {
    const waiting = scope.step()
    if (waiting) await waiting
    const next = iterator.next()
    if (next.done) return next.value
  }
}
export function snapshot(value: unknown, maxBytes: number, scope: Preparation) {
  return cooperate(serializedJson(value, maxBytes), scope)
}
