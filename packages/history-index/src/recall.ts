import type { DatabaseSync } from 'node:sqlite'
import { buildQuery, fuse, tokenize } from '@agnes/lexical-search'
import { cjkPartial } from './cjk-backfill.js'
import { HistoryIndexError } from './errors.js'
import type { HistoryItem, HistoryPage, HistoryQuery } from './store.js'
import { HISTORY_FETCH_CAP } from './text.js'

function excerpt(text: string, words: string[]) {
  let at = -1
  for (const term of words) {
    at = text.indexOf(term)
    if (at >= 0) break
  }
  const start = Math.max(0, at - 50)
  return (start ? '…' : '') + text.slice(start, start + 160) + (text.length > start + 160 ? '…' : '')
}

const singleEnglishWord = /^[a-z]{4,}$/

function englishVariants(term: string): string[] {
  if (!singleEnglishWord.test(term)) return []
  const variants: string[] = []
  if (term.endsWith('ies') && term.length >= 5) variants.push(`${term.slice(0, -3)}y`)
  else if (/(?:sh|ch|x|z|s)es$/u.test(term) && term.length >= 5) variants.push(term.slice(0, -2))
  else if (term.endsWith('s') && !/(?:ss|us|is)$/u.test(term) && term.length >= 5)
    variants.push(term.slice(0, -1))
  else variants.push(`${term}s`)

  if (term.endsWith('ing') && term.length >= 6) {
    const stem = term.slice(0, -3)
    variants.push(stem, `${stem}e`)
    if (/(.)\1$/u.test(stem) && stem.length >= 4) variants.push(stem.slice(0, -1))
  } else if (term.endsWith('ed') && term.length >= 5) {
    const stem = term.slice(0, -2)
    variants.push(stem, term.slice(0, -1))
    if (/(.)\1$/u.test(stem) && stem.length >= 4) variants.push(stem.slice(0, -1))
  } else if (!/(?:s|ed|ing)$/u.test(term)) {
    variants.push(`${term}ed`, `${term}ing`)
  }
  return variants
}

function expandEnglishInflections(match: string): string {
  if (!match) return ''
  const terms = new Set<string>()
  for (const part of match.matchAll(/"((?:[^"]|"")*)"/gu)) {
    const term = part[1]!.replaceAll('""', '"')
    if (term) terms.add(term)
  }
  for (const term of [...terms]) {
    for (const variant of englishVariants(term)) {
      if (terms.size >= 128) break
      terms.add(variant)
    }
    if (terms.size >= 128) break
  }
  return Array.from(terms)
    .slice(0, 128)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ')
}

export function recallEvents(
  db: DatabaseSync,
  request: HistoryQuery,
  where: string,
  params: (string | number)[],
  limit: number,
  generation: number,
): HistoryPage {
  if (request.cursor) throw new HistoryIndexError('INVALID_CURSOR')
  if (!request.query.trim() || request.query.length > 256) throw new HistoryIndexError('INVALID_QUERY')
  const query = buildQuery(request.query)
  const { words, bigrams } = tokenize(request.query)
  const terms = [...words, ...bigrams]
  type Row = HistoryItem & { id: number; seq: number }
  const channel = (table: 'docs_fts' | 'docs_cjk', match: string): Row[] => {
    if (!match) return []
    const snippet = table === 'docs_fts' ? "snippet(docs_fts,0,'[',']','…',12)" : 'e.text'
    const sql = `SELECT e.rowid AS id,e.session_id AS sessionId,e.seq,e.ts,e.type,s.title,s.workspace,${snippet} AS snippet
      FROM ${table} JOIN docs e ON e.rowid=${table}.rowid JOIN sessions s ON s.session_id=e.session_id
      WHERE ${table} MATCH ? AND e.seq>=1 AND ${where}
      ORDER BY rank,e.session_id,e.seq LIMIT ?`
    const rows = db.prepare(sql).all(match, ...params, HISTORY_FETCH_CAP + 1) as Row[]
    if (table === 'docs_cjk') {
      for (const row of rows) row.snippet = excerpt(row.snippet, terms)
    }
    return rows
  }
  const ranked = fuse(
    [channel('docs_fts', expandEnglishInflections(query.en)), channel('docs_cjk', query.cjk)],
    (row) => row.id,
  )
  return {
    items: ranked.slice(0, limit).map(({ item: { id: _, ...item } }) => item),
    truncated: ranked.length > limit,
    generation,
    ...(cjkPartial(db) ? { partial: true } : {}),
  }
}
