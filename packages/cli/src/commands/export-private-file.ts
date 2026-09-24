import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPrivateFileSync, renameWriteThroughSync } from '@agnes/system-node'

/** Windows export commit: new bytes are private before they replace any existing directory entry. */
export function writeWindowsPrivateExport(path: string, bytes: Uint8Array): void {
  const temporary = join(dirname(path), `.agnes-export-${randomUUID()}.tmp`)
  // Exclusive creation must succeed before cleanup owns this name.
  const fd = createPrivateFileSync(temporary)
  let committed = false
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWriteThroughSync(temporary, path)
    committed = true
  } finally {
    if (!committed) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Preserve the write/commit error; any surviving temporary remains private.
      }
    }
  }
}
