import { describe, expect, it } from 'vitest'
import { looksTruncated } from '../src/guards/truncation.js'

describe('looksTruncated', () => {
  it.each([
    ['similar-sized content', 'a'.repeat(100), 'b'.repeat(90)],
    ['a quoted character', 'const quote = "a";', `const quote = '"';`],
    [
      'regular expressions and quoted characters',
      String.raw`const pattern = /export\s+const\s+\w+\s*=\s*"([^"]*)"/g;
const config = { quote: '"' };
const quote = "a";`,
      String.raw`const pattern = /export\s+const\s+\w+\s*=\s*"([^"]*)"/g;
const config = { quote: '"' };
const quote = '"';`,
    ],
    ['a quotation mark in prose', 'He said hello.', 'He typed a " character.'],
    ['an escaped quotation mark', 'const text = "old";', String.raw`const text = "say \"hello";`],
  ])('accepts a comparable rewrite with %s', (_name, before, after) => {
    expect(looksTruncated(before, after)).toEqual({ truncated: false })
  })

  it('accepts a rewrite sitting exactly on the ratio', () => {
    // The boundary is part of the contract: 40% of the original is still a rewrite, and only
    // less than that is a suspected truncation.
    expect(looksTruncated('a'.repeat(100), 'b'.repeat(40))).toEqual({ truncated: false })
  })

  it('rejects < 40% of original and says how much is left', () => {
    expect(looksTruncated('a'.repeat(100), 'b'.repeat(30))).toMatchObject({
      truncated: true,
      reason: expect.stringContaining('30%'),
    })
  })

  it('rejects newly unbalanced brackets', () => {
    expect(looksTruncated('f(){ return 1 }', 'f(){ return 1')).toMatchObject({
      truncated: true,
      reason: 'unbalanced {',
    })
  })

  it('lets an already unbalanced original stay unbalanced', () => {
    expect(looksTruncated('x = "(', 'y = "(')).toEqual({ truncated: false })
  })

  it('accepts writes into empty files', () => {
    expect(looksTruncated('', 'anything')).toEqual({ truncated: false })
    expect(looksTruncated('', '')).toEqual({ truncated: false })
  })

  it('rejects emptying a non-empty file', () => {
    // Truncating to nothing is the case this guard exists for, and an exemption for empty new
    // content made `write` with an empty string succeed over any file in the workspace. Empty is
    // the shortest kind of short.
    expect(looksTruncated('x'.repeat(100_000), '')).toMatchObject({
      truncated: true,
      reason: expect.stringContaining('0%'),
    })
    expect(looksTruncated('hello', '')).toMatchObject({ truncated: true })
  })
})
