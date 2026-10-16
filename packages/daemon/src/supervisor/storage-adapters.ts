import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TableHandle, Tables } from '@agnes/daemon-foundation/storage/table'
import { createPlatform, type TableStore as HostTableStore, type ResolvedProfile } from '@agnes/host'
import { renameWriteThrough } from '@agnes/system-node'

/** Atomically replace the default profile consumed by workers acquired after activation. */
export async function persistResolvedProfile(file: string, profile: ResolvedProfile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const windows = createPlatform().os === 'win32'
    await writeFile(temporary, JSON.stringify(profile), { mode: 0o600, ...(windows ? { flush: true } : {}) })
    if (windows) await renameWriteThrough(temporary, file)
    else await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Host uses `run(sql, params)` while daemon's older narrow port uses `exec(sql, params)`. */
export function adaptHostTables(store: HostTableStore): Pick<Tables, 'table'> {
  return {
    table(name: string): TableHandle {
      const table = store.table(name)
      return {
        exec(sql, params = []) {
          if (params.length) table.run(sql, params)
          else table.exec(sql)
        },
        get: <T>(sql: string, params = []) => table.get<T>(sql, params),
        all: <T>(sql: string, params = []) => table.all<T>(sql, params),
        transaction: <T>(fn: () => T) => table.transaction(fn),
      }
    },
  }
}
