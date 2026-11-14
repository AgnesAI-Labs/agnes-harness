import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import type { JsonValue } from '@agnes/protocol'

/** Why an input sits in its state; the platform fixes this vocabulary, no caller text goes here. */
export type ManagedInputReason =
  | 'eligible'
  | 'busy'
  | 'questionOpen'
  | 'legacySourceUnknown'
  | 'recoveryUnverified'
  | 'receiptUnknown'
  | 'pairingChanged'
  | 'grantRevoked'
  | 'sessionArchived'
  | 'ownerRetained'
  | 'ownerDiscarded'

export type ManagedInputState =
  | 'queued'
  | 'enqueued'
  | 'consumed'
  | 'retained'
  | 'needsOwner'
  | 'waitingQuestion'
  | 'recoveryUnknown'
export type ManagedInputKind = 'ownerMessage' | 'recoveryContinuation' | 'legacyOwnerMessage'

export interface ManagedInputHistoryEntry {
  version: number
  state: ManagedInputState
  reason: ManagedInputReason
  at: number
  by: 'platform' | 'owner'
}

export interface ManagedInputRow {
  owner: string
  sessionId: string
  key: string
  bindingDigest: string
  /** The calling plugin row: an idle submit has no caller, so this rebuilds the actor. */
  actorOwner: string
  receiptId: string | null
  kind: ManagedInputKind
  taskId: string
  taskGeneration: number
  startKey: string
  contentDigest: string | null
  /** At most `MANAGED_INPUT_TEXT_LIMIT` UTF-8 bytes. */
  text: string | null
  source: JsonValue
  state: ManagedInputState
  reason: ManagedInputReason
  version: number
  itemCommandId: string | null
  submittedSeq: number | null
  consumedTurn: number | null
  consumedSeq: number | null
  history: ManagedInputHistoryEntry[]
  createdAt: number
  updatedAt: number
}

export type NewManagedInput = Omit<ManagedInputRow, 'version' | 'history' | 'createdAt' | 'updatedAt'>
export type ManagedInputChange = Pick<ManagedInputRow, 'state' | 'reason'> &
  Partial<
    Pick<
      ManagedInputRow,
      'text' | 'contentDigest' | 'itemCommandId' | 'submittedSeq' | 'consumedTurn' | 'consumedSeq'
    >
  >

export const MANAGED_INPUT_TEXT_LIMIT = 64 * 1024

/** Rows the owner or the platform can still move: only `consumed` and `retained` are final. */
const OPEN = "('queued', 'waitingQuestion', 'enqueued')"
const FINAL = "('consumed', 'retained')"

/** New tables only; the managed-session records constructor runs these with its own. */
export const MANAGED_INPUT_TABLES = [
  `CREATE TABLE IF NOT EXISTS managed_session_bindings (
    session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_generation INTEGER NOT NULL,
    input_digest TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS managed_session_inputs (
    owner TEXT NOT NULL, session_id TEXT NOT NULL, key TEXT NOT NULL, binding_digest TEXT NOT NULL,
    actor_owner TEXT NOT NULL, receipt_id TEXT, kind TEXT NOT NULL, task_id TEXT NOT NULL,
    task_generation INTEGER NOT NULL, start_key TEXT NOT NULL, content_digest TEXT, text TEXT,
    source TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL, version INTEGER NOT NULL,
    item_command_id TEXT, submitted_seq INTEGER, consumed_turn INTEGER, consumed_seq INTEGER,
    history TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, session_id, key)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS managed_session_inputs_receipt
     ON managed_session_inputs (receipt_id) WHERE receipt_id IS NOT NULL`,
  // Partial: finished rows are kept for good, so held, inFlight and the startup and slow sweep read
  // only the open rows however many finished ones there are.
  `CREATE INDEX IF NOT EXISTS managed_session_inputs_open
     ON managed_session_inputs (session_id, state) WHERE state IN ${OPEN}`,
] as const

type Row = {
  owner: string
  session_id: string
  key: string
  binding_digest: string
  actor_owner: string
  receipt_id: string | null
  kind: string
  task_id: string
  task_generation: number
  start_key: string
  content_digest: string | null
  text: string | null
  source: string
  state: string
  reason: string
  version: number
  item_command_id: string | null
  submitted_seq: number | null
  consumed_turn: number | null
  consumed_seq: number | null
  history: string
  created_at: number
  updated_at: number
}

const row = (value: Row): ManagedInputRow => ({
  owner: value.owner,
  sessionId: value.session_id,
  key: value.key,
  bindingDigest: value.binding_digest,
  actorOwner: value.actor_owner,
  receiptId: value.receipt_id,
  kind: value.kind as ManagedInputKind,
  taskId: value.task_id,
  taskGeneration: value.task_generation,
  startKey: value.start_key,
  contentDigest: value.content_digest,
  text: value.text,
  source: JSON.parse(value.source) as JsonValue,
  state: value.state as ManagedInputState,
  reason: value.reason as ManagedInputReason,
  version: value.version,
  itemCommandId: value.item_command_id,
  submittedSeq: value.submitted_seq,
  consumedTurn: value.consumed_turn,
  consumedSeq: value.consumed_seq,
  history: JSON.parse(value.history) as ManagedInputHistoryEntry[],
  createdAt: value.created_at,
  updatedAt: value.updated_at,
})

function checkText(text: string | null | undefined): void {
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > MANAGED_INPUT_TEXT_LIMIT)
    throw new RangeError(`owner input text exceeds ${MANAGED_INPUT_TEXT_LIMIT} bytes`)
}

const KEY = 'owner = ? AND session_id = ? AND key = ?'

/**
 * Owner inputs the platform holds for managed sessions: the original text, where it stands, and the
 * versioned history the Web panel shows. Rows are never pruned by time (a stored key must keep
 * answering "known"); they go with the package through `ManagedSessionRecords.releasePackage`.
 */
export class ManagedSessionInputs {
  constructor(
    private readonly table: TableHandle,
    private readonly clock: () => number = Date.now,
  ) {
    for (const ddl of MANAGED_INPUT_TABLES) table.exec(ddl)
  }

  get(owner: string, sessionId: string, key: string): ManagedInputRow | undefined {
    const found = this.table.get<Row>(`SELECT * FROM managed_session_inputs WHERE ${KEY}`, [
      owner,
      sessionId,
      key,
    ])
    return found ? row(found) : undefined
  }

  /** Writes version 1 with its first history entry. `exists`: the key is known; `receiptTaken`: the receipt is bound to another key. */
  reserve(value: NewManagedInput): 'reserved' | 'exists' | 'receiptTaken' {
    checkText(value.text)
    const now = this.clock()
    const history: ManagedInputHistoryEntry[] = [
      { version: 1, state: value.state, reason: value.reason, at: now, by: 'platform' },
    ]
    return this.table.transaction(() => {
      if (
        this.table.get(`SELECT 1 FROM managed_session_inputs WHERE ${KEY}`, [
          value.owner,
          value.sessionId,
          value.key,
        ])
      )
        return 'exists'
      if (
        value.receiptId !== null &&
        this.table.get('SELECT 1 FROM managed_session_inputs WHERE receipt_id = ?', [value.receiptId])
      )
        return 'receiptTaken'
      this.table.exec(
        `INSERT INTO managed_session_inputs
           (owner, session_id, key, binding_digest, actor_owner, receipt_id, kind, task_id, task_generation,
            start_key, content_digest, text, source, state, reason, version, item_command_id, submitted_seq,
            consumed_turn, consumed_seq, history, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          value.owner,
          value.sessionId,
          value.key,
          value.bindingDigest,
          value.actorOwner,
          value.receiptId,
          value.kind,
          value.taskId,
          value.taskGeneration,
          value.startKey,
          value.contentDigest,
          value.text,
          JSON.stringify(value.source),
          value.state,
          value.reason,
          value.itemCommandId,
          value.submittedSeq,
          value.consumedTurn,
          value.consumedSeq,
          JSON.stringify(history),
          now,
          now,
        ],
      )
      return 'reserved'
    })
  }

  /** Compare-and-set on `version`; a stale or unknown row returns undefined and changes nothing. */
  transition(
    owner: string,
    sessionId: string,
    key: string,
    expectVersion: number,
    next: ManagedInputChange,
    by: 'platform' | 'owner',
  ): ManagedInputRow | undefined {
    checkText(next.text)
    const now = this.clock()
    return this.table.transaction(() => {
      const found = this.get(owner, sessionId, key)
      if (!found || found.version !== expectVersion) return undefined
      const version = found.version + 1
      const merged: ManagedInputRow = {
        ...found,
        state: next.state,
        reason: next.reason,
        version,
        updatedAt: now,
        history: [...found.history, { version, state: next.state, reason: next.reason, at: now, by }],
      }
      for (const field of [
        'text',
        'contentDigest',
        'itemCommandId',
        'submittedSeq',
        'consumedTurn',
        'consumedSeq',
      ] as const)
        if (next[field] !== undefined) (merged as unknown as Record<string, unknown>)[field] = next[field]
      this.table.exec(
        `UPDATE managed_session_inputs
            SET state = ?, reason = ?, version = ?, text = ?, content_digest = ?, item_command_id = ?,
                submitted_seq = ?, consumed_turn = ?, consumed_seq = ?, history = ?, updated_at = ?
          WHERE ${KEY} AND version = ?`,
        [
          merged.state,
          merged.reason,
          version,
          merged.text,
          merged.contentDigest,
          merged.itemCommandId,
          merged.submittedSeq,
          merged.consumedTurn,
          merged.consumedSeq,
          JSON.stringify(merged.history),
          now,
          owner,
          sessionId,
          key,
          expectVersion,
        ],
      )
      return merged
    })
  }

  /** Not yet in the core inbox, in admission order: queued, waiting on a question, or enqueued and held. */
  held(sessionId: string): ManagedInputRow[] {
    return this.table
      .all<Row>(
        `SELECT * FROM managed_session_inputs
          WHERE session_id = ? AND state IN ${OPEN} AND submitted_seq IS NULL ORDER BY rowid`,
        [sessionId],
      )
      .map(row)
  }

  /** Submitted to the core inbox and not yet seen consumed. The extra `IN` term lets the planner use the partial index. */
  inFlight(sessionId: string): ManagedInputRow[] {
    return this.table
      .all<Row>(
        `SELECT * FROM managed_session_inputs
          WHERE session_id = ? AND state IN ${OPEN} AND state = 'enqueued' AND submitted_seq IS NOT NULL
          ORDER BY rowid`,
        [sessionId],
      )
      .map(row)
  }

  /** Every row of one owner that is not final, for a revoked grant. */
  byOwner(owner: string): ManagedInputRow[] {
    return this.table
      .all<Row>(
        `SELECT * FROM managed_session_inputs WHERE owner = ? AND state NOT IN ${FINAL} ORDER BY rowid`,
        [owner],
      )
      .map(row)
  }

  /** Grant keys under a package prefix with rows not final; package removal only, so it may scan. */
  owners(prefix: string): string[] {
    return this.table
      .all<{ owner: string }>(
        `SELECT DISTINCT owner FROM managed_session_inputs
          WHERE substr(owner, 1, length(?)) = ? AND state NOT IN ${FINAL} ORDER BY owner`,
        [prefix, prefix],
      )
      .map((value) => value.owner)
  }

  sessionsWithWork(): string[] {
    return this.table
      .all<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM managed_session_inputs WHERE state IN ${OPEN}`,
      )
      .map((value) => value.session_id)
  }
}
