// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import { describe, expect, it } from 'vitest'
import { extractReferences, isPathReferences, parseListing } from '../src/references.js'

const CWD = '/w/proj'
const text = (t: string, more: object = {}) => ({ content: [{ type: 'text' as const, text: t }], ...more })
const refs = (kind: string, path: string) => ({ kind, path })
const structured = (references: object[], over: object = {}) => ({
  structured: {
    schema: 'agh.path-references/1',
    references,
    total: references.length,
    truncated: false,
    ...over,
  },
})

describe('extractReferences', () => {
  it('takes the references of a search tool from its structured result', () => {
    const r = extractReferences({
      name: 'ls',
      args: {},
      cwd: CWD,
      result: text(
        'src/\na.ts\nlink@',
        structured([refs('directory', 'src'), refs('file', 'a.ts'), refs('symlink', 'link')], {
          total: 5,
          truncated: true,
        }),
      ),
    })
    expect(r).toEqual({
      source: 'structured',
      references: [
        { kind: 'directory', value: 'src' },
        { kind: 'file', value: 'a.ts' },
      ],
      truncated: true,
    })
  })
  it('ignores the same payload from any other tool', () => {
    for (const name of ['shell', 'todo', 'docs_search'])
      expect(
        extractReferences({
          name,
          args: {},
          cwd: CWD,
          result: text('a.ts', structured([refs('file', 'a.ts')])),
        }).references,
      ).toEqual([])
  })
  it('drops an unsafe structured path and marks the result partial', () => {
    const r = extractReferences({
      name: 'find',
      args: { pattern: '*' },
      cwd: CWD,
      result: text(
        'x',
        structured([refs('file', '../x'), refs('file', '/etc/passwd'), refs('file', 'ok.ts')]),
      ),
    })
    expect(r).toEqual({
      source: 'structured',
      references: [{ kind: 'file', value: 'ok.ts' }],
      truncated: true,
    })
  })
  it('keeps a name that cannot be bound as evidence only', () => {
    const r = extractReferences({
      name: 'ls',
      args: {},
      cwd: CWD,
      result: text('not\na\nbinding', structured([refs('file', 'not\na\nbinding')])),
    })
    expect(r).toEqual({ source: 'structured', references: [], truncated: true })
  })
  it('reads ls text when there is no structured result', () => {
    const r = extractReferences({
      name: 'ls',
      args: { path: 'pkg' },
      cwd: CWD,
      result: text('src/\na.ts\nlink@\npipe?\n[3 more]'),
    })
    expect(r).toEqual({
      source: 'text',
      references: [
        { kind: 'directory', value: 'pkg/src' },
        { kind: 'file', value: 'pkg/a.ts' },
      ],
      truncated: true,
    })
  })
  it('binds no listed name of a search root outside the workspace', () => {
    const r = extractReferences({ name: 'ls', args: { path: '..' }, cwd: CWD, result: text('a.ts\nsrc/') })
    expect(r).toEqual({ source: 'text', references: [], truncated: true })
  })
  it('reads find lines below the search root and skips the notes', () => {
    const r = extractReferences({
      name: 'find',
      args: { pattern: '**/*.ts', path: 'src' },
      cwd: CWD,
      result: text('a.ts\nsub/b.ts\n[not searched: .git, node_modules]'),
    })
    expect(r.references.map((x) => x.value)).toEqual(['src/a.ts', 'src/sub/b.ts'])
  })
  it('reads only the match lines of grep, a path with a colon included', () => {
    const r = extractReferences({
      name: 'grep',
      args: { pattern: 'x' },
      cwd: CWD,
      result: text('src/a:b.ts:12:foo\nsrc/a.ts-3-near\nsrc/c.ts:1:x\nsrc/c.ts:9:x'),
    })
    expect(r.references.map((x) => x.value)).toEqual(['src/a:b.ts', 'src/c.ts'])
  })
  it('names the searched file for a grep of one file', () => {
    const r = extractReferences({
      name: 'grep',
      args: { pattern: 'hit', path: 'src/a.ts' },
      cwd: CWD,
      result: text('a.ts:1:hit'),
    })
    expect(r.references).toEqual([{ kind: 'file', value: 'src/a.ts' }])
  })
  it('leaves a search of a stored output unparsed', () => {
    const r = extractReferences({
      name: 'grep',
      args: { pattern: 'x', path: 'artifact://0123456789ab?size=3' },
      cwd: CWD,
      result: text('artifact://0123456789ab:1:x'),
    })
    expect(r).toEqual({ source: 'none', references: [], truncated: false })
  })
  it('takes read, write and edit paths from their arguments, inside the workspace only', () => {
    expect(
      extractReferences({ name: 'read', args: { path: '/w/proj/src/a.ts' }, cwd: CWD, result: text('x') }),
    ).toEqual({
      source: 'arguments',
      references: [{ kind: 'file', value: 'src/a.ts' }],
      truncated: false,
    })
    expect(
      extractReferences({
        name: 'write',
        args: { path: 'out/b.md', content: 'y' },
        cwd: CWD,
        result: text('ok'),
      }).references,
    ).toEqual([{ kind: 'file', value: 'out/b.md' }])
    expect(
      extractReferences({ name: 'edit', args: { path: './out//c.md' }, cwd: CWD, result: text('ok') })
        .references,
    ).toEqual([{ kind: 'file', value: 'out/c.md' }])
    for (const path of ['/etc/passwd', '../x', 'artifact://abc', '.', 'a\\b'])
      expect(
        extractReferences({ name: 'read', args: { path }, cwd: CWD, result: text('x') }).references,
      ).toEqual([])
  })
  it('never parses shell output into references', () => {
    expect(
      extractReferences({ name: 'shell', args: { command: 'ls' }, cwd: CWD, result: text('src/a.ts\nb.ts') }),
    ).toEqual({ source: 'none', references: [], truncated: false })
  })
  it('records nothing for a failed call', () => {
    expect(
      extractReferences({ name: 'ls', args: {}, cwd: CWD, result: text('ls failed', { isError: true }) })
        .references,
    ).toEqual([])
  })
})

describe('isPathReferences', () => {
  it('accepts only the whole shape of the shared schema', () => {
    const ok = { schema: 'agh.path-references/1', references: [], total: 0, truncated: false }
    expect(isPathReferences(ok)).toBe(true)
    expect(isPathReferences({ ...ok, schema: 'agh.path-references/2' })).toBe(false)
    expect(isPathReferences({ ...ok, references: {} })).toBe(false)
    expect(isPathReferences({ ...ok, total: '0' })).toBe(false)
    expect(isPathReferences({ ...ok, truncated: 0 })).toBe(false)
    expect(isPathReferences(null)).toBe(false)
  })
})

describe('parseListing', () => {
  it('skips the empty-directory line and marks nothing partial without notes', () => {
    expect(parseListing('ls', '(no entries)', '.')).toEqual({ references: [], truncated: false })
    expect(parseListing('find', 'no matches', '.')).toEqual({ references: [], truncated: false })
  })
  it('lists each path once, in the order first seen', () => {
    expect(parseListing('find', 'b.ts\na.ts\nb.ts\n.', '.')).toEqual({
      references: [
        { kind: 'file', value: 'b.ts' },
        { kind: 'file', value: 'a.ts' },
      ],
      truncated: false,
    })
  })
})
