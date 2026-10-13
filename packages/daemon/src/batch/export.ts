import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { quote } from './prompt.js'
import { type BatchRepo, type BatchRow, clipText, ITEM_STATES, type ItemRow, type ItemState } from './repo.js'
import { inside, singleLine } from './spec.js'

export const RESULT_FILES = ['results.jsonl', 'results.csv', 'errors.jsonl', 'summary.md'] as const
type ResultFile = (typeof RESULT_FILES)[number]

/** Each result file stops growing here; the summary says how many rows were left out. */
export const MAX_RESULT_FILE_BYTES = 512 * 1024 * 1024
/** Spreadsheets cap a cell near 32,767 characters; results.jsonl keeps the full value. */
export const MAX_CSV_CELL_CHARS = 32_000
const PAGE = 200
const FLUSH_BYTES = 1024 * 1024
const MAX_VALUES = 20
const MAX_VALUE_CHARS = 60
const MAX_SUMMARY_FIELDS = 30
const MAX_PROBLEMS = 10
const STALE_TEMPORARY_MS = 60 * 60 * 1000
const TEMPORARY = /^\.(?:results\.jsonl|results\.csv|errors\.jsonl|summary\.md)\.[0-9a-f]{12}\.tmp$/u
// Excludes O_NOFOLLOW where the platform has none (Windows); O_EXCL alone already refuses an existing link.
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)

type FieldStat = {
  numbers: { count: number; sum: number; min: number; max: number }
  values: Map<string, number>
  other: number
}

// A leading = + - @ (or a full-width one), possibly after spaces, or a leading tab or carriage return,
// makes a spreadsheet treat the cell as a formula. A plain number is safe as it is.
const FORMULA = /^(?:[\t\r]|\s*[=+\-@＝＋－＠])/u
// A spreadsheet that splits on `;` or tab (the list separator of many locales) starts a new cell
// after each one, so a formula character there is neutralised too.
const FORMULA_AFTER_SEPARATOR = /([;\t]\s*)(?=[=+\-@＝＋－＠])/gu
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point.
const CSV_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu

/**
 * One CSV cell. Paths and answers are untrusted: text a spreadsheet would run as a formula gets a
 * leading apostrophe (also after a `;` or tab, for spreadsheets that split on those), control
 * characters other than tab and line breaks are replaced, and very long text is cut. Quoted only when
 * the text holds a quote, comma, semicolon, tab or line break.
 */
export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  let text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  if (text.length > MAX_CSV_CELL_CHARS) text = `${clipText(text, MAX_CSV_CELL_CHARS)} [truncated]`
  text = text.replace(CSV_CONTROLS, '\ufffd')
  if (FORMULA.test(text) && !NUMBER.test(text)) text = `'${text}`
  text = text.replace(FORMULA_AFTER_SEPARATOR, "$1'")
  return /[",;\t\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Untrusted text placed inside one line of summary.md: kept on that line, cut to `max` characters,
 * with the characters that open links, images, HTML, code, emphasis, headings or table cells escaped
 * (`_` only where it is not between two letters or digits, so `a_b` stays readable), and URLs, `www.`
 * (wherever it appears) and e-mail addresses defanged so no renderer turns them into links.
 */
export function markdownText(text: string, max = 200): string {
  let flat = singleLine(text)
  if (flat.length > max) flat = `${clipText(flat, max - 1)}…`
  return flat
    .replace(/[\\`*[\]<>|&#!~$]/gu, (char) => `\\${char}`)
    .replace(/:\/\//gu, '\\[:\\]//')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
    .replace(/www\./giu, (match) => `${match.slice(0, 3)}\\[.\\]`)
    .replaceAll('@', '\\[@\\]')
}

export function schemaColumns(schema: unknown): string[] {
  const properties = (schema as { properties?: unknown } | undefined)?.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : []
}

const fmt = (n: number): string => String(Number(n.toFixed(4)))
const fail = (message: string): never => {
  throw new Error(message)
}
const code = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/**
 * The results folder as a real path inside the real workspace. Walked one folder at a time from the
 * workspace's real path: a missing folder is created (never through a link), an existing link is
 * followed only when its target stays inside the workspace. Refuses a folder that holds the input.
 */
async function resultsFolder(batch: BatchRow): Promise<string> {
  const segments = batch.outRel.split('/')
  if (
    segments.some(
      (s) => s === '' || s === '.' || s === '..' || s.includes('\0') || (sep === '\\' && /[\\:]/u.test(s)),
    )
  )
    fail('the results folder must be a folder inside the workspace')
  // Hidden folders hold tool and agent configuration; a model-written summary does not belong there.
  if (segments.some((s) => s.startsWith('.'))) fail('the results folder must not be in a hidden folder')
  const dirSegments = batch.dirRel === '' ? [] : batch.dirRel.split('/')
  if (inside(join(batch.root, ...segments), join(batch.root, ...dirSegments)))
    fail('the results folder holds the input folder')
  const realRoot = await realpath(batch.root)
  let current = realRoot
  for (const segment of segments) {
    const next = join(current, segment)
    try {
      await lstat(next)
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error
      await mkdir(next).catch((reason: unknown) => {
        if (code(reason) !== 'EEXIST') throw reason
      })
    }
    const real = await realpath(next).catch(() => fail('the results folder is not a directory'))
    if (!inside(realRoot, real)) fail('the results folder resolves outside the workspace')
    if (!(await lstat(real)).isDirectory()) fail('the results folder is not a directory')
    current = real
  }
  if (current === realRoot) fail('the results folder must be a folder inside the workspace')
  const realDir = await realpath(join(realRoot, ...dirSegments)).catch(() => undefined)
  if (realDir !== undefined && inside(current, realDir)) fail('the results folder holds the input folder')
  return current
}

/** Removes temporary files an interrupted export left behind (old enough not to be another export's). */
async function sweep(out: string): Promise<void> {
  const names = await readdir(out).catch(() => [] as string[])
  for (const name of names) {
    if (!TEMPORARY.test(name)) continue
    const path = join(out, name)
    const info = await lstat(path).catch(() => undefined)
    if (info?.isFile() && Date.now() - info.mtimeMs > STALE_TEMPORARY_MS)
      await unlink(path).catch(() => undefined)
  }
}

type Identity = Readonly<{ dev: number; ino: number }>

/** The file at `path` is still the one opened with this identity: a plain file, same device and inode. */
async function same(path: string, identity: Identity): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined)
  return !!info && info.isFile() && info.dev === identity.dev && info.ino === identity.ino
}

/**
 * Removes a temporary file only while its path still leads to the file this export created; anything
 * else found there is left alone and named (true when nothing is left behind).
 */
async function discard(path: string, identity: Identity | undefined): Promise<boolean> {
  if (identity === undefined || !(await same(path, identity)))
    return (await lstat(path).catch(() => undefined)) === undefined
  await unlink(path).catch(() => undefined)
  return true
}

/**
 * The folder must still be the checked real path, and every temporary file the one it created. Node has
 * no openat/renameat, so this is re-checked after each create and again just before the renames; a
 * swap between that last check and a rename needs write access to the workspace and is not covered.
 */
async function unchanged(out: string, drafts: readonly Draft[]): Promise<void> {
  if ((await realpath(out).catch(() => undefined)) !== out)
    fail('the results folder changed while it was written')
  for (const draft of drafts)
    if (!(await same(draft.temporary, draft.identity)))
      fail('a temporary result file was replaced while it was written')
}

/** A result file being written: a new temporary file in the checked folder, renamed over the old one. */
class Draft {
  rows = 0
  omitted = 0
  full = false
  committed = false
  closed = false
  private bytes = 0
  private pending: string[] = []
  private pendingBytes = 0

  private constructor(
    readonly name: ResultFile,
    readonly temporary: string,
    readonly file: FileHandle,
    readonly identity: Identity,
    private readonly maxBytes: number,
  ) {}

  /** Creates the temporary file without following a link, then checks at once where it landed. */
  static async create(out: string, name: ResultFile, maxBytes: number): Promise<Draft> {
    const temporary = join(out, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
    const file = await open(temporary, CREATE_NEW, 0o666)
    let identity: Identity | undefined
    try {
      const { dev, ino } = await file.stat()
      identity = { dev, ino }
      const draft = new Draft(name, temporary, file, identity, maxBytes)
      await unchanged(out, [draft])
      return draft
    } catch (error) {
      await file.close().catch(() => undefined)
      if (!(await discard(temporary, identity))) throw leftBehind(error, [temporary])
      throw error
    }
  }

  /** Appends text unless the file is full; after the first row that does not fit, every later row is left out. */
  async add(text: string, row = true): Promise<void> {
    const size = Buffer.byteLength(text)
    if (this.full || this.bytes + size > this.maxBytes) {
      this.full = true
      if (row) this.omitted++
      return
    }
    this.bytes += size
    if (row) this.rows++
    this.pending.push(text)
    this.pendingBytes += size
    if (this.pendingBytes >= FLUSH_BYTES) await this.flush()
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return
    const text = this.pending.join('')
    this.pending = []
    this.pendingBytes = 0
    await this.file.write(text)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.file.close()
  }
}

const leftBehind = (error: unknown, paths: readonly string[]): Error =>
  new Error(
    `${error instanceof Error ? error.message : String(error)}; temporary files left in place: ${paths.join(', ')}`,
    { cause: error },
  )

function collect(
  stats: Map<string, FieldStat>,
  output: Record<string, unknown>,
  columns: readonly string[],
): void {
  for (const column of columns) {
    const stat = stats.get(column) ?? {
      numbers: { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
      values: new Map<string, number>(),
      other: 0,
    }
    stats.set(column, stat)
    const value = Object.hasOwn(output, column) ? output[column] : undefined
    if (typeof value === 'number' && Number.isFinite(value)) {
      stat.numbers.count++
      stat.numbers.sum += value
      stat.numbers.min = Math.min(stat.numbers.min, value)
      stat.numbers.max = Math.max(stat.numbers.max, value)
    } else if (typeof value === 'string' || typeof value === 'boolean') {
      const key = clipText(String(value), MAX_VALUE_CHARS)
      if (stat.values.has(key) || stat.values.size < MAX_VALUES)
        stat.values.set(key, (stat.values.get(key) ?? 0) + 1)
      else stat.other++
    }
  }
}

export function renderSummary(input: {
  batch: BatchRow
  counts: Record<ItemState, number>
  spent: number
  columns: readonly string[]
  stats: ReadonlyMap<string, FieldStat>
  problems: readonly ItemRow[]
  truncated: ReadonlyArray<{ name: string; rows: number; omitted: number }>
  now: number
}): string {
  const { batch, counts } = input
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const lines = [
    `# Batch ${markdownText(batch.id, 40)}`,
    '',
    `- Status: ${batch.status}${batch.reason ? ` (${markdownText(batch.reason, 300)})` : ''}`,
    `- Folder: ${markdownText(batch.dirRel || '.', 300)} (${total} files)`,
    `- Done ${counts.done} · Invalid ${counts.invalid} · Failed ${counts.failed} · Skipped ${counts.skipped} · Cancelled ${counts.cancelled} · Pending ${counts.pending} · Running ${counts.running}`,
    `- Credits spent: ${fmt(input.spent)}${batch.spec.budgetCredits !== undefined ? ` of ${batch.spec.budgetCredits}` : ''}`,
    `- Files: ${RESULT_FILES.slice(0, 3).join(', ')}`,
    `- Written: ${new Date(input.now).toISOString()}`,
  ]
  for (const file of input.truncated)
    lines.push(`- ${file.name} stops after ${file.rows} rows (size limit); ${file.omitted} more are left out`)
  const fields = input.columns.filter((column) => input.stats.has(column))
  if (fields.length > 0) {
    lines.push('', '## Fields', '', '| Field | Values |', '| --- | --- |')
    for (const column of fields.slice(0, MAX_SUMMARY_FIELDS)) {
      const stat = input.stats.get(column) as FieldStat
      const parts: string[] = []
      if (stat.numbers.count > 0)
        parts.push(
          `n=${stat.numbers.count}, min ${fmt(stat.numbers.min)}, mean ${fmt(stat.numbers.sum / stat.numbers.count)}, max ${fmt(stat.numbers.max)}`,
        )
      const values = [...stat.values]
        .sort((a, b) => b[1] - a[1])
        .map(([value, n]) => `${markdownText(value, MAX_VALUE_CHARS)}: ${n}`)
      if (values.length > 0)
        parts.push(`${values.join(', ')}${stat.other > 0 ? `, other: ${stat.other}` : ''}`)
      lines.push(`| ${markdownText(column, MAX_VALUE_CHARS)} | ${parts.join('; ')} |`)
    }
    if (fields.length > MAX_SUMMARY_FIELDS)
      lines.push('', `${fields.length - MAX_SUMMARY_FIELDS} more fields are in results.csv.`)
  }
  if (input.problems.length > 0) {
    lines.push('', '## First problems', '')
    for (const item of input.problems)
      lines.push(
        `- ${item.ordinal} ${markdownText(item.path, 300)}: ${item.status}${item.error ? ` (${markdownText(item.error)})` : ''}`,
      )
  }
  return `${lines.join('\n')}\n`
}

/**
 * Rewrites every result file from the table, in item order; safe to repeat at any time, also while
 * the batch runs. Items are read page by page after an ordinal cursor, so the files and the summary
 * describe the same rows. Each file is written to a new temporary file in the checked folder and
 * renamed over the old one, so a reader sees a whole old file or a whole new one, and a link left
 * in the folder is replaced, never written through.
 */
export async function exportBatch(input: {
  repo: BatchRepo
  batch: BatchRow
  now: number
  maxFileBytes?: number
}): Promise<{ files: string[]; summary: string }> {
  const { repo, batch } = input
  const maxBytes = input.maxFileBytes ?? MAX_RESULT_FILE_BYTES
  const out = await resultsFolder(batch)
  await sweep(out)
  const columns = schemaColumns(batch.spec.schema)
  const drafts: Draft[] = []
  try {
    // The summary is bounded by construction and must always be complete.
    for (const name of RESULT_FILES)
      drafts.push(await Draft.create(out, name, name === 'summary.md' ? Number.POSITIVE_INFINITY : maxBytes))
    const [jsonl, csv, errors, summaryFile] = drafts as [Draft, Draft, Draft, Draft]
    const stats = new Map<string, FieldStat>()
    const problems: ItemRow[] = []
    const counts = Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as Record<ItemState, number>
    let spent = 0
    const header = ['ordinal', 'path', ...(columns.length > 0 ? columns : ['answer']), 'credits']
    await csv.add(`\ufeff${header.map(csvCell).join(',')}\r\n`, false)
    for (let after = 0; ; ) {
      if (jsonl.full && csv.full && errors.full) {
        // Every data file is full: the rest only needs counting, which the table does in one query.
        for (const rest of repo.tally(batch.id, after)) {
          counts[rest.status] += rest.items
          spent += rest.credits
          if (rest.status === 'done') {
            jsonl.omitted += rest.items
            csv.omitted += rest.items
          } else if (rest.status !== 'pending' && rest.status !== 'running') errors.omitted += rest.items
        }
        break
      }
      const page = repo.page(batch.id, after, PAGE)
      if (page.length === 0) break
      after = (page.at(-1) as ItemRow).ordinal
      for (const item of page) {
        counts[item.status]++
        spent += item.credits
        if (item.status === 'done') {
          const output = (item.output ?? {}) as Record<string, unknown>
          await jsonl.add(
            `${quote({ ordinal: item.ordinal, path: item.path, output, credits: item.credits })}\n`,
          )
          const cells =
            columns.length > 0
              ? columns.map((column) => (Object.hasOwn(output, column) ? output[column] : undefined))
              : [output.text]
          await csv.add(
            `${[item.ordinal, item.path, ...cells, fmt(item.credits)].map(csvCell).join(',')}\r\n`,
          )
          collect(stats, output, columns)
        } else if (item.status !== 'pending' && item.status !== 'running') {
          await errors.add(
            `${quote({ ordinal: item.ordinal, path: item.path, status: item.status, error: item.error ?? null, credits: item.credits })}\n`,
          )
          if (problems.length < MAX_PROBLEMS) problems.push(item)
        }
      }
    }
    const truncated = [jsonl, csv, errors]
      .filter((draft) => draft.omitted > 0)
      .map((draft) => ({ name: draft.name, rows: draft.rows, omitted: draft.omitted }))
    const summary = renderSummary({
      batch,
      counts,
      spent,
      columns,
      stats,
      problems,
      truncated,
      now: input.now,
    })
    await summaryFile.add(summary, false)
    for (const draft of drafts) {
      await draft.flush()
      await draft.file.sync()
      await draft.close()
    }
    await unchanged(out, drafts)
    // Every rename is tried; summary.md moves only when all three data files did, so it never
    // describes files that still hold an earlier export.
    const stale: string[] = []
    for (const draft of [jsonl, csv, errors, summaryFile]) {
      if (draft === summaryFile && stale.length > 0) {
        stale.push(draft.name)
        continue
      }
      try {
        await rename(draft.temporary, join(out, draft.name))
        draft.committed = true
      } catch {
        stale.push(draft.name)
      }
    }
    await syncFolder(out)
    if (stale.length > 0)
      fail(`some result files could not be replaced and still hold an earlier export: ${stale.join(', ')}`)
    return { files: RESULT_FILES.map((name) => `${batch.outRel}/${name}`), summary }
  } catch (error) {
    const left: string[] = []
    for (const draft of drafts) {
      await draft.close().catch(() => undefined)
      if (!draft.committed && !(await discard(draft.temporary, draft.identity))) left.push(draft.temporary)
    }
    throw left.length > 0 ? leftBehind(error, left) : error
  }
}

/** Makes the renames durable where the platform allows syncing a folder (not on Windows). */
async function syncFolder(path: string): Promise<void> {
  try {
    const folder = await open(path, 'r')
    try {
      await folder.sync()
    } finally {
      await folder.close()
    }
  } catch {
    // Best effort only.
  }
}
