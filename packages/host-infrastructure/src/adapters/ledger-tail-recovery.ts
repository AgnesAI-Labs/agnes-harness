import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  CoreError,
  type Event,
  type IntegrityRow,
  type IntegrityState,
  prepareIntegrity,
  StateTracker,
  verifyIntegrityRows,
} from '@agnes/core'
import { registerRows } from '@agnes/core-ledger/reduce/tracker'

export type LedgerTailRecovery = { diagnosticId: string; quarantineFile: string; validThroughSeq: number }

/** The sidecar is durable before the transaction is allowed to delete damaged rows. */
export function quarantineBytes(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const directory = openSync(dirname(path), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

type Raw = { session_key: string; seq: number }
function independentlyValid(row: IntegrityRow): boolean {
  try {
    verifyIntegrityRows([row], {
      lastSeq: row.event.seq - 1,
      legacyThroughSeq: row.event.seq - 1,
      headDigest: row.integrity?.mode === 'chain' ? row.integrity.previousDigest : null,
    })
    return true
  } catch {
    return false
  }
}

/** Called under the writer transaction. Interior damage and referenced fork prefixes fail closed. */
export function recoverSqliteTail<R extends Raw>(input: {
  db: DatabaseSync
  key: string
  file: string
  now: number
  decode(row: R): IntegrityRow
  encodeKey(key: string): Uint8Array
}): LedgerTailRecovery | undefined {
  const { db, key, file, decode, encodeKey, now } = input
  const last = db.prepare('SELECT * FROM events WHERE session_key = ? ORDER BY seq DESC LIMIT 1').get(key) as
    | R
    | undefined
  if (!last) return undefined
  try {
    if (independentlyValid(decode(last))) return undefined
  } catch {
    /* Check the whole prefix below. */
  }
  let state: IntegrityState = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
  const tracker = new StateTracker()
  const triggers = new Map<string, number>()
  let bad: number | undefined
  const rows = (owner: string, from: number, to: number): R[] => {
    const parent = db
      .prepare('SELECT parent_key, boundary_seq FROM sessions WHERE session_key = ?')
      .get(owner) as { parent_key: string | null; boundary_seq: number | null } | undefined
    const inherited =
      parent?.parent_key && parent.boundary_seq !== null && from <= parent.boundary_seq
        ? rows(parent.parent_key, from, Math.min(to, parent.boundary_seq))
        : []
    return [
      ...inherited,
      ...(db
        .prepare(
          'SELECT * FROM events WHERE session_key = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT 500',
        )
        .all(owner, from, to) as R[]),
    ].slice(0, 500)
  }
  for (let from = 1; from <= last.seq; ) {
    const page = rows(key, from, last.seq)
    if (!page.length)
      throw new CoreError('E_LEDGER_INTEGRITY', 'Missing ledger rows cannot be recovered as a damaged tail')
    for (const raw of page) {
      let row: IntegrityRow | undefined
      try {
        row = decode(raw)
      } catch {
        /* Preserve exact raw fields in the sidecar. */
      }
      if (bad !== undefined) {
        if (row && independentlyValid(row))
          throw new CoreError(
            'E_LEDGER_INTEGRITY',
            'Valid events follow ledger damage; automatic truncation refused',
          )
      } else {
        try {
          if (!row) throw new Error('invalid row')
          state = verifyIntegrityRows([row], state)
        } catch {
          if (raw.session_key !== key)
            throw new CoreError(
              'E_LEDGER_INTEGRITY',
              'Inherited ledger damage requires recovery of the owning session',
            )
          bad = raw.seq
        }
        // Reducer errors in checksum-valid events are not damaged bytes: never truncate them.
        if (bad === undefined && row) {
          tracker.apply([row.event])
          if (row.event.type === 'user/message') triggers.set(row.event.lane ?? 'main', row.event.seq)
        }
      }
    }
    from = (page.at(-1)?.seq ?? last.seq) + 1
  }
  if (bad === undefined) return undefined
  if (state.lastSeq === 0)
    throw new CoreError('E_LEDGER_INTEGRITY', 'Ledger has no valid prefix; automatic truncation refused')
  if (
    db
      .prepare('SELECT session_key FROM sessions WHERE parent_key = ? AND boundary_seq >= ? LIMIT 1')
      .get(key, bad)
  )
    throw new CoreError(
      'E_LEDGER_INTEGRITY',
      'Damaged tail is referenced by a fork; automatic truncation refused',
    )
  const diagnosticId = randomUUID()
  const quarantineFile = `${file}.tail-${diagnosticId}.json`
  const damaged = db
    .prepare('SELECT * FROM events WHERE session_key = ? AND seq >= ? ORDER BY seq')
    .all(key, bad)
  const registers = db.prepare('SELECT * FROM registers WHERE session_key = ?').all(key)
  quarantineBytes(
    quarantineFile,
    Buffer.from(
      JSON.stringify(
        { diagnosticId, sessionKey: key, validThroughSeq: state.lastSeq, damaged, registers },
        (_name, value) =>
          value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value,
      ),
    ),
  )
  db.prepare('DELETE FROM events WHERE session_key = ? AND seq >= ?').run(key, bad)
  db.prepare('DELETE FROM registers WHERE session_key = ?').run(key)
  const put = db.prepare(
    'INSERT INTO registers (session_key, register, key, seq, data) VALUES (?, ?, ?, ?, ?)',
  )
  for (const cell of registerRows(tracker.state))
    put.run(key, cell.register, encodeKey(cell.key), cell.seq, JSON.stringify(cell.data))
  const by: Event['actor'] = { id: 'ledger-recovery', org: '', role: 'system', deptPath: [], attrs: {} }
  for (const [lane, turn] of tracker.state.openTurn) {
    const triggerSeq = triggers.get(lane) ?? turn.startSeq
    const op = {
      meta: {
        turn: turn.turn,
        lane,
        acceptedAt: new Date(now).toISOString(),
        triggerSeq,
        presetName: 'recovery',
        profileHash: null,
        depthLimit: 0,
      },
      control: { status: 'cancel_requested', requestedAt: new Date(now).toISOString(), by },
      step: tracker.state.openStep.get(lane)?.step ?? 0,
      latestAssistantSeq: null,
      taint: true,
      phase: {
        kind: 'failure_drain',
        error: {
          code: 'LEDGER_TAIL_RECOVERED',
          message: 'Damaged ledger tail was quarantined; outstanding effects must not be replayed.',
        },
        provenance: { kind: 'seam' },
      },
    }
    put.run(key, 'op.state', encodeKey(lane), state.lastSeq, JSON.stringify(op))
  }
  const recovery = { diagnosticId, quarantineFile, validThroughSeq: state.lastSeq }
  const event: Event = {
    seq: state.lastSeq + 1,
    ts: new Date(now).toISOString(),
    id: randomUUID(),
    type: 'x/core/ledger-tail-recovered',
    v: 1,
    lane: 'main',
    actor: by,
    origin: 'system',
    trust: 'trusted',
    ignorable: true,
    data: recovery,
  }
  const integrity = prepareIntegrity(key, [event], state).entries[0]
  if (!integrity) throw new CoreError('E_STORAGE_FAULT', 'Recovery audit integrity is unavailable')
  db.prepare(
    'INSERT INTO events (session_key, seq, ts, id, type, v, lane, actor, origin, trust, ignorable, data, integrity_mode, integrity_prev, integrity_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    key,
    event.seq,
    event.ts,
    event.id,
    event.type,
    1,
    encodeKey('main'),
    JSON.stringify(by),
    'system',
    'trusted',
    1,
    JSON.stringify(recovery),
    integrity.mode,
    integrity.previousDigest,
    integrity.digest,
  )
  return recovery
}
