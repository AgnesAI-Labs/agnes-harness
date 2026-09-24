import { expect, it } from 'vitest'
import { countLines } from './count-lines.js'

it('counts code lines only', () => {
  const text = ['const a = 1', '', '// comment', '/* block */', '  ', 'const b = 2'].join('\n')
  expect(countLines(text)).toBe(2)
})

it('tracks a block comment that starts mid-line (regression)', () => {
  const text = ['const a = 1 /* start', 'still comment', '*/', 'const b = 2'].join('\n')
  expect(countLines(text)).toBe(2)
})

it('counts a block comment that opens and closes on the same line as code (coverage gap)', () => {
  const text = 'const a = 1 /* x */ + 2'
  expect(countLines(text)).toBe(1)
})

it('does not let // inside a block comment end the block early (coverage gap)', () => {
  const text = ['/* start', '// still just a comment, not code', 'end */', 'const b = 2'].join('\n')
  expect(countLines(text)).toBe(1)
})
