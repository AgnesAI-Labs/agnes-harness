import { describe, expect, it } from 'vitest'
import { MENTION_CAP, mentionedPaths } from '../src/mentions.js'

const files = (text: string) => mentionedPaths(text).map((ref) => `${ref.kind}:${ref.value}`)

describe('mentionedPaths', () => {
  it('takes relative paths with a slash and dotted file names, in order', () => {
    expect(files('Compare src/app/main.py with README.md and config/app.toml.')).toEqual([
      'file:src/app/main.py',
      'file:README.md',
      'file:config/app.toml',
    ])
  })
  it('sees through quotes, backticks, brackets, trailing punctuation and a ./ prefix', () => {
    expect(files('Read `a.md`, "b/c.txt", (d.py); and ./e/f.rs! Then \'g.json\'?')).toEqual([
      'file:a.md',
      'file:b/c.txt',
      'file:d.py',
      'file:e/f.rs',
      'file:g.json',
    ])
  })
  it('finds a path glued to CJK text', () => {
    expect(files('请读取config/app.toml的内容，再看src/main.py。')).toEqual([
      'file:config/app.toml',
      'file:src/main.py',
    ])
  })
  it('takes a word ending in a slash as a directory, and normalizes it', () => {
    expect(files('List src/tallyhouse/ and ./docs/ please')).toEqual([
      'directory:src/tallyhouse',
      'directory:docs',
    ])
  })
  it('rejects absolute paths, .. segments, URLs and a dot-only directory', () => {
    expect(
      files(
        'See /etc/passwd, ../secret.txt, a/../b.txt, https://example.com/a/b.html, C:\\x\\y.txt, ./ and /',
      ),
    ).toEqual([])
    // The relative part of a word that is not a whole path still counts, as any word does.
    expect(files('a/../b.txt ok.md')).toEqual(['file:ok.md'])
  })
  it('rejects words over 256 bytes and keeps one of exactly 256', () => {
    expect(files(`${'a'.repeat(300)}.md`)).toEqual([])
    const edge = `${'a'.repeat(252)}.txt`
    expect(files(edge)).toEqual([`file:${edge}`])
    expect(files(`${'a'.repeat(253)}.txt`)).toEqual([])
  })
  it('does not read prose as paths', () => {
    expect(
      files(
        'Use v1.2 or 3.14, e.g. the .md files, and/or 24/7 coverage at example.com, mail me@host.org ...',
      ),
    ).toEqual(['file:and/or'])
  })
  it('rejects a word holding a NUL or a character outside the path set, instead of cutting it short', () => {
    expect(files('a\u0000b/c.txt ok.md')).toEqual(['file:ok.md'])
    expect(files('src/café.ts src/ok.ts')).toEqual(['file:src/ok.ts'])
    expect(files('docs/文档.md and $HOME/.ssh/id_rsa and ~/notes.md')).toEqual([])
  })
  it('judges a .. segment on the word as written, before trailing dots are dropped', () => {
    expect(files('see a/b/.. and x/../.. and ../ then ok.md')).toEqual(['file:ok.md'])
  })
  it('keeps the first of a repeated path and stops at the cap', () => {
    expect(files('a.md b.md a.md ./a.md')).toEqual(['file:a.md', 'file:b.md'])
    const many = Array.from({ length: 12 }, (_, i) => `f${i}.md`).join(' ')
    expect(files(many)).toEqual(Array.from({ length: 8 }, (_, i) => `file:f${i}.md`))
  })
  it('keeps the words that read most like paths when more than 8 qualify', () => {
    const noise = Array.from({ length: 6 }, (_, i) => `and/or${i}`).join(' ')
    // Six extensionless slash words come first; only two of them make the eight, the real paths all do.
    expect(files(`${noise} a.md b.md src/ lib/x.ts c.md d.md`)).toEqual([
      'file:and/or0',
      'file:and/or1',
      'file:a.md',
      'file:b.md',
      'directory:src',
      'file:lib/x.ts',
      'file:c.md',
      'file:d.md',
    ])
    expect(files(Array.from({ length: 9 }, (_, i) => `f${i}.md`).join(' '))).toHaveLength(MENTION_CAP)
  })
  it('keeps a file and a directory of the same name apart', () => {
    expect(files('docs docs/ docs/x.md')).toEqual(['directory:docs', 'file:docs/x.md'])
  })
})
