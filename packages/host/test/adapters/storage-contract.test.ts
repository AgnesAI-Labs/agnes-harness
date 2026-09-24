import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorage } from '@agnes/core'
import { describe } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { ev } from './events.js'
import { scanPageContract } from './scan-page-contract.js'
import { claimContract, opWriteContract, storageContract } from './storage-contract.js'

// Both adapters run the same suite. One of them going green alone would say the durable adapter and
// the in-memory reference have drifted, which is what a session resuming on the other one would
// discover much later and much more expensively.
describe('StorageAdapter contract', () => {
  storageContract('memory', () => new MemoryStorage(), ev)
  scanPageContract('memory', () => new MemoryStorage(), ev)
  storageContract(
    'sqlite',
    () => {
      const d = mkdtempSync(join(tmpdir(), 'agnes-c-'))
      return createSqliteStorage({ file: join(d, 'sessions.db'), tablesDir: join(d, 'tables') })
    },
    ev,
  )
  claimContract('memory', (clock) => new MemoryStorage({ clock }), ev)
  claimContract(
    'sqlite',
    (clock) => {
      const d = mkdtempSync(join(tmpdir(), 'agnes-c-'))
      return createSqliteStorage({ file: join(d, 'sessions.db'), tablesDir: join(d, 'tables'), clock })
    },
    ev,
  )
  scanPageContract(
    'sqlite',
    () => {
      const d = mkdtempSync(join(tmpdir(), 'agnes-p-'))
      return createSqliteStorage({ file: join(d, 'sessions.db'), tablesDir: join(d, 'tables') })
    },
    ev,
  )
  opWriteContract('memory', () => new MemoryStorage(), ev)
  opWriteContract(
    'sqlite',
    () => {
      const d = mkdtempSync(join(tmpdir(), 'agnes-c-'))
      return createSqliteStorage({ file: join(d, 'sessions.db'), tablesDir: join(d, 'tables') })
    },
    ev,
  )
})
