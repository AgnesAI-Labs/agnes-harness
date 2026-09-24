import { randomUUID } from 'node:crypto'
import { opendirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPrivateDirectorySync,
  hasPrivateDaclSync,
  windowsProcessStartTimeSync,
} from '@agnes/system-node'

const namePattern =
  /^agnes-powershell-v1-([1-9]\d{0,9})-([1-9]\d{0,19})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Only remove empty, private directories whose original owner can no longer be running. */
export function recoverPowerShellDirectories(root: string): number {
  const directory = opendirSync(root)
  let removed = 0
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (!entry.isDirectory()) continue
      const match = namePattern.exec(entry.name)
      if (!match) continue
      try {
        const owner = windowsProcessStartTimeSync(Number(match[1]))
        if (owner === match[2]) continue
        const path = join(root, entry.name)
        if (!hasPrivateDaclSync(path)) continue
        rmdirSync(path) // No recursive deletion: content, links and uncertain ownership are never traversed.
        removed++
      } catch {
        // Unknown process state, sharing conflicts, changed ACLs or nonempty directories stay intact.
      }
    }
  } finally {
    directory.closeSync()
  }
  return removed
}

export function createPowerShellDirectory(): string {
  const root = tmpdir()
  const identity = windowsProcessStartTimeSync(process.pid)
  if (identity === null) throw new Error('Cannot identify the PowerShell temporary directory owner')
  recoverPowerShellDirectories(root)
  const directory = join(root, `agnes-powershell-v1-${process.pid}-${identity}-${randomUUID()}`)
  createPrivateDirectorySync(directory)
  return directory
}
