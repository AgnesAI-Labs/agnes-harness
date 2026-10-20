import { expect, it } from 'vitest'
import { jcs, jcsWrite } from '../src/jcs.js'

it('writes the same bytes in chunks as jcs returns whole', () => {
  const value = { b: ['x', 1, null, { d: true, c: 'é😀' }], a: ' "\\' }
  const parts: string[] = []
  jcsWrite(value, (chunk) => parts.push(chunk))
  expect(parts.join('')).toBe(jcs(value))
  expect(parts.length).toBeGreaterThan(1)
})

it('never splits a string token across chunks', () => {
  const parts: string[] = []
  jcsWrite({ k: '😀'.repeat(10_000) }, (chunk) => parts.push(chunk))
  // A `u` regex matches \p{Cs} only on an unpaired surrogate, so a split pair would show here.
  for (const part of parts) expect(/\p{Cs}/u.test(part)).toBe(false)
  expect(parts.join('')).toBe(jcs({ k: '😀'.repeat(10_000) }))
})

it('gives the same answers without String.prototype.isWellFormed, on the per-character path', () => {
  const samples: unknown[] = [
    '',
    'plain',
    'é你好😀𝄞',
    '"\\\n\t\u0000\u001f\u007f\u2028\u2029',
    { '😀': ['𐀀', '􏿿'] },
    'x'.repeat(70_000),
    '\ud800',
    'a\udc00',
    '\udc00\ud800',
    `😀${'\ud83d'}`,
    { k: ['ok', 'bad\udfff'] },
    { '\ud800': 1 },
  ]
  const run = () =>
    samples.map((value) => {
      try {
        return jcs(value)
      } catch (error) {
        return (error as Error).message
      }
    })
  const fast = run()
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed')
  expect(descriptor).toBeDefined()
  Reflect.deleteProperty(String.prototype, 'isWellFormed')
  try {
    expect('isWellFormed' in String.prototype).toBe(false)
    expect(run()).toEqual(fast)
  } finally {
    Object.defineProperty(String.prototype, 'isWellFormed', descriptor as PropertyDescriptor)
  }
  expect(fast.filter((result) => result === 'invalid JCS input')).toHaveLength(6)
})
