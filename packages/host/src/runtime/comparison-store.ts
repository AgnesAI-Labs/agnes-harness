import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ComparisonListParams, ComparisonListResult } from '@agnes/protocol'
import type { ComparisonRecord, ComparisonStore } from '@agnes/runtime-comparison'
import {
  type ComparisonAdmission,
  type ComparisonSessionKeys,
  createComparisonAdmission,
} from './comparison-admission.js'
import { createComparisonArchive } from './comparison-archive.js'
import {
  assertComparisonBindings,
  comparisonTransaction,
  createComparisonJournal,
} from './comparison-journal-store.js'
import { ComparisonJournalError, type ComparisonJournalStore } from './comparison-journal-types.js'
import { createComparisonListing } from './comparison-list.js'
import { assertComparisonRetirement } from './comparison-retirement-state.js'
import { createComparisonTreeArchive } from './comparison-tree-archive.js'

export interface ScopedComparisonStore extends ComparisonStore {
  /** Explicit history removal only after released -> removing; retains permanent identity/fences. */
  removeRetiredHistory(id: string, expectedRevision: number): Promise<ComparisonRecord>
  /** Safe summaries; no session opens, reconciliation or current model configuration reads. */
  list(params?: ComparisonListParams): Promise<ComparisonListResult>
  findSession(sessionId: string): Promise<ComparisonRecord | undefined>
  admission(sessionId: string): ComparisonAdmission | undefined
  reservedBindings(id: string): Partial<Record<'left' | 'right', string>>
  treeArchive: ReturnType<ReturnType<typeof createComparisonTreeArchive>['scoped']>
  archive: ReturnType<ReturnType<typeof createComparisonArchive>['scoped']>
  journal: ComparisonJournalStore
}

/** Private metadata only; all keys are SQL parameters and all changes cross a FULL durability barrier. */
export function createComparisonStore(
  file: string,
  options: { clock?: () => number; sessionKeys?: ComparisonSessionKeys } = {},
): {
  scoped(principal: string): ScopedComparisonStore
  assertSessionAdmitted(sessionId: string): void
  comparisonSessionIds(): string[]
  close(): void
} {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA busy_timeout=5000')
  db.exec(
    'CREATE TABLE IF NOT EXISTS comparisons (principal TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(principal,id))',
  )
  const admission = createComparisonAdmission(db, options.sessionKeys)
  comparisonTransaction(db, () => {
    for (const row of db.prepare('SELECT principal,body FROM comparisons').all())
      admission.record(String(row.principal), JSON.parse(String(row.body)) as ComparisonRecord)
  })
  const listing = createComparisonListing(db, options.clock ?? Date.now)
  const get = db.prepare('SELECT body FROM comparisons WHERE principal=? AND id=?')
  const all = db.prepare('SELECT body FROM comparisons WHERE principal=?')
  const insert = db.prepare('INSERT OR IGNORE INTO comparisons(principal,id,revision,body) VALUES(?,?,?,?)')
  const update = db.prepare(
    'UPDATE comparisons SET revision=?,body=? WHERE principal=? AND id=? AND revision=?',
  )
  const decode = (row: unknown): ComparisonRecord | undefined =>
    row === undefined ? undefined : (JSON.parse((row as { body: string }).body) as ComparisonRecord)
  const journal = createComparisonJournal(db, (principal, id) => decode(get.get(principal, id)))
  const archive = createComparisonArchive(db, (principal, id) => decode(get.get(principal, id)))
  const treeArchive = createComparisonTreeArchive(db, (principal, id) => decode(get.get(principal, id)))
  return {
    assertSessionAdmitted: admission.assert,
    comparisonSessionIds: admission.sessionIds,
    scoped(principal) {
      return {
        journal: journal.scoped(principal),
        archive: archive.scoped(principal),
        treeArchive: treeArchive.scoped(principal),
        admission(sessionId) {
          const row = admission.get(sessionId)
          return row?.principal === principal ? row : undefined
        },
        reservedBindings(id) {
          return admission.bindings(principal, id)
        },
        async list(params) {
          return listing.list(principal, params)
        },
        async read(id) {
          return decode(get.get(principal, id))
        },
        async findSession(sessionId) {
          const bound = admission.get(sessionId)
          if (bound?.principal === principal) return decode(get.get(principal, bound.id))
          for (const row of all.all(principal)) {
            const record = decode(row)
            if (record && Object.values(record.lanes).some((lane) => lane?.sessionId === sessionId))
              return record
          }
          return undefined
        },
        async removeRetiredHistory(id, expectedRevision) {
          return comparisonTransaction(db, () => {
            const previous = decode(get.get(principal, id))
            if (previous?.retirement?.state === 'removed') return previous
            if (
              !previous ||
              previous.revision !== expectedRevision ||
              previous.retirement?.state !== 'removing'
            )
              throw new ComparisonJournalError(
                'COMPARISON_RETIREMENT_CONFLICT',
                'History removal requires a matching removal fence',
              )
            const next: ComparisonRecord = {
              id,
              revision: previous.revision + 1,
              createPayload: '',
              creation: 'failed',
              retirement: { state: 'removed', epoch: previous.retirement.epoch },
              lanes: {},
              rounds: [],
              cancellation: {},
              cleanup: { exited: [], released: true },
            }
            assertComparisonRetirement(previous, next)
            if (
              update.run(next.revision, JSON.stringify(next), principal, id, previous.revision).changes !== 1
            )
              throw new ComparisonJournalError(
                'COMPARISON_RETIREMENT_CONFLICT',
                'History removal revision changed',
              )
            admission.record(principal, next)
            for (const table of [
              'comparison_journal',
              'comparison_archives',
              'comparison_tree_archives',
              'comparison_listing',
            ])
              db.prepare(`DELETE FROM ${table} WHERE principal=? AND id=?`).run(principal, id)
            return next
          })
        },
        async compareAndSwap(id, expected, next) {
          if (
            next.id !== id ||
            !Number.isSafeInteger(next.revision) ||
            next.revision < 0 ||
            (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) ||
            next.revision !== (expected === null ? 0 : expected + 1)
          )
            throw new ComparisonJournalError('JOURNAL_INVALID_ARGUMENT', 'Invalid comparison revision')
          return comparisonTransaction(db, () => {
            const previous = decode(get.get(principal, id))
            if (expected === null ? previous !== undefined : previous?.revision !== expected) return false
            assertComparisonRetirement(previous, next)
            assertComparisonBindings(previous ?? { ...next, lanes: {} }, next)
            const body = JSON.stringify(next)
            const changed =
              (expected === null
                ? insert.run(principal, id, next.revision, body)
                : update.run(next.revision, body, principal, id, expected)
              ).changes === 1
            if (changed) {
              admission.record(principal, next)
              listing.changed(principal, id, expected === null)
              journal.coordinator(principal, previous, next)
            }
            return changed
          })
        },
      }
    },
    close() {
      db.close()
    },
  }
}
