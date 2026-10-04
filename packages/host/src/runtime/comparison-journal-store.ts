import type { DatabaseSync } from 'node:sqlite'
import { canonicalJson } from '@agnes/core'
import type { ComparisonTreeCuts } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import {
  ComparisonPreparedReceipt as PreparedSchema,
  ComparisonTreeCuts as TreeCutsSchema,
} from '@agnes/protocol/gen/agnes-v1'
import type { ComparisonRecord, RunTiming, Side, TerminalCause } from '@agnes/runtime-comparison'
import {
  type ComparisonJournalBinding,
  type ComparisonJournalCuts,
  type ComparisonJournalEntry,
  ComparisonJournalError,
  type ComparisonJournalFact,
  type ComparisonJournalStore,
} from './comparison-journal-types.js'

const sides: Side[] = ['left', 'right']
const fail = (code: string, message: string): never => {
  throw new ComparisonJournalError(code, message)
}
function integer(value: number, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail('JOURNAL_INVALID_ARGUMENT', `Invalid ${label}`)
}
export function comparisonTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
function bindings(record: ComparisonRecord): Partial<Record<Side, ComparisonJournalBinding>> {
  const result: Partial<Record<Side, ComparisonJournalBinding>> = {}
  for (const side of sides) {
    const lane = record.lanes[side]
    if (lane)
      result[side] = {
        sessionId: lane.sessionId,
        runtime: { id: lane.runtime.id, version: lane.runtime.version },
      }
  }
  return result
}
export function assertComparisonBindings(previous: ComparisonRecord, next: ComparisonRecord): void {
  for (const prior of previous.rounds) {
    const round = next.rounds.find((value) => value.inputId === prior.inputId)
    if (
      (prior.permissionMode !== undefined && round?.permissionMode !== prior.permissionMode) ||
      (prior.prepared !== undefined &&
        canonicalJson(round?.prepared ?? null) !== canonicalJson(prior.prepared))
    )
      fail('JOURNAL_IDENTITY_CONFLICT', 'Admitted round permission and preparation are immutable')
  }
  for (const side of sides) {
    const old = previous.lanes[side]
    const lane = next.lanes[side]
    if (
      old &&
      (!lane ||
        old.sessionId !== lane.sessionId ||
        old.runtime.id !== lane.runtime.id ||
        old.runtime.version !== lane.runtime.version)
    )
      fail('JOURNAL_IDENTITY_CONFLICT', 'Comparison lane identity is immutable')
    const priorReceipt = previous.prepared?.[side]
    const receipt = next.prepared?.[side]
    if (priorReceipt && (!receipt || canonicalJson(priorReceipt) !== canonicalJson(receipt)))
      fail('JOURNAL_IDENTITY_CONFLICT', 'Comparison preparation receipt is immutable')
    if (
      receipt &&
      (!validateAgainst(PreparedSchema, receipt).ok ||
        !lane ||
        receipt.sessionId !== lane.sessionId ||
        receipt.sourceSeq > lane.lastSeq ||
        receipt.configuration.runtime.id !== lane.runtime.id ||
        receipt.configuration.runtime.version !== lane.runtime.version)
    )
      fail('JOURNAL_IDENTITY_CONFLICT', 'Comparison preparation receipt does not match its lane')
  }
  if (next.lanes.left && next.lanes.left.sessionId === next.lanes.right?.sessionId)
    fail('JOURNAL_IDENTITY_CONFLICT', 'Comparison lanes must have distinct sessions')
}
function coordinator(record: ComparisonRecord): ComparisonJournalFact {
  assertComparisonBindings(record, record)
  const lanes: Extract<ComparisonJournalFact, { kind: 'coordinator' }>['lanes'] = {}
  for (const side of sides) {
    const lane = record.lanes[side]
    if (lane)
      lanes[side] = {
        sessionId: lane.sessionId,
        runtime: { id: lane.runtime.id, version: lane.runtime.version },
        phase: lane.phase,
      }
  }
  const round = record.rounds.at(-1)
  const terminalCauses: Record<Side, TerminalCause> = { left: 'unknown', right: 'unknown' }
  const acceptedSeqs: Partial<Record<Side, number>> = {}
  const timings: Partial<Record<Side, RunTiming>> = {}
  const terminalSeqs: Partial<Record<Side, number>> = {}
  if (round) {
    const causes: readonly TerminalCause[] = ['finished', 'cancelled', 'failed', 'unknown']
    for (const side of sides) {
      const cause = round.runs[side].terminalCause
      if (cause !== undefined && causes.includes(cause)) terminalCauses[side] = cause
      const acceptance = round.acceptances[side]
      if (acceptance.status === 'accepted' && acceptance.seq !== undefined) {
        integer(acceptance.seq, `${side} accepted sequence`, 1)
        acceptedSeqs[side] = acceptance.seq
      }
      if (round.runs[side].timing) timings[side] = structuredClone(round.runs[side].timing)
      const terminalSeq = round.runs[side].terminalSeq
      if (terminalSeq !== undefined) {
        integer(terminalSeq, `${side} terminal sequence`)
        terminalSeqs[side] = terminalSeq
      }
    }
  }
  return {
    kind: 'coordinator',
    revision: record.revision,
    creation: record.creation,
    ...(record.prepared === undefined ? {} : { prepared: structuredClone(record.prepared) }),
    lanes,
    roundCount: record.rounds.length,
    latestRound: round
      ? {
          inputId: round.inputId,
          ...(round.permissionMode === undefined ? {} : { permissionMode: round.permissionMode }),
          ...(round.prepared === undefined ? {} : { prepared: structuredClone(round.prepared) }),
          runs: { left: round.runs.left.status, right: round.runs.right.status },
          terminalCauses,
          acceptances: { left: round.acceptances.left.status, right: round.acceptances.right.status },
          acceptedSeqs,
          ...(Object.keys(timings).length === 0 ? {} : { timings }),
          ...(Object.keys(terminalSeqs).length === 0 ? {} : { terminalSeqs }),
        }
      : null,
    cancellation: Object.fromEntries(
      sides.flatMap((side) => (record.cancellation[side] ? [[side, record.cancellation[side]]] : [])),
    ),
    cleanup: {
      exited: sides.filter((side) => record.cleanup.exited.includes(side)),
      released: record.cleanup.released,
    },
  }
}

/** All writer helpers are synchronous; caller owns the SQL transaction. */
export function createComparisonJournal(
  db: DatabaseSync,
  readRecord: (principal: string, id: string) => ComparisonRecord | undefined,
) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS comparison_journal (principal TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, side TEXT, local_seq INTEGER, PRIMARY KEY(principal,id,seq), UNIQUE(principal,id,side,local_seq))',
  )
  const latest = db.prepare(
    'SELECT body FROM comparison_journal WHERE principal=? AND id=? ORDER BY seq DESC LIMIT 1',
  )
  const one = db.prepare('SELECT body FROM comparison_journal WHERE principal=? AND id=? AND seq=?')
  const source = db.prepare(
    'SELECT body FROM comparison_journal WHERE principal=? AND id=? AND side=? AND local_seq=?',
  )
  const range = db.prepare(
    'SELECT body FROM comparison_journal WHERE principal=? AND id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?',
  )
  const insert = db.prepare(
    'INSERT INTO comparison_journal(principal,id,seq,body,side,local_seq) VALUES(?,?,?,?,?,?)',
  )
  const legacy = db.prepare(
    "SELECT 1 FROM comparison_journal WHERE principal=? AND id=? AND json_extract(body,'$.fact.reason')='legacy' LIMIT 1",
  )
  const gaps = db.prepare(
    "SELECT 1 FROM comparison_journal WHERE principal=? AND id=? AND json_extract(body,'$.fact.coverage')='unknown-interleaving' LIMIT 1",
  )
  const decode = (row: unknown): ComparisonJournalEntry | undefined =>
    row === undefined ? undefined : (JSON.parse((row as { body: string }).body) as ComparisonJournalEntry)
  const requireRecord = (principal: string, id: string) =>
    readRecord(principal, id) ?? fail('COMPARISON_NOT_FOUND', 'Comparison does not exist')
  const last = (principal: string, id: string) => decode(latest.get(principal, id))
  function append(
    principal: string,
    id: string,
    cuts: ComparisonJournalCuts,
    fact: ComparisonJournalFact,
    treeCuts?: ComparisonTreeCuts,
  ): ComparisonJournalEntry {
    const inherited = structuredClone(treeCuts ?? last(principal, id)?.treeCuts)
    if (!treeCuts && inherited)
      for (const side of sides) {
        const tree = inherited[side]
        const root = requireRecord(principal, id).lanes[side]?.sessionId
        const member = tree?.members.find((value) => value.sessionId === root)
        if (member && member.throughSeq !== cuts[side]) {
          member.throughSeq = cuts[side]
          if (tree) {
            tree.complete = false
            tree.issues = [...new Set([...tree.issues, 'tree_capture_pending'])]
          }
        }
      }
    const entry = {
      seq: (last(principal, id)?.seq ?? 0) + 1,
      cuts: { left: cuts.left, right: cuts.right },
      fact,
      ...(inherited ? { treeCuts: structuredClone(inherited) } : {}),
    }
    integer(entry.seq, 'journal sequence', 1)
    insert.run(
      principal,
      id,
      entry.seq,
      JSON.stringify(entry),
      fact.kind === 'lane' ? fact.side : null,
      fact.kind === 'lane' ? fact.localSeq : null,
    )
    return entry
  }
  function checkpoint(
    principal: string,
    id: string,
    input: Parameters<ComparisonJournalStore['checkpoint']>[1],
  ) {
    const record = requireRecord(principal, id)
    const head = last(principal, id)
    if (!['baseline', 'recovery', 'legacy'].includes(input.reason))
      fail('JOURNAL_INVALID_ARGUMENT', 'Invalid checkpoint reason')
    if (!head && input.reason !== 'legacy')
      fail('JOURNAL_CHECKPOINT_REQUIRED', 'Existing comparison requires a legacy checkpoint')
    if (head && input.reason === 'legacy')
      fail('JOURNAL_INVALID_ARGUMENT', 'Legacy checkpoint must be the first journal entry')
    for (const side of sides) {
      if (!record.lanes[side]) fail('JOURNAL_IDENTITY_CONFLICT', 'Checkpoint requires both comparison lanes')
      integer(input.cuts[side], `${side} cut`)
      if (input.cuts[side] < (head?.cuts[side] ?? 0))
        fail('JOURNAL_CUT_REGRESSION', 'Checkpoint cannot decrease ledger cuts')
    }
    if (input.treeCuts) {
      if (!validateAgainst(TreeCutsSchema, input.treeCuts).ok)
        fail('JOURNAL_INVALID_ARGUMENT', 'Invalid delegated tree cut')
      for (const side of sides) {
        const tree = input.treeCuts[side]
        if (!tree) continue
        const root = record.lanes[side]?.sessionId
        const ids = new Set(tree.members.map((member) => member.sessionId))
        if (ids.size !== tree.members.length) fail('JOURNAL_IDENTITY_CONFLICT', 'Duplicate tree member')
        for (const member of tree.members) {
          if (
            member.inheritedThroughSeq > member.throughSeq ||
            (member.sessionId === root
              ? member.parentSessionId !== null || member.throughSeq !== input.cuts[side]
              : member.parentSessionId === null)
          )
            fail('JOURNAL_IDENTITY_CONFLICT', 'Tree member binding differs')
          const old = head?.treeCuts?.[side]?.members.find((value) => value.sessionId === member.sessionId)
          if (
            old &&
            (old.parentSessionId !== member.parentSessionId ||
              old.inheritedThroughSeq !== member.inheritedThroughSeq ||
              canonicalJson(old.runtime) !== canonicalJson(member.runtime) ||
              old.throughSeq > member.throughSeq)
          )
            fail('JOURNAL_IDENTITY_CONFLICT', 'Tree member identity or cut regressed')
        }
        if (
          tree.complete &&
          (!root ||
            !ids.has(root) ||
            tree.members.some(
              (member) => member.parentSessionId !== null && !ids.has(member.parentSessionId),
            ))
        )
          fail('JOURNAL_IDENTITY_CONFLICT', 'Complete tree membership is missing')
      }
    }
    return append(
      principal,
      id,
      input.cuts,
      {
        kind: 'checkpoint',
        reason: input.reason,
        coverage: input.reason === 'legacy' ? 'per-lane-only' : 'unknown-interleaving',
      },
      input.treeCuts,
    )
  }
  return {
    coordinator(principal: string, previous: ComparisonRecord | undefined, next: ComparisonRecord) {
      if (previous && !last(principal, next.id)) {
        // A legacy CAS cannot reconstruct earlier coordinator transitions or lane interleaving.
        const cuts = { left: previous.lanes.left?.lastSeq ?? 0, right: previous.lanes.right?.lastSeq ?? 0 }
        for (const side of sides) integer(cuts[side], `${side} legacy cut`)
        append(principal, next.id, cuts, { kind: 'checkpoint', reason: 'legacy', coverage: 'per-lane-only' })
      }
      append(principal, next.id, last(principal, next.id)?.cuts ?? { left: 0, right: 0 }, coordinator(next))
    },
    scoped(principal: string): ComparisonJournalStore {
      return {
        async head(id) {
          const record = requireRecord(principal, id)
          const entry = last(principal, id)
          return (
            entry && {
              seq: entry.seq,
              cuts: entry.cuts,
              coverage: legacy.get(principal, id)
                ? 'per-lane-only'
                : gaps.get(principal, id)
                  ? 'unknown-interleaving'
                  : 'ordered',
              bindings: bindings(record),
            }
          )
        },
        async checkpoint(id, input) {
          return comparisonTransaction(db, () => checkpoint(principal, id, input))
        },
        async appendLane(id, input) {
          return comparisonTransaction(db, () => {
            const record = requireRecord(principal, id)
            if (!sides.includes(input.side) || record.lanes[input.side]?.sessionId !== input.sessionId)
              fail('JOURNAL_IDENTITY_CONFLICT', 'Source does not match the comparison lane')
            integer(input.localSeq, 'local sequence', 1)
            if (!/^[a-f0-9]{64}$/.test(input.digest))
              fail('JOURNAL_INVALID_ARGUMENT', 'Expected a SHA-256 event digest')
            const old = decode(source.get(principal, id, input.side, input.localSeq))
            if (old) {
              if (
                old.fact.kind === 'lane' &&
                old.fact.sessionId === input.sessionId &&
                old.fact.digest === input.digest
              )
                return old
              fail('JOURNAL_SOURCE_CONFLICT', 'Source sequence has a different digest')
            }
            const head =
              last(principal, id) ??
              fail('JOURNAL_CHECKPOINT_REQUIRED', 'Existing comparison requires a legacy checkpoint')
            if (input.localSeq !== head.cuts[input.side] + 1)
              fail('JOURNAL_SEQUENCE_GAP', 'Source sequence must immediately follow the committed lane cut')
            return append(
              principal,
              id,
              { ...head.cuts, [input.side]: input.localSeq },
              {
                kind: 'lane',
                side: input.side,
                sessionId: input.sessionId,
                localSeq: input.localSeq,
                digest: input.digest,
              },
            )
          })
        },
        async read(id, options = {}) {
          requireRecord(principal, id)
          const headSeq = last(principal, id)?.seq ?? 0
          const afterSeq = options.afterSeq ?? 0
          const throughSeq = options.throughSeq ?? headSeq
          const limit = options.limit ?? 100
          const maxBytes = options.maxBytes ?? 256 * 1024
          integer(afterSeq, 'afterSeq')
          integer(throughSeq, 'throughSeq')
          integer(limit, 'limit', 1, 1000)
          integer(maxBytes, 'maxBytes', 2, 4 * 1024 * 1024)
          if (afterSeq > throughSeq || throughSeq > headSeq)
            fail('JOURNAL_INVALID_ARGUMENT', 'Invalid journal page window')
          const entries: ComparisonJournalEntry[] = []
          let bytes = 2
          for (const row of range.all(principal, id, afterSeq, throughSeq, limit)) {
            const entry = decode(row) ?? fail('JOURNAL_PAGE_MISSING', 'Journal entry is missing')
            if (entry.seq !== afterSeq + entries.length + 1)
              fail('JOURNAL_PAGE_MISSING', 'Journal page contains a sequence gap')
            const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (entries.length ? 1 : 0)
            if (bytes + size > maxBytes) {
              if (!entries.length)
                fail('JOURNAL_ENTRY_TOO_LARGE', 'One journal entry exceeds the page byte limit')
              break
            }
            entries.push(entry)
            bytes += size
          }
          const nextAfterSeq = entries.at(-1)?.seq ?? afterSeq
          if (!entries.length && nextAfterSeq < throughSeq)
            fail('JOURNAL_PAGE_MISSING', 'Journal page is missing')
          return { entries, afterSeq, throughSeq, nextAfterSeq, complete: nextAfterSeq === throughSeq }
        },
        async cutsAt(id, seq) {
          requireRecord(principal, id)
          integer(seq, 'journal sequence')
          if (seq === 0) return { left: 0, right: 0 }
          return (
            decode(one.get(principal, id, seq))?.cuts ??
            fail('JOURNAL_PAGE_MISSING', 'Journal cut does not exist')
          )
        },
        async treeCutsAt(id, seq) {
          requireRecord(principal, id)
          integer(seq, 'journal sequence')
          if (seq === 0) return undefined
          const entry =
            decode(one.get(principal, id, seq)) ?? fail('JOURNAL_PAGE_MISSING', 'Journal cut does not exist')
          return entry.treeCuts
        },
      }
    },
  }
}
