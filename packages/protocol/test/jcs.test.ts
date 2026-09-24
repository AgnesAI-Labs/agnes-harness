import { expect, it } from 'vitest'
import { jcs } from '../src/jcs.js'

it('sorts raw UTF-16 keys recursively and preserves array order and Unicode', () => {
  const value = { '\ufb33': 1, '😀': 2, z: [{ b: 1, a: 2 }], '10': 10, '2': 2, a: 'e\u0301' }
  expect(jcs(value)).toBe('{"10":10,"2":2,"a":"é","z":[{"a":2,"b":1}],"😀":2,"דּ":1}')
})
it('uses JSON number and escape spelling without lossy Unicode normalization', () => {
  expect(jcs([-0, 1e21, 1e-7, 4.5, null, true, false, '"\\\n\t\u000f'])).toBe(
    '[0,1e+21,1e-7,4.5,null,true,false,"\\"\\\\\\n\\t\\u000f"]',
  )
  expect(jcs('e\u0301')).not.toBe(jcs('é'))
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
})
it('refuses nested invalid values, holes, cycles and lone-surrogate keys', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const value of [{ n: NaN }, { u: undefined }, new Array(1), cycle, { '\ud800': 1 }])
    expect(() => jcs(value)).toThrow(/^invalid JCS input$/)
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
