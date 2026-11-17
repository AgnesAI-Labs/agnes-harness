import { expect, it } from 'vitest'
import * as api from '../src/index.js'

it.each([
  ['AKIA1234567890ABCDEF', '[REDACTED:aws]'],
  ['ghp_' + 'a'.repeat(36), '[REDACTED:github]'],
  ['sk-' + 'a'.repeat(16), '[REDACTED:sk]'],
  ['Authorization: Bearer abcdefghijklmnop', 'Authorization: [REDACTED] [REDACTED]'],
  ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: [REDACTED] [REDACTED]'],
  ['"password":"hello"', '"password":"[REDACTED]"'],
  ['token: true', 'token: "[REDACTED]"'],
  ['secret://service=value', 'secret://service=[REDACTED:secret]'],
  ['see secret://service', 'see secret://service'],
  ['a basic understanding, deadbeef0123456789', 'a basic understanding, deadbeef0123456789'],
  ['hello\u200b <|im_start|> <untrusted id="x">', 'hello [removed:special-token] [removed:untrusted-tag]'],
])('redacts the public text contract %s', (text, want) => {
  expect(api.redactSecrets(text)).toBe(want)
})
it('masks unterminated long secrets without losing ordinary evidence', () => {
  const secret = 'z'.repeat(100000)
  expect(api.redactSecrets('password="' + secret)).toBe('password="[REDACTED]"')
  expect(api.redactSecrets('commit ' + 'a'.repeat(40))).toBe('commit ' + 'a'.repeat(40))
})
