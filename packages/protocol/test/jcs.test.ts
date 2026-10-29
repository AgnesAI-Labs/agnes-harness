import { expect, it } from 'vitest'
import { jcs, jcsChunks, jcsWrite } from '../src/jcs.js'

it('sorts raw UTF-16 keys recursively and preserves array order and Unicode', () => {
  const value = { '\ufb33': 1, '😀': 2, z: [{ b: 1, a: 2 }], '10': 10, '2': 2, a: 'e\u0301' }
  expect(jcs(value)).toBe('{"10":10,"2":2,"a":"é","z":[{"a":2,"b":1}],"😀":2,"דּ":1}')
})
it('uses JSON number and escape spelling without lossy Unicode normalization', () => {
  expect(jcs([-0, 1e21, 1e-7, 4.5, null, true, false, '"\\\n\t\u000f'])).toBe(
    '[0,1e+21,1e-7,4.5,null,true,false,"\\"\\\\\\n\\t\\u000f"]',
  )
  expect(jcs('e\u0301')).not.toBe(jcs('é'))
  const large = ['x'.repeat(65535) + '😀' + 'é'.repeat(70000), { 'a\n': '\\' }]
  expect([...jcsChunks(large)].join('')).toBe(jcs(large))
  const value = ['😀', '"\\\n', { b: 'é', a: 1 }]
  const encoded = jcs(value)
  const bytes = new TextEncoder().encode(encoded).length
  expect(jcs(value, bytes)).toBe(encoded)
  expect(() => jcs(value, bytes - 1)).toThrow('JCS byte limit exceeded')
  expect(() => jcs(['x'.repeat(1_000_000), NaN], 16)).toThrow('JCS byte limit exceeded')
})
it.each(
  [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('x'),
    () => 1,
    new Date(),
    new Map(),
    '\ud800',
    '\udc00',
    '\ud800a',
  ].map((value) => ({ value })),
)('rejects non-JSON or invalid Unicode input $value', ({ value }) => {
  expect(() => jcs(value)).toThrow(/^invalid JCS input$/)
  expect(() => [...jcsChunks(value)]).toThrow(/^invalid JCS input$/)
})
it('refuses nested invalid values, holes, cycles and lone-surrogate keys', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const value of [{ n: NaN }, { u: undefined }, new Array(1), cycle, { '\ud800': 1 }]) {
    expect(() => jcs(value)).toThrow(/^invalid JCS input$/)
    expect(() => [...jcsChunks(value)]).toThrow(/^invalid JCS input$/)
  }
})
it('does not execute accessors or toJSON and allows shared acyclic JSON objects', () => {
  let calls = 0
  const getter = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      calls++
      return 1
    },
  })
  expect(() => jcs(getter)).toThrow(/^invalid JCS input$/)
  expect(() =>
    jcs({
      toJSON() {
        calls++
        return 'hidden'
      },
    }),
  ).toThrow(/^invalid JCS input$/)
  expect(calls).toBe(0)
  const shared = { a: 1 }
  expect(jcs([shared, shared])).toBe('[{"a":1},{"a":1}]')
  expect(jcs(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}')
})

// The bounded encoder is the previous implementation, kept unchanged for callers that need a byte
// budget. With a budget no input can reach it must agree with the chunked writer on every value: the
// same bytes for what serializes, and a refusal for exactly what does not.
it('serializes and refuses exactly as the bounded encoder does, and its chunks add up to the same text', () => {
  const reference = (value: unknown): string | Error => {
    try {
      return jcs(value, Number.MAX_SAFE_INTEGER)
    } catch (error) {
      return error as Error
    }
  }
  const candidate = (value: unknown): string | Error => {
    try {
      const encoded = jcs(value)
      expect([...jcsChunks(value)].join('')).toBe(encoded)
      return encoded
    } catch (error) {
      return error as Error
    }
  }
  // xorshift32: the low bits of a linear congruential generator cycle, which left the sample degenerate.
  let seed = 424242
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  const strings = [
    '',
    'a',
    'é',
    '中',
    '😀',
    '\n',
    '"',
    '\\',
    '\u0001',
    '\ud800',
    '\udc00',
    'a\ud83d',
    '\ude00b',
    'x'.repeat(300),
  ]
  let unordered = 0
  const numbers = [0, -0, 1, -1.5, 1e21, 1e-7, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]
  const make = (depth: number): unknown => {
    const kind = next() % (depth > 3 ? 4 : 9)
    if (kind === 0) return strings[next() % strings.length]
    if (kind === 1) return numbers[next() % numbers.length]
    if (kind === 2) return next() % 2 === 0
    if (kind === 3) return null
    if (kind === 4 || kind === 5) return Array.from({ length: next() % 4 }, () => make(depth + 1))
    if (kind === 6) {
      const out: Record<string, unknown> = {}
      for (let i = 0, n = next() % 4; i < n; i++) out[`${strings[next() % 6]}${next() % 5}`] = make(depth + 1)
      const inserted = Object.keys(out)
      if (inserted.join() !== [...inserted].sort().join()) unordered++
      return out
    }
    if (kind === 7) return [undefined, make(depth + 1)]
    return { [strings[next() % strings.length] as string]: undefined, k: make(depth + 1) }
  }
  let refused = 0
  for (let n = 0; n < 3000; n++) {
    const value = make(0)
    const expected = reference(value)
    const actual = candidate(value)
    if (expected instanceof Error) {
      refused++
      expect(actual).toBeInstanceOf(Error)
      expect((actual as Error).message).toBe(expected.message)
    } else {
      expect(actual).toBe(expected)
      const parts: string[] = []
      jcsWrite(value, (chunk) => parts.push(chunk))
      expect(parts.join('')).toBe(expected)
    }
  }
  expect(refused).toBeGreaterThan(100)
  expect(refused).toBeLessThan(2900)
  // Without objects whose keys were inserted out of order the comparison could not notice a missing sort.
  expect(unordered).toBeGreaterThan(50)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const accessor = Object.defineProperty({}, 'x', { get: () => 1, enumerable: true })
  const symbolKeyed = { [Symbol('s')]: 1 }
  // biome-ignore lint/suspicious/noSparseArray: the case under test
  const hole = [1, , 3]
  const hidden = Object.defineProperty({}, 'x', { value: 1, enumerable: false })
  for (const value of [
    cyclic,
    accessor,
    symbolKeyed,
    hole,
    hidden,
    new Date(0),
    new Map(),
    () => 1,
    Symbol('x'),
    undefined,
  ]) {
    expect(candidate(value)).toBeInstanceOf(Error)
    expect(reference(value)).toBeInstanceOf(Error)
  }
})
