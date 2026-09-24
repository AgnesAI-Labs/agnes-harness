import { describe, expect, it } from 'vitest'
import { isJsonPayload, SLOT_NAMES, SLOT_PAYLOAD_MAX_BYTES, SLOT_TABLE } from '../src/index.js'

describe('slot contracts and JSON boundary', () => {
  it('uses the real protocol slots and immutable table metadata', () => {
    expect(SLOT_NAMES).toEqual(['tool.card.inline', 'sidebar.action', 'status.line', 'notification'])
    expect(Object.values(SLOT_TABLE).map((s) => s.order)).toEqual([100, 200, 300, 400])
    expect(SLOT_TABLE.notification.surfaces).toEqual(['web', 'channel'])
    expect(Reflect.set(SLOT_TABLE.notification, 'failPolicy', 'closed')).toBe(false)
    expect(Reflect.set(SLOT_TABLE.notification.surfaces, 0, 'tui')).toBe(false)
  })
  it('measures exact JSON UTF-8 bytes through the default limit path', () => {
    expect(SLOT_PAYLOAD_MAX_BYTES).toBe(65536)
    expect(isJsonPayload('a'.repeat(65534))).toEqual({ ok: true, bytes: 65536 })
    expect(isJsonPayload('a'.repeat(65535))).toEqual({ ok: false, reason: 'size 65537 > 65536' })
    expect(isJsonPayload('中'.repeat(21844))).toEqual({ ok: true, bytes: 65534 })
    expect(isJsonPayload('中'.repeat(21845))).toEqual({ ok: false, reason: 'size 65537 > 65536' })
    expect(isJsonPayload('\n', 4)).toEqual({ ok: true, bytes: 4 })
    expect(isJsonPayload('\n', 3).ok).toBe(false)
  })
  it('rejects non-JSON data without executing accessors or serializers', () => {
    let calls = 0
    const getter = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        calls++
        return 'x'
      },
    })
    const serializer = {
      toJSON() {
        calls++
        return 'x'
      },
    }
    for (const value of [
      getter,
      serializer,
      undefined,
      1n,
      Symbol('s'),
      NaN,
      Infinity,
      new Date(),
      new Map(),
      (JSON as typeof JSON & { rawJSON: (text: string) => unknown }).rawJSON('123'),
      // biome-ignore lint/suspicious/noSparseArray: negative boundary probe
      [1, , 2],
      Object.assign([], { decorated: true }),
      { [Symbol('x')]: 1 },
      Object.defineProperty({}, 'hidden', { value: 1 }),
    ])
      expect(isJsonPayload(value).ok).toBe(false)
    expect(calls).toBe(0)
  })
  it('rejects cycles and excessive nesting but accepts shared plain data and null prototypes', () => {
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(isJsonPayload(cyclic).ok).toBe(false)
    let deep: unknown = null
    for (let i = 0; i < 34; i++) deep = [deep]
    expect(isJsonPayload(deep).ok).toBe(false)
    const shared = Object.assign(Object.create(null), { a: 1 })
    expect(isJsonPayload([shared, shared])).toEqual({ ok: true, bytes: 17 })
    expect(isJsonPayload(JSON.parse('{"__proto__":{"safe":true}}'))).toEqual({ ok: true, bytes: 27 })
    for (const limit of [-1, NaN, Infinity, 1.5]) expect(isJsonPayload(null, limit).ok).toBe(false)
  })
})
