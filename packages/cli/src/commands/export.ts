import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import { DEFAULT_RULES, redact } from '@agnes/base/privacy'
import { exportClaudeCode, exportShareGpt } from '@agnes/bridges/convert'
import { createPlatform } from '@agnes/host'
import type { EventEnvelope, UITimeline } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import { renderHtml } from '../html/template.js'
import type { ParsedArgs } from '../types.js'
import { writeWindowsPrivateExport } from './export-private-file.js'

export type LedgerExport = {
  events: EventEnvelope[]
  timeline: UITimeline
  lastSeq: number
}

type ExportSink = {
  write(chunk: string | Uint8Array): unknown
}

export type ExportDeps = {
  cwd: string
  io: { stdout: ExportSink; stderr: ExportSink }
  now?: () => Date
  home?: string
  username?: string
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>
}

export function sanitizeExportValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[OMITTED:binary:${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.map(sanitizeExportValue)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ((record.type === 'image' || record.type === 'audio') && typeof record.data === 'string')
    return { ...record, data: `[OMITTED:${record.type}:base64]` }
  if (record.type === 'base64' && typeof record.data === 'string')
    return { ...record, data: '[OMITTED:binary:base64]' }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, sanitizeExportValue(child)]))
}

function privacyRules(deps: ExportDeps) {
  const home = deps.home ?? homedir()
  return {
    ...DEFAULT_RULES,
    paths: {
      home,
      workspaceRoot: deps.cwd,
      username: deps.username ?? basename(home),
    },
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  if (createPlatform().os === 'win32') return writeWindowsPrivateExport(path, bytes)
  const file = await open(path, 'w', 0o600)
  try {
    // `mode` only applies when the file is created. Tighten an existing destination before any raw
    // bytes are written so a former 0644 export cannot expose the replacement through that window.
    await file.chmod(0o600)
    await file.writeFile(bytes)
  } finally {
    await file.close()
  }
}

/**
 * Read a stable ledger prefix and the projection of that same prefix.
 *
 * Calling `client.session.attach` creates the sdk Session handle synchronously, before its returned
 * promise settles. The iterator is created in that window, which registers sdk's notification
 * listener before daemon can finish replaying rows inside the attach RPC; starting `events()` after
 * awaiting attach loses exactly those rows on an in-process transport.
 *
 * A client that already has a handle for this id cannot be made into a full-ledger reader. sdk
 * deduplicates admitted rows on the Session object and exposes no reset operation, so accepting one
 * would silently return a suffix. The CLI always boots a fresh client; other callers get a loud
 * refusal instead of a plausible but incomplete export.
 */
export async function readLedger(client: Client, id: string): Promise<LedgerExport> {
  // A durable sdk journal normally resumes at its saved position. Export is different: it needs the
  // whole retained ledger, so keep only the generation and explicitly rewind the exclusive cursor.
  const stored = await client.journal.cursor(id)
  // Restore only an existing durable session; an empty cwd lets the daemon recover its binding.
  // Do not create an SDK handle during load, which replays ACP rather than the export event stream.
  if (client.sessions.has(id))
    throw new UsageError(`cannot export ${id} with a client that already opened that session`)
  await client.restoreSession(id, '')
  // A caller may have installed a handle while restoration was awaiting the daemon.
  if (client.sessions.has(id))
    throw new UsageError(`cannot export ${id} with a client that already opened that session`)
  const attaching = client.session.attach(id, {
    ...(stored ? { cursor: { fromSeq: 0, generation: stored.generation } } : {}),
    filter: { acpUpdates: false },
  })
  // Client.session.attach installs this handle before its first await. If that contract changes,
  // fail here rather than await the replay and then register a listener too late.
  const session = client.sessions.get(id)
  if (!session) throw new Error('sdk did not publish the session handle before attach')
  const iterator = session.events()[Symbol.asyncIterator]()
  // Also tracks events()'s own ensureAttached attempt. If the explicit attach fails, sdk may retry
  // that ensure; awaiting this promise during cleanup prevents such a retry from attaching after
  // readLedger has already returned an error.
  const first = iterator.next()
  let streamError: Error | undefined
  const offNotice = client.on('notice', (payload) => {
    const notice = payload as { kind?: unknown; sessionId?: unknown; seq?: unknown } | null
    if (notice?.kind !== 'invalid-event' || notice.sessionId !== id) return
    streamError = new Error(`invalid ledger event at sequence ${String(notice.seq)}`)
    // sdk deliberately drops an invalid row. Wake the reader now: waiting for the dropped final
    // sequence would otherwise turn a validation failure into an export that hangs forever.
    void iterator.return?.()
  })
  try {
    await attaching
    const lastSeq = session.lastServerSeq
    const events: EventEnvelope[] = []
    let next = await (lastSeq > 0 ? first : Promise.resolve({ done: true as const, value: undefined }))
    while (events.at(-1)?.seq !== lastSeq && lastSeq > 0) {
      if (next.done) {
        if (streamError) throw streamError
        throw new Error(`event stream ended at ${events.at(-1)?.seq ?? 0} before export target ${lastSeq}`)
      }
      const { _meta: _ignored, ...envelope } = next.value
      events.push(envelope)
      if (envelope.seq >= lastSeq) break
      next = await iterator.next()
    }
    // Zero is a real snapshot boundary. Omitting it asks for "latest", which can include a row that
    // arrived after an empty attach and make the timeline disagree with the exported ledger.
    const timeline = await session.projectUI(lastSeq)
    return { events, timeline, lastSeq }
  } finally {
    offNotice()
    await iterator.return?.()
    await first.catch(() => undefined)
    if (session.attached) await session.detach().catch(() => undefined)
  }
}

/** The native export is one protocol envelope per UTF-8 line, with no sdk-only `_meta` wrapper. */
export function formatAgnes(events: EventEnvelope[]): Uint8Array {
  const text = events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n` : ''
  return new TextEncoder().encode(text)
}

function formatFor(p: ParsedArgs): 'agnes' | 'html' | 'sharegpt' | 'claude-code' {
  return p.html ? 'html' : (p.format ?? 'agnes')
}

export function validateExportRequest(p: ParsedArgs): {
  id: string
  format: 'agnes' | 'html' | 'sharegpt' | 'claude-code'
} {
  const id = p.positional[0]
  if (!id || p.positional.length !== 1) throw new UsageError('export expects exactly one session id')
  const format = formatFor(p)
  return { id, format }
}

/**
 * Every export/share format is redacted before formatting by the shared privacy implementation.
 * `--raw` is still an explicit, warned escape hatch.
 */
export async function exportSession(p: ParsedArgs, deps: ExportDeps, client: Client): Promise<number> {
  const { id, format } = validateExportRequest(p)

  const ledger = await readLedger(client, id)
  if (p.raw) deps.io.stderr.write('warning: --raw exports without redaction (secrets, paths, PII)\n')
  const rules = privacyRules(deps)
  const events = p.raw
    ? ledger.events
    : (redact(sanitizeExportValue(ledger.events), rules) as EventEnvelope[])
  const timeline = p.raw
    ? ledger.timeline
    : (redact(sanitizeExportValue(ledger.timeline), rules) as UITimeline)
  const sessionId = p.raw ? id : redact(id, rules)
  const bytes =
    format === 'html'
      ? new TextEncoder().encode(
          renderHtml(timeline, {
            sessionId,
            exportedAt: (deps.now?.() ?? new Date()).toISOString(),
            redacted: !p.raw,
          }),
        )
      : format === 'sharegpt'
        ? exportShareGpt(events, { tools: 'role', id: sessionId })
        : format === 'claude-code'
          ? exportClaudeCode(events, { cwd: p.raw ? deps.cwd : redact(deps.cwd, rules) })
          : formatAgnes(events)

  if (p.out) {
    const path = isAbsolute(p.out) ? p.out : resolve(deps.cwd, p.out)
    await (deps.writeFile ?? writePrivateFile)(path, bytes)
  } else {
    deps.io.stdout.write(bytes)
  }
  return ExitCode.OK
}
