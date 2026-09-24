import { describe, expect, it } from 'vitest'
import { inspectJsonData } from '../src/index.js'

describe('shared JSON data inspection', () => {
  it('returns a detached snapshot and exact default byte measurement', () => {
    const original = { nested: [{ text: 'ok' }] }
    const inspected = inspectJsonData(original)
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) throw new Error('rejected')
    const first = original.nested[0]
    if (!first) throw new Error('missing fixture')
    first.text = 'changed'
    expect(inspected.value).toEqual({ nested: [{ text: 'ok' }] })
    expect(inspected.bytes).toBe(new TextEncoder().encode(JSON.stringify(inspected.value)).length)
    expect(inspectJsonData('x'.repeat(65534)).ok).toBe(true)
    expect(inspectJsonData('x'.repeat(65535)).ok).toBe(false)
  })
  it('never invokes accessors or serializers and does not accept hidden or symbolic state', () => {
    let called = 0
    const getter = Object.defineProperty({}, 'key', {
      enumerable: true,
      get() {
        called++
        return 'value'
      },
    })
    const serializer = {
      toJSON() {
        called++
        return {}
      },
    }
    for (const value of [
      getter,
      serializer,
      { [Symbol('s')]: 1 },
      Object.defineProperty({}, 'x', { value: 1 }),
    ])
      expect(inspectJsonData(value).ok).toBe(false)
    expect(called).toBe(0)
  })
  it('keeps proto keys as own data and rejects cycles while allowing shared references', () => {
    const value = JSON.parse('{"__proto__":{"x":1}}')
    const result = inspectJsonData(value)
    if (!result.ok) throw new Error('rejected')
    expect(Object.getPrototypeOf(result.value)).toBeNull()
    expect(Object.hasOwn(result.value as object, '__proto__')).toBe(true)
    const a: unknown[] = []
    a.push(a)
    expect(inspectJsonData(a).ok).toBe(false)
    expect(inspectJsonData([value, value]).ok).toBe(true)
  })
})
