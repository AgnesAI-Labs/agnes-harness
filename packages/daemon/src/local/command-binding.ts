import { createHash } from 'node:crypto'
import type { JournalBinding, JournalIdentity } from './ports.js'

const canonical = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('command binding contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item === undefined ? null : item)).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('command binding contains a non-JSON value')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

/** RFC 8785-shaped binding for already schema-validated JSON values. */
export function commandBinding(
  kind: string,
  sessionId: string,
  generation: number | undefined,
  payload: unknown,
): JournalBinding {
  const bytes = canonical({ kind, sessionId, generation: generation ?? null, payload })
  return {
    algorithm: 'agnes-command-jcs-sha256-v1',
    digest: createHash('sha256').update(bytes, 'utf8').digest('hex'),
    kind,
    generation: generation ?? null,
  }
}

export function commandAdmissionId(identity: JournalIdentity, binding: JournalBinding): string {
  return createHash('sha256').update(canonical({ identity, binding }), 'utf8').digest('hex')
}
