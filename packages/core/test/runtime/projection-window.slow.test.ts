import type * as Wire from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { fail } from '../../src/runtime/projection/commands.js'
import { createProjectionProvider } from '../../src/runtime/providers/projection.js'
import { expectBoundedReads, TICKS, tickRecord } from './projection-window-fixture.js'

const NO_READS = {
  query: async () => fail('unsupported', 'no selector reads in this test'),
  resolveData: async () => fail('unsupported', 'no selector reads in this test'),
}

/** Committed records built on demand, so the journal itself is never held in memory. */
function journal() {
  const handed = { records: 0 }
  return {
    handed,
    read: async (after: number, limit: number) => {
      const out: Wire.DomainEventRecord[] = []
      for (let sequence = after + 1; sequence <= after + limit; sequence++) out.push(tickRecord(sequence))
      handed.records += out.length
      return out
    },
  }
}

function provider(total: number) {
  const source = journal()
  let limit = total
  const projection = createProjectionProvider({
    binding: TICKS.binding,
    reads: NO_READS,
    domain: TICKS.domain,
    access: TICKS.access,
    native: TICKS.native,
    journal: (after, count) => source.read(after, Math.max(0, Math.min(count, limit - after))),
    owner: {
      namespace: 'slow.ticks',
      authorityId: TICKS.authorityId,
      aggregate: { typeId: 'slow.ticks/clock@1', id: 'clock' },
      source: TICKS.binding,
      stateSchema: TICKS.domain.stateSchema,
      destination: 'runtime-inbox',
      storage: {
        transaction: async () => {
          throw new Error('commands are not used here')
        },
      },
      clock: { now: () => '2026-10-01T00:00:00Z', newId: () => 'unused' },
    },
  })
  return {
    projection,
    source,
    grow(more: number) {
      limit += more
    },
  }
}

describe.each([100_000, 1_000_000])('projection window over %i committed events', (total) => {
  it('folds incrementally and serves bounded snapshots and windows, never the whole history', async () => {
    const { projection, source, grow } = provider(total)
    await expectBoundedReads(projection, total)
    expect(source.handed.records).toBe(total)

    grow(1)
    const next = await projection.snapshot(TICKS.query, TICKS.context)
    if (!next.ok) throw new Error(next.error.message)
    expect(next.value.projectionRevision).toBe(total + 1)
    // One more record, not the history again.
    expect(source.handed.records).toBe(total + 1)
  }, 600_000)
})
