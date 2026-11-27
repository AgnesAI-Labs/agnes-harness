import { randomUUID } from 'node:crypto'
import { lstatSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { syncDirectorySync } from '@agnes/system-node'
import { fault } from './content.js'
import { missing } from './paths.js'

async function retryBusy(action: () => void): Promise<void> {
  const deadline = performance.now() + 1000
  for (;;) {
    try {
      return action()
    } catch (error) {
      if (
        !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ||
        performance.now() >= deadline
      )
        throw error
      await delay(10)
    }
  }
}

/** Move first so a concurrent replacement of the original name cannot be unlinked by mistake. */
export async function unlinkTopic(
  path: string,
  matches: (tombstone: string) => boolean,
  assertActive: () => void,
): Promise<void> {
  const tombstone = `${path}.${randomUUID()}.del.tmp`
  await retryBusy(() => {
    assertActive()
    renameSync(path, tombstone)
  })
  try {
    await retryBusy(() => {
      let verified = false
      try {
        const entry = lstatSync(tombstone)
        verified = entry.isFile() && entry.nlink === 1 && matches(tombstone)
      } catch {
        // An unreadable replacement cannot attest the reviewed bytes.
      }
      if (!verified) throw fault('MEMORY_CONFLICT')
      assertActive()
      unlinkSync(tombstone)
    })
  } catch (error) {
    // Preserve a concurrent creator's bytes if the original name has already been reclaimed.
    try {
      lstatSync(path)
    } catch (statError) {
      if (!missing(statError)) throw statError
      await retryBusy(() => renameSync(tombstone, path))
    }
    throw error
  }
}

export const syncTopicDirectory = (path: string) => retryBusy(() => syncDirectorySync(dirname(path)))
