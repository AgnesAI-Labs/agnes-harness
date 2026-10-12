import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONCURRENT_SCENARIOS,
  callEventProblems,
  MERGED_STATUSES,
  opMarkProblems,
  readGolden,
  recordTransitions,
  statusProjectionProblems,
  TRANSITION_SCENARIOS,
  withMintedIdsInOrder,
} from '@agnes/core/testkit'
import type { DecisionSnapshot } from '@agnes/protocol'
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
      if (name === 'approval-sync' || name === 'approval-parked') {
        const rows = recorded.flatMap((commit) => commit.events as Array<{ type: string; data: unknown }>)
        const states = rows
          .filter((row) => row.type === 'decision/state')
          .map((row) => row.data as DecisionSnapshot)
        expect(states.map((row) => row.revision)).toEqual([1, 2, 3])
        expect(states[0]?.result).toBeNull()
        expect(states[1]?.result).toMatchObject({
          reason: 'answered',
          response: { option: 'allowed-once' },
        })
        const consume = recorded.find((commit) =>
          commit.events.some((item) => {
            const row = item as { type: string; data: unknown }
            return row.type === 'decision/state' && (row.data as DecisionSnapshot).consumption
          }),
        )
        expect(consume?.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'effect/intent',
              data: expect.objectContaining({ kind: 'tool' }),
            }),
          ]),
        )
        expect(opMarkProblems(recorded)).toEqual([])
      }
      const reference = readGolden(name)
      if (CONCURRENT_SCENARIOS.has(name)) {
        expect(statusProjectionProblems(recorded, reference, MERGED_STATUSES)).toEqual([])
        expect(callEventProblems(recorded, reference)).toEqual([])
      } else expect(withMintedIdsInOrder(recorded)).toEqual(withMintedIdsInOrder(reference))
      expect(opMarkProblems(recorded)).toEqual([])
    } finally {
      await storage.close()
    }
  })
})
