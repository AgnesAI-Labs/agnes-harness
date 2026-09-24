import { type EventEnvelope, type JsonValue, validateEvent } from '@agnes/protocol'
import { detectSource } from './detect.js'
import { EnvelopeBuilder } from './envelope.js'
import { importClaudeCode, readClaudeCodeHeader } from './import/claude-code.js'
import { importCodex, readCodexHeader } from './import/codex.js'
import { importPi, readPiHeader } from './import/pi.js'
import { type JsonlRow, parseJsonl, Tolerance } from './tolerance.js'
import { ImportError, type ImportOptions, type ImportResult, type ImportSource } from './types.js'

const IMPORTERS = {
  'claude-code': { header: readClaudeCodeHeader, run: importClaudeCode },
  codex: { header: readCodexHeader, run: importCodex },
  pi: { header: readPiHeader, run: importPi },
} as const

const isCliResult = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && (value as { v?: unknown }).v === 'agnes-cli-result/v1'

function passThroughAgnes(rows: JsonlRow[], report: Tolerance): EventEnvelope[] {
  const events: EventEnvelope[] = []
  let previousSeq = 0
  for (const { line, value } of rows) {
    if (isCliResult(value)) {
      report.unsupported('cli-result')
      continue
    }
    const result = validateEvent(value)
    if (!result.ok) {
      report.skip(line, `invalid agnes event: ${result.errors[0]?.message ?? 'unknown'}`)
      continue
    }
    if (result.value.seq !== previousSeq + 1) {
      report.skip(line, `agnes sequence ${result.value.seq} does not follow ${previousSeq}`)
      continue
    }
    if (result.value.type === 'session/start' && events.length > 0) {
      report.skip(line, 'duplicate session/start')
      continue
    }
    previousSeq = result.value.seq
    events.push(result.value)
  }
  if (events[0]?.type !== 'session/start')
    throw new ImportError('E_IMPORT_NO_HEADER', 'agnes stream has no valid session/start')
  return events
}

function boundedRaw(data: JsonValue): { raw: JsonValue | string; truncated?: true } {
  const encoded = JSON.stringify(data)
  if (encoded.length <= 65_536) return { raw: data }
  return { raw: encoded.slice(0, 65_536), truncated: true }
}

function downgrade(event: EventEnvelope, errors: unknown[]): EventEnvelope {
  return {
    ...event,
    type: 'x/agnes/import/unmapped',
    ignorable: true,
    data: {
      originalType: event.type,
      ...boundedRaw(event.data),
      errors: errors.slice(0, 3) as JsonValue,
    },
  }
}

export function importSession(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
  const tolerance = new Tolerance()
  const rows = parseJsonl(bytes, tolerance)
  const detected =
    options.from === undefined || options.from === 'auto'
      ? detectSource(rows.map(({ value }) => value))
      : options.from
  if (detected === 'unknown')
    throw new ImportError('E_IMPORT_UNKNOWN_FORMAT', 'no known session header in the first 20 rows')
  if (detected === 'cli-result')
    throw new ImportError('E_IMPORT_NO_HEADER', 'stream contains only a CLI result, not a session')
  if (detected === 'agnes') {
    const events = passThroughAgnes(rows, tolerance)
    return { events, report: tolerance.finish('agnes', events.length) }
  }

  const source: ImportSource = detected
  const importer = IMPORTERS[source]
  const header = importer.header(rows)
  if (!header) throw new ImportError('E_IMPORT_NO_HEADER', `${source}: no valid session header`)
  const builder = new EnvelopeBuilder({
    source,
    sessionKey: options.sessionKey ?? `agnes:local:default:import:dm:${header.sourceId}`.slice(0, 512),
    now: options.now ?? (() => Date.now()),
    rng: options.rng ?? Math.random,
    agnesVersion: options.agnesVersion ?? '0.0.0',
  })
  builder.start({ sourceId: header.sourceId, cwd: header.cwd })
  importer.run(rows, builder, tolerance)
  for (const repair of tolerance.repairs())
    builder.ext('repair', { sourceSeq: repair.seq, reason: repair.reason })

  const events = builder.finish().map((event) => {
    const checked = validateEvent(event)
    if (checked.ok) return checked.value
    tolerance.unsupported(`invalid:${event.type}`)
    const replacement = downgrade(event, checked.errors)
    const replacementCheck = validateEvent(replacement)
    if (!replacementCheck.ok) throw new Error(`internal import fallback is invalid at seq ${event.seq}`)
    return replacementCheck.value
  })
  return { events, report: tolerance.finish(source, events.length) }
}
