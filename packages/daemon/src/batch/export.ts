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
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point.
const CSV_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu

/**
 * One CSV cell. Paths and answers are untrusted: text a spreadsheet would run as a formula gets a
 * leading apostrophe, control characters other than tab and line breaks are replaced, and very long
 * text is cut. Quoted only when the text needs it.
 */
export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  let text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  if (text.length > MAX_CSV_CELL_CHARS) text = `${clipText(text, MAX_CSV_CELL_CHARS)} [truncated]`
  text = text.replace(CSV_CONTROLS, '\ufffd')
  if (FORMULA.test(text) && !NUMBER.test(text)) text = `'${text}`
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Untrusted text placed inside one line of summary.md: kept on that line, cut to `max` characters,
 * with the characters that open links, images, HTML, code, emphasis, headings or table cells escaped,
 * and URLs and e-mail addresses defanged so no renderer turns them into links.
 */
export function markdownText(text: string, max = 200): string {
  let flat = singleLine(text)
  if (flat.length > max) flat = `${clipText(flat, max - 1)}…`
  return flat
    .replace(/[\\`*[\]<>|&#!~$]/gu, (char) => `\\${char}`)
    .replace(/:\/\//gu, '\\[:\\]//')
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}\\[.\\]`)
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

/** A result file being written: a new temporary file in the checked folder, renamed over the old one. */
class Draft {
  rows = 0
  omitted = 0
  private bytes = 0
  private full = false
  private pending: string[] = []
  private pendingBytes = 0
  committed = false

  private constructor(
    readonly name: ResultFile,
    readonly temporary: string,
    readonly file: FileHandle,
    readonly identity: { dev: number; ino: number },
    private readonly maxBytes: number,
  ) {}

  static async create(out: string, name: ResultFile, maxBytes: number): Promise<Draft> {
    const temporary = join(out, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
    const file = await open(temporary, CREATE_NEW, 0o666)
    try {
      const { dev, ino } = await file.stat()
      return new Draft(name, temporary, file, { dev, ino }, maxBytes)
    } catch (error) {
      await file.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
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
}

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
    }
    // The folder and every temporary file must still be the ones checked and created above.
    if ((await realpath(out)) !== out) fail('the results folder changed while it was written')
    for (const draft of drafts) {
      const info = await lstat(draft.temporary)
      if (!info.isFile() || info.dev !== draft.identity.dev || info.ino !== draft.identity.ino)
        fail('a temporary result file was replaced while it was written')
    }
    for (const draft of drafts) {
      await rename(draft.temporary, join(out, draft.name))
      draft.committed = true
    }
    await syncFolder(out)
    return { files: RESULT_FILES.map((name) => `${batch.outRel}/${name}`), summary }
  } finally {
    for (const draft of drafts) {
      await draft.file.close().catch(() => undefined)
      if (!draft.committed) await unlink(draft.temporary).catch(() => undefined)
    }
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
