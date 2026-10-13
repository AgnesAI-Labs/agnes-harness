import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchSpec } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EnumeratedItem } from '../src/batch/enumerate.js'
import {
  csvCell,
  exportBatch,
  MAX_CSV_CELL_CHARS,
  markdownText,
  renderSummary,
  schemaColumns,
  summaryIsCurrent,
} from '../src/batch/export.js'
import { BatchRepo, type BatchRow, ITEM_STATES, type ItemState } from '../src/batch/repo.js'
import { sqliteTables } from './sqlite-tables.js'

type Schema = NonNullable<BatchSpec['schema']>

const id = 'b0123456789ab'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-export-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function seeded(schema?: Schema, outRel = `agh-batch/${id}`): { repo: BatchRepo; batch: BatchRow } {
  const repo = new BatchRepo(sqliteTables().table('batches'), () => 0)
  repo.create(
    {
      id,
      principalId: 'p',
      root,
      spec: { dir: 'images', prompt: 'x', ...(schema ? { schema } : {}) },
      dirRel: 'images',
      outRel,
      concurrency: 2,
      itemTimeoutMs: 600_000,
      createdAt: 0,
    },
    [
      { path: 'images/a.png', kind: 'image', bytes: 1 },
      { path: 'images/b,"c".png', kind: 'image', bytes: 1 },
      { path: 'images/d.png', kind: 'image', bytes: 1 },
      { path: 'images/e.bmp', kind: 'other', bytes: 1, skip: 'unsupported_type' },
    ],
  )
  repo.settle(id, 1, {
    status: 'done',
    output: schema ? { species: 'weevil', count: 2 } : { text: 'two\nweevils' },
    credits: 0.5,
  })
  repo.settle(id, 2, {
    status: 'done',
    output: schema ? { species: 'none', count: 0 } : { text: 'none' },
    credits: 0.25,
  })
  repo.settle(id, 3, { status: 'invalid', error: 'invalid_output: /count must be integer', credits: 0.75 })
  repo.setStatus(id, 'completed')
  return { repo, batch: repo.get(id) as BatchRow }
}

/** A finished batch whose items carry the given paths and answers, all settled as done. */
function custom(
  rows: ReadonlyArray<{ path: string; output?: unknown; error?: string }>,
  schema?: Schema,
  outRel = `agh-batch/${id}`,
): { repo: BatchRepo; batch: BatchRow } {
  const repo = new BatchRepo(sqliteTables().table('batches'), () => 0)
  const items: EnumeratedItem[] = rows.map((row) => ({ path: row.path, kind: 'text', bytes: 1 }))
  repo.create(
    {
      id,
      principalId: 'p',
      root,
      spec: { dir: 'docs', prompt: 'x', ...(schema ? { schema } : {}) },
      dirRel: 'docs',
      outRel,
      concurrency: 2,
      itemTimeoutMs: 600_000,
      createdAt: 0,
    },
    items,
  )
  for (const [index, row] of rows.entries())
    repo.settle(
      id,
      index + 1,
      row.error !== undefined
        ? { status: 'failed', error: row.error, credits: 0 }
        : { status: 'done', output: row.output, credits: 0 },
    )
  repo.setStatus(id, 'completed')
  return { repo, batch: repo.get(id) as BatchRow }
}

describe('exportBatch', () => {
  it('writes ordered results, a CSV of the schema fields, errors and a summary', async () => {
    const schema = { type: 'object', properties: { species: { type: 'string' }, count: { type: 'integer' } } }
    const { repo, batch } = seeded(schema)
    const exported = await exportBatch({ repo, batch, now: 0 })
    const out = join(root, 'agh-batch', id)
    expect(exported.files).toEqual(
      ['results.jsonl', 'results.csv', 'errors.jsonl', 'summary.md'].map((name) => `agh-batch/${id}/${name}`),
    )
    expect(
      readFileSync(join(out, 'results.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).ordinal),
    ).toEqual([1, 2])
    const csv = readFileSync(join(out, 'results.csv'), 'utf8')
    expect(csv.startsWith('\ufeffordinal,path,species,count,credits\r\n')).toBe(true)
    expect(csv).toContain('2,"images/b,""c"".png",none,0,0.25\r\n')
    expect(
      readFileSync(join(out, 'errors.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).status),
    ).toEqual(['invalid', 'skipped'])
    expect(exported.summary).toContain('| species | weevil: 1, none: 1 |')
    expect(exported.summary).toContain('| count | n=2, min 0, mean 1, max 2 |')
    expect(exported.summary).toContain('- 3 images/d.png: invalid (invalid_output: /count must be integer)')
    expect(readdirSync(out).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('writes the plain-text answer when there is no schema', async () => {
    const { repo, batch } = seeded()
    await exportBatch({ repo, batch, now: 0 })
    const csv = readFileSync(join(root, 'agh-batch', id, 'results.csv'), 'utf8')
    expect(csv).toContain('ordinal,path,answer,credits')
    expect(csv).toContain('1,images/a.png,"two\nweevils",0.5')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a results folder that resolves outside the workspace',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'agh-export-outside-'))
      try {
        mkdirSync(join(root, 'agh-batch'))
        symlinkSync(outside, join(root, 'agh-batch', id))
        const { repo, batch } = seeded()
        await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(
          /outside the workspace|not a directory/,
        )
        expect(existsSync(join(outside, 'results.jsonl'))).toBe(false)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    },
  )

  it('quotes CSV cells only when needed', () => {
    expect([csvCell('plain'), csvCell('a,b'), csvCell('say "hi"'), csvCell(null), csvCell({ a: 1 })]).toEqual(
      ['plain', '"a,b"', '"say ""hi"""', '', '"{""a"":1}"'],
    )
  })

  it('takes the CSV columns from the schema properties only', () => {
    expect(schemaColumns({ type: 'object', properties: { a: {}, b: {} } })).toEqual(['a', 'b'])
    expect(schemaColumns({ type: 'object', properties: ['a'] })).toEqual([])
    expect(schemaColumns(undefined)).toEqual([])
  })
})

describe('exportBatch: the results folder', () => {
  it.skipIf(process.platform === 'win32')(
    'creates nothing outside the workspace when a parent folder is a link out of it',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'agh-export-outside-'))
      try {
        symlinkSync(outside, join(root, 'agh-batch'))
        const { repo, batch } = seeded()
        await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(/outside the workspace/)
        expect(readdirSync(outside)).toEqual([])
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'follows a folder link that stays inside the workspace',
    async () => {
      mkdirSync(join(root, 'kept'))
      symlinkSync(join(root, 'kept'), join(root, 'agh-batch'))
      const { repo, batch } = seeded()
      await exportBatch({ repo, batch, now: 0 })
      expect(existsSync(join(root, 'kept', id, 'results.csv'))).toBe(true)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'replaces a result file that is a link instead of writing through it',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'agh-export-outside-'))
      try {
        const out = join(root, 'agh-batch', id)
        mkdirSync(out, { recursive: true })
        for (const name of ['results.jsonl', 'results.csv', 'errors.jsonl', 'summary.md']) {
          writeFileSync(join(outside, name), 'untouched')
          symlinkSync(join(outside, name), join(out, name))
        }
        const { repo, batch } = seeded()
        await exportBatch({ repo, batch, now: 0 })
        for (const name of ['results.jsonl', 'results.csv', 'errors.jsonl', 'summary.md']) {
          expect(readFileSync(join(outside, name), 'utf8')).toBe('untouched')
          expect(lstatSync(join(out, name)).isFile()).toBe(true)
        }
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    },
  )

  it('refuses a results folder that is a file', async () => {
    mkdirSync(join(root, 'agh-batch'))
    writeFileSync(join(root, 'agh-batch', id), 'x')
    const { repo, batch } = seeded()
    await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(/not a directory/)
  })

  it('refuses a results folder that is or holds the input folder', async () => {
    mkdirSync(join(root, 'images'))
    for (const outRel of ['images', '.', '', 'images/../x/..', '../elsewhere', 'a/../../b', '/abs']) {
      const { repo, batch } = seeded(undefined, outRel)
      await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(
        /results folder (?:holds the input folder|must be a folder inside the workspace)/,
      )
    }
    expect(readdirSync(join(root, 'images'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a results folder that holds the input folder through a link',
    async () => {
      mkdirSync(join(root, 'data', 'images'), { recursive: true })
      symlinkSync(join(root, 'data'), join(root, 'out'))
      const repo = new BatchRepo(sqliteTables().table('batches'), () => 0)
      repo.create(
        {
          id,
          principalId: 'p',
          root,
          spec: { dir: 'data/images', prompt: 'x' },
          dirRel: 'data/images',
          outRel: 'out',
          concurrency: 1,
          itemTimeoutMs: 600_000,
          createdAt: 0,
        },
        [{ path: 'data/images/a.png', kind: 'image', bytes: 1 }],
      )
      await expect(exportBatch({ repo, batch: repo.get(id) as BatchRow, now: 0 })).rejects.toThrow(
        /holds the input folder/,
      )
      expect(readdirSync(join(root, 'data'))).toEqual(['images'])
    },
  )

  it('creates no folder for a results folder that would hold an input folder not on disk', async () => {
    const repo = new BatchRepo(sqliteTables().table('batches'), () => 0)
    repo.create(
      {
        id,
        principalId: 'p',
        root,
        spec: { dir: 'gone/images', prompt: 'x' },
        dirRel: 'gone/images',
        outRel: 'gone',
        concurrency: 1,
        itemTimeoutMs: 600_000,
        createdAt: 0,
      },
      [{ path: 'gone/images/a.png', kind: 'image', bytes: 1 }],
    )
    await expect(exportBatch({ repo, batch: repo.get(id) as BatchRow, now: 0 })).rejects.toThrow(
      /holds the input folder/,
    )
    expect(existsSync(join(root, 'gone'))).toBe(false)
  })

  it('refuses a results folder inside a hidden folder', async () => {
    for (const outRel of ['.agnes/skills/x', 'out/.cache']) {
      const { repo, batch } = seeded(undefined, outRel)
      await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(/hidden folder/)
    }
    expect(readdirSync(root)).toEqual([])
  })

  it('replaces summary.md only when every data file was replaced, and names the stale files', async () => {
    const out = join(root, 'agh-batch', id)
    mkdirSync(join(out, 'results.csv', 'keep'), { recursive: true })
    const { repo, batch } = seeded()
    await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow(
      /could not be replaced and still hold an earlier export: results\.csv, summary\.md/,
    )
    expect(readdirSync(out).sort()).toEqual(['errors.jsonl', 'results.csv', 'results.jsonl'])
    expect(lstatSync(join(out, 'results.jsonl')).isFile()).toBe(true)
  })

  it('leaves no temporary files behind when two exports overlap', async () => {
    const { repo, batch } = seeded()
    await Promise.all([exportBatch({ repo, batch, now: 0 }), exportBatch({ repo, batch, now: 0 })])
    expect(readdirSync(join(root, 'agh-batch', id)).sort()).toEqual([
      'errors.jsonl',
      'results.csv',
      'results.jsonl',
      'summary.md',
    ])
  })

  it('removes temporary files an interrupted export left behind, but not recent ones', async () => {
    const out = join(root, 'agh-batch', id)
    mkdirSync(out, { recursive: true })
    const stale = join(out, '.results.csv.0123456789ab.tmp')
    const recent = join(out, '.results.csv.ba9876543210.tmp')
    const foreign = join(out, '.notes.tmp')
    for (const path of [stale, recent, foreign]) writeFileSync(path, 'x')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    utimesSync(foreign, old, old)
    const { repo, batch } = seeded()
    await exportBatch({ repo, batch, now: 0 })
    expect([existsSync(stale), existsSync(recent), existsSync(foreign)]).toEqual([false, true, true])
  })

  it('removes its temporary files when the export fails', async () => {
    const out = join(root, 'agh-batch', id)
    mkdirSync(join(out, 'summary.md', 'keep'), { recursive: true })
    const { repo, batch } = seeded()
    await expect(exportBatch({ repo, batch, now: 0 })).rejects.toThrow()
    expect(readdirSync(out).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('exportBatch: untrusted text', () => {
  it('neutralises spreadsheet formulas in paths, answers and schema column names', async () => {
    const hostile = ['=HYPERLINK("http://x")', '+1+cmd', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', '＝1+1']
    const schema = { type: 'object', properties: { '=col': { type: 'string' }, n: { type: 'number' } } }
    const { repo, batch } = custom(
      hostile.map((text, index) => ({ path: `${text}${index}.txt`, output: { '=col': text, n: -3 } })),
      schema,
    )
    await exportBatch({ repo, batch, now: 0 })
    const csv = readFileSync(join(root, 'agh-batch', id, 'results.csv'), 'utf8')
    expect(csv.startsWith("\ufeffordinal,path,'=col,n,credits\r\n")).toBe(true)
    const cells = csv.slice(1).split('\r\n').slice(1, -1)
    expect(cells).toHaveLength(hostile.length)
    for (const line of cells) {
      // Every text cell starts with an apostrophe, possibly inside quotes; the numbers stay numbers.
      expect(line).toMatch(/^\d+,"?'.*,"?'.*,-3,0$/su)
    }
  })

  it('neutralises a formula prefix in a single cell and leaves numbers alone', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('-x')).toBe("'-x")
    expect(csvCell(' =1')).toBe("' =1")
    expect(csvCell('\t=1')).toBe(`"'\t'=1"`)
    expect(csvCell('=a,b')).toBe(`"'=a,b"`)
    expect(csvCell('-3')).toBe('-3')
    expect(csvCell('+1.5e3')).toBe('+1.5e3')
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell(true)).toBe('true')
    expect(csvCell('a\u0000b')).toBe('a\ufffdb')
  })

  it('neutralises formulas after a semicolon or tab, for spreadsheets that split on those', () => {
    expect(csvCell('x;=1+1;')).toBe(`"x;'=1+1;"`)
    expect(csvCell('x;-2+3')).toBe(`"x;'-2+3"`)
    expect(csvCell('a\t=1')).toBe(`"a\t'=1"`)
    expect(csvCell('a; =1')).toBe(`"a; '=1"`)
    expect(csvCell('a;\t @x')).toBe(`"a;\t '@x"`)
    expect(csvCell('a;＝1;＋1;－1;＠1')).toBe(`"a;'＝1;'＋1;'－1;'＠1"`)
    expect(csvCell("ok;=cmd|' /C calc'!A0;")).toBe(`"ok;'=cmd|' /C calc'!A0;"`)
    // Separators alone only make the cell quoted; plain numbers stay numbers.
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('a\tb')).toBe('"a\tb"')
    expect(csvCell('1;2')).toBe('"1;2"')
    expect(csvCell('-3')).toBe('-3')
    expect(csvCell(-3)).toBe('-3')
  })

  it('caps very long CSV cells and keeps the full value in results.jsonl', async () => {
    const long = 'y'.repeat(MAX_CSV_CELL_CHARS + 500)
    const { repo, batch } = custom([{ path: 'docs/a.txt', output: { text: long } }])
    await exportBatch({ repo, batch, now: 0 })
    const out = join(root, 'agh-batch', id)
    const csv = readFileSync(join(out, 'results.csv'), 'utf8')
    expect(csv.length).toBeLessThan(MAX_CSV_CELL_CHARS + 200)
    expect(csv).toContain('[truncated]')
    expect(JSON.parse(readFileSync(join(out, 'results.jsonl'), 'utf8')).output.text).toBe(long)
  })

  it('writes one JSON value per line whatever line separators the text holds', async () => {
    const tricky = 'a\u2028b\u2029c\u0085d\re\nf\u000bg\u001ch'
    const { repo, batch } = custom([
      { path: `docs/${tricky}.txt`, output: { text: tricky } },
      { path: 'docs/ok.txt', output: { text: 'ok' } },
      { path: `docs/bad\u2028.txt`, error: `boom\u2029${tricky}` },
    ])
    await exportBatch({ repo, batch, now: 0 })
    const out = join(root, 'agh-batch', id)
    for (const [name, count] of [
      ['results.jsonl', 2],
      ['errors.jsonl', 1],
    ] as const) {
      const text = readFileSync(join(out, name), 'utf8')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: these line breaks must not appear raw.
      expect(text).not.toMatch(/[\u2028\u2029\u0085\r\u000b\u000c\u001c-\u001e]/u)
      const lines = text.split('\n')
      expect(lines.at(-1)).toBe('')
      expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toHaveLength(count)
    }
    const first = JSON.parse(readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n')[0] as string)
    expect(first).toMatchObject({ path: `docs/${tricky}.txt`, output: { text: tricky } })
  })

  it('keeps summary.md structure whatever the paths, answers and errors say', async () => {
    const schema = { type: 'object', properties: { 'note|x': { type: 'string' } } }
    const evil =
      '</td><script>x</script> [click](http://evil.example) ![i](https://e/i.png) <http://a.b> www.evil.com me@evil.com `code` **bold** &amp; |pipe| \\'
    const { repo, batch } = custom(
      [
        {
          path: `docs/\n# Injected heading\n${evil}.txt`,
          output: { 'note|x': `${evil}\n\n## Fake section` },
        },
        { path: `docs/${evil}.txt`, error: `${evil}\n- fake list item` },
      ],
      schema,
    )
    const exported = await exportBatch({ repo, batch, now: 0 })
    const summary = readFileSync(join(root, 'agh-batch', id, 'summary.md'), 'utf8')
    expect(exported.summary).toBe(summary)
    const lines = summary.split('\n')
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      `# Batch ${id}`,
      '## Fields',
      '## First problems',
    ])
    expect(lines.filter((line) => line.startsWith('- ') && line.includes('fake list item'))).toHaveLength(1)
    expect(summary).not.toMatch(/(?<!\\)[<>]/u)
    expect(summary).not.toMatch(/(?<!\\)\[/u)
    expect(summary).not.toMatch(/(?<!\\)`/u)
    expect(summary).not.toMatch(/https?:\/\//u)
    expect(summary).not.toMatch(/www\./u)
    expect(summary).not.toMatch(/\w@\w/u)
    for (const line of lines.filter(
      (row) => row.startsWith('| ') && !row.startsWith('| Field') && !row.startsWith('| ---'),
    )) {
      // Two unescaped pipes per row: the cells cannot be split by text inside them.
      expect(line.match(/(?<!\\)\|/gu)).toHaveLength(3)
    }
  })

  it('escapes markdown in a single piece of text and keeps it on one line', () => {
    expect(markdownText('a_b c/d.png: x (y)')).toBe('a_b c/d.png: x (y)')
    expect(markdownText('[x](http://e.com)')).toBe('\\[x\\](http\\[:\\]//e.com)')
    expect(markdownText('<b>\n#h')).toBe('\\<b\\> \\#h')
    expect(markdownText('x'.repeat(500), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('defangs www. wherever it appears, also right after a letter, digit or underscore', () => {
    expect(markdownText('_www.evil.com_')).toBe('\\_www\\[.\\]evil.com\\_')
    expect(markdownText('xwww.evil.com')).toBe('xwww\\[.\\]evil.com')
    expect(markdownText('1www.evil.com/a')).toBe('1www\\[.\\]evil.com/a')
    expect(markdownText('see WWW.Evil.com')).toBe('see WWW\\[.\\]Evil.com')
    for (const text of ['_www.evil.com_', 'xwww.evil.com', '1www.evil.com/a'])
      expect(markdownText(text)).not.toMatch(/www\./iu)
  })

  it('escapes underscores that could open emphasis and keeps snake_case readable', () => {
    expect(markdownText('invalid_output: a_b_c')).toBe('invalid_output: a_b_c')
    expect(markdownText('__init__.py')).toBe('\\_\\_init\\_\\_.py')
    expect(markdownText('_x_ and x_ _y')).toBe('\\_x\\_ and x\\_ \\_y')
    expect(markdownText('名前_値')).toBe('名前_値')
  })

  it('bounds the summary however many fields and problems there are', async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`f${index}`, { type: 'string' }]),
    )
    const output = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`f${index}`, 'v'.repeat(200)]),
    )
    const rows = [
      ...Array.from({ length: 30 }, (_, index) => ({ path: `docs/${index}.txt`, output })),
      ...Array.from({ length: 30 }, (_, index) => ({ path: `docs/e${index}.txt`, error: 'e'.repeat(2000) })),
    ]
    const { repo, batch } = custom(rows, { type: 'object', properties })
    const exported = await exportBatch({ repo, batch, now: 0 })
    expect(Buffer.byteLength(exported.summary)).toBeLessThan(16 * 1024)
    expect(exported.summary).toContain('more fields')
    expect(exported.summary.match(/^- \d+ /gmu)).toHaveLength(10)
  })

  it('stops a result file at its size limit and says so in the summary', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      path: `docs/${index}.txt`,
      output: { text: 'z'.repeat(100) },
    }))
    const { repo, batch } = custom(rows)
    const exported = await exportBatch({ repo, batch, now: 0, maxFileBytes: 2000 })
    const out = join(root, 'agh-batch', id)
    for (const name of ['results.jsonl', 'results.csv'])
      expect(Buffer.byteLength(readFileSync(join(out, name)))).toBeLessThanOrEqual(2000)
    const lines = readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n').slice(0, -1)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) JSON.parse(line)
    expect(exported.summary).toMatch(
      /results\.jsonl stops after \d+ rows \(size limit\); \d+ more are left out/,
    )
    expect(exported.summary).toMatch(/results\.csv stops after/)
  })

  it('only counts the rest once every data file is full, and still reports every row', async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, index) => ({ path: `docs/e${index}.txt`, error: 'boom' })),
      ...Array.from({ length: 997 }, (_, index) => ({ path: `docs/${index}.txt`, output: { text: 'z' } })),
    ]
    const { repo, batch } = custom(rows)
    let pages = 0
    const counted = new Proxy(repo, {
      get(target, key, receiver) {
        if (key === 'page')
          return (...args: Parameters<BatchRepo['page']>) => {
            pages++
            return target.page(...args)
          }
        return Reflect.get(target, key, receiver)
      },
    })
    const exported = await exportBatch({ repo: counted, batch, now: 0, maxFileBytes: 1 })
    expect(pages).toBe(1)
    expect(exported.summary).toContain('- Done 997 · Invalid 0 · Failed 3 ·')
    expect(exported.summary).toContain(
      '- results.jsonl stops after 0 rows (size limit); 997 more are left out',
    )
    expect(exported.summary).toContain('- results.csv stops after 0 rows (size limit); 997 more are left out')
    expect(exported.summary).toContain('- errors.jsonl stops after 0 rows (size limit); 3 more are left out')
  })

  it('takes summary counts and spend from the rows it wrote, not from the table afterwards', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      path: `docs/${index}.txt`,
      output: { text: 'a' },
    }))
    const repo = new BatchRepo(sqliteTables().table('batches'), () => 0)
    repo.create(
      {
        id,
        principalId: 'p',
        root,
        spec: { dir: 'docs', prompt: 'x' },
        dirRel: 'docs',
        outRel: `agh-batch/${id}`,
        concurrency: 2,
        itemTimeoutMs: 600_000,
        createdAt: 0,
      },
      rows.map((row) => ({ path: row.path, kind: 'text' as const, bytes: 1 })),
    )
    repo.settle(id, 1, { status: 'done', output: { text: 'a' }, credits: 1 })
    // A snapshot older than the rows: item 2 settles after it was taken but before the export reads it.
    const batch = repo.get(id) as BatchRow
    repo.settle(id, 2, { status: 'done', output: { text: 'b' }, credits: 2 })
    let first = true
    const racing = new Proxy(repo, {
      get(target, key, receiver) {
        if (key === 'page')
          return (...args: Parameters<BatchRepo['page']>) => {
            const page = target.page(...args)
            if (first) {
              first = false
              // Settles after the rows were read: the files show item 3 still pending.
              target.settle(id, 3, { status: 'done', output: { text: 'c' }, credits: 4 })
            }
            return page
          }
        return Reflect.get(target, key, receiver)
      },
    })
    const exported = await exportBatch({ repo: racing, batch, now: 0 })
    const written = readFileSync(join(root, 'agh-batch', id, 'results.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(written).toHaveLength(2)
    expect(exported.summary).toContain(
      '- Done 2 · Invalid 0 · Failed 0 · Skipped 0 · Cancelled 0 · Pending 1 · Running 0',
    )
    expect(exported.summary).toContain('- Credits spent: 3\n')
  })

  it('always writes the whole summary, whatever the size limit', async () => {
    const { repo, batch } = custom([{ path: 'docs/a.txt', output: { text: 'a' } }])
    const exported = await exportBatch({ repo, batch, now: 0, maxFileBytes: 100 })
    expect(Buffer.byteLength(exported.summary)).toBeGreaterThan(100)
    expect(readFileSync(join(root, 'agh-batch', id, 'summary.md'), 'utf8')).toBe(exported.summary)
  })
})

describe('summaryIsCurrent', () => {
  it('accepts a summary only for the status and reason it was written with', () => {
    const batch = {
      id,
      status: 'failed',
      reason: 'the first 5 items all failed (invalid_output: must be number)',
      dirRel: 'items',
      spec: { dir: 'items', prompt: 'x' },
    } as unknown as BatchRow
    const counts = Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as Record<ItemState, number>
    const summary = renderSummary({
      batch,
      counts,
      spent: 0,
      columns: [],
      stats: new Map(),
      problems: [],
      truncated: [],
      now: 0,
    })
    expect(summaryIsCurrent(summary, batch)).toBe(true)
    expect(summaryIsCurrent(summary, { ...batch, status: 'running' })).toBe(false)
    expect(summaryIsCurrent(summary, { ...batch, reason: 'cancelled by request' })).toBe(false)
    expect(summaryIsCurrent(`# Notes\n${summary}`, batch)).toBe(false)
  })
})
