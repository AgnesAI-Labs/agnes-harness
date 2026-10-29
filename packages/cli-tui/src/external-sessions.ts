import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ExternalSession = {
  path: string
  source: 'claude-code' | 'codex'
  mtimeMs: number
  title?: string
}

export type ExternalRoots = { claude: string; codex: string }

export const defaultExternalRoots = (): ExternalRoots => ({
  claude: join(homedir(), '.claude', 'projects'),
  codex: join(homedir(), '.codex', 'sessions'),
})

/** How much of a file is read to find its directory or first message: metadata only, never the whole file. */
const HEAD_BYTES = 32 * 1024
/** Newest codex rollouts examined; older ones are not offered. */
const CODEX_SCAN_LIMIT = 400
const MAX_ITEMS = 50

function head(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const lines = (text: string): unknown[] =>
  text
    .split('\n')
    .slice(0, -1)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/** The first thing the user said in a Claude Code transcript, as a one-line title. */
function claudeTitle(rows: unknown[]): string | undefined {
  for (const row of rows) {
    const r = obj(row)
    if (r.type !== 'user') continue
    const content = obj(r.message).content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (typeof obj(part).text === 'string' ? (obj(part).text as string) : ''))
              .join(' ')
          : ''
    if (text.trim()) return text
  }
  return undefined
}

function walk(dir: string, depth: number, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) walk(full, depth - 1, out)
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(full)
  }
}

/**
 * Recent Claude Code and codex sessions that belong to `cwd`, newest first, at most 50. Only file
 * metadata and the head of each file are read; nothing is uploaded or cached. A file that cannot be
 * read is skipped and counted.
 */
export function listExternalSessions(
  cwd: string,
  roots: ExternalRoots = defaultExternalRoots(),
): { items: ExternalSession[]; skipped: number } {
  const items: ExternalSession[] = []
  let skipped = 0
  const stat = (path: string): number | undefined => {
    try {
      return statSync(path).mtimeMs
    } catch {
      skipped += 1
      return undefined
    }
  }
  try {
    const dir = join(roots.claude, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      const mtimeMs = stat(path)
      if (mtimeMs === undefined) continue
      let title: string | undefined
      try {
        const text = head(path)
        const rows = lines(text)
        if (rows.length === 0 && text.trim() !== '') throw new Error('not a transcript')
        title = claudeTitle(rows)
      } catch {
        skipped += 1
        continue
      }
      items.push({ path, source: 'claude-code', mtimeMs, ...(title ? { title } : {}) })
    }
  } catch {
    // No Claude Code directory for this workspace.
  }
  try {
    const files: string[] = []
    walk(roots.codex, 4, files)
    const newest = files
      .flatMap((path) => {
        const mtimeMs = stat(path)
        return mtimeMs === undefined ? [] : [{ path, mtimeMs }]
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, CODEX_SCAN_LIMIT)
    for (const { path, mtimeMs } of newest) {
      try {
        const text = head(path)
        const rows = lines(text)
        if (rows.length === 0 && text.trim() !== '') throw new Error('not a transcript')
        const first = obj(rows[0])
        if (obj(first.payload).cwd === cwd) items.push({ path, source: 'codex', mtimeMs })
      } catch {
        skipped += 1
      }
    }
  } catch {
    // No codex session directory.
  }
  return { items: items.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_ITEMS), skipped }
}
