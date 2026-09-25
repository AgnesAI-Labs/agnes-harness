import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONCURRENT_SCENARIOS,
  callEventProblems,
  expectedFromGolden,
  MERGED_STATUSES,
  mergeLedgerWriteCommits,
  opMarkProblems,
  readGolden,
  recordTransitions,
  statusProjectionProblems,
  TRANSITION_SCENARIOS,
  withMintedIdsInOrder,
} from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The same reference as the in-memory run: the durable adapter must commit exactly what the
// reference implementation commits, commit by commit, program-counter cells included — with a tool
// call's adjacent transitions merged into one commit, and interleaved batches checked call by call.
describe('program-counter transitions match the recorded reference (SQLite)', () => {
  it.each(TRANSITION_SCENARIOS)('%s', async (name) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-op-golden-'))
    dirs.push(dir)
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      const recorded = await recordTransitions(name, storage)
      const reference = expectedFromGolden(readGolden(name))
      if (CONCURRENT_SCENARIOS.has(name)) {
        expect(statusProjectionProblems(recorded, reference, MERGED_STATUSES)).toEqual([])
        expect(callEventProblems(recorded, reference)).toEqual([])
      } else
        expect(withMintedIdsInOrder(recorded)).toEqual(
          withMintedIdsInOrder(mergeLedgerWriteCommits(reference)),
        )
      expect(opMarkProblems(recorded)).toEqual([])
    } finally {
      await storage.close()
    }
  })
})
