import { type RedactRules, redact } from '@agnes/error-sanitization'
import { type EventEnvelope, validateEvent } from '@agnes/protocol'

const SHA256 = /^[0-9a-f]{64}$/
const RESOLVED_HASH = /^(?:sha256-)?[0-9a-f]{64}$/
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const EFFECT_ID = /^e-[0-9a-f]{32}$/
const TOOL_ID = /^t\d+-[0-9a-f]{32}$/
const REQUEST_ID = /^r-[0-9a-f]{32}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type Field = readonly [path: string, shape: RegExp]
const REQUEST_HASHES: Field[] = ['derived_hash', 'sent_hash', 'prompt_prefix_hash', 'tool_schema_hash'].map(
  (name) => [`data.${name}`, SHA256],
)
const ARTIFACT: Field[] = [['sha256', SHA256]]
const CONTENT: Field[] = [
  ['reference.hash', SHA256],
  ['attachment.artifact.sha256', SHA256],
  ['attachment.thumbnail.sha256', SHA256],
  ['attachment.receiptId', UUID],
]
const under = (prefix: string, fields: Field[]): Field[] =>
  fields.map(([path, shape]) => [`${prefix}.${path}`, shape])

// These are protocol locations, never field-name or string-shape exemptions for arbitrary JSON.
// In particular, tool args/structured output, actor attributes and extension event data stay redacted.
const FIELDS: Record<string, Field[]> = {
  'session/start': [
    ['data.resolvedProfileHash', RESOLVED_HASH],
    ['data.resolvedPresetHash', RESOLVED_HASH],
    ['data.systemPrompt.hash', SHA256],
  ],
  'request/header': [
    ...REQUEST_HASHES,
    ['data.envelopeNonce', /^[0-9a-f]{32,64}$/],
    ['data.media.manifest.*.sha256', SHA256],
    ['data.media.manifest.*.elementMapDigest', SHA256],
    ['data.media.manifest.*.artifactUri', /^artifact:\/\/[0-9a-f]{64}$/],
  ],
  'request/sent': [...REQUEST_HASHES, ['data.requestTraceId', UUID]],
  'tool/call': [
    ['data.toolUseId', TOOL_ID],
    ['data.parentEffectId', EFFECT_ID],
    ['data.definitionFingerprint', SHA256],
    ['data.policyHash', SHA256],
  ],
  'tool/result': [
    ['data.toolUseId', TOOL_ID],
    ['data.authz.decisionId', ULID],
    ...under('data.artifactRefs.*', ARTIFACT),
    ...under('data.content.*', CONTENT),
  ],
  'user/message': under('data.content.*', CONTENT),
  'assistant/message': under('data.content.*', CONTENT),
  'assistant/output': [['data.effectId', EFFECT_ID]],
  'effect/intent': [
    ['data.effectId', EFFECT_ID],
    ['data.parentEffectId', EFFECT_ID],
    ['data.tool.toolUseId', TOOL_ID],
  ],
  'effect/settled': [['data.effectId', EFFECT_ID]],
  'cost/ledger': [['data.effectId', EFFECT_ID]],
  'turn/start': [
    ['data.continues.toolUseId', TOOL_ID],
    ['data.continues.requestId', REQUEST_ID],
  ],
  'verifier/signal': [['data.toolUseId', TOOL_ID]],
  'artifact/job': under('data.ref', ARTIFACT),
  'budget.state': [['data.lastPreflight.boundHash', SHA256]],
  inbox: [['data.items.*.admissionId', SHA256], ...under('data.items.*.content.*', CONTENT)],
  'format/deviation': [['data.sampleHash', SHA256]],
  'decision/state': [
    ['data.handle.id', ULID],
    ['data.request.subjectDigest', SHA256],
    ['data.answerCommand.digest', SHA256],
    ['data.consumption.effectId', EFFECT_ID],
    ['data.consumption.operationId', TOOL_ID],
    ['data.request.operationId', TOOL_ID],
    ['data.request.operationId', ULID],
    ['data.consumption.operationId', ULID],
    ['data.request.spec.key', ULID],
    ['data.answerCommand.commandId', UUID],
  ],
}

function preserveAt(source: unknown, target: unknown, path: string[], shape: RegExp): void {
  if (source === null || target === null || typeof source !== 'object' || typeof target !== 'object') return
  const [key, ...rest] = path
  if (!key) return
  if (key === '*') {
    if (Array.isArray(source) && Array.isArray(target))
      source.forEach((value, index) => {
        preserveAt(value, target[index], rest, shape)
      })
    return
  }
  const original = source as Record<string, unknown>
  const copy = target as Record<string, unknown>
  if (rest.length > 0) preserveAt(original[key], copy[key], rest, shape)
  else if (typeof original[key] === 'string' && shape.test(original[key])) copy[key] = original[key]
}

/** Redact content first, then retain only validated protocol metadata at known event paths. */
export function redactExportEvents(events: EventEnvelope[], rules: RedactRules): EventEnvelope[] {
  return events.map((event) => {
    if (!validateEvent(event).ok) throw new Error(`invalid export event at sequence ${event.seq}`)
    const copy = redact(event, rules)
    preserveAt(event, copy, ['id'], ULID)
    for (const [path, shape] of FIELDS[event.type] ?? []) preserveAt(event, copy, path.split('.'), shape)
    return copy
  })
}
