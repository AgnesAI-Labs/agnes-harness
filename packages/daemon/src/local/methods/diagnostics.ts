import { open } from 'node:fs/promises'
import { release } from 'node:os' // guards-allow-platform: diagnostics report
import { join } from 'node:path'
import { accountComparisonLane, redactDetail } from '@agnes/host'
import {
  type DiagnosticsCollectResult,
  type DiagnosticsEventsParams,
  type DiagnosticsEventsResult,
  type EventEnvelope,
  rpcError,
  type SessionAccountingParams,
  type SessionAccountingResult,
} from '@agnes/protocol'
import type { Registry } from '../../registry.js'
import type { CallContext, LocalEndpoint } from '../endpoint.js'
import type { SessionEntry } from '../sessions.js'

// Injected into the daemon bundle by cli/tools/build-local.ts and sea/build.mjs; absent from source runs.
declare const AGNES_VERSION: string | undefined

const TAIL_BYTES = 1024 * 1024
const LOGS = ['daemon.jsonl', 'host.jsonl'] as const
type Log = DiagnosticsCollectResult['logs'][number]

// Same semantics as cli/src/commands/export.ts sanitizeExportValue; the daemon does not depend on cli.
function sanitize(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[OMITTED:binary:${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.map(sanitize)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ((record.type === 'image' || record.type === 'audio') && typeof record.data === 'string')
    return { ...record, data: `[OMITTED:${record.type}:base64]` }
  if (record.type === 'base64' && typeof record.data === 'string')
    return { ...record, data: '[OMITTED:binary:base64]' }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, sanitize(child)]))
}

function localOwner(c: CallContext): void {
  if (c.conn.authKind !== 'local' || c.conn.credentialKind !== 'local')
    throw rpcError('CAPABILITY_DENIED', { reason: 'local owner required' })
}

function redactLine(line: string): string {
  try {
    const row = JSON.parse(line) as unknown
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('not a row')
    const record = row as Record<string, unknown>
    return JSON.stringify({
      ...record,
      detail: redactDetail(record.detail as Record<string, unknown> | undefined),
    })
  } catch {
    return JSON.stringify({ at: null, kind: 'unparseable' })
  }
}

async function readTail(dataDir: string | undefined, name: Log['name']): Promise<Log> {
  const missing: Log = { name, size: 0, text: '', truncated: false, missing: true }
  if (dataDir === undefined) return missing
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(join(dataDir, 'audit', name), 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing
    throw error
  }
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    let text = buf.subarray(0, bytesRead).toString('utf8')
    // A tail that starts mid-file starts mid-line: drop everything up to the first newline.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1 || text.length)
    const lines = text.split('\n').filter((line) => line.length > 0)
    return { name, size, text: lines.map(redactLine).join('\n'), truncated: start > 0, missing: false }
  } finally {
    await fh.close()
  }
}

export function registerDiagnostics(
  endpoint: LocalEndpoint,
  deps: {
    requireSessionOwner: (method: string, sessionId: string, c: CallContext) => void
    registry: Pick<Registry<SessionEntry>, 'require'>
    dataDir?: string
  },
): void {
  endpoint.register(
    '_agnes/v1/diagnostics.collect',
    async (_params, c): Promise<DiagnosticsCollectResult> => {
      localOwner(c)
      const logs: Log[] = []
      for (const name of LOGS) logs.push(await readTail(deps.dataDir, name))
      return {
        collectedAt: new Date(c.clock()).toISOString(),
        agh: { version: typeof AGNES_VERSION === 'string' ? AGNES_VERSION : 'dev' },
        runtime: {
          platform: process.platform, // guards-allow-platform: diagnostics report
          arch: process.arch, // guards-allow-platform: diagnostics report
          osRelease: release(), // guards-allow-platform: diagnostics report
          node: process.versions.node,
          pid: process.pid,
          uptimeMs: Math.round(process.uptime() * 1000),
        },
        logs,
      }
    },
  )

  endpoint.register('_agnes/v1/diagnostics.events', async (params, c): Promise<DiagnosticsEventsResult> => {
    const { sessionId, afterSeq, limit, maxBytes } = params as DiagnosticsEventsParams
    localOwner(c)
    deps.requireSessionOwner('diagnostics.events', sessionId, c)
    const { session } = deps.registry.require(sessionId)
    // Snapshot first, as session.attach does: rows appended after this cut belong to a later export.
    const lastSeq = session.lastSeq
    const rows = (await session.scan({ fromSeq: afterSeq + 1, limit })) as readonly EventEnvelope[]
    const events: EventEnvelope[] = []
    let cursor = afterSeq
    let bytes = 0
    // More may follow only when this page was full or cut by bytes, and never past the snapshot.
    let more = rows.length === limit
    for (const row of rows) {
      if (row.seq > lastSeq) {
        more = false
        break
      }
      const { _meta: _dropped, ...event } = sanitize(row) as EventEnvelope & { _meta?: unknown }
      const size = Buffer.byteLength(JSON.stringify(event))
      if (events.length > 0 && bytes + size > maxBytes) {
        more = true
        break
      }
      bytes += size
      events.push(event)
      cursor = row.seq
    }
    return { events, lastSeq, nextAfterSeq: more && cursor < lastSeq ? cursor : null }
  })

  endpoint.register('_agnes/v1/session.accounting', async (params, c): Promise<SessionAccountingResult> => {
    const { sessionId } = params as SessionAccountingParams
    localOwner(c)
    deps.requireSessionOwner('session.accounting', sessionId, c)
    const { session } = deps.registry.require(sessionId)
    const throughSeq = session.lastSeq
    const events: EventEnvelope[] = []
    let next = 1
    let bytes = 0
    let complete = true
    // Identical per-root limits to comparison accounting. A limit or gap degrades coverage;
    // it can never turn an unknown provider amount into zero or a known total.
    while (next <= throughSeq) {
      if (events.length >= 100_000 || bytes >= 16 * 1024 * 1024) {
        complete = false
        break
      }
      const page = (await session.scan({
        fromSeq: next,
        toSeq: throughSeq,
        order: 'asc',
        limit: Math.min(128, throughSeq - next + 1),
      })) as EventEnvelope[]
      if (page.length === 0) {
        complete = false
        break
      }
      for (const event of page) {
        const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
        if (event.seq !== next || events.length >= 100_000 || bytes + size > 16 * 1024 * 1024) {
          complete = false
          break
        }
        events.push(event)
        bytes += size
        next++
      }
      if (!complete) break
    }
    return {
      sessionId,
      runtime: session.runtimeIdentity,
      accounting: accountComparisonLane({
        sessionId,
        runtime: session.runtimeIdentity,
        events,
        afterSeq: 0,
        throughSeq,
        complete,
      }),
    }
  })
}
