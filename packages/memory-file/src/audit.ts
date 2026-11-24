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

function parseLines(path: string): AuditEntry[] {
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
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

function lastSeqOf(current: string, rotated: string): number {
  const fromCurrent = parseLines(current).at(-1)?.seq
  if (fromCurrent !== undefined) return fromCurrent
  return parseLines(rotated).at(-1)?.seq ?? 0
}

/**
 * Append a commit or pre-approval refusal audit entry to `<root>/meta/audit.jsonl`.
 * Never writes file body content. Rotates to a single `audit.1.jsonl` when exceeding 1 MiB.
 */
export function appendAudit(meta: MetaStore, entry: Omit<AuditEntry, 'seq'>): AuditEntry {
  meta.ensureDir()
  const current = meta.pathOf(AUDIT_FILE)
  const rotated = meta.pathOf(AUDIT_ARCHIVE)
  const seq = lastSeqOf(current, rotated) + 1
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
  const lineBytes = Buffer.byteLength(line)
  if (existsSync(current)) {
    const size = statSync(current).size
    if (size + lineBytes > MAX_AUDIT_BYTES) {
      renameWriteThroughSync(current, rotated)
    }
  }
  const fd = openSync(current, 'a', 0o600)
  try {
    writeFileSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(current, 0o600)
  return record
}

export function readAuditEntries(meta: MetaStore): AuditEntry[] {
  return [...parseLines(meta.pathOf(AUDIT_ARCHIVE)), ...parseLines(meta.pathOf(AUDIT_FILE))]
}
