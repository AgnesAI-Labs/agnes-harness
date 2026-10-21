import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Flushes one entry: `full` also asks the drive to persist everything it was handed so far. */
export type EntryFlush = (path: string, directory: boolean, full: boolean) => void

/**
 * Makes a tree durable with one drive cache flush instead of one per entry. Every regular file and
 * directory (the same entries `syncTreeSync` flushes, children before parents) is first handed to the
 * drive; the final full flush through `root` then drains the drive cache, which covers everything handed
 * to it before. A record that names the tree may be published only after this returns.
 */
export function syncTreeBatched(root: string, flush: EntryFlush): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) flush(child, false, false)
    }
    flush(directory, true, false)
  }
  visit(root)
  flush(root, true, true)
}
