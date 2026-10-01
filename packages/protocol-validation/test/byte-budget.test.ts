import { describe, expect, it } from 'vitest'
import { boundedCanonicalJson, utf8ByteLength } from '../src/byte-budget.js'
import { jcs } from '../src/canonical-json.js'

const budget = { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 }

describe('bounded canonical JSON and UTF-8', () => {
  it('counts UTF-8 separately from escaped JSON, with exact byte boundaries', () => {
    expect(utf8ByteLength('😀é\n', 7)).toEqual({ ok: true, value: 7 })
    expect(utf8ByteLength('😀é\n', 6)).toMatchObject({
      ok: false,
      errors: [{ code: 'RANGE', key: 'maxBytes' }],
    })
    const exact = 'x'.repeat(65534)
    expect(boundedCanonicalJson(exact, budget)).toMatchObject({ ok: true, value: { bytes: 65536 } })
    expect(boundedCanonicalJson(`${exact}x`, budget)).toMatchObject({
      ok: false,
      errors: [{ key: 'maxBytes' }],
    })
    expect(boundedCanonicalJson('\n', { ...budget, maxBytes: 4 })).toMatchObject({
      ok: true,
      value: { canonical: '"\\n"', bytes: 4 },
    })
  })
  it('preserves original numbers and detaches the snapshot before schema validation', () => {
    const value = { z: -0, a: { x: 1 } }
    const result = boundedCanonicalJson(value, budget)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.value.canonical).toBe('{"a":{"x":1},"z":0}')
    expect(Object.is((result.value.json as { z: number }).z, -0)).toBe(true)
    value.a.x = 2
    expect(result.value.json).toEqual({ z: -0, a: { x: 1 } })
    expect(jcs(result.value.json)).toBe(result.value.canonical)
  })
  it('applies zero, depth and repeated-member budgets exactly', () => {
    expect(utf8ByteLength('', 0)).toEqual({ ok: true, value: 0 })
    expect(boundedCanonicalJson(null, { maxBytes: 4, maxDepth: 0, maxMembers: 0 }).ok).toBe(true)
    expect(boundedCanonicalJson({}, { maxBytes: 2, maxDepth: 0, maxMembers: 0 }).ok).toBe(true)
    expect(boundedCanonicalJson({ a: 1 }, { ...budget, maxDepth: 0 })).toMatchObject({
      ok: false,
      errors: [{ key: 'maxDepth' }],
    })
    const child = { a: 1 }
    expect(boundedCanonicalJson([child, child], { ...budget, maxMembers: 3 })).toMatchObject({
      ok: false,
      errors: [{ key: 'maxMembers' }],
    })
    expect(boundedCanonicalJson([child, child], { ...budget, maxMembers: 4 }).ok).toBe(true)
    for (const invalid of [-0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(utf8ByteLength('a', invalid).ok).toBe(false)
      expect(boundedCanonicalJson({}, { ...budget, maxDepth: invalid }).ok).toBe(false)
    }
  })
  it('rejects unsafe data without executing getters or toJSON and rejects lone surrogates', () => {
    let calls = 0
    const accessor = {
      get x() {
        calls++
        return 1
      },
    }
    const cycle: unknown[] = []
    cycle.push(cycle)
    for (const value of [
      accessor,
      cycle,
      new Date(),
      [undefined],
      Array(1),
      { x: Infinity },
      {
        toJSON() {
          calls++
          return {}
        },
      },
      { [Symbol('x')]: 1 },
      '\ud800',
      { '\udfff': 1 },
    ]) {
      expect(boundedCanonicalJson(value, budget).ok).toBe(false)
    }
    expect(
      boundedCanonicalJson(
        {},
        {
          ...budget,
          get maxBytes() {
            calls++
            return 10
          },
        },
      ).ok,
    ).toBe(false)
    expect(calls).toBe(0)
    expect(utf8ByteLength('\ud800', 100).ok).toBe(false)
    expect(utf8ByteLength('\udfff', 100).ok).toBe(false)
    expect(utf8ByteLength('😀', 4)).toEqual({ ok: true, value: 4 })
  })
  it('stops before visiting data beyond a structural or byte limit', () => {
    let calls = 0
    const value = {
      a: 'x'.repeat(2048),
      get z() {
        calls++
        return 1
      },
    }
    expect(boundedCanonicalJson(value, { ...budget, maxBytes: 100 })).toMatchObject({
      ok: false,
      errors: [{ key: 'maxBytes' }],
    })
    expect(boundedCanonicalJson(value, { ...budget, maxMembers: 0 })).toMatchObject({
      ok: false,
      errors: [{ key: 'maxMembers' }],
    })
    expect(calls).toBe(0)
  })
})
