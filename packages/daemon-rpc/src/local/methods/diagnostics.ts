import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { release } from 'node:os' // guards-allow-platform: diagnostics report
import { join } from 'node:path'
import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { Registry } from '@agnes/daemon-foundation/registry'
import { memoryPrivateEvent } from '@agnes/extension-api'
import { redactDetail } from '@agnes/host'
import { administerObservability, observabilityHome, readDiagnosticJournal } from '@agnes/observability'
import {
  type DiagnosticsCollectResult,
  type DiagnosticsEventsParams,
  type DiagnosticsEventsResult,
  type DiagnosticsExportParams,
  type DiagnosticsExportResult,
  type EventEnvelope,
  rpcError,
} from '@agnes/protocol'
import type { AdminObservabilityParams, AdminObservabilityResult } from '@agnes/protocol/gen/app-server'
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
  if (
    (record.type === 'image' || record.type === 'audio' || record.type === 'file') &&
    typeof record.data === 'string'
  )
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
    registry: Pick<Registry<SessionEntry>, 'require' | 'get'>
    sessionSnapshot?: (
      key: string,
    ) => { lastSeq: number; loop?: { id: string; version: string }; pluginGenerationId?: string } | undefined
    dataDir?: string
    home?: string
    profileHash?: string
    compositionHash?: string
    telemetry?: DiagnosticsExportResult['telemetry'] | (() => DiagnosticsExportResult['telemetry'])
    exporterHealth?: () => Promise<Pick<AdminObservabilityResult, 'workerHealth' | 'workerState'>>
    generations?: () => Promise<unknown> | unknown
    doctor?: () =>
      | Promise<readonly { name: string; status: string }[]>
      | readonly { name: string; status: string }[]
  },
): void {
  endpoint.register('_agnes/v1/admin.observability', async (params, c) => {
    localOwner(c)
    try {
      const result = await administerObservability(params as AdminObservabilityParams, deps.home)
      return { ...result, ...(deps.exporterHealth ? await deps.exporterHealth() : {}) }
    } catch {
      throw rpcError('INVALID_PARAMS', { reason: 'invalid observability settings' })
    }
  })
  endpoint.register('_agnes/v1/diagnostics.export', async (params, c): Promise<DiagnosticsExportResult> => {
    localOwner(c)
    const { sessionId, diagnosticId, limit = 100 } = params as DiagnosticsExportParams
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    let session: DiagnosticsExportResult['session']
    if (sessionId) {
      deps.requireSessionOwner('diagnostics.export', sessionId, c)
      const found = deps.registry.get(sessionId)?.session ?? deps.sessionSnapshot?.(sessionId)
      if (!found) throw rpcError('SESSION_NOT_FOUND', { sessionId })
      session = {
        idHash: hash(sessionId),
        lastSeq: found.lastSeq,
        ...(found.loop ? { loopIdHash: hash(found.loop.id), loopVersionHash: hash(found.loop.version) } : {}),
        ...(found.pluginGenerationId ? { generationIdHash: hash(found.pluginGenerationId) } : {}),
      }
    }
    const audit: DiagnosticsExportResult['audit'] = []
    for (const name of LOGS) {
      const log = await readTail(deps.dataDir, name)
      for (const line of log.text.split('\n')) {
        try {
          const row = JSON.parse(line) as {
            at?: string
            kind?: string
            detail?: { diagnosticId?: string; traceId?: string; spanId?: string }
          }
          if (
            !row.at ||
            !Number.isFinite(Date.parse(row.at)) ||
            !row.kind ||
            ![
              'daemon.request_failed',
              'plugin.tree.reverted',
              'profile.resolved',
              'host.ready',
              'host.closed',
              'host.teardown_finished',
              'session.recovered',
              'startup.failed',
              'secret.resolved',
              'extension.service-call',
            ].includes(row.kind)
          )
            continue
          const d = row.detail
          audit.push({
            at: new Date(row.at).toISOString(),
            kind: row.kind,
            ...(d?.diagnosticId && /^[a-f0-9-]{36}$/.test(d.diagnosticId)
              ? { diagnosticId: d.diagnosticId }
              : {}),
            ...(d?.traceId && /^[a-f0-9]{32}$/.test(d.traceId) ? { traceId: d.traceId } : {}),
            ...(d?.spanId && /^[a-f0-9]{16}$/.test(d.spanId) ? { spanId: d.spanId } : {}),
          })
        } catch {
          /* Arbitrary audit values and unparseable bytes never enter an issue bundle. */
        }
      }
    }
    audit.sort((a, b) => a.at.localeCompare(b.at))
    let generations: DiagnosticsExportResult['generations'] = { available: false, current: null, items: [] }
    try {
      const value = (await deps.generations?.()) as
        | {
            currentGenerationId?: string
            generations?: Array<{ id: string; state: string; boundSessions: number }>
          }
        | undefined
      if (value && Array.isArray(value.generations))
        generations = {
          available: true,
          current: value.currentGenerationId ? hash(value.currentGenerationId) : null,
          items: value.generations
            .slice(0, 512)
            .filter(
              (row) =>
                typeof row.id === 'string' &&
                ['active', 'draining', 'failed'].includes(row.state) &&
                Number.isInteger(row.boundSessions) &&
                row.boundSessions >= 0,
            )
            .map((row) => ({
              idHash: hash(row.id),
              state: row.state as 'active' | 'draining' | 'failed',
              boundSessions: row.boundSessions,
            })),
        }
    } catch {
      /* An unavailable worker remains explicit; exporting does not start or replace it. */
    }
    const sections = (await deps.doctor?.()) ?? [
      { name: 'daemon', status: 'ok' },
      { name: 'worker', status: 'unavailable' },
    ]
    return {
      schemaVersion: 1,
      ...(deps.telemetry
        ? { telemetry: typeof deps.telemetry === 'function' ? deps.telemetry() : deps.telemetry }
        : {}),
      collectedAt: new Date(c.clock()).toISOString(),
      agh: { version: typeof AGNES_VERSION === 'string' ? AGNES_VERSION : 'dev' },
      runtime: {
        platform: process.platform, // guards-allow-platform: diagnostics report
        arch: process.arch, // guards-allow-platform: diagnostics report
        osRelease: release(),
        node: process.versions.node,
        pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
      }, // guards-allow-platform: diagnostics report
      profile: {
        hash: deps.profileHash ?? hash('unavailable'),
        ...(deps.compositionHash ? { compositionHash: deps.compositionHash } : {}),
      },
      generations,
      doctor: sections
        .filter((row) =>
          ['daemon', 'worker', 'lock', 'socket', 'leases', 'jobs', 'sandbox', 'storage'].includes(row.name),
        )
        .map((row) => ({
          name: row.name,
          status: (['ok', 'warn', 'fail'].includes(row.status) ? row.status : 'unavailable') as
            | 'ok'
            | 'warn'
            | 'fail'
            | 'unavailable',
        })),
      errors: readDiagnosticJournal(deps.home ?? observabilityHome(), diagnosticId ? 1 : 4096, diagnosticId),
      audit: audit.slice(-limit),
      ...(session ? { session } : {}),
      limits: { audit: limit, errors: diagnosticId ? 1 : 4096 },
    }
  })

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
          platform: process.platform, // guards-allow-platform: diagnostics report // guards-allow-platform: diagnostics report
          arch: process.arch, // guards-allow-platform: diagnostics report // guards-allow-platform: diagnostics report
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
    const memoryPrivate = (await session.scan({ type: 'x/core/memory-private', limit: 1 })).length > 0
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
      const { _meta: _dropped, ...event } = sanitize(
        memoryPrivate ? memoryPrivateEvent(row) : row,
      ) as EventEnvelope & { _meta?: unknown }
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
}
