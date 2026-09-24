import { checkToolDef, type ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { MAX_READ_BYTES } from '../../tools-core/src/tools/read.js'
import { findTool } from '../src/tools/find.js'
import { grepTool } from '../src/tools/grep.js'
import { lsTool } from '../src/tools/ls.js'
import { globToRegExp, newWalkReport, walk } from '../src/tools/walk.js'

function textOf(r: ToolResult): string {
  const first = r.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(first)
}

const files = {
  'src/a.ts': 'foo\nbar foo\nbaz',
  'src/sub/b.ts': 'Foo here',
  'node_modules/x/c.ts': 'foo',
  'bin.dat': 'a\u0000foo',
  'README.md': 'nothing',
}

describe('globToRegExp', () => {
  it('matches ** across directories, * within one segment and ? one character', () => {
    expect(globToRegExp('**/*.ts').test('src/sub/b.ts')).toBe(true)
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false)
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/?.ts').test('src/ab.ts')).toBe(false)
  })

  it('treats a dot as a literal dot, not as any character', () => {
    // Unescaped, `*.ts` would also match `axts`, and a glob that matches files the caller did not
    // ask for is worse than one that matches none.
    expect(globToRegExp('*.ts').test('axts')).toBe(false)
  })
})

describe('walk', () => {
  it('reports that it stopped rather than returning a short list as if it were complete', async () => {
    // A bare return at the entry ceiling tells the caller "that is everything", and a search that
    // silently ends early reads as "there is nothing more to find".
    const ctx = fakeToolContext({ files: { 'a.ts': '1', 'b.ts': '2', 'c.ts': '3' } })
    const report = newWalkReport()
    const seen: string[] = []
    for await (const e of walk(ctx, ctx.cwd, report, { maxEntries: 2 })) seen.push(e.rel)
    expect(seen).toEqual(['a.ts', 'b.ts'])
    expect(report.truncated).toBe(true)
  })

  it('orders entries by code point, so the same tree always yields the same list', async () => {
    // Locale-sensitive collation depends on the machine's environment, and a tool whose output
    // ordering moves with the host cannot be compared across runs.
    const ctx = fakeToolContext({ files: { 'B.ts': '1', 'a.ts': '2', 'Z.ts': '3' } })
    const report = newWalkReport()
    const seen: string[] = []
    for await (const e of walk(ctx, ctx.cwd, report, { maxEntries: 10 })) seen.push(e.rel)
    expect(seen).toEqual(['B.ts', 'Z.ts', 'a.ts'])
  })

  it('does not descend a symlink, and reports it as one', async () => {
    // A link is the ordinary way out of a workspace, and following one lexically would walk a tree
    // the fence never cleared.
    const ctx = fakeToolContext({
      files: { 'a.ts': '1' },
      entries: {
        '/work/proj': [{ name: 'link', kind: 'symlink' }],
        // What the link points at. Descending it would put this entry in the walk.
        '/work/proj/link': [{ name: 'beyond.ts', kind: 'file' }],
      },
    })
    const report = newWalkReport()
    const kinds: string[] = []
    for await (const e of walk(ctx, ctx.cwd, report, { maxEntries: 10 })) kinds.push(`${e.rel}:${e.kind}`)
    expect(kinds).toEqual(['a.ts:file', 'link:symlink'])
  })
})

describe('grep', () => {
  it('has complete definitions, read-only and replayable', () => {
    for (const t of [grepTool, findTool, lsTool]) {
      expect(checkToolDef(t), t.name).toEqual({ ok: true })
      expect(t.meta, t.name).toMatchObject({ isReadOnly: true, replay: 'safe', requiresApproval: 'never' })
    }
  })

  it('finds matches, honours ignoreCase and glob, skips node_modules and binaries', async () => {
    const ctx = fakeToolContext({ files })
    const r = await grepTool.execute({ pattern: 'foo' }, ctx)
    // node_modules/x/c.ts holds `foo` and bin.dat holds `foo` after a NUL; neither is a result,
    // though the skipped directory is named in the trailing note.
    const hits = textOf(r)
      .split('\n')
      .filter((l) => !l.startsWith('['))
    expect(hits).toEqual(['src/a.ts:1:foo', 'src/a.ts:2:bar foo'])
    const ci = await grepTool.execute({ pattern: 'foo', ignoreCase: true, glob: '**/*.ts' }, ctx)
    expect(textOf(ci)).toContain('src/sub/b.ts:1:Foo here')
    expect(textOf(ci)).not.toContain('README.md')
  })

  it('treats literal patterns literally and says when nothing matched', async () => {
    const ctx = fakeToolContext({ files })
    const r = await grepTool.execute({ pattern: 'ba.', literal: true }, ctx)
    expect(textOf(r).split('\n')[0]).toBe('no matches')
    expect((await grepTool.execute({ pattern: 'ba.' }, ctx)).content[0]).toMatchObject({
      text: expect.stringContaining('src/a.ts:2:bar foo'),
    })
  })

  it('reports an unparseable pattern instead of throwing', async () => {
    const ctx = fakeToolContext({ files })
    const r = await grepTool.execute({ pattern: '([', ignoreCase: false }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('invalid pattern')
  })

  it('shows context lines around a match, marked apart from the match itself', async () => {
    const ctx = fakeToolContext({ files: { 'c.ts': 'one\ntwo\nHIT\nfour\nfive' } })
    const r = await grepTool.execute({ pattern: 'HIT', context: 1 }, ctx)
    expect(textOf(r).split('\n').slice(0, 3)).toEqual(['c.ts-2-two', 'c.ts:3:HIT', 'c.ts-4-four'])
  })

  it('clips a very long matching line instead of pasting the whole of it', async () => {
    const ctx = fakeToolContext({ files: { 'long.ts': `hit${'x'.repeat(2000)}` } })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    const line = textOf(r).split('\n')[0] as string
    expect(line.length).toBe('long.ts:1:'.length + 500)
    expect(line.endsWith('...')).toBe(true)
  })

  it('says when it stopped at the match limit', async () => {
    const ctx = fakeToolContext({ files: { 'many.ts': 'hit\nhit\nhit\nhit' } })
    const r = await grepTool.execute({ pattern: 'hit', limit: 2 }, ctx)
    const lines = textOf(r).split('\n')
    expect(lines.filter((l) => l.startsWith('many.ts:'))).toHaveLength(2)
    expect(textOf(r)).toContain('[limit 2 reached')
  })

  it('defaults the match limit to 100 and says so when it is reached', async () => {
    // The default is the value every real call takes, and a call that passes `limit` explicitly is
    // the only kind the other cases make.
    const ctx = fakeToolContext({ files: { 'many.ts': 'hit\n'.repeat(150) } })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(
      textOf(r)
        .split('\n')
        .filter((l) => l.startsWith('many.ts:')),
    ).toHaveLength(100)
    expect(textOf(r)).toContain('[limit 100 reached')
  })

  it('names the directories it walked past, rather than reporting no matches in them', async () => {
    const ctx = fakeToolContext({
      files: {
        'node_modules/a.ts': 'hit',
        '.git/b.ts': 'hit',
        'dist/c.ts': 'hit',
        '.agnes-tmp/d.ts': 'hit',
        'src/e.ts': 'hit',
      },
    })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(textOf(r)).toContain('src/e.ts:1:hit')
    for (const dir of ['node_modules', '.git', 'dist', '.agnes-tmp']) expect(textOf(r), dir).toContain(dir)
    expect(textOf(r)).toContain('not searched')
  })

  it('does not walk into a path the shipped deny list covers', async () => {
    // These are the paths the deployment defaults refuse to open: the secret store, the seam
    // tables, the audit log and the session database. A tool that walks a tree has to keep away
    // from them on its own - the kernel's own check compares the string it was handed, so a tool
    // that reaches them by absolute path walks straight past it.
    const ctx = fakeToolContext({
      files: {
        'secrets/key.txt': 'hit',
        'tables/t.json': 'hit',
        'audit/log.jsonl': 'hit',
        'sessions.db': 'hit',
        '.agnes/secrets/token': 'hit',
        'ok.txt': 'hit',
      },
    })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(
      textOf(r)
        .split('\n')
        .filter((l) => l.includes(':1:hit')),
    ).toEqual(['ok.txt:1:hit'])
    expect(textOf(r)).toContain('denied by policy')
    const f = await findTool.execute({ pattern: '**' }, ctx)
    expect(
      textOf(f)
        .split('\n')
        .filter((l) => !l.startsWith('[')),
    ).toEqual(['ok.txt'])
  })

  it('keeps out of the workspace secrets directory under both .agh and the legacy .agnes name', async () => {
    const ctx = fakeToolContext({
      files: { '.agh/secrets/token': 'hit', '.agnes/secrets/token': 'hit', '.agh/notes.txt': 'hit' },
    })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(
      textOf(r)
        .split('\n')
        .filter((l) => l.includes(':1:hit')),
    ).toEqual(['.agh/notes.txt:1:hit'])
    const f = await findTool.execute({ pattern: '**' }, ctx)
    expect(
      textOf(f)
        .split('\n')
        .filter((l) => !l.startsWith('[')),
    ).toEqual(['.agh/notes.txt'])
  })

  it('skips a file over the read ceiling and counts it, instead of pretending it held nothing', async () => {
    const ctx = fakeToolContext({
      files: { 'huge.ts': 'x'.repeat(MAX_READ_BYTES + 1), 'small.ts': 'hit' },
    })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(textOf(r)).toContain('small.ts:1:hit')
    expect(textOf(r)).toContain('1 file(s) skipped: larger than')
  })

  it('skips a file it cannot read and counts it, instead of ending the turn', async () => {
    const ctx = fakeToolContext({
      files: { 'locked.ts': 'hit', 'open.ts': 'hit' },
      readErrors: { 'locked.ts': { code: 'EACCES', message: 'EACCES: permission denied' } },
    })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(textOf(r)).toContain('open.ts:1:hit')
    expect(textOf(r)).toContain('1 path(s) could not be read')
  })
})

describe('a guarded result', () => {
  it('carries a reference to the whole output whenever the guard had to cut', async () => {
    // Truncating and dropping the pointer would leave the model with the middle of a search gone
    // and no way to reach it. One place decides this for every tool, so one case pins it.
    const ctx = fakeToolContext({ files: { 'wide.ts': `${'hit long line here '.repeat(60)}\n`.repeat(60) } })
    const r = await grepTool.execute({ pattern: 'hit' }, ctx)
    expect(textOf(r)).toContain('[truncated:')
    expect(r.content).toHaveLength(2)
    expect(r.content[1]).toMatchObject({ type: 'ref', ref: { size: expect.any(Number) } })
  })
})

describe('find', () => {
  it('lists workspace-relative paths matching the glob', async () => {
    const ctx = fakeToolContext({ files })
    const r = await findTool.execute({ pattern: '**/*.ts' }, ctx)
    expect(textOf(r).split('\n')).toEqual(['src/a.ts', 'src/sub/b.ts', '[not searched: node_modules]'])
  })

  it('says when it stopped at the result limit', async () => {
    const ctx = fakeToolContext({ files: { 'a.ts': '', 'b.ts': '', 'c.ts': '' } })
    const r = await findTool.execute({ pattern: '**/*.ts', limit: 2 }, ctx)
    expect(textOf(r).split('\n')).toEqual(['a.ts', 'b.ts', '[limit 2 reached; there may be more]'])
  })

  it('defaults the result limit to 1000', async () => {
    const ctx = fakeToolContext({
      files: Object.fromEntries(
        Array.from({ length: 1001 }, (_, i) => [`f${String(i).padStart(4, '0')}.ts`, '']),
      ),
    })
    const r = await findTool.execute({ pattern: '**/*.ts' }, ctx)
    // A thousand paths is over the output guard's ceiling, so the listing itself arrives head and
    // tail with the whole of it stored; the note that says where it stopped is what pins the value.
    expect(textOf(r)).toContain('[limit 1000 reached')
  })
})

describe('ls', () => {
  it('marks each entry kind, so a symlink is not shown as an ordinary file', async () => {
    const ctx = fakeToolContext({
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
  })

  it('lists the working directory when no path is given', async () => {
    // The default is the path every bare `ls` call takes, and every other case here names a path.
    const ctx = fakeToolContext({ cwd: '/elsewhere', files: { '/elsewhere/only.txt': '' } })
    const r = await lsTool.execute({}, ctx)
    expect(textOf(r)).toBe('only.txt')
  })

  it('says how many entries it did not show', async () => {
    const ctx = fakeToolContext({
      files: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, ''])),
    })
    const r = await lsTool.execute({ limit: 2 }, ctx)
    expect(textOf(r).split('\n')).toEqual(['f0.txt', 'f1.txt', '[3 more]'])
  })

  it('shows at most 500 entries when no limit is given', async () => {
    // The default is the ceiling every bare `ls` call runs into, and the case above names a limit.
    const ctx = fakeToolContext({
      files: Object.fromEntries(
        Array.from({ length: 501 }, (_, i) => [`f${String(i).padStart(3, '0')}.txt`, '']),
      ),
    })
    const r = await lsTool.execute({}, ctx)
    const lines = textOf(r).split('\n')
    expect(lines.filter((l) => l.endsWith('.txt'))).toHaveLength(500)
    expect(lines.at(-1)).toBe('[1 more]')
  })

  it('says a directory is empty rather than answering with nothing at all', async () => {
    const ctx = fakeToolContext({ files: { 'a/keep.txt': '' } })
    const r = await lsTool.execute({ path: 'nothing-here' }, ctx)
    expect(textOf(r)).toBe('(no entries)')
    expect(r.isError).toBeUndefined()
  })

  it('refuses a denied directory and hides denied entries from a listing', async () => {
    const ctx = fakeToolContext({ files: { 'secrets/key.txt': '', 'src/a.ts': '', 'sessions.db': '' } })
    const denied = await lsTool.execute({ path: 'secrets' }, ctx)
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('denied by policy')
    const root = await lsTool.execute({}, ctx)
    expect(textOf(root).split('\n')[0]).toBe('src/')
    expect(textOf(root)).not.toContain('secrets')
    expect(textOf(root)).not.toContain('sessions.db')
    expect(textOf(root)).toContain('2 entries not listed')
  })

  it('reports a listing failure rather than throwing', async () => {
    const ctx = fakeToolContext({
      files: { 'a.txt': '' },
      listErrors: { locked: { code: 'EACCES', message: 'EACCES: permission denied' } },
    })
    const r = await lsTool.execute({ path: 'locked' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('ls failed')
    expect(textOf(r)).toContain('EACCES')
  })
})
