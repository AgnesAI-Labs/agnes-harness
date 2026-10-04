import { lstatSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { CoreError } from '@agnes/core'

/** Fresh reads see cross-process CAS publication. No session-key or history-parent guessing. */
export function comparisonAdmissionReader(file: string) {
  let observed = false
  return (
    sessionKeys: readonly string[],
    remembered: ReadonlySet<string>,
    authorityKnown: boolean,
  ): string[] => {
    const missing = () => {
      if (observed || authorityKnown || remembered.size)
        throw new CoreError('E_CLOSED', 'Comparison admission authority disappeared')
      return []
    }
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new CoreError('E_CLOSED', 'Comparison admission authority is invalid')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing()
      throw error
    }
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comparison_session_admission'")
          .get()
      ) {
        if (
          db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comparisons'").get() &&
          db.prepare('SELECT 1 FROM comparisons LIMIT 1').get()
        )
          throw new CoreError('E_CLOSED', 'Existing comparisons have no admission authority')
        return missing()
      }
      observed = true
      const bound: string[] = []
      for (const key of sessionKeys) {
        const row = db
          .prepare('SELECT blocked,retirement FROM comparison_session_admission WHERE session_id=?')
          .get(key)
        if (!row) {
          if (remembered.has(key)) throw new CoreError('E_CLOSED', 'Comparison session binding disappeared')
          continue
        }
        if (row.blocked !== 0 || row.retirement !== 'full')
          throw new CoreError('E_CLOSED', 'Comparison tree admission is permanently sealed')
        bound.push(key)
      }
      return bound
    } finally {
      db.close()
    }
  }
}
