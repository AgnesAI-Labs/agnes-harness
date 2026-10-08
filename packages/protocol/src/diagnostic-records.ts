import { Value } from '@sinclair/typebox/value'
/** Error metadata only. Messages, params, stacks and arbitrary cause fields never enter this seam. */
import type { DiagnosticRecord } from '../gen/ts/agnes-v1.js'
import { AppServerErrorCause } from '../gen/ts/app-server.js'
import { AGNES_ERRORS, JSONRPC_ERRORS } from './errors.js'

export type { DiagnosticRecord } from '../gen/ts/agnes-v1.js'

const records = new Map<string, DiagnosticRecord>()
const sinks = new Set<(record: Readonly<DiagnosticRecord>) => void>()
export function recordDiagnostic(record: DiagnosticRecord): boolean {
  records.delete(record.diagnosticId)
  records.set(record.diagnosticId, Object.freeze({ ...record }))
  if (records.size > 4096) records.delete(records.keys().next().value!)
  let available = true
  for (const sink of sinks) {
    try {
      sink(record)
    } catch {
      available = false
    }
  }
  return available
}
export function diagnosticRecords(): readonly Readonly<DiagnosticRecord>[] {
  return [...records.values()]
}
/** A process owner installs durable storage; registration replays errors raised before startup. */
export function observeDiagnostics(sink: (record: Readonly<DiagnosticRecord>) => void): () => void {
  for (const record of records.values()) sink(record)
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}
/** Validate a stored row and discard all unrecognized properties. */
export function safeDiagnosticRecord(input: unknown): DiagnosticRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const row = input as DiagnosticRecord
  if (!Number.isInteger(row.code) || typeof row.name !== 'string') return undefined
  if (
    typeof row.diagnosticId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.diagnosticId) ||
    typeof row.at !== 'string' ||
    !Number.isFinite(Date.parse(row.at))
  )
    return undefined
  const names = { ...AGNES_ERRORS, ...JSONRPC_ERRORS }
  const expected = names[row.name as keyof typeof names]
  if (
    expected !== row.code &&
    !(row.name === 'INTERNAL_ERROR' && !Object.values(names).some((code) => code === row.code))
  )
    return undefined
  return {
    diagnosticId: row.diagnosticId,
    at: new Date(row.at).toISOString(),
    code: row.code,
    name: row.name,
    ...(Value.Check(AppServerErrorCause, { code: row.cause }) ? { cause: row.cause } : {}),
  }
}
