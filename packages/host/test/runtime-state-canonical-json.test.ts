import { jcs } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { canonicalJson } from '../src/runtime/state/canonical-json.js'

function sameBytes(value: unknown): void {
  const local = Buffer.from(canonicalJson(value), 'utf8')
  const protocol = Buffer.from(jcs(value), 'utf8')
  expect(local.equals(protocol)).toBe(true)
}

function bothReject(value: unknown): void {
  expect(() => canonicalJson(value)).toThrow(/^invalid JCS input$/)
  expect(() => jcs(value)).toThrow(/^invalid JCS input$/)
}

it('matches protocol jcs byte for byte on sorted keys, numbers and escapes', () => {
  const sorted = { '\ufb33': 1, '😀': 2, z: [{ b: 1, a: 2 }], '10': 10, '2': 2, a: 'e\u0301' }
  expect(canonicalJson(sorted)).toBe('{"10":10,"2":2,"a":"é","z":[{"a":2,"b":1}],"😀":2,"דּ":1}')
  sameBytes(sorted)
  const numbers = [-0, 1e21, 1e-7, 4.5, null, true, false, '"\\\n\t\u000f']
  expect(canonicalJson(numbers)).toBe('[0,1e+21,1e-7,4.5,null,true,false,"\\"\\\\\\n\\t\\u000f"]')
  sameBytes(numbers)
  expect(canonicalJson('e\u0301')).not.toBe(canonicalJson('é'))
  sameBytes('e\u0301')
  sameBytes('é')
  sameBytes({})
  sameBytes([])
  sameBytes({ nested: { b: [1, { a: 'x' }], a: 0 }, z: null })
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
)('rejects the same non-JSON input as protocol jcs ($value)', ({ value }) => {
  bothReject(value)
})

it('rejects the same holes, cycles, accessors and lone surrogates as protocol jcs', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const hole = new Array(1)
  const hidden = Object.defineProperty({ a: 1 }, 'b', { value: 2, enumerable: false })
  const symbolKey = Object.defineProperty({ a: 1 }, Symbol('k'), { value: 2, enumerable: true })
  for (const value of [{ n: NaN }, { u: undefined }, hole, cycle, { '\ud800': 1 }, hidden, symbolKey])
    bothReject(value)
  let calls = 0
  const getter = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      calls++
      return 1
    },
  })
  const toJson = {
    toJSON() {
      calls++
      return 'hidden'
    },
  }
  bothReject(getter)
  bothReject(toJson)
  expect(calls).toBe(0)
  const shared = { a: 1 }
  sameBytes([shared, shared])
  sameBytes(Object.assign(Object.create(null), { a: 1 }))
  sameBytes(new Proxy({ b: 1, a: 2 }, {}))
  sameBytes({ nested: new Proxy({ z: 1, a: [shared] }, {}) })
})
