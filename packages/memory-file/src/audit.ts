import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { renameWriteThroughSync } from '@agnes/system-node'
import type { MetaStore } from './meta.js'

const MAX_AUDIT_BYTES = 1024 * 1024
const AUDIT_FILE = 'audit.jsonl'
const AUDIT_ARCHIVE = 'audit.1.jsonl'

export type AuditEntry = Readonly<{
  seq: number
  at: string
  path: string
  action: 'commit' | 'refused'
  code?: string
  origin: 'agent' | 'host' | 'human'
  actor: string
  sessionKey?: string
  maintenance?: string
  beforeHash: string
  afterHash: string
}>

function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function parseLines(raw: string): AuditEntry[] {
  const entries: AuditEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<AuditEntry>
      if (typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq)) {
        entries.push(parsed as AuditEntry)
      }
    } catch {
      // Skip malformed partial lines on crash recovery.
    }
  }
  return entries
}

/**
 * Append a commit or pre-approval refusal audit entry to `<root>/meta/audit.jsonl`.
 * Never writes file body content. Rotates to a single `audit.1.jsonl` when exceeding 1 MiB.
 */
export function appendAudit(meta: MetaStore, entry: Omit<AuditEntry, 'seq'>): AuditEntry {
  meta.ensureDir()
  const current = meta.pathOf(AUDIT_FILE)
  const rotated = meta.pathOf(AUDIT_ARCHIVE)
  const raw = readLog(current)
  const seq = (parseLines(raw).at(-1)?.seq ?? parseLines(readLog(rotated)).at(-1)?.seq ?? 0) + 1
  const record: AuditEntry = Object.freeze({
    seq,
    at: entry.at,
    path: entry.path,
    action: entry.action,
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    origin: entry.origin,
    actor: entry.actor,
    ...(entry.sessionKey !== undefined ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.maintenance !== undefined ? { maintenance: entry.maintenance } : {}),
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
  })
  const line = `${JSON.stringify(record)}\n`
  // Keep a torn final record on its own line so the next durable entry remains readable.
  let separator = raw && !raw.endsWith('\n') ? '\n' : ''
  const lineBytes = Buffer.byteLength(line) + separator.length
  if (existsSync(current)) {
    const size = statSync(current).size
    if (size + lineBytes > MAX_AUDIT_BYTES) {
      renameWriteThroughSync(current, rotated)
      separator = ''
    }
  }
  const fd = openSync(current, 'a', 0o600)
  try {
    writeFileSync(fd, separator + line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    chmodSync(current, 0o600)
  } catch {
    // Some filesystems do not support POSIX file modes.
  }
  return record
}

export function readAuditEntries(meta: MetaStore): AuditEntry[] {
  return [...parseLines(readLog(meta.pathOf(AUDIT_ARCHIVE))), ...parseLines(readLog(meta.pathOf(AUDIT_FILE)))]
}
