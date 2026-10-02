import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  expectBoundedReads,
  TICKS,
  tickEvent,
} from '../../../../packages/core/test/runtime/projection-window-fixture.js'
import { openProjectionStore } from './projection.js'

const BATCH = 10_000

describe.each([100_000, 1_000_000])('reference projection window over %i committed events', (total) => {
  it('serves bounded snapshots and windows from a checkpoint at the head, never the whole history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reference-projection-window-'))
    const store = openProjectionStore(join(directory, 'projection.sqlite'), TICKS)
    try {
      for (let first = 1; first <= total; first += BATCH)
        store.append(
          Array.from({ length: Math.min(BATCH, total - first + 1) }, (_, n) => tickEvent(first + n)),
        )
      // A read rebuilds from the newest checkpoint, which sits at the head, not from the journal start.
      expect(store.checkpoints().at(-1)?.revision).toBe(total)
      await expectBoundedReads(store, total)

      store.append([tickEvent(total + 1)])
      const next = await store.snapshot(TICKS.query, TICKS.context)
      if (!next.ok) throw new Error(next.error.message)
      expect(next.value.projectionRevision).toBe(total + 1)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 600_000)
})
