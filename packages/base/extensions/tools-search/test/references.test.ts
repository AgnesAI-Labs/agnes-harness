import { boundToolResult, TOOL_RESULT_LIMITS } from '@agnes/core-effects/effects/tool-dispatch'
import { TOOL_PATH_REFERENCES, type ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { MAX_READ_BYTES } from '../../tools-core/src/tools/read.js'
import { findTool } from '../src/tools/find.js'
import { grepTool } from '../src/tools/grep.js'
import { lsTool } from '../src/tools/ls.js'
import { pathReferences, STRUCTURED_MAX_BYTES } from '../src/tools/references.js'
import { ripgrepFindTool, ripgrepGrepTool } from '../src/tools/ripgrep.js'

const ctxOf = (o: Parameters<typeof fakeToolContext>[0] = {}) =>
  fakeToolContext({ outputMaxBytes: 8192, ...o })
const textOf = (r: ToolResult) => (r.content[0]?.type === 'text' ? r.content[0].text : '')

describe('pathReferences', () => {
  it('lists shown paths inside the workspace and counts the rest', () => {
    const ctx = ctxOf()
    const refs = pathReferences(
      ctx,
      [
        { abs: '/work/proj/src', kind: 'directory' },
        { abs: '/elsewhere/x', kind: 'file' },
        { abs: `/work/proj/${'a'.repeat(1100)}`, kind: 'file' },
        { abs: '/work/proj/b.ts', kind: 'file' },
      ],
      3,
      false,
    )
    expect(refs).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'directory', path: 'src' }],
      total: 4,
      truncated: true,
    })
  })
  it('stops at 100 references', () => {
    const found = Array.from({ length: 150 }, (_, i) => ({ abs: `/work/proj/f${i}`, kind: 'file' as const }))
    const refs = pathReferences(ctxOf(), found, 150, false)
    expect(refs.references).toHaveLength(100)
    expect(refs).toMatchObject({ total: 150, truncated: true })
  })
  it('measures a path by its JSON-encoded size', () => {
    const control = '\u0001'.repeat(200)
    const surrogate = '\ud800'.repeat(200)
    const refs = pathReferences(
      ctxOf(),
      [
        { abs: `/work/proj/a\u0001b`, kind: 'file' },
        { abs: `/work/proj/${control}`, kind: 'file' },
        { abs: `/work/proj/${surrogate}`, kind: 'file' },
      ],
      3,
      false,
    )
    expect(refs).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'file', path: 'a\u0001b' }],
      total: 3,
      truncated: true,
    })
  })
  it('keeps a hundred paths that grow when escaped under the kernel limit on structured results', () => {
    expect(STRUCTURED_MAX_BYTES).toBe(TOOL_RESULT_LIMITS.maxJsonBytes)
    // Each is just under the cap once escaped, and just under it raw, which escapes to six times that.
    const escaped = (i: number) => `${String(i).padStart(4, '0')}${'\u0001'.repeat(170)}`
    const raw = (i: number) => `${String(i).padStart(4, '0')}${'\u0001'.repeat(1019)}`
    for (const name of [escaped, raw]) {
      const found = Array.from({ length: 100 }, (_, i) => ({
        abs: `/work/proj/${name(i)}`,
        kind: 'file' as const,
      }))
      const result: ToolResult = {
        content: [{ type: 'text', text: 'listing' }],
        structured: pathReferences(ctxOf(), found, 100, false),
      }
      expect(Buffer.byteLength(JSON.stringify(result.structured))).toBeLessThan(STRUCTURED_MAX_BYTES)
      expect(boundToolResult(result, 8192)).toBe(result)
    }
    const listed = (name: (i: number) => string) =>
      pathReferences(
        ctxOf(),
        Array.from({ length: 100 }, (_, i) => ({ abs: `/work/proj/${name(i)}`, kind: 'file' as const })),
        100,
        false,
      ).references.length
    expect(listed(escaped)).toBe(100)
    expect(listed(raw)).toBe(0)
  })
  it('leaves out a path with a backslash where the backslash is part of a name', () => {
    const found = [
      { abs: '/work/proj/a\\b', kind: 'file' as const },
      { abs: '/work/proj/c', kind: 'file' as const },
    ]
    expect(pathReferences(ctxOf(), found, 2, false)).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'file', path: 'c' }],
      total: 2,
      truncated: true,
    })
  })
  it('reads a backslash as a separator where it is one', () => {
    const ctx = ctxOf()
    const windows = {
      ...ctx,
      session: { ...ctx.session, workspaceRoot: 'C:\\work\\proj' },
      platform: { ...ctx.platform, fs: { ...ctx.platform.fs, pathSep: '\\' as const } },
    }
    const refs = pathReferences(windows, [{ abs: 'C:\\work\\proj\\src\\a.ts', kind: 'file' }], 1, false)
    expect(refs).toMatchObject({
      references: [{ kind: 'file', path: 'src/a.ts' }],
      total: 1,
      truncated: false,
    })
  })
})

describe('ls references', () => {
  it('lists the shown entries with their kinds and keeps the text as it was', async () => {
    const ctx = ctxOf({
      files: { 'src/a.ts': '', 'top.txt': '' },
      entries: {
        '/work/proj': [
          { name: 'link', kind: 'symlink' },
          { name: 'pipe', kind: 'other' },
        ],
      },
    })
    const r = await lsTool.execute({ path: '/work/proj' }, ctx)
    expect(textOf(r).split('\n')).toEqual(['link@', 'pipe?', 'src/', 'top.txt'])
    expect(r.structured).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [
        { kind: 'symlink', path: 'link' },
        { kind: 'other', path: 'pipe' },
        { kind: 'directory', path: 'src' },
        { kind: 'file', path: 'top.txt' },
      ],
      total: 4,
      truncated: false,
    })
  })
  it('lists only the entries the limit shows', async () => {
    const ctx = ctxOf({ files: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, ''])) })
    const r = await lsTool.execute({ limit: 2 }, ctx)
    expect(textOf(r).split('\n')).toEqual(['f0.txt', 'f1.txt', '[3 more; increase limit or narrow path]'])
    expect(r.structured).toMatchObject({
      references: [
        { kind: 'file', path: 'f0.txt' },
        { kind: 'file', path: 'f1.txt' },
      ],
      total: 5,
      truncated: true,
    })
  })
  it('lists paths of a subdirectory relative to the workspace', async () => {
    const r = await lsTool.execute({ path: 'src' }, ctxOf({ files: { 'src/a.ts': '' } }))
    expect(r.structured).toMatchObject({ references: [{ kind: 'file', path: 'src/a.ts' }] })
  })
  it('lists nothing outside the workspace but counts it', async () => {
    const ctx = ctxOf({ files: { '/outside/x.txt': '' } })
    const r = await lsTool.execute(
      { path: '/outside' },
      { ...ctx, session: { ...ctx.session, fullAccess: true } },
    )
    expect(textOf(r)).toBe('x.txt')
    expect(r.structured).toEqual({ schema: TOOL_PATH_REFERENCES, references: [], total: 1, truncated: true })
  })
  it('counts an entry whose name holds a backslash but does not list it', async () => {
    const ctx = ctxOf({ files: { 'b.txt': '' }, entries: { '/work/proj': [{ name: 'a\\b', kind: 'file' }] } })
    const r = await lsTool.execute({}, ctx)
    expect(textOf(r).split('\n')).toEqual(['a\\b', 'b.txt'])
    expect(r.structured).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'file', path: 'b.txt' }],
      total: 2,
      truncated: true,
    })
  })
  it('gives an empty directory empty references and a failure none', async () => {
    const empty = await lsTool.execute({ path: 'empty' }, ctxOf({ entries: { '/work/proj/empty': [] } }))
    expect(textOf(empty)).toBe('(no entries)')
    expect(empty.structured).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [],
      total: 0,
      truncated: false,
    })
    const failed = await lsTool.execute(
      { path: 'locked' },
      ctxOf({ files: { 'a.txt': '' }, listErrors: { locked: { code: 'EACCES', message: 'EACCES' } } }),
    )
    expect(failed.isError).toBe(true)
    expect(failed.structured).toBeUndefined()
  })
})

/** A context whose bundled ripgrep lists the fake files and answers --json searches with `rows`. */
function rgCtx(files: Record<string, string>, rows: (paths: string[]) => object[] = () => []) {
  const ctx = ctxOf({ files })
  ctx.exec = async (argv) => {
    if (argv.includes('--files'))
      return { code: 0, stderr: '', truncated: false, stdout: `${[...ctx.mem.files.keys()].join('\0')}\0` }
    const paths = argv.slice(argv.indexOf('--') + 1)
    return {
      code: 0,
      stderr: '',
      truncated: false,
      stdout: rows(paths)
        .map((r) => JSON.stringify(r))
        .join('\n'),
    }
  }
  return ctx
}
const match = (path: string, line: number, text: string) => ({
  type: 'match',
  data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line },
})
const context = (path: string, line: number, text: string) => ({
  type: 'context',
  data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line },
})

describe('find and grep references', () => {
  it('references the files find shows, relative to the workspace, below a search root', async () => {
    const ctx = rgCtx({ 'src/a.ts': '', 'src/sub/b.ts': '', 'README.md': '' })
    const r = await ripgrepFindTool.execute({ pattern: '**/*.ts', path: 'src' }, ctx)
    expect(textOf(r).split('\n').slice(0, 2)).toEqual(['a.ts', 'sub/b.ts'])
    expect(r.structured).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'file', path: 'src/sub/b.ts' },
      ],
      total: 2,
      truncated: false,
    })
  })
  it('references each file with a match once, never a context line alone', async () => {
    const ctx = rgCtx({ 'a.ts': 'x', 'b.ts': 'y' }, () => [
      match('/work/proj/a.ts', 1, 'foo'),
      match('/work/proj/a.ts', 3, 'foo'),
      context('/work/proj/b.ts', 1, 'near'),
    ])
    const r = await ripgrepGrepTool.execute({ pattern: 'foo' }, ctx)
    expect(textOf(r)).toContain('a.ts:1:foo')
    expect(r.structured).toMatchObject({
      references: [{ kind: 'file', path: 'a.ts' }],
      total: 1,
      truncated: false,
    })
  })
  it('references a named file by its workspace path, not the displayed name', async () => {
    const ctx = rgCtx({ 'src/a.ts': 'hit' }, () => [match('/work/proj/src/a.ts', 1, 'hit')])
    const r = await ripgrepGrepTool.execute({ pattern: 'hit', path: 'src/a.ts' }, ctx)
    expect(textOf(r)).toContain('a.ts:1:hit')
    expect(r.structured).toMatchObject({ references: [{ kind: 'file', path: 'src/a.ts' }] })
  })
  it('caps a large search at 100 references and leaves a long path out without touching the text', async () => {
    const long = `${'d'.repeat(1030)}.ts`
    const files = Object.fromEntries([
      ...Array.from({ length: 150 }, (_, i) => [`f${i}.ts`, 'hit']),
      [long, 'hit'],
    ])
    const ctx = rgCtx(files, (paths) => paths.map((p) => match(p, 1, 'hit')))
    const r = await ripgrepGrepTool.execute({ pattern: 'hit', limit: 1000 }, ctx)
    const s = r.structured as { references: Array<{ path: string }>; total: number; truncated: boolean }
    expect(s.references).toHaveLength(100)
    expect(s.references.some((x) => x.path === long)).toBe(false)
    expect(s).toMatchObject({ total: 151, truncated: true })
    expect(textOf(r)).not.toContain('[output truncated')
  })
  it('marks references partial when the search says it is partial', async () => {
    const ctx = rgCtx({ 'a.ts': 'x' }, () => [match('/work/proj/a.ts', 1, 'x')])
    const exec = ctx.exec
    ctx.exec = async (argv, o) => ({
      ...(await exec(argv, o)),
      ...(argv.includes('--json') ? { truncated: true } : {}),
    })
    const r = await ripgrepGrepTool.execute({ pattern: 'x' }, ctx)
    expect(textOf(r)).toContain('[match capture limit reached; search is partial]')
    expect(r.structured).toMatchObject({ references: [{ path: 'a.ts' }], truncated: true })
  })
  it('fills the same references when the search executable cannot run', async () => {
    const ctx = ctxOf({ files: { 'src/a.ts': 'hit', 'README.md': 'none' } })
    ctx.exec = async () => {
      throw Object.assign(new Error('no process backend'), { code: 'SANDBOX_UNAVAILABLE' })
    }
    const grep = await ripgrepGrepTool.execute({ pattern: 'hit' }, ctx)
    expect(grep.structured).toMatchObject({
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'file', path: 'src/a.ts' }],
    })
    const find = await ripgrepFindTool.execute({ pattern: '**/*.ts' }, ctx)
    expect(find.structured).toMatchObject({ references: [{ kind: 'file', path: 'src/a.ts' }] })
  })
  it('adds nothing to a failed search or to a search of a stored output', async () => {
    const missing = await ripgrepFindTool.execute({ path: 'missing', pattern: '*' }, rgCtx({ 'a.ts': '' }))
    expect(missing.isError).toBe(true)
    expect(missing.structured).toBeUndefined()
    const artifact = await grepTool.execute({ path: 'artifact://0123456789ab?size=3', pattern: 'x' }, ctxOf())
    expect(artifact.structured).toBeUndefined()
  })
})

/** A context where the bundled search executable cannot run, so the filesystem search answers. */
function fallbackCtx(o: Parameters<typeof fakeToolContext>[0]) {
  const ctx = ctxOf(o)
  ctx.exec = async () => {
    throw Object.assign(new Error('no process backend'), { code: 'SANDBOX_UNAVAILABLE' })
  }
  return ctx
}
type Refs = { references: Array<{ path: string }>; total: number; truncated: boolean }
const pad = (i: number) => String(i).padStart(3, '0')
const manyFiles = (n: number, content = '') =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`entry-${pad(i)}.txt`, content]))

describe('references of a text the output guard cut', () => {
  // A small output limit cuts the text to its first 512 and last 128 bytes.
  const small = { outputMaxBytes: 1024 }
  /** Every referenced path is shown in the text, the middle of the list is not referenced, and the cut is reported. */
  function expectCut(r: ToolResult, total: number) {
    const s = r.structured as Refs
    expect(textOf(r)).toContain('[truncated: ')
    expect(s).toMatchObject({ total, truncated: true })
    expect(s.references.length).toBeGreaterThan(0)
    expect(s.references.length).toBeLessThan(total)
    for (const ref of s.references) expect(textOf(r)).toContain(ref.path.split('/').pop())
    expect(s.references.map((x) => x.path)).not.toContain('entry-050.txt')
    return s
  }

  it('ls lists only the entries whose whole name is in the kept head or tail', async () => {
    const r = await lsTool.execute({}, ctxOf({ ...small, files: manyFiles(100) }))
    const s = expectCut(r, 100)
    // Rows are 14 bytes apart: rows 0-35 end inside the first 512 bytes, rows 91-99 start inside the last 128.
    const kept = [...Array.from({ length: 36 }, (_, i) => i), ...Array.from({ length: 9 }, (_, i) => 91 + i)]
    expect(s.references.map((x) => x.path)).toEqual(kept.map((i) => `entry-${pad(i)}.txt`))
  })
  it('find marks a cut text truncated', async () => {
    const ctx = rgCtx(manyFiles(100))
    const r = await ripgrepFindTool.execute({ pattern: '*.txt' }, { ...ctx, outputMaxBytes: 1024 })
    expectCut(r, 100)
  })
  it('grep marks a cut text truncated', async () => {
    const ctx = rgCtx(manyFiles(100, 'hit'), (paths) =>
      paths.map((p) => match(p, 1, `hit ${'x'.repeat(20)}`)),
    )
    const r = await ripgrepGrepTool.execute({ pattern: 'hit' }, { ...ctx, outputMaxBytes: 1024 })
    expectCut(r, 100)
  })
  it('the filesystem find and grep mark a cut text truncated', async () => {
    const find = await findTool.execute(
      { pattern: '*.txt' },
      fallbackCtx({ ...small, files: manyFiles(100) }),
    )
    expectCut(find, 100)
    const grep = await grepTool.execute(
      { pattern: 'hit' },
      fallbackCtx({ ...small, files: manyFiles(100, 'hit') }),
    )
    expectCut(grep, 100)
  })
})

describe('find and grep references at the edges', () => {
  it('references only the files the shown rows of grep match in', async () => {
    const ctx = rgCtx({ 'a.ts': 'x', 'b.ts': 'x', 'c.ts': 'x' }, (paths) =>
      paths.map((p) => match(p, 1, 'x')),
    )
    const r = await ripgrepGrepTool.execute({ pattern: 'x', limit: 2 }, ctx)
    expect(r.structured).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [
        { kind: 'file', path: 'a.ts' },
        { kind: 'file', path: 'b.ts' },
      ],
      total: 3,
      truncated: true,
    })
  })
  it('counts a file whose name holds a backslash in the filesystem search but does not list it', async () => {
    const ctx = fallbackCtx({ files: { 'a\\b': 'hit', 'c.ts': 'hit' } })
    const expected = {
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'file', path: 'c.ts' }],
      total: 2,
      truncated: true,
    }
    const grep = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(textOf(grep)).toContain('a\\b:1:hit')
    expect(grep.structured).toEqual(expected)
    expect((await findTool.execute({ pattern: '*' }, ctx)).structured).toEqual(expected)
  })
  it('marks the filesystem search partial at the limit and over files it passed by', async () => {
    const two = fallbackCtx({ files: { 'a.ts': 'hit', 'b.ts': 'hit' } })
    expect((await findTool.execute({ pattern: '*.ts', limit: 1 }, two)).structured).toEqual({
      schema: TOOL_PATH_REFERENCES,
      references: [{ kind: 'file', path: 'a.ts' }],
      total: 1,
      truncated: true,
    })
    expect((await grepTool.execute({ pattern: 'hit', limit: 1 }, two)).structured).toMatchObject({
      references: [{ path: 'a.ts' }],
      total: 1,
      truncated: true,
    })
    const binary = fallbackCtx({ files: { 'a.ts': 'hit', 'b.bin': 'hit\0' } })
    expect((await grepTool.execute({ pattern: 'hit' }, binary)).structured).toMatchObject({
      references: [{ path: 'a.ts' }],
      total: 1,
      truncated: true,
    })
    const oversize = fallbackCtx({ files: { 'a.ts': 'hit', 'big.txt': new Uint8Array(MAX_READ_BYTES + 1) } })
    expect((await grepTool.execute({ pattern: 'hit' }, oversize)).structured).toMatchObject({
      references: [{ path: 'a.ts' }],
      total: 1,
      truncated: true,
    })
    expect(
      (await grepTool.execute({ pattern: 'hit' }, fallbackCtx({ files: { 'a.ts': 'hit' } }))).structured,
    ).toMatchObject({
      truncated: false,
    })
  })
})
