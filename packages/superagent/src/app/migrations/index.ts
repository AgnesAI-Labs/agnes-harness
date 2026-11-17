// Adapted from dsh-superagent (MIT)
/**
 * Database schema versions and the steps that move an older database to the current one. A database starts empty at
 * `SCHEMA_VERSION`; a later schema adds a `migrations/v<N>.ts` that moves a version N-1 database to N and registers it in
 * `MIGRATIONS`. Databases written by dsh-superagent (schema 10) are not imported, so the oldest schema opened is the first one.
 */
import type { Store } from '../store.js'

/** The database schema version this build writes. */
export const SCHEMA_VERSION = 11
/** The oldest database schema version this build can open and migrate directly. */
export const OLDEST_SCHEMA = 11
/** Returns an error message explaining why `version` cannot be opened: older schemas need a new state directory. */
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}, which this version cannot migrate; start with a new state directory`

/** One migration: rewrites a database at schema `to - 1` into its schema `to` shape, inside the caller's transaction. */
export interface Migration {
  readonly to: number
  run(store: Store): void
}
/** Migrations in ascending order of `to`, each moving the version before it. */
export const MIGRATIONS: readonly Migration[] = []

/** Runs one migration step, prefixing any thrown error with the name of the record that failed. */
export function step<T>(record: string, work: () => T): T {
  try {
    return work()
  } catch (error) {
    throw new Error(`${record}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** Applies every migration after schema `from` in order; the caller then records `SCHEMA_VERSION`. */
export function migrate(store: Store, from: number, migrations: readonly Migration[] = MIGRATIONS): void {
  for (const migration of migrations) {
    if (migration.to > from && migration.to <= SCHEMA_VERSION)
      step(`schema ${migration.to}`, () => migration.run(store))
  }
}
