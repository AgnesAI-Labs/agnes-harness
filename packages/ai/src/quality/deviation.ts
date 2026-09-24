import type { FormatDeviation, RequestHeader } from '@agnes/protocol'

export type DeviationInput = Pick<FormatDeviation, 'model' | 'responseModel' | 'rule' | 'parserVersion'>
export type DeviationStat = DeviationInput & {
  count: number
  requests: number
  rate: number
}
export type DeviationReportRow = Omit<DeviationStat, 'parserVersion' | 'requests' | 'rate'> & {
  parser_version: string
}
export type RequestsByModel = Readonly<Record<RequestHeader['model'], number>>
const keyOf = (row: DeviationInput) =>
  JSON.stringify([row.model, row.responseModel ?? null, row.rule, row.parserVersion])

/** Frozen events have no route, so equal model ids on different routes are deliberately pooled. */
export function aggregateDeviations(
  rows: readonly DeviationInput[],
  requestsByModel: RequestsByModel,
): DeviationStat[] {
  const counts = new Map<string, DeviationInput & { count: number }>()
  for (const row of rows) {
    const key = keyOf(row)
    const current = counts.get(key)
    if (current) current.count++
    else counts.set(key, { ...row, count: 1 })
  }
  return [...counts.values()]
    .map((row) => {
      const candidate = Object.hasOwn(requestsByModel, row.model) ? requestsByModel[row.model] : undefined
      const requests = candidate ?? 0
      if (!Number.isInteger(requests) || requests < 0)
        throw new RangeError('requests must be a non-negative integer')
      return { ...row, requests, rate: requests === 0 ? 0 : row.count / requests }
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

export function deviationGate(
  stats: readonly DeviationStat[],
  max: number,
): { pass: boolean; offenders: DeviationStat[] } {
  if (!Number.isFinite(max) || max < 0 || max > 1) throw new RangeError('max must be between 0 and 1')
  // A missing denominator means unknown quality, not zero deviation: fail closed.
  const offenders = stats.filter((stat) => (stat.requests === 0 ? stat.count > 0 : stat.rate > max))
  return { pass: offenders.length === 0, offenders }
}

export function toDeviationRows(stats: readonly DeviationStat[]): DeviationReportRow[] {
  return stats.map(({ parserVersion, requests: _requests, rate: _rate, ...row }) => ({
    ...row,
    parser_version: parserVersion,
  }))
}

export const DEVIATION_STATS_SQL = `
SELECT json_extract(data, '$.model') AS model,
       json_extract(data, '$.responseModel') AS responseModel,
       json_extract(data, '$.rule') AS rule,
       json_extract(data, '$.parserVersion') AS parserVersion,
       COUNT(*) AS count
FROM events WHERE type = 'format/deviation' AND ts >= :since
GROUP BY model, responseModel, rule, parserVersion`

export const REQUESTS_BY_MODEL_SQL = `
SELECT json_extract(data, '$.model') AS model, COUNT(*) AS requests
FROM events WHERE type = 'request/header' AND ts >= :since GROUP BY model`
