import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Flushes one entry: `full` also asks the drive to persist everything it was handed so far. */
export type EntryFlush = (path: string, directory: boolean, full: boolean) => void

/**
 * Makes trees durable with one drive cache flush instead of one per entry. Every regular file and
 * directory (the same entries `syncTreeSync` flushes, children before parents) under each root is first
 * handed to the drive; the final full flush through the last root then drains the drive cache, which
 * covers everything handed to it before. A record that names the trees may be published only after this
 * returns.
 */
export function syncTreeBatched(roots: readonly string[], flush: EntryFlush): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) flush(child, false, false)
    }
    flush(directory, true, false)
  }
  for (const root of roots) visit(root)
  const last = roots.at(-1)
  if (last !== undefined) flush(last, true, true)
}
