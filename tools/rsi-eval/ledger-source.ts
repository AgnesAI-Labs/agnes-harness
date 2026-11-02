import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Read-only access to session ledgers for offline statistics. A ledger is read from a copy of
// `sessions.db` or from the event files a loop bench writes; nothing here can write to either.

export type LedgerEvent = {
  seq: number
  ts: string
  type: string
  data: unknown
  /** Event origin, when the source records it. */
  origin?: string
  /** Events this one answers, when the source records them. */
  sourceEventSeqs?: number[]
}

export type LedgerSession = { key: string; parentKey: string | null; imported: boolean }

export type LedgerReader = {
  sessions(): LedgerSession[]
  events(key: string): LedgerEvent[]
  close(): void
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function seqList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seqs = value.filter((n): n is number => Number.isSafeInteger(n))
  return seqs.length > 0 ? seqs : undefined
}

export function openLedgerReadOnly(file: string): LedgerReader {
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA query_only = ON')
  const listSessions = db.prepare('SELECT session_key AS key, parent_key AS parentKey FROM sessions')
  const startData = db.prepare(
    `SELECT data FROM events WHERE session_key = ? AND type = 'session/start' ORDER BY seq LIMIT 1`,
  )
  // The lane column is a BLOB; the CAST also accepts rows that stored the same bytes as text.
  const listEvents = db.prepare(
    `SELECT seq, ts, type, origin, source_event_seqs AS sourceEventSeqs, data FROM events
     WHERE session_key = ? AND (lane IS NULL OR CAST(lane AS BLOB) IN (x'6d61696e', x''))
     ORDER BY seq ASC`,
  )
  return {
    sessions() {
      return listSessions.all().map((row) => {
        const key = String(row.key)
        const start = parseJson(startData.get(key)?.data)
        const imported = isObject(start) && isObject(start.imported)
        return { key, parentKey: row.parentKey === null ? null : String(row.parentKey), imported }
      })
    },
    events(key) {
      return listEvents.all(key).map((row) => {
        const event: LedgerEvent = {
          seq: Number(row.seq),
          ts: String(row.ts),
          type: String(row.type),
          data: parseJson(row.data),
          origin: String(row.origin),
        }
        const sources = seqList(parseJson(row.sourceEventSeqs))
        if (sources) event.sourceEventSeqs = sources
        return event
      })
    },
    close() {
      db.close()
    },
  }
}

/** Reads `<dir>/*.jsonl` (or `<dir>/events/*.jsonl`); one file per session, main lane only. */
export function readBenchEvents(dir: string): Map<string, LedgerEvent[]> {
  const nested = join(dir, 'events')
  const root = existsSync(nested) && statSync(nested).isDirectory() ? nested : dir
  const bySession = new Map<string, LedgerEvent[]>()
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith('.jsonl')) continue
    const events: LedgerEvent[] = []
    for (const line of readFileSync(join(root, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const row = parseJson(line)
      if (!isObject(row)) continue
      if (row.lane !== undefined && row.lane !== '' && row.lane !== 'main') continue
      if (!Number.isSafeInteger(row.seq) || typeof row.type !== 'string') continue
      const event: LedgerEvent = {
        seq: row.seq as number,
        ts: typeof row.ts === 'string' ? row.ts : '',
        type: row.type,
        data: row.data,
      }
      if (typeof row.origin === 'string') event.origin = row.origin
      const sources = seqList(row.sourceEventSeqs)
      if (sources) event.sourceEventSeqs = sources
      events.push(event)
    }
    events.sort((a, b) => a.seq - b.seq)
    bySession.set(basename(name, '.jsonl'), events)
  }
  return bySession
}

/**
 * A stable key for "the same error": the code if there is one, else a masked first line of text. Shell
 * results start with a stream label (`[stderr]`, `[stdout]`) that says nothing about the error, so
 * labels are skipped: otherwise every failing shell call would look like the same error.
 */
const STREAM_LABEL = /^\[(?:stderr|stdout)\]$/i

export function normalizeToolError(result: { code?: string; content?: unknown[] }): string {
  if (result.code) return result.code
  let text = ''
  for (const block of result.content ?? []) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      text = block.text
      break
    }
  }
  const firstLine = text.split('\n').find((line) => line.trim() && !STREAM_LABEL.test(line.trim())) ?? ''
  return firstLine
    .trim()
    .toLowerCase()
    .replace(/(?<![\w.])(?:\/|[a-z]:\\)[^\s'"`<>()]+/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/\d+/g, '#')
    .slice(0, 120)
}
