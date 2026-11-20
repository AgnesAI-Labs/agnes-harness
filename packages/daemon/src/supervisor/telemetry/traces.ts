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
// In the reduced form of a turn too large to send whole, a body over this size becomes a marker.
const EVENT_LIMIT = 16 * 1024

type Workspace = { cwd?: string; extraRoots?: readonly string[] }

/** Work a later daemon start must retry: the newest boundary queued while upload was on. */
export type QueuedTrace = {
  key: string
  seq: number
  /** When the enablement that queued it began; only rows committed since then belong to it. */
  since: number
  surface: Surface
  workspace: Workspace
}

type QueueRow = {
  session_key: string
  queued_seq: number
  enabled_since: number
  surface: Surface
  workspace: string
}

function queuedTrace(row: QueueRow): QueuedTrace {
  const { cwd, extraRoots } = record(JSON.parse(row.workspace))
  return {
    key: row.session_key,
    seq: row.queued_seq,
    since: row.enabled_since,
    surface: row.surface,
    workspace: {
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(Array.isArray(extraRoots)
        ? { extraRoots: extraRoots.filter((root) => typeof root === 'string') }
        : {}),
    },
  }
}

export function traceWatermarks(table: TableHandle) {
  table.exec(`CREATE TABLE IF NOT EXISTS trace_upload_watermarks (
    session_key TEXT PRIMARY KEY,
    last_acked_seq INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  // Rows leave this table once acknowledged, so it only ever holds unfinished uploads.
  table.exec(`CREATE TABLE IF NOT EXISTS trace_upload_queue (
    session_key TEXT PRIMARY KEY,
    queued_seq INTEGER NOT NULL,
    enabled_since INTEGER NOT NULL,
    surface TEXT NOT NULL,
    workspace TEXT NOT NULL,
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
      table.transaction(() => {
        table.exec(
          `INSERT INTO trace_upload_watermarks (session_key, last_acked_seq, updated_at)
          VALUES (?, ?, ?) ON CONFLICT(session_key) DO UPDATE
          SET last_acked_seq = excluded.last_acked_seq, updated_at = excluded.updated_at
          WHERE excluded.last_acked_seq > trace_upload_watermarks.last_acked_seq`,
          [key, seq, at],
        )
        table.exec('DELETE FROM trace_upload_queue WHERE session_key = ? AND queued_seq <= ?', [key, seq])
      })
    },
    dequeue(key: string, seq: number): void {
      table.exec('DELETE FROM trace_upload_queue WHERE session_key = ? AND queued_seq <= ?', [key, seq])
    },
    queued(key: string): QueuedTrace | undefined {
      const row = table.get<QueueRow>('SELECT * FROM trace_upload_queue WHERE session_key = ?', [key])
      return row && queuedTrace(row)
    },
    /** An entry left by an earlier enablement is kept until acknowledged: its time window differs. */
    queue(entry: QueuedTrace, at: string): void {
      table.exec(
        `INSERT INTO trace_upload_queue (session_key, queued_seq, enabled_since, surface, workspace, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_key) DO UPDATE
        SET queued_seq = MAX(trace_upload_queue.queued_seq, excluded.queued_seq), surface = excluded.surface,
          workspace = excluded.workspace, updated_at = excluded.updated_at
        WHERE trace_upload_queue.enabled_since = excluded.enabled_since`,
        [entry.key, entry.seq, entry.since, entry.surface, JSON.stringify(entry.workspace), at],
      )
    },
    outstanding(limit: number): QueuedTrace[] {
      return table
        .all<QueueRow>(
          `SELECT q.* FROM trace_upload_queue q
          LEFT JOIN trace_upload_watermarks w ON w.session_key = q.session_key
          WHERE q.queued_seq > COALESCE(w.last_acked_seq, 0)
          ORDER BY q.updated_at DESC, q.session_key LIMIT ?`,
          [limit],
        )
        .map(queuedTrace)
    },
    clearQueue(): void {
      table.exec('DELETE FROM trace_upload_queue')
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
  /** Start of the current enablement: a row committed earlier is never uploaded under it. */
  since: number
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

type Read = {
  scan: ScanRead<EventEnvelope>
  to: number
  clean: ReturnType<typeof traceRedaction>
  memoryPrivate: boolean
  signal: AbortSignal
  admit: (event: EventEnvelope) => boolean
  /** Elide large bodies and stop at the first complete turn: that turn cannot be sent whole. */
  reduce?: boolean
}

function cleanRow(read: Read, event: EventEnvelope, route: string | undefined) {
  let safe = read.clean.event(
    read.memoryPrivate ? privateProjection(event) : event,
    event.type === 'cost/ledger' ? route : undefined,
  )
  let size = Buffer.byteLength(JSON.stringify(safe.row)) + 1
  if (read.reduce && size > EVENT_LIMIT) {
    safe = { ...safe, row: { ...safe.row, data: `[omitted-oversized bytes=${size}]` } }
    size = Buffer.byteLength(JSON.stringify(safe.row)) + 1
  }
  return { safe, size }
}

/**
 * Walk only committed rows, leaving intersecting turns unacknowledged. Rows the enablement does not
 * admit still count toward turn boundaries, so a later range never re-reads them.
 */
async function readBatch(start: number, read: Read) {
  const events: CleanEvent[] = []
  const bounds: { seq: number; length: number; event: EventEnvelope }[] = []
  const open = new Set<string>()
  const routesByLane = new Map<string, string>()
  const totals = { count: 0, bytes: 0, overflow: false }
  const result = () => ({ events, bounds, ...totals })
  let sawCompleted = start > 1
  for (let cursor = start; cursor <= read.to; ) {
    read.signal.throwIfAborted()
    const page = await read.scan({ fromSeq: cursor, toSeq: read.to, limit: PAGE_SIZE })
    read.signal.throwIfAborted()
    if (!page.length) break
    for (const event of page) {
      if (event.seq !== cursor || event.seq > read.to) return result()
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
      if (read.admit(event)) {
        totals.count++
        // Past the budget a reduced read only measures what its omitted record reports.
        if (totals.overflow) totals.bytes += Buffer.byteLength(JSON.stringify(event.data ?? null))
        else {
          const { safe, size } = cleanRow(read, event, routesByLane.get(lane))
          totals.bytes += size
          totals.overflow = totals.bytes > RAW_LIMIT
          // A full-size read stops here; a reduced read keeps counting up to its turn's end.
          if (totals.overflow && !read.reduce) return result()
          if (!totals.overflow) events.push(safe)
        }
      }
      if (open.size === 0 && (event.type === 'turn/end' || (event.type === FEEDBACK && sawCompleted))) {
        bounds.push({ seq: event.seq, length: events.length, event })
        if (read.reduce) return result()
      }
    }
  }
  return result()
}

/** First seq in [low, high] committed at or after `since`, or high + 1; ledger time rises with seq. */
async function firstAt(scan: ScanRead<EventEnvelope>, low: number, high: number, since: number) {
  const committed = async (seq: number) => {
    const [row] = await scan({ fromSeq: seq, toSeq: seq, limit: 1 })
    return row !== undefined && Date.parse(row.ts) >= since
  }
  // The common case costs one read: the watermark sits right behind rows of this enablement.
  if (low > high || (await committed(low))) return low
  let end = high + 1
  for (low++; low < end; ) {
    const middle = Math.floor((low + end) / 2)
    if (await committed(middle)) end = middle
    else low = middle + 1
  }
  return low
}

/** Find by binary search, not a full read, the first row the enablement covering it admits. */
async function firstAdmitted(input: TraceInput, from: number, queued: QueuedTrace | undefined) {
  const { scan, session } = input
  if (queued && from <= queued.seq) {
    const through = Math.min(queued.seq, session.seq)
    const cut = await firstAt(scan, from, through, queued.since)
    if (cut <= through) return cut
    from = through + 1
  }
  return from > session.seq ? from : firstAt(scan, from, session.seq, input.since)
}

type Delivery = 'sent' | 'oversized' | 'failed'
type Batch = {
  from: number
  to: number
  rows: CleanEvent[]
}

async function traceContext(input: TraceInput) {
  const { scan, session, installId, runtime } = input
  const [start] = await scan({ type: 'session/start', order: 'desc', toSeq: session.seq, limit: 1 })
  const data = record(start?.data)
  if (
    !start ||
    data.key !== session.key ||
    data.memory === true ||
    session.key.startsWith('refinement:workspace')
  )
    return undefined
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
  return { clean, sessionId, context, headSeq: head?.seq ?? session.seq, memoryPrivate: !!memoryMarker }
}

type Context = NonNullable<Awaited<ReturnType<typeof traceContext>>>

async function deliver(input: TraceInput, trace: Context, batch: Batch): Promise<Delivery> {
  const { session, watermarks, installId, signal, clock } = input
  signal.throwIfAborted()
  const now = clock()
  const sent_at = new Date(now).toISOString()
  if (!batch.rows.length) {
    // Nothing in the range is admitted for upload; acknowledge it locally so it is never re-read.
    watermarks.acknowledge(session.key, batch.to, sent_at)
    return 'sent'
  }
  const body = JSON.stringify({
    ...trace.context,
    batch_id: telemetryId(now),
    sent_at,
    watermark: { from_seq: batch.from, to_seq: batch.to, session_head_seq: trace.headSeq },
    route_providers: Object.fromEntries(batch.rows.flatMap((event) => [...event.routes])),
    events: batch.rows.map((event) => event.row),
  })
  if (Buffer.byteLength(body) > RAW_LIMIT) return 'oversized'
  const compressed = new Uint8Array(await gzipAsync(body))
  signal.throwIfAborted()
  if (compressed.byteLength > GZIP_LIMIT) return 'oversized'
  const key = `${installId}:${trace.sessionId}:${batch.from}-${batch.to}`
  if (!(await postTelemetry(input.endpoint, '/v1/traces/batches', compressed, signal, key))) return 'failed'
  signal.throwIfAborted()
  watermarks.acknowledge(session.key, batch.to, sent_at)
  return 'sent'
}

/**
 * The first complete turn is over the batch limits on its own. Send it with large bodies replaced by
 * size markers, or as a single record of what was left out, so it can never stall later turns.
 */
async function deliverReduced(input: TraceInput, trace: Context, from: number, start: number, read: Read) {
  const reduced = await readBatch(start, { ...read, reduce: true })
  const [bound] = reduced.bounds
  if (!bound) return undefined
  const batch = { from, to: bound.seq }
  const outcome = reduced.overflow
    ? 'oversized'
    : await deliver(input, trace, { ...batch, rows: reduced.events.slice(0, bound.length) })
  if (outcome !== 'oversized') return outcome
  const omitted = trace.clean.event({
    ...bound.event,
    type: 'x/telemetry/omitted',
    origin: 'system',
    trust: 'trusted',
    data: { reason: 'size', from_seq: from, to_seq: bound.seq, events: reduced.count, bytes: reduced.bytes },
  } as EventEnvelope)
  return deliver(input, trace, { ...batch, rows: [omitted] })
}

/** Upload the session's committed range in complete turns; `failed` means retry it later. */
export async function uploadTrace(input: TraceInput): Promise<'done' | 'failed'> {
  const { session, watermarks, signal } = input
  signal.throwIfAborted()
  let from = watermarks.read(session.key) + 1
  if (from > session.seq) return 'done'
  const trace = await traceContext(input)
  if (!trace) return 'done'
  const queued = watermarks.queued(session.key)
  const read: Read = {
    scan: input.scan,
    to: session.seq,
    clean: trace.clean,
    memoryPrivate: trace.memoryPrivate,
    signal,
    // A row up to an earlier enablement's queued boundary belongs to that enablement's window.
    admit: (event) =>
      Date.parse(event.ts) >= (queued && event.seq <= queued.seq ? queued.since : input.since),
  }
  while (from <= session.seq) {
    const start = await firstAdmitted(input, from, queued)
    const { events, bounds, overflow } = await readBatch(start, read)
    if (!bounds.length && !overflow) return 'done'
    let outcome: Delivery = 'oversized'
    for (let boundary = bounds.length - 1; boundary >= 0 && outcome === 'oversized'; ) {
      const bound = bounds[boundary] as (typeof bounds)[number]
      outcome = await deliver(input, trace, { from, to: bound.seq, rows: events.slice(0, bound.length) })
      // Retry a smaller complete prefix, never splitting a single turn to satisfy the byte budget.
      boundary = Math.floor((boundary - 1) / 2)
    }
    if (outcome === 'oversized') {
      const reduced = await deliverReduced(input, trace, from, start, read)
      if (reduced === undefined) return 'done'
      outcome = reduced
    }
    const next = watermarks.read(session.key) + 1
    // Only an acknowledged range moves on; anything else is retried later, never looped on here.
    if (outcome !== 'sent' || next <= from) return 'failed'
    from = next
  }
  return 'done'
}
