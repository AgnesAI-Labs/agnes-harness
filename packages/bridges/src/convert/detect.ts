import type { ImportSource } from './types.js'

export type DetectedSource = ImportSource | 'agnes' | 'cli-result' | 'unknown'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Detection is deliberately header-biased: recognizing a body is not permission to invent a head. */
export function detectSource(values: unknown[]): DetectedSource {
  const head = values.slice(0, 20).filter(record)
  const first = head[0]
  if (!first) return 'unknown'
  if (first.v === 'agnes-cli-result/v1') return 'cli-result'
  if (
    typeof first.seq === 'number' &&
    typeof first.type === 'string' &&
    'actor' in first &&
    'origin' in first &&
    'trust' in first
  )
    return 'agnes'
  if (head.some((row) => 'parentUuid' in row && 'isSidechain' in row)) return 'claude-code'
  if (first.type === 'session') return 'pi'
  if (
    typeof first.id === 'string' &&
    typeof first.timestamp === 'string' &&
    head.some((row) => row.record_type === 'state' || row.type === 'message')
  )
    return 'codex'
  if (
    head.some(
      (row) => typeof row.type === 'string' && /^(?:session[_-]?meta|response[_-]?item)$/i.test(row.type),
    )
  )
    return 'codex'
  return 'unknown'
}
