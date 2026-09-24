import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemTable } from '@agnes/base/testkit'
import { afterAll, describe } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { tableContract } from './table-contract.js'

// Both implementations run one shared suite. The durable one is the host's; the in-memory one is
// what `@agnes/base`'s testkit hands a seam under test, and it lives one layer down, so this file
// is where they can be put side by side. One of them going green alone means a seam's tests are
// measuring something the seam will never meet.
const open: SqliteStorage[] = []
const dirs: string[] = []

afterAll(async () => {
  for (const s of open) await s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('TableHandle contract', () => {
  tableContract('sqlite', () => {
    const d = mkdtempSync(join(tmpdir(), 'agnes-tc-'))
    dirs.push(d)
    const s = createSqliteStorage({ file: join(d, 'sessions.db'), tablesDir: join(d, 'tables') })
    open.push(s)
    return s.tables('@agnes/base').table('t')
  })
  tableContract('memtable', () => new MemTable('t'))
})
