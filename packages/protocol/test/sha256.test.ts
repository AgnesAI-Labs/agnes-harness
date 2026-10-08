import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { sha256Hex } from '../src/index.js'

it('matches published SHA-256 vectors', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

it.each([
  'a',
  'café — 中文',
  '😀𐍈',
  '\ud800',
  '\udc00',
  'a\ud800b',
  ...[55, 56, 63, 64, 65, 1000].map((n) => 'x'.repeat(n)),
])('matches UTF-8 host digests, including replacement characters and block boundaries: %j', (text) =>
  expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex')),
)
