import { describe, expect, it } from 'vitest'
import { applyRefine, rollbackRefine } from '../src/refine/apply.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

// Mirrors the NUL separator `registerKey` (src/log/storage.ts) joins a harness/entry cell's `kind`
// and `id` with, spelled via fromCharCode rather than a `\u` escape for the same reason apply.ts
// does: a literal control byte must never land in this file's own source text.
const SEP = String.fromCharCode(0)
const key = (kind: string, id: string) => `${kind}${SEP}${id}`

const limits = {
  maxEntries: { prompt: 2, memory: 2, skill: 2, subagent: 2 },
  maxCharsPerEntry: 50,
  contractPrefixMarkers: ['<contract>'],
}
const entry = (id: string, content = 'c', version = 1) => ({
  kind: 'memory' as const,
  id,
  title: 't',
  content,
  scope: 'local' as const,
  version,
  source: 'refine',
})
const proposal = (
  edits: unknown[],
  baseline: Array<{ key: string; version: number }> = [],
  evidenceSeqs = [1],
) => ({ proposalId: 'p', trigger: 'manual' as const, edits, baseline, rationale: 'r', evidenceSeqs }) as never

describe('applyRefine', () => {
  it('applies edits in one transaction and folds entries with a version bump', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    const r = await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1') }]), limits)
    expect(r.outcome).toBe('applied')
    expect((session.latest('harness/entry', key('memory', 'm1')) as { version: number }).version).toBe(1)
    // `r.seq` names the harness/refine control row, so scanning from it (inclusive) sees exactly the
    // two rows this one transaction produced — proof it committed as a single unit, not two.
    const types = (await log.scan({ fromSeq: r.seq, limit: 5 })).map((e) => e.type)
    expect(types).toEqual(['harness/refine', 'harness/entry'])

    const r2 = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m1', 'new') }], [{ key: key('memory', 'm1'), version: 1 }]),
      limits,
    )
    expect(r2.outcome).toBe('applied')
    expect(session.latest('harness/entry', key('memory', 'm1'))).toMatchObject({ version: 2, content: 'new' })
  })

  it('rejects the whole proposal on baseline conflict, limits, missing evidence and contract prefix', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1') }]), limits)

    // A mixed proposal — one edit whose baseline conflicts, one that would otherwise succeed on its
    // own — must be rejected as a whole: the second edit (m2) must never land.
    const mixed = await applyRefine(
      session,
      proposal(
        [
          { op: 'upsert', entry: entry('m1', 'x') },
          { op: 'upsert', entry: entry('m2') },
        ],
        [{ key: key('memory', 'm1'), version: 9 }],
      ),
      limits,
    )
    expect(mixed.outcome).toBe('rejected:conflict')
    expect(session.latest('harness/entry', key('memory', 'm2'))).toBeUndefined()

    expect(
      (
        await applyRefine(
          session,
          proposal([
            { op: 'upsert', entry: entry('m2') },
            { op: 'upsert', entry: entry('m3') },
          ]),
          limits,
        )
      ).outcome,
    ).toBe('rejected:limit')
    expect(
      (await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m2', 'x'.repeat(51)) }]), limits))
        .outcome,
    ).toBe('rejected:limit')
    expect(
      (await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m2') }], [], [999]), limits))
        .outcome,
    ).toBe('rejected:evidence')
    expect(
      (
        await applyRefine(
          session,
          proposal([{ op: 'upsert', entry: entry('m2', 'has <contract> inside') }]),
          limits,
        )
      ).outcome,
    ).toBe('rejected:prefix')
  })

  it('a proposal with only legitimate edits still succeeds after a rejection', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1') }]), limits)
    const rejected = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m2') }], [{ key: key('memory', 'm1'), version: 9 }]),
      limits,
    )
    expect(rejected.outcome).toBe('rejected:conflict')
    expect(session.latest('harness/entry', key('memory', 'm2'))).toBeUndefined()
    const applied = await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m2') }]), limits)
    expect(applied.outcome).toBe('applied')
    expect((session.latest('harness/entry', key('memory', 'm2')) as { version: number }).version).toBe(1)
  })

  it('rollback restores the previous value as a new refine event, not a deletion', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1', 'v1') }]), limits)
    const r2 = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m1', 'v2') }], [{ key: key('memory', 'm1'), version: 1 }]),
      limits,
    )
    await rollbackRefine(session, r2.seq)
    expect(session.latest('harness/entry', key('memory', 'm1'))).toMatchObject({ content: 'v1', version: 3 })
    // The key is still live (an upsert row, not a tombstone) — rollback is expressed forward as a
    // third refine, never by erasing the row it is undoing.
    expect(session.latest('harness/entry', key('memory', 'm1'))).not.toBeUndefined()
    const refines = await log.scan({ type: 'harness/refine', limit: 10 })
    expect(refines).toHaveLength(3)
    expect(refines[2]?.data).toMatchObject({ trigger: 'rollback', rollbackOf: r2.seq, outcome: 'applied' })
  })

  it('rollback of a delete restores the deleted entry', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1', 'v1') }]), limits)
    const del = await applyRefine(
      session,
      proposal([{ op: 'delete', kind: 'memory', id: 'm1' }], [{ key: key('memory', 'm1'), version: 1 }]),
      limits,
    )
    expect(del.outcome).toBe('applied')
    expect(session.latest('harness/entry', key('memory', 'm1'))).toBeUndefined()
    await rollbackRefine(session, del.seq)
    expect(session.latest('harness/entry', key('memory', 'm1'))).toMatchObject({ content: 'v1' })
  })
})
