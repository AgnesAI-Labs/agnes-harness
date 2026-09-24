import type {
  ApisListResult,
  DiagnosticsCollectResult,
  DiagnosticsEventsResult,
  EventEnvelope,
  UITimeline,
} from '@agnes/protocol'
import {
  type BrowserLog,
  buildZip,
  type DiagnosticsArtifact,
  type DiagnosticsBundle,
  type DiagnosticsInclude,
  type DiagnosticsWarning,
  type LogTail,
  renderDiagnosticsViewer,
  type ZipEntry,
} from '@agnes/web-units'
import { redactDiagnostic, redactDiagnosticText } from './diagnostics-redact.js'

export type RpcCall = (method: string, params: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>
export type CollectInput = {
  call: RpcCall
  sessionId: string | null
  sessionTitle: string | null
  projection: UITimeline | undefined
  browserLog: BrowserLog
  browser: Record<string, unknown>
  now: Date
}
export type CollectedDiagnostics = { bundle: DiagnosticsBundle; fileName: string; zip: Uint8Array }

export const DIAGNOSTICS_LIMITS = {
  zipBytes: 64 * 1024 * 1024,
  entries: 1000,
  ledgerBytes: 32 * 1024 * 1024,
  pageBytes: 1024 * 1024,
  rpcMs: 15_000,
  totalMs: 60_000,
}

const PREFIX = '_agnes/v1/'
// JSON-RPC METHOD_NOT_FOUND (old daemon / unregistered handler) and agnes SESSION_NOT_FOUND. The SDK
// surfaces both as JsonRpcError with a numeric `code` and the symbolic name in `data.code`.
const UNAVAILABLE = new Set<unknown>([
  -32601,
  -32003,
  'METHOD_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'NOT_REGISTERED',
])
const ARTIFACT_URI = /^artifact:\/\/([0-9a-f]{64})$/
const encoder = new TextEncoder()

const abortError = () => new DOMException('Aborted', 'AbortError')

// Same semantics as cli/src/commands/export.ts sanitizeExportValue (and the daemon's copy that
// already cleans events.jsonl): the UI projection's user nodes are a structuredClone of message
// content and can carry inline base64 media. Returns a copy; the live projection is not touched.
function omitInlineMedia(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[OMITTED:binary:${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.map(omitInlineMedia)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ((record.type === 'image' || record.type === 'audio') && typeof record.data === 'string')
    return { ...record, data: `[OMITTED:${record.type}:base64]` }
  if (record.type === 'base64' && typeof record.data === 'string')
    return { ...record, data: '[OMITTED:binary:base64]' }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, omitInlineMedia(child)]))
}

export function diagnosticsFileName(sessionId: string | null, now: Date): string {
  // agh session ids are namespaced (e.g. agnes:local:local-dev:cli:session:<uuid>); only the part
  // after the last ':' is meaningful for a short file-name id (spec §5).
  const tail = sessionId?.split(':').at(-1) ?? ''
  const id = tail.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'application'
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `agh-diagnostics-${id}-${stamp}.zip`
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  const either = AbortSignal.any([signal, AbortSignal.timeout(ms)])
  return new Promise<T>((resolve, reject) => {
    const stop = () =>
      reject(signal.aborted ? abortError() : new DOMException(`timed out after ${ms} ms`, 'TimeoutError'))
    if (either.aborted) return stop()
    either.addEventListener('abort', stop, { once: true })
    promise.then(resolve, reject).finally(() => either.removeEventListener('abort', stop))
  })
}

function warnFor(source: string, error: unknown): DiagnosticsWarning {
  const e = (error ?? {}) as { name?: unknown; code?: unknown; data?: { code?: unknown }; message?: unknown }
  if (e.name === 'TimeoutError' || e.name === 'RequestTimeout') return { source, reason: 'timeout' }
  if (UNAVAILABLE.has(e.code) || UNAVAILABLE.has(e.data?.code)) return { source, reason: 'unavailable' }
  const detail = redactDiagnosticText(String(e.message ?? error)).slice(0, 500)
  return { source, reason: 'failed', detail }
}

/** Adds the event's artifact references to `found`, keyed by (lane, sha256); the first seq wins. */
function collectArtifacts(event: EventEnvelope, found: Map<string, DiagnosticsArtifact>): void {
  const add = (item: Omit<DiagnosticsArtifact, 'lane' | 'seq'>) => {
    const lane = event.lane ?? 'main'
    const key = `${lane}|${item.sha256}`
    if (!found.has(key)) found.set(key, { ...item, lane, seq: event.seq })
  }
  const data = event.data as { media?: { manifest?: unknown }; content?: unknown } | null
  if (event.type === 'request/header' && Array.isArray(data?.media?.manifest)) {
    for (const entry of data.media.manifest as Record<string, unknown>[]) {
      if (typeof entry?.sha256 !== 'string' || typeof entry.mime !== 'string') continue
      add({
        sha256: entry.sha256,
        mime: entry.mime,
        source: 'request-media',
        ...(typeof entry.artifactUri === 'string' ? { uri: entry.artifactUri } : {}),
      })
    }
  }
  if (event.type === 'tool/result' && Array.isArray(data?.content)) {
    for (const block of data.content as Record<string, unknown>[]) {
      const match =
        block?.type === 'resource_link' && typeof block.uri === 'string' && ARTIFACT_URI.exec(block.uri)
      if (!match) continue
      const mime = typeof block.mimeType === 'string' ? block.mimeType : ''
      add({ sha256: match[1] as string, mime, source: 'tool-result', uri: block.uri as string })
    }
  }
}

export async function collectDiagnostics(
  input: CollectInput,
  include: DiagnosticsInclude,
  signal: AbortSignal,
  overrides: Partial<typeof DIAGNOSTICS_LIMITS> = {},
): Promise<CollectedDiagnostics> {
  const limits = { ...DIAGNOSTICS_LIMITS, ...overrides }
  if (signal.aborted) throw abortError()
  const total = AbortSignal.timeout(limits.totalMs)
  const combined = AbortSignal.any([signal, total])
  const warnings: DiagnosticsWarning[] = []
  let expired = false
  // A failed item becomes a warning and `undefined`; only the user's own abort rejects the export.
  const rpc = async <T>(method: string, params: unknown, quiet = false): Promise<T | undefined> => {
    if (expired) return undefined
    try {
      return (await withTimeout(
        input.call(PREFIX + method, params, { signal: combined }),
        limits.rpcMs,
        combined,
      )) as T
    } catch (error) {
      if (signal.aborted) throw abortError()
      if (total.aborted) expired = true
      else if (!quiet) warnings.push(warnFor(method, error))
      return undefined
    }
  }

  const sessionId = input.sessionId
  const effective = { ...include, conversation: include.conversation && sessionId !== null }
  const [collected, apis, config] = await Promise.all([
    // Always read for bundle.version, but a failure only matters when logs or system were selected.
    rpc<DiagnosticsCollectResult>('diagnostics.collect', {}, !(effective.logs || effective.system)),
    effective.system ? rpc<ApisListResult>('apis.list', {}) : undefined,
    effective.system ? rpc<unknown>('config.get', {}) : undefined,
  ])

  const lines: string[] = []
  const artifacts = new Map<string, DiagnosticsArtifact>()
  let ledger: DiagnosticsBundle['events']
  if (effective.conversation && sessionId !== null) {
    let afterSeq = 0
    let bytes = 0
    let truncated = false
    let read = false
    for (;;) {
      const from = afterSeq
      const page = await rpc<DiagnosticsEventsResult>('diagnostics.events', {
        sessionId,
        afterSeq,
        limit: 500,
        maxBytes: limits.pageBytes,
      })
      if (!page) {
        truncated = read
        break
      }
      read = true
      for (const event of page.events) {
        const line = JSON.stringify(redactDiagnostic(event))
        bytes += encoder.encode(line).byteLength + 1
        if (bytes > limits.ledgerBytes) {
          truncated = true
          break
        }
        lines.push(line)
        collectArtifacts(event, artifacts)
        afterSeq = event.seq
      }
      // A cursor that fails to advance would page forever; keep what was read.
      if (page.nextAfterSeq !== null && page.nextAfterSeq <= from) truncated = true
      if (truncated) {
        warnings.push({ source: 'diagnostics.events', reason: 'truncated' })
        break
      }
      afterSeq = page.nextAfterSeq ?? page.lastSeq
      if (page.nextAfterSeq === null) break
    }
    if (read) ledger = { file: 'events.jsonl', count: lines.length, lastSeq: afterSeq, truncated }
  }
  if (effective.conversation && !input.projection) warnings.push({ source: 'trace', reason: 'unavailable' })
  if (expired) warnings.push({ source: 'collect', reason: 'timeout' })
  if (signal.aborted) throw abortError()

  const tailOf = (name: string): LogTail | undefined => {
    const log = collected?.logs.find((l) => l.name === name)
    return log && { size: log.size, text: log.text, truncated: log.truncated, missing: log.missing }
  }
  const daemonLog = tailOf('daemon.jsonl')
  const hostLog = tailOf('host.jsonl')
  const missingLogs = [daemonLog?.missing && 'daemon.jsonl', hostLog?.missing && 'host.jsonl'].filter(Boolean)
  if (effective.logs && missingLogs.length)
    warnings.push({ source: 'logs', reason: 'unavailable', detail: missingLogs.join(', ') })
  const bundle: DiagnosticsBundle = redactDiagnostic({
    bundleVersion: 1,
    createdAt: input.now.toISOString(),
    product: 'agh',
    version: collected?.agh.version ?? 'unknown',
    sessionId,
    sessionTitle: input.sessionTitle,
    include: effective,
    ...(effective.conversation && input.projection
      ? { trace: omitInlineMedia(input.projection) as UITimeline }
      : {}),
    ...(ledger ? { events: ledger } : {}),
    artifacts: [...artifacts.values()],
    ...(effective.logs
      ? {
          logs: {
            ...(daemonLog ? { daemon: daemonLog } : {}),
            ...(hostLog ? { host: hostLog } : {}),
            browser: input.browserLog,
          },
        }
      : {}),
    ...(effective.system
      ? {
          system: {
            agh: collected?.agh,
            runtime: collected?.runtime,
            profile: apis?.profile,
            config,
            browser: input.browser,
          },
        }
      : {}),
    warnings,
  } satisfies DiagnosticsBundle)

  // spec §5 order; index.html is rendered last (it embeds every warning) but ships first.
  const entries: ZipEntry[] = []
  let size = 0
  const add = (path: string, text: string) => {
    const data = encoder.encode(text)
    // Two slots stay reserved for index.html and the warnings file.
    if (entries.length + 3 > limits.entries || size + data.byteLength > limits.zipBytes) {
      bundle.warnings.push({ source: path, reason: 'limit' })
      return
    }
    size += data.byteLength
    entries.push({ path, data })
  }
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  if (bundle.system) add('system.json', json(bundle.system))
  if (bundle.trace) add('trace.json', json(bundle.trace))
  if (bundle.logs?.daemon && !bundle.logs.daemon.missing) add('logs/daemon.jsonl', bundle.logs.daemon.text)
  if (bundle.logs?.host && !bundle.logs.host.missing) add('logs/host.jsonl', bundle.logs.host.text)
  if (bundle.logs) add('logs/browser.json', json(bundle.logs.browser))
  if (ledger) add('events.jsonl', lines.length ? `${lines.join('\n')}\n` : '')

  let index = encoder.encode(renderDiagnosticsViewer(bundle))
  if (size + index.byteLength > limits.zipBytes) {
    // The heavy trace/logs sections live in their own files; the viewer falls back to a slim summary.
    bundle.warnings.push({ source: 'index.html', reason: 'limit' })
    const { trace: _trace, logs: _logs, ...slim } = bundle
    index = encoder.encode(renderDiagnosticsViewer(slim))
  }
  entries.unshift({ path: 'index.html', data: index })
  // ponytail: the warnings file is exempt from zipBytes (bounded: a dozen sources x 500-char detail),
  // so every warning the viewer lists has its companion file; count it in `size` if that ever grows.
  if (bundle.warnings.length)
    entries.push({ path: 'diagnostic-export-warnings.json', data: encoder.encode(json(bundle.warnings)) })

  const zip = await buildZip(entries, input.now)
  if (signal.aborted) throw abortError()
  return { bundle, fileName: diagnosticsFileName(sessionId, input.now), zip }
}
