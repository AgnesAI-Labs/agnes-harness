import {
  EVENT_NAME_PATTERN,
  EXTENSION_ID_PATTERN,
  extEventType,
  type OwnerLedgerPage,
  type OwnerLedgerPort,
  type OwnerLedgerQuery,
  ProviderError,
} from '@agnes/extension-api'
import { type EventEnvelope, inspectJsonData, type JsonValue } from '@agnes/protocol'

const PAGE_BUDGET = 262144
const LIMIT_MAX = 256

export interface LedgerEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
  readonly lane?: string
  readonly origin?: string
  readonly trust?: string
}

/** Session I/O supplied by the host. This module only filters and refuses. */
export interface OwnerLedgerSource {
  scan(fromSeq: number, toSeq: number, lane: string): AsyncIterable<readonly LedgerEvent[]>
  append(type: string, data: JsonValue, sourceSeq?: number): Promise<number>
  alive(): void
  readonly boundarySeq: number
  readonly lane: string
}

interface Cursor {
  readonly v: 1
  readonly owner: string
  readonly lane: string
  readonly names: readonly string[]
  readonly watermark: number
  readonly after: number
}

function invalid(kind: string, operation: string, message: string): ProviderError {
  return new ProviderError('E_PROVIDER_INVALID', message, { kind, operation })
}

/** Payload owner is not a fact. Acceptance uses origin, trust, lane, namespace, and the watermark. */
function acceptRow(
  row: LedgerEvent,
  owner: string,
  fullNames: ReadonlySet<string>,
  lane: string,
  fromSeq: number,
  toSeq: number,
): boolean {
  if (row.seq < fromSeq || row.seq > toSeq) return false
  if (row.lane !== lane) return false
  if (row.origin !== `ext:${owner}`) return false
  if (row.trust !== 'untrusted') return false
  return fullNames.has(row.type)
}

function byteSize(row: LedgerEvent): number {
  const encoded = JSON.stringify(row.data)
  if (typeof encoded !== 'string') throw new Error('event is not JSON')
  return Buffer.byteLength(encoded)
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(kind: string, value: string): Cursor {
  let parsed: unknown
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8')
    parsed = JSON.parse(text)
  } catch {
    throw invalid(kind, 'scan', 'event cursor is invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw invalid(kind, 'scan', 'event cursor is invalid')
  const row = parsed as Record<string, unknown>
  if (
    row.v !== 1 ||
    typeof row.owner !== 'string' ||
    typeof row.lane !== 'string' ||
    !Array.isArray(row.names) ||
    row.names.some((name) => typeof name !== 'string') ||
    !Number.isSafeInteger(row.watermark) ||
    !Number.isSafeInteger(row.after)
  )
    throw invalid(kind, 'scan', 'event cursor is invalid')
  return {
    v: 1,
    owner: row.owner,
    lane: row.lane,
    names: row.names as string[],
    watermark: row.watermark as number,
    after: row.after as number,
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

export function createOwnerLedger(options: {
  kind: string
  owner: string
  eventNames: readonly string[]
  watermark: number
  source: OwnerLedgerSource
}): OwnerLedgerPort {
  const { kind, owner, source } = options
  if (!EXTENSION_ID_PATTERN.test(owner)) throw invalid(kind, 'bind', 'invalid service owner')
  const relative = new Map<string, string>()
  for (const name of options.eventNames) {
    if (!EVENT_NAME_PATTERN.test(name) || relative.has(name))
      throw invalid(kind, 'bind', 'invalid service event name')
    relative.set(name, extEventType(owner, name))
  }
  let watermark = options.watermark
  if (!Number.isSafeInteger(watermark) || watermark < 0)
    throw invalid(kind, 'bind', 'invalid service watermark')

  return Object.freeze({
    async scanOwn(query: OwnerLedgerQuery): Promise<OwnerLedgerPage> {
      source.alive()
      if (!query || !Array.isArray(query.names) || query.names.length === 0 || query.names.length > LIMIT_MAX)
        throw invalid(kind, 'scan', 'undeclared event name')
      const names = [...query.names]
      if (names.some((name) => typeof name !== 'string' || !relative.has(name)))
        throw invalid(kind, 'scan', 'undeclared event name')
      if (new Set(names).size !== names.length) throw invalid(kind, 'scan', 'undeclared event name')
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > LIMIT_MAX)
        throw invalid(kind, 'scan', 'event page limit is invalid')
      const asOfSeq = query.asOfSeq === undefined ? watermark : query.asOfSeq
      if (!Number.isSafeInteger(asOfSeq) || asOfSeq < 0 || asOfSeq > watermark)
        throw invalid(kind, 'scan', 'event watermark was exceeded')
      if (asOfSeq < 1) {
        if (watermark !== 0) throw invalid(kind, 'scan', 'event watermark was exceeded')
        source.alive()
        return Object.freeze({ events: Object.freeze([]), asOfSeq })
      }
      const sorted = [...names].sort()
      const requested = new Set(names.map((name) => relative.get(name) as string))
      let after = source.boundarySeq
      if (query.cursor !== undefined) {
        if (typeof query.cursor !== 'string' || query.cursor.length === 0)
          throw invalid(kind, 'scan', 'event cursor is invalid')
        const cursor = decodeCursor(kind, query.cursor)
        if (
          cursor.owner !== owner ||
          cursor.lane !== source.lane ||
          cursor.watermark !== watermark ||
          !sameNames(cursor.names, sorted) ||
          cursor.after < source.boundarySeq
        )
          throw invalid(kind, 'scan', 'event cursor does not match this binding')
        after = cursor.after
      }
      const fromSeq = after + 1
      const accepted: LedgerEvent[] = []
      let lastAccepted = after
      if (fromSeq <= asOfSeq) {
        let bytes = 0
        for await (const page of source.scan(fromSeq, asOfSeq, source.lane)) {
          source.alive()
          for (const row of page) {
            if (!acceptRow(row, owner, requested, source.lane, fromSeq, asOfSeq)) continue
            if (row.seq <= lastAccepted) throw invalid(kind, 'scan', 'event page is unordered')
            lastAccepted = row.seq
            let size: number
            try {
              size = byteSize(row)
            } catch {
              throw invalid(kind, 'scan', 'event page exceeds the byte budget')
            }
            if (size > PAGE_BUDGET || (bytes + size > PAGE_BUDGET && accepted.length === 0))
              throw invalid(kind, 'scan', 'event page exceeds the byte budget')
            if (accepted.length === query.limit || bytes + size > PAGE_BUDGET) {
              source.alive()
              const last = accepted[accepted.length - 1]
              if (!last) throw invalid(kind, 'scan', 'event page exceeds the byte budget')
              return Object.freeze({
                events: Object.freeze(accepted.map((event) => event as EventEnvelope)),
                asOfSeq,
                nextCursor: encodeCursor({
                  v: 1,
                  owner,
                  lane: source.lane,
                  names: sorted,
                  watermark,
                  after: last.seq,
                }),
              })
            }
            accepted.push(row)
            bytes += size
          }
        }
      }
      source.alive()
      return Object.freeze({
        events: Object.freeze(accepted.map((event) => event as EventEnvelope)),
        asOfSeq,
      })
    },
    async appendOwn(name: string, data: JsonValue, sourceSeq?: number): Promise<number> {
      source.alive()
      const type = relative.get(name)
      if (!type) throw invalid(kind, 'append', 'undeclared event name')
      const checked = inspectJsonData(data, 65536)
      if (!checked.ok) throw invalid(kind, 'append', 'invalid event JSON payload')
      if (sourceSeq !== undefined && (!Number.isSafeInteger(sourceSeq) || sourceSeq <= 0))
        throw invalid(kind, 'append', 'invalid event source')
      source.alive()
      const seq = await source.append(type, checked.value, sourceSeq)
      if (seq > watermark) watermark = seq
      return seq
    },
  })
}
