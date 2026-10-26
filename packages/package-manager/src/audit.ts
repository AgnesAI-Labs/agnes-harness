import {
  closeSync,
  constants,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  truncateSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { windowsAppendPrivateFileSync, windowsOpenPrivateFileSync } from '@agnes/system-node'
import { PackageError } from './errors.js'
import { canonical } from './integrity.js'
import { appendPrivateLog, recordPackageRecovery } from './recovery-log.js'

export type PackageAuditEvent = Readonly<{
  eventId: string
  at: string
  actor: string
  profile: string
  operation: string
  id: string
  source: string
  sourceHash: string
  version: string | null
  capabilityDiff: { old: string | null; next: string | null }
  integrity: string | null
  old: string
  next: string
  result: 'committed'
}>
export type PackageAuditSink = { write(event: PackageAuditEvent): void }
const windows = process.platform === 'win32' // guards-allow-platform: private audit file primitives.

function readAudit(file: string): string {
  if (!windows) return readFileSync(file, 'utf8')
  const fd = windowsOpenPrivateFileSync(resolve(file))
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

const appendAudit = appendPrivateLog
const corrupt = (file: string) =>
  new PackageError('E_EXT_LOAD', 'package audit is corrupt', {
    detail: {
      reason: 'audit-corrupt',
      path: file,
      repair:
        'A complete line in this log is not a valid record. Restore the file or move it aside to start a new log.',
    },
  })
function validateEvent(value: unknown): asserts value is PackageAuditEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PackageError('E_EXT_LOAD', 'package audit is corrupt')
  const row = value as Record<string, unknown>
  const keys = [
    'eventId',
    'at',
    'actor',
    'profile',
    'operation',
    'id',
    'source',
    'sourceHash',
    'version',
    'capabilityDiff',
    'integrity',
    'old',
    'next',
    'result',
  ]
  const states = ['removed', 'enabled-desired', 'installed-disabled-trusted', 'installed-disabled-untrusted']
  const digest = (v: unknown) => v === null || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
  if (
    canonical(Object.keys(row).sort()) !== canonical(keys.sort()) ||
    keys
      .filter((k) => !['version', 'integrity', 'capabilityDiff'].includes(k))
      .some((k) => typeof row[k] !== 'string' || (row[k] as string).length > 256) ||
    row.result !== 'committed' ||
    !states.includes(row.old as string) ||
    !states.includes(row.next as string) ||
    !Number.isFinite(Date.parse(row.at as string)) ||
    (row.version !== null && typeof row.version !== 'string') ||
    (row.integrity !== null && typeof row.integrity !== 'string') ||
    !row.capabilityDiff ||
    typeof row.capabilityDiff !== 'object'
  )
    throw new PackageError('E_EXT_LOAD', 'package audit is corrupt')
  const diff = row.capabilityDiff as Record<string, unknown>
  if (
    canonical(Object.keys(diff).sort()) !== canonical(['next', 'old']) ||
    !digest(diff.old) ||
    !digest(diff.next) ||
    !digest(row.sourceHash)
  )
    throw new PackageError('E_EXT_LOAD', 'package audit is corrupt')
}
/** Cut the log back to `length` bytes without following a link planted at its path (POSIX). */
function truncateAudit(file: string, length: number): void {
  if (windows) {
    truncateSync(file, length)
    return
  }
  const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW)
  try {
    ftruncateSync(fd, length)
  } finally {
    closeSync(fd)
  }
}
/**
 * An append interrupted part-way leaves a last line without its newline. Records are independent (no
 * chain), and a committed transaction keeps its journal until its record is durable, so recovery
 * appends that record again. A tail that is a whole valid record only lost its newline and is kept;
 * anything else is cut back to the last complete line. Complete lines are never changed. Returns the
 * kept tail record, if any.
 */
function healTail(profileDir: string, file: string, text: string, cut: number): unknown {
  let tail: unknown
  try {
    tail = JSON.parse(text.slice(cut))
    validateEvent(tail)
  } catch {
    tail = undefined
  }
  if (tail !== undefined) appendAudit(file, '\n')
  else truncateAudit(file, Buffer.byteLength(text.slice(0, cut)))
  recordPackageRecovery(profileDir, {
    action: 'repaired',
    path: file,
    reason: tail !== undefined ? 'audit-newline-restored' : 'audit-incomplete-record-cut',
  })
  return tail
}
/** The local durable log is authoritative; the optional external sink is only a mirror. */
export function appendPackageAudit(
  profileDir: string,
  event: PackageAuditEvent,
  sink?: PackageAuditSink,
): void {
  validateEvent(event)
  const file = join(profileDir, '.agnes-package-audit.jsonl')
  if (windows) windowsAppendPrivateFileSync(resolve(file), Buffer.alloc(0))
  if (existsSync(file)) {
    const text = readAudit(file)
    const cut = text.lastIndexOf('\n') + 1
    let present = false
    const same = (row: { eventId: string }) => {
      if (row.eventId !== event.eventId) return
      if (canonical(row) !== canonical(event))
        throw new PackageError('E_EXT_LOAD', 'package audit has a conflicting event', {
          detail: { reason: 'audit-conflict', path: file },
        })
      present = true
    }
    // Every complete line is checked before the tail is repaired, so a refusal leaves the log as it was.
    for (const line of text.slice(0, cut).split('\n').filter(Boolean)) {
      let row: unknown
      try {
        row = JSON.parse(line)
        validateEvent(row)
      } catch {
        throw corrupt(file)
      }
      same(row as PackageAuditEvent)
    }
    if (cut < text.length) {
      const tail = healTail(profileDir, file, text, cut)
      if (tail !== undefined) same(tail as { eventId: string })
    }
    if (present) {
      // A previous append may have written bytes but failed to flush them. Retry the flush.
      appendAudit(file, '')
      return
    }
  }
  appendAudit(file, `${JSON.stringify(event)}\n`)
  try {
    sink?.write(Object.freeze(event))
  } catch {
    /* the durable event remains committed */
  }
}
