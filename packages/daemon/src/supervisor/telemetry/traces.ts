import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import { memoryPrivateEvent } from '@agnes/extension-api'
import type { ScanRead } from '@agnes/host'
import type { ConfigAccount, EventEnvelope } from '@agnes/protocol'
import { traceRedaction } from './redaction.js'
import { postTelemetry, record, type Surface, telemetryId, type telemetryRuntime } from './wire.js'

const gzipAsync = promisify(gzip)
const RAW_LIMIT = 8 * 1024 * 1024
const GZIP_LIMIT = 4 * 1024 * 1024
const PAGE_SIZE = 20
const GROWTH = 'x/feedback/growth'
const FEEDBACK = 'x/feedback/item'

export function traceWatermarks(table: TableHandle) {
  table.exec(`CREATE TABLE IF NOT EXISTS trace_upload_watermarks (
    session_key TEXT PRIMARY KEY,
    last_acked_seq INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  return {
    read(key: string): number {
      return (
        table.get<{ last_acked_seq: number }>(
          'SELECT last_acked_seq FROM trace_upload_watermarks WHERE session_key = ?',
          [key],
        )?.last_acked_seq ?? 0
      )
    },
    acknowledge(key: string, seq: number, at: string): void {
      table.exec(
        `INSERT INTO trace_upload_watermarks (session_key, last_acked_seq, updated_at)
        VALUES (?, ?, ?) ON CONFLICT(session_key) DO UPDATE
        SET last_acked_seq = excluded.last_acked_seq, updated_at = excluded.updated_at
        WHERE excluded.last_acked_seq > trace_upload_watermarks.last_acked_seq`,
        [key, seq, at],
      )
    },
  }
}

export type TraceWatermarks = ReturnType<typeof traceWatermarks>
export type TraceSession = {
  key: string
  seq: number
  surface: Surface
  cwd?: string
  extraRoots?: readonly string[]
}

export type TraceInput = {
  session: TraceSession
  scan: ScanRead<EventEnvelope>
  watermarks: TraceWatermarks
  accounts: readonly ConfigAccount[]
  privatePaths: readonly string[]
  workspacePaths: readonly string[]
  credentialValues: readonly string[]
  installId: string
  endpoint: URL
  clock: () => number
  runtime: ReturnType<typeof telemetryRuntime>
  signal: AbortSignal
}

type CleanEvent = ReturnType<ReturnType<typeof traceRedaction>['event']>

function privateProjection(event: EventEnvelope): EventEnvelope {
  if (event.type === 'turn/start' || event.type === 'session/start') return event
  if (event.type === FEEDBACK) {
    const { note: _note, ...data } = record(event.data)
    return { ...event, data } as EventEnvelope
  }
  const projected = memoryPrivateEvent(event)
  const structural = record(projected.data)
  const data = record(event.data)
  if (event.type === 'request/sent') {
    const { id, route } = record(data.model)
    if (typeof id === 'string' && typeof route === 'string') structural.model = { id, route }
  }
  if (event.type === 'cost/ledger' && typeof data.route === 'string') structural.route = data.route
  return projected
}

/** Walk only committed rows, leaving intersecting turns and any oversized single turn unacknowledged. */
async function readBatch(
  scan: ScanRead<EventEnvelope>,
  from: number,
  to: number,
  clean: ReturnType<typeof traceRedaction>,
  memoryPrivate: boolean,
  signal: AbortSignal,
) {
  const events: CleanEvent[] = []
  const bounds: { seq: number; length: number }[] = []
  const open = new Set<string>()
  const routesByLane = new Map<string, string>()
  let sawCompleted = from > 1
  let eventBytes = 0
  for (let cursor = from; cursor <= to; ) {
    signal.throwIfAborted()
    const page = await scan({ fromSeq: cursor, toSeq: to, limit: PAGE_SIZE })
    signal.throwIfAborted()
    if (!page.length) break
    for (const event of page) {
      if (event.seq !== cursor || event.seq > to) return { events, bounds }
      cursor++
      if (event.type === GROWTH) continue
      const lane = event.lane ?? 'main'
      if (event.type === 'turn/start') open.add(lane)
      if (event.type === 'turn/end') {
        open.delete(lane)
        routesByLane.delete(lane)
        sawCompleted = true
      }
      if (event.type === 'request/sent') {
        const { route } = record(record(event.data).model)
        if (typeof route === 'string') routesByLane.set(lane, route)
      }
      const safe = clean.event(
        memoryPrivate ? privateProjection(event) : event,
        event.type === 'cost/ledger' ? routesByLane.get(lane) : undefined,
      )
      eventBytes += Buffer.byteLength(JSON.stringify(safe.row)) + 1
      if (eventBytes > RAW_LIMIT) return { events, bounds }
      events.push(safe)
      if (open.size === 0 && (event.type === 'turn/end' || (event.type === FEEDBACK && sawCompleted)))
        bounds.push({ seq: event.seq, length: events.length })
    }
  }
  return { events, bounds }
}

export async function uploadTrace(input: TraceInput): Promise<void> {
  const { scan, session, watermarks, installId, signal, clock, runtime } = input
  signal.throwIfAborted()
  let from = watermarks.read(session.key) + 1
  if (from > session.seq) return
  const [start] = await scan({ type: 'session/start', order: 'desc', toSeq: session.seq, limit: 1 })
  const data = record(start?.data)
  if (
    !start ||
    data.key !== session.key ||
    data.memory === true ||
    session.key.startsWith('refinement:workspace')
  )
    return
  const [head] = await scan({ order: 'desc', limit: 1 })
  const [memoryMarker] = await scan({ type: 'x/core/memory-private', toSeq: session.seq, limit: 1 })
  const parent = record(data.parent).key
  const delegation = record(data.delegation)
  const root = delegation.rootTaskId
  const clean = traceRedaction({
    ...input,
    sessionKeys: [
      session.key,
      ...(typeof parent === 'string' ? [parent] : []),
      ...(typeof root === 'string' ? [root] : []),
    ],
  })
  const sessionId = clean.sessionId(session.key)
  const context = {
    schema_version: 1,
    install_id: installId,
    app_version: runtime.app_version,
    os: runtime.os,
    arch: runtime.arch,
    surface: session.surface,
    session: {
      session_id: sessionId,
      parent_session_id: typeof parent === 'string' ? clean.sessionId(parent) : null,
      root_task_id: typeof root === 'string' ? clean.sessionId(root) : null,
      delegation_kind: delegation.kind === 'fork' || delegation.kind === 'spawn' ? delegation.kind : null,
      generation_depth: typeof delegation.generationDepth === 'number' ? delegation.generationDepth : 0,
      preset: typeof data.preset === 'string' ? clean.scrub(data.preset).slice(0, 128) : null,
      created_at: start.ts,
    },
  }
  while (from <= session.seq) {
    const { events, bounds } = await readBatch(scan, from, session.seq, clean, !!memoryMarker, signal)
    let boundary = bounds.length - 1
    let delivered = false
    while (boundary >= 0) {
      signal.throwIfAborted()
      const bound = bounds[boundary]
      if (!bound) return
      const { seq, length } = bound
      const rows = events.slice(0, length)
      const now = clock()
      const sent_at = new Date(now).toISOString()
      const body = JSON.stringify({
        ...context,
        batch_id: telemetryId(now),
        sent_at,
        watermark: { from_seq: from, to_seq: seq, session_head_seq: head?.seq ?? session.seq },
        route_providers: Object.fromEntries(rows.flatMap((event) => [...event.routes])),
        events: rows.map((event) => event.row),
      })
      if (Buffer.byteLength(body) <= RAW_LIMIT) {
        const compressed = new Uint8Array(await gzipAsync(body))
        signal.throwIfAborted()
        if (compressed.byteLength <= GZIP_LIMIT) {
          const key = `${installId}:${sessionId}:${from}-${seq}`
          if (!(await postTelemetry(input.endpoint, '/v1/traces/batches', compressed, signal, key))) return
          signal.throwIfAborted()
          watermarks.acknowledge(session.key, seq, sent_at)
          from = seq + 1
          delivered = true
          break
        }
      }
      // Retry a smaller complete prefix, never splitting a single turn to satisfy the byte budget.
      boundary = Math.floor((boundary - 1) / 2)
    }
    if (!delivered) return
  }
}
