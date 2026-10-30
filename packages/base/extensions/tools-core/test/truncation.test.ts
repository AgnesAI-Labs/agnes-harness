import { describe, expect, it } from 'vitest'
import { looksTruncated } from '../src/guards/truncation.js'

describe('looksTruncated', () => {
  it('accepts a comparable rewrite', () => {
    expect(looksTruncated('a'.repeat(100), 'b'.repeat(90))).toEqual({ truncated: false })
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

  it('lets allowShrink waive the size signal, emptying included, and nothing else', () => {
    expect(looksTruncated('a'.repeat(100), 'b'.repeat(30), { allowShrink: true })).toEqual({
      truncated: false,
    })
    expect(looksTruncated('hello', '', { allowShrink: true })).toEqual({ truncated: false })
    expect(looksTruncated(`f(){ ${'x'.repeat(100)} }`, 'f(){', { allowShrink: true })).toMatchObject({
      truncated: true,
      kind: 'unbalanced',
      reason: 'unbalanced {',
    })
    expect(looksTruncated('a'.repeat(100), 'b'.repeat(30))).toMatchObject({ kind: 'shrink' })
  })

  it.each([
    String.raw`pattern = r"Overfull \hbox \(([0-9.]+)pt..."`,
    String.raw`pattern = r"Overfull \\hbox \\(([0-9.]+)pt..."`,
    `pattern = /Overfull \\hbox \\(([0-9.]+)pt/`,
    `message = "it's an unmatched ( in text"`,
    `message = '" unmatched [ in text'`,
    'message = `unmatched { in text`',
    "Remember: don't skip tests",
    'Use the ` key to open the console',
    'const get = () => /[(]/;',
    'function* patterns() { yield /[)]/; }',
    'if (ok) /[(]/.test(s);',
    String.raw`escaped \( outside a literal`,
    "Theorem plus : forall n' m, S (n' + m) = S n' + m. (* induction *)\nProof. intros n' m. reflexivity. Qed.",
    `def insert(seq):\n    '''Insert at the 3' end (after checking).'''\n    return seq + 'A'`,
    `def dimer_len(a, b):\n    """Run between the 3' end of a and anywhere in b."""\n    return len(a)`,
    `fn borrow<'a>(s: &'a str) -> &'a str { s }`,
    "let n' = List.map (fun x -> x + 1) xs (* primed *)",
    "(define quoted '(a b c))",
    "cat <<'EOF'\nThis isn't a shell ( expression.\nEOF\n",
    "# Notes\nA primed n' and an example (with parentheses).",
  ])('accepts literal delimiters: %s', (text) => {
    expect(looksTruncated('original content', text)).toEqual({ truncated: false })
    expect(looksTruncated('x'.repeat(text.length), text)).toEqual({ truncated: false })
  })

  it('rejects newly unbalanced brackets', () => {
    expect(looksTruncated('f(){ return 1 }', 'f(){ return 1')).toMatchObject({
      truncated: true,
      reason: 'unbalanced {',
    })
    expect(looksTruncated('value = "done"', 'value = "unfinished')).toMatchObject({
      truncated: true,
      reason: 'unbalanced "',
    })
    expect(looksTruncated('const x = a / (b / c)', 'const x = a / (b / c')).toMatchObject({
      truncated: true,
      reason: 'unbalanced (',
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
