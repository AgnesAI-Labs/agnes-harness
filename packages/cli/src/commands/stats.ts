import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DEVIATION_STATS_SQL, type DeviationStat, REQUESTS_BY_MODEL_SQL } from '@agnes/ai'
import { inDataDir } from '@agnes/host'
import { UsageError } from '../errors.js'
import type { BootDeps, ParsedArgs } from '../types.js'

type DeviationCount = {
  model: unknown
  responseModel: unknown
  rule: unknown
  parserVersion: unknown
  count: unknown
}
type RequestCount = { model: unknown; requests: unknown }

const withPositionalSince = (sql: string): string => sql.replace(':since', '?')

function integer(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`invalid ${field} count in sessions.db`)
  return number
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`invalid deviation ${field} in sessions.db`)
  return value
}

function stats(rows: DeviationCount[], requests: RequestCount[]): DeviationStat[] {
  const denominators = new Map<string, number>()
  for (const row of requests) denominators.set(text(row.model, 'model'), integer(row.requests, 'request'))

  return rows
    .map((row): DeviationStat => {
      const model = text(row.model, 'model')
      const count = integer(row.count, 'deviation')
      const denominator = denominators.get(model) ?? 0
      return {
        model,
        ...(row.responseModel === null ? {} : { responseModel: text(row.responseModel, 'responseModel') }),
        rule: text(row.rule, 'rule'),
        parserVersion: text(row.parserVersion, 'parserVersion'),
        count,
        requests: denominator,
        rate: denominator === 0 ? 0 : count / denominator,
      }
    })
    .sort(
      (a, b) =>
        b.rate - a.rate ||
        b.count - a.count ||
        a.model.localeCompare(b.model) ||
        (a.responseModel ?? '').localeCompare(b.responseModel ?? '') ||
        a.rule.localeCompare(b.rule) ||
        a.parserVersion.localeCompare(b.parserVersion),
    )
}

function empty(p: ParsedArgs, suffix = ''): string {
  return p.json ? '[]' : `0 rows${suffix}`
}

/** Reads the immutable ledger database without creating it or changing its journal state. */
export async function statsDeviation(p: ParsedArgs, deps: BootDeps): Promise<string> {
  if (p.positional.length !== 1 || p.positional[0] !== 'deviation')
    throw new UsageError('stats deviation [--json]')

  const file = inDataDir(deps.home, 'sessions.db')
  if (!existsSync(file)) return empty(p, ' (no sessions.db yet)')

  const db = new DatabaseSync(file, { readOnly: true })
  let result: DeviationStat[]
  try {
    // Event timestamps are ISO strings. The empty lower bound includes every valid timestamp while
    // retaining the shared AI query contract (and its grouping) instead of duplicating that SQL.
    const deviations = db
      .prepare(withPositionalSince(DEVIATION_STATS_SQL))
      .all('') as unknown as DeviationCount[]
    const requests = db
      .prepare(withPositionalSince(REQUESTS_BY_MODEL_SQL))
      .all('') as unknown as RequestCount[]
    result = stats(deviations, requests)
  } catch (error) {
    // An old/empty database may not have the ledger table yet. Corrupt JSON and other failures are
    // not hidden as a healthy zero-result report.
    if (error instanceof Error && /no such table:\s*events/i.test(error.message)) return empty(p)
    throw error
  } finally {
    db.close()
  }

  if (p.json) return JSON.stringify(result, null, 2)
  if (result.length === 0) return empty(p)
  return result
    .map(
      (row) =>
        `${row.model}\t${row.responseModel ?? '-'}\t${row.rule}\t${row.parserVersion}\t${row.count}/${row.requests}\t${(row.rate * 100).toFixed(2)}%`,
    )
    .join('\n')
}
