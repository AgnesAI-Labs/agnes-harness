import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { windowsAppendPrivateFileSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { createPlatform } from './adapters/platform.js'
import { looksLikeSecret } from './errors.js'

/**
 * Host-audit vocabulary, including the package/workspace writers that land after their manager
 * prerequisites. Keeping their names here before those writers exist prevents each later slice
 * from weakening the sink to an open string just to add one event.
 */
export const AUDIT_KINDS = [
  'profile.resolved',
  'package.installed',
  'package.trusted',
  'package.enabled',
  'package.removed',
  'package.rolledback',
  'workspace.trusted',
  'workspace.rejected',
  'workspace.verified',
  'seams.assembled',
  'provider.assembled',
  'provider.env_swept',
  'extension.loaded',
  'extension.registered',
  'extension.service-call',
  'extension.failed',
  'extension.reloaded',
  'extension.revoked',
  'extension.revoke_failed',
  'extension.isolated',
  'extension.isolation-failed',
  'extension.isolation-fallback',
  'extensions.loaded',
  'secret.resolved',
  'startup.failed',
  'daemon.request_failed',
  'plugin.tree.reverted',
  'host.ready',
  'host.closed',
  'host.teardown_finished',
  'session.close_failed',
  'session.recovered',
  'preset.deprecated',
] as const
export type AuditKind = (typeof AUDIT_KINDS)[number]
export type AuditEvent = { kind: string; detail?: Record<string, unknown>; at?: string }
export interface AuditSink {
  write(e: AuditEvent): void
  close?(): Promise<void>
}

const KINDS = new Set<string>(AUDIT_KINDS)
export const isAuditKind = (kind: string): kind is AuditKind => KINDS.has(kind)

const SENSITIVE_KEY = /secret|token|key|password/i
const REDACTED = '<redacted>'

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) {
    if (typeof value === 'string') return value.startsWith('secret://') ? value : REDACTED
    // Counts and booleans are not credentials; structured material under a sensitive name can be.
    if (value !== null && typeof value === 'object') return REDACTED
  }
  if (typeof value === 'string') return looksLikeSecret(value) ? REDACTED : value
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return REDACTED
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, undefined, seen))
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey, seen)]),
    )
  } finally {
    seen.delete(value)
  }
}

/** Mandatory baseline redaction. A deployment-specific redactor may only make this stricter. */
export function redactDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return detail === undefined
    ? undefined
    : (redactValue(detail, undefined, new WeakSet()) as Record<string, unknown>)
}

function assertKnown(event: AuditEvent): void {
  if (!isAuditKind(event.kind)) throw new Error(`unknown audit kind ${event.kind}`)
}

export function createMemoryAudit(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = []
  return {
    events,
    write: (event) => {
      assertKnown(event)
      // Memory audit is test evidence, not an external sink: retain its detail so callers can assert
      // exact session keys and decisions. File audit below owns the production redaction boundary.
      events.push({ ...event, at: new Date().toISOString() })
    },
  }
}

export function createFileAudit(
  file: string,
  opts: { redact?: (event: AuditEvent) => AuditEvent } = {},
): AuditSink & { file: string } {
  const directory = dirname(file)
  const windows = createPlatform().os === 'win32'
  if (windows) {
    windowsEnsurePrivateDirectorySync(directory)
    windowsAppendPrivateFileSync(file, Buffer.alloc(0))
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    // Create and repair modes before the first event. `mode` on appendFileSync only affects a new
    // file, so it cannot fix an existing world-readable audit trail by itself.
    const created = openSync(file, 'a', 0o600)
    closeSync(created)
    chmodSync(file, 0o600)
  }

  return {
    file,
    write(event) {
      assertKnown(event)
      const baselineDetail = event.detail === undefined ? undefined : redactDetail(event.detail)
      const baseline: AuditEvent = {
        kind: event.kind,
        ...(baselineDetail === undefined ? {} : { detail: baselineDetail }),
      }
      const customized = opts.redact?.(baseline) ?? baseline
      if (customized === null || typeof customized !== 'object' || typeof customized.kind !== 'string')
        throw new Error('audit redactor returned an invalid event')
      assertKnown(customized)
      const detail = redactDetail(customized.detail)
      // The sink owns `at`: accepting a caller-supplied time would let an event forge ordering.
      const line = `${JSON.stringify({ at: new Date().toISOString(), kind: customized.kind, detail })}\n`
      if (windows) windowsAppendPrivateFileSync(file, Buffer.from(line))
      else {
        appendFileSync(file, line, { mode: 0o600 })
        chmodSync(file, 0o600)
      }
    },
    async close() {
      if (windows) {
        windowsAppendPrivateFileSync(file, Buffer.alloc(0), true)
        return
      }
      // Writes are synchronous, and fsync makes close's promised flush explicit for the final line.
      const fd = openSync(file, 'a', 0o600)
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    },
  }
}
