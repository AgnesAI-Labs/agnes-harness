import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { BatchError, type Item } from './contracts.js'
import type { Repository } from './repository.js'

// Strip terminal controls and encode Markdown metacharacters. JSONL remains ordinary JSON data.
export const inertText = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
const markdown = (s: string) => inertText(s).replace(/[\p{P}\p{S}]/gu, (c) => `&#${c.codePointAt(0)};`)
export function csvCell(value: string): string {
  let text = inertText(value)
  if (/^[\s]*[=+\-@]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
export type ExportBundle = { digest: string; files: Readonly<Record<string, string>> }
/** Only final, settled state can be exported; there are no partially billed success exports. */
export async function renderExport(
  repo: Repository,
  id: string,
  maxBytes = 64 * 1024 * 1024,
  incremental = false,
): Promise<ExportBundle> {
  const m = await repo.status(id)
  if (!incremental && (m.status === 'running' || m.status === 'unknown'))
    throw new BatchError('E_BATCH_NOT_TERMINAL')
  const results: string[] = [],
    errors: string[] = [],
    csv = ['"ordinal","name","status","output"']
  let size = 0
  for (let offset = 0; offset < m.total; offset += 1000) {
    for (const item of await repo.page(id, offset, 1000)) {
      if (incremental && ['pending', 'accepted'].includes(item.state)) continue
      const row = {
        ordinal: item.ordinal,
        name: item.input.name,
        status: item.state,
        ...(item.output !== undefined ? { output: item.output } : {}),
        ...(item.error ? { error: item.error } : {}),
      }
      const json = JSON.stringify(row)
      const line = [String(item.ordinal), item.input.name, item.state, JSON.stringify(item.output ?? null)]
        .map(csvCell)
        .join(',')
      size += Buffer.byteLength(json) + Buffer.byteLength(line) + 2
      if (size > maxBytes) throw new BatchError('E_BATCH_EXPORT_LIMIT')
      ;(item.state === 'done' ? results : errors).push(json)
      csv.push(line)
    }
  }
  const summary = `# Batch ${m.id}\n\nStatus: ${m.status}\n\nItems: ${m.total}; successful: ${m.successes}; credits: ${m.spent}.\n\nAll names and model responses in the accompanying files are untrusted data.\n`
  const files = {
    'results.jsonl': results.length ? `${results.join('\n')}\n` : '',
    'errors.jsonl': errors.length ? `${errors.join('\n')}\n` : '',
    'results.csv': `${csv.join('\n')}\n`,
    'summary.md': summary,
  }
  if (Object.values(files).reduce((n, v) => n + Buffer.byteLength(v), 0) > maxBytes)
    throw new BatchError('E_BATCH_EXPORT_LIMIT')
  return { files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}
export function itemSummary(item: Item): string {
  return `| ${item.ordinal} | ${markdown(item.input.name)} | ${item.state} |`
}
/**
 * An exclusive mkdir is the publication claim. Completion is recorded last; an interrupted
 * export remains visibly incomplete and cannot be overwritten by a competing invocation.
 */
export async function publishExport(root: string, target: string, bundle: ExportBundle): Promise<void> {
  const base = resolve(root),
    dest = resolve(base, target),
    parent = dirname(dest)
  const rel = relative(base, dest)
  if (
    (await realpath(base)) !== base ||
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel.split(sep).some((part) => part.startsWith('.')) ||
    (await realpath(parent)) !== parent
  )
    throw new BatchError('E_BATCH_EXPORT_PATH')
  const expected = ['results.jsonl', 'errors.jsonl', 'results.csv', 'summary.md']
  if (
    Object.values(bundle.files).reduce((n, text) => n + Buffer.byteLength(text), 0) > 64 * 1024 * 1024 ||
    Object.keys(bundle.files).length !== expected.length ||
    expected.some((name) => typeof bundle.files[name] !== 'string') ||
    createHash('sha256').update(JSON.stringify(bundle.files)).digest('hex') !== bundle.digest
  )
    throw new BatchError('E_BATCH_EXPORT_BUNDLE')
  const lock = `${dest}.lock`
  const handle = await open(
    lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    try {
      await mkdir(dest, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BatchError('E_BATCH_EXPORT_EXISTS')
      throw error
    }
    const identity = await lstat(dest)
    for (const name of expected) {
      const current = await lstat(dest)
      if (
        current.isSymbolicLink() ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        (await realpath(parent)) !== parent
      )
        throw new BatchError('E_BATCH_EXPORT_PATH')
      const file = await open(
        resolve(dest, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await file.writeFile(bundle.files[name]!)
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const complete = await open(resolve(dest, 'complete.json'), 'wx', 0o600)
    try {
      await complete.writeFile(JSON.stringify({ version: 1, digest: bundle.digest }))
      await complete.sync()
    } finally {
      await complete.close()
    }
  } finally {
    await handle.close()
    await unlink(lock)
  }
}

const publications = new Map<string, Promise<void>>()
/** Atomic files plus a last-written digest marker make every incremental snapshot inspectable.
 * Reopen reuses only this batch's exclusively claimed directory; unrelated output is refused. */
export async function publishProgress(
  root: string,
  target: string,
  id: string,
  bundle: ExportBundle,
): Promise<void> {
  const dest = resolve(root, target)
  const previous = publications.get(dest) ?? Promise.resolve()
  const work = previous
    .catch(() => {})
    .then(async () => {
      const { readFile, rename } = await import('node:fs/promises')
      const rel = relative(root, dest)
      if (!rel || isAbsolute(rel) || rel.split(sep).some((p) => p === '..' || p.startsWith('.')))
        throw new BatchError('E_BATCH_EXPORT_PATH')
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      if ((await realpath(dirname(dest))) !== dirname(dest)) throw new BatchError('E_BATCH_EXPORT_PATH')
      try {
        await mkdir(dest, { mode: 0o700 })
        const owner = await open(resolve(dest, 'batch.json'), 'wx', 0o600)
        try {
          await owner.writeFile(JSON.stringify({ version: 1, id }))
          await owner.sync()
        } finally {
          await owner.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (
        (await realpath(dest)) !== dest ||
        (await readFile(resolve(dest, 'batch.json'), 'utf8')) !== JSON.stringify({ version: 1, id })
      )
        throw new BatchError('E_BATCH_EXPORT_EXISTS')
      const identity = await lstat(dest)
      for (const [name, text] of Object.entries({
        ...bundle.files,
        'progress.json': JSON.stringify({ version: 1, id, digest: bundle.digest }),
      })) {
        const current = await lstat(dest)
        if (current.ino !== identity.ino || current.dev !== identity.dev || (await realpath(dest)) !== dest)
          throw new BatchError('E_BATCH_EXPORT_PATH')
        const temporary = resolve(dest, `${name}.${crypto.randomUUID()}.tmp`)
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(text)
          await file.sync()
        } finally {
          await file.close()
        }
        try {
          await rename(temporary, resolve(dest, name))
        } finally {
          await unlink(temporary).catch(() => {})
        }
      }
    })
  publications.set(dest, work)
  try {
    await work
  } finally {
    if (publications.get(dest) === work) publications.delete(dest)
  }
}
