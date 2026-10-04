/** Candidate inputs contain committed objective facts, never admitted messages or pending proposals. */
import type { CandidateFactRecord, JsonValue, RuntimeRecord } from './types.js'

const RESOURCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'jev.native-candidate-recipes.v1': ['globPatterns', 'grepContextLines', 'readPageLines'],
  'jev.workspace-directory.v1': [
    'root',
    'entries',
    'complete',
    'limit',
    'omitted',
    'sourceEnumeration',
    'ioBounded',
    'status',
  ],
  'jev.skill-catalog.v1': ['entries', 'complete'],
  'jev.skill-loaded.v1': ['name'],
  'jev.attachment.v1': ['attachmentId', 'name', 'bytes', 'mediaType', 'width', 'height'],
}

function metadataArray(value: JsonValue | undefined, fields: readonly string[]): JsonValue | undefined {
  if (!Array.isArray(value)) return undefined
  const output: JsonValue[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const entry: Record<string, JsonValue> = {}
    for (const field of fields) if (item[field] !== undefined) entry[field] = item[field]
    output.push(entry)
  }
  return output
}

/**
 * Project the candidate producer's restricted fact input from the authoritative ledger.
 * @param records - Committed runtime prefix, including user and model records that must remain private to decision routing.
 * @returns Catalog facts, admitted resource metadata and completed execution evidence with original record identities.
 */
export function candidateFacts(records: readonly RuntimeRecord[]): readonly CandidateFactRecord[] {
  const dispatched = new Set(
    records.flatMap((record) => (record.kind === 'action.dispatching' ? [record.intentId] : [])),
  )
  const completed = new Set(
    records.flatMap((record) =>
      record.kind === 'action.settled' &&
      dispatched.has(record.intentId) &&
      record.outcome.kind === 'success' &&
      record.effect !== 'unknown' &&
      record.effect !== 'not_applied'
        ? [record.intentId]
        : [],
    ),
  )
  const settlements = new Map(
    records.flatMap((record) =>
      record.kind === 'action.settled' ? [[record.intentId, record] as const] : [],
    ),
  )
  const facts: CandidateFactRecord[] = []
  for (const record of records) {
    if (record.kind === 'environment.observed') facts.push(record)
    else if (record.kind === 'resource.observed') {
      const value = record.resource
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof value.kind !== 'string'
      )
        continue
      const fields = RESOURCE_FIELDS[value.kind]
      if (fields === undefined) continue
      const resource: Record<string, JsonValue> = { kind: value.kind }
      for (const key of fields) if (value[key] !== undefined) resource[key] = value[key]
      if (value.kind === 'jev.workspace-directory.v1') {
        const entries = metadataArray(value.entries, ['path', 'kind', 'version', 'size'])
        if (entries === undefined) continue
        resource.entries = entries
      } else if (value.kind === 'jev.skill-catalog.v1') {
        const entries = metadataArray(value.entries, ['name', 'description'])
        if (entries === undefined) continue
        resource.entries = entries
      } else if (value.kind === 'jev.native-candidate-recipes.v1') {
        const patterns = metadataArray(value.globPatterns, ['pattern', 'path'])
        if (patterns === undefined) continue
        resource.globPatterns = patterns
      }
      facts.push({ ...record, resource })
    } else if (record.kind === 'action.intended' && completed.has(record.intent.id)) {
      facts.push(record)
    } else if (
      record.kind === 'action.intended' &&
      dispatched.has(record.intent.id) &&
      (record.intent.effectClass !== 'read_only' ||
        settlements.get(record.intent.id)?.outcome.kind === 'error')
    ) {
      const settlement = settlements.get(record.intent.id)
      if (
        settlement !== undefined &&
        (record.intent.effectClass === 'read_only' || settlement.effect !== 'not_applied')
      )
        facts.push({
          kind: 'candidate.invalidation',
          id: record.id,
          tool: record.intent.tool,
          effectClass: record.intent.effectClass,
          effect: settlement.effect,
        })
    } else if (record.kind === 'action.settled' && completed.has(record.intentId)) {
      const result = record.outcome
      facts.push({
        ...record,
        outcome: {
          kind: result.kind,
          ...(result.value === undefined ? {} : { value: result.value }),
          ...(result.meta === undefined ? {} : { meta: result.meta }),
          ...(result.error === undefined
            ? {}
            : {
                error: {
                  code: result.error.code,
                  ...(result.error.data === undefined ? {} : { data: result.error.data }),
                },
              }),
        },
      })
    }
  }
  return facts
}
