export const HISTORY_PAGE_SIZE = 20
export const HISTORY_PAGE_MAX = 50
export const HISTORY_FETCH_CAP = 400
export const HISTORY_TEXT_MAX = 4000
export const HISTORY_BODY_MAX = 32_000
export const HISTORY_READ_MAX = 256 * 1024
const TEXT_KEYS = new Set(['text', 'title', 'message', 'output', 'command', 'path'])

/** Quote a user phrase so FTS operators in the text stay data. */
export function ftsPhrase(input: string): string | undefined {
  const normalized = input.trim().replace(/\s+/g, ' ')
  if (!normalized) return undefined
  return `"${normalized.replaceAll('"', '""')}"`
}

export function likeContains(input: string): string {
  const escaped = input.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  return `%${escaped}%`
}

export function extractText(data: unknown): string {
  const parts: string[] = []
  let used = 0
  const push = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed || used >= HISTORY_TEXT_MAX) return
    const room = HISTORY_TEXT_MAX - used
    const piece = trimmed.length > room ? trimmed.slice(0, room) : trimmed
    parts.push(piece)
    used += piece.length
  }
  const walk = (value: unknown, key: string | undefined): void => {
    if (used >= HISTORY_TEXT_MAX) return
    if (typeof value === 'string') {
      if (key !== undefined && TEXT_KEYS.has(key)) push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey)
    }
  }
  walk(data, undefined)
  return parts.join('\n')
}

export function eventBody(raw: string): { body: string; truncated: boolean } {
  const windowed = raw.length > HISTORY_READ_MAX ? raw.slice(0, HISTORY_READ_MAX) : raw
  const truncated = raw.length > HISTORY_BODY_MAX
  const body = windowed.length > HISTORY_BODY_MAX ? windowed.slice(0, HISTORY_BODY_MAX) : windowed
  return { body, truncated }
}

export type HistoryCursor = {
  g: number
  o: number
  n: number
  kind: 'search' | 'list'
  q: string
  title: string
  workspace: string
  sessionId: string
}

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCursor(value: string): HistoryCursor | undefined {
  if (value.length === 0 || value.length > 512) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const row = parsed as Record<string, unknown>
  if (row.kind !== 'search' && row.kind !== 'list') return undefined
  if (typeof row.g !== 'number' || !Number.isSafeInteger(row.g) || row.g < 1) return undefined
  if (typeof row.o !== 'number' || !Number.isSafeInteger(row.o) || row.o < 0) return undefined
  if (typeof row.n !== 'number' || !Number.isSafeInteger(row.n) || row.n < 1 || row.n > HISTORY_PAGE_MAX)
    return undefined
  if (typeof row.q !== 'string' || typeof row.title !== 'string') return undefined
  if (typeof row.workspace !== 'string' || typeof row.sessionId !== 'string') return undefined
  return {
    g: row.g,
    o: row.o,
    n: row.n,
    kind: row.kind,
    q: row.q,
    title: row.title,
    workspace: row.workspace,
    sessionId: row.sessionId,
  }
}
