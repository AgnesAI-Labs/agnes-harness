import { describe, expect, it } from 'vitest'
import { applyRefine, rollbackRefine } from '../src/refine/apply.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

// Mirrors the NUL separator `registerKey` (src/log/storage.ts) joins a harness/entry cell's `kind`
// and `id` with, spelled via fromCharCode rather than a `\u` escape for the same reason apply.ts
// does: a literal control byte must never land in this file's own source text.
const SEP = String.fromCharCode(0)
const key = (kind: string, id: string) => `${kind}${SEP}${id}`

const limits = { maxEdits: 10, maxChars: 50, safetyCap: 2, contractPrefixMarkers: ['<contract>'] }
const entry = (id: string, content = 'c', version = 1) => ({
  kind: 'memory' as const,
  id,
  title: 't',
  content,
  scope: 'local' as const,
  version,
  source: 'refine',
})
// Every proposal carries a run id; one that does not name its own gets a fresh one.
let runCounter = 0
const proposal = (
  edits: unknown[],
  baseline: Array<{ key: string; version: number }> = [],
  evidenceSeqs = [1],
  runId = `auto-${++runCounter}`,
) =>
  ({
    proposalId: 'p',
    trigger: 'manual' as const,
    edits,
    baseline,
    rationale: 'r',
    evidenceSeqs,
    runId,
  }) as never

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

    // Every edit stale (and an untouched baseline key gone stale) is a whole-proposal conflict;
    // the mixed case (one stale, one fresh) is the partial apply covered below.
    const allStale = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m1', 'x') }], [{ key: key('memory', 'm1'), version: 9 }]),
      limits,
    )
    expect(allStale.outcome).toBe('rejected:conflict')
    const untouched = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m2') }], [{ key: key('memory', 'm1'), version: 9 }]),
      limits,
    )
    expect(untouched.outcome).toBe('rejected:conflict')
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

  it('a repeated rollback returns the original seq and writes no new row', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1', 'v1') }]), limits)
    const r2 = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m1', 'v2') }], [{ key: key('memory', 'm1'), version: 1 }]),
      limits,
    )
    const first = await rollbackRefine(session, r2.seq)
    const rowsAfterFirst = (await log.scan({ limit: 1000 })).length
    const again = await rollbackRefine(session, r2.seq)
    expect(again).toEqual(first)
    expect((await log.scan({ limit: 1000 })).length).toBe(rowsAfterFirst)
    expect(session.latest('harness/entry', key('memory', 'm1'))).toMatchObject({ content: 'v1', version: 3 })
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

// The limits the refinement apply runs under: at most 5 edits of at most 2000 chars each, and a
// safety cap of 200 counted entries per kind.
const applyLimits = { maxEdits: 5, maxChars: 2000, safetyCap: 200 }
const seedLimits = { ...applyLimits, maxEdits: 200 }
const refineRows = async (log: { scan: (q: never) => Promise<{ data: unknown }[]> }) =>
  (await log.scan({ type: 'harness/refine', limit: 1000 } as never)).map(
    (e) => e.data as Record<string, unknown>,
  )

describe('applyRefine with a run id', () => {
  it('requires a run id: the type refuses a proposal without one and a JS caller is rejected', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    const noRun = {
      proposalId: 'p',
      trigger: 'manual' as const,
      edits: [{ op: 'upsert' as const, entry: entry('m1') }],
      baseline: [],
      rationale: 'r',
      evidenceSeqs: [1],
    }
    // @ts-expect-error runId is required
    await expect(applyRefine(session, noRun, applyLimits)).rejects.toThrow(/runId/)
    await expect(applyRefine(session, { ...noRun, runId: '' }, applyLimits)).rejects.toThrow(/runId/)
    expect(await log.scan({ limit: 1000, type: 'harness/refine' })).toHaveLength(0)
  })

  it('the same runId applies once', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    const p = proposal([{ op: 'upsert', entry: entry('m1') }], [], [1], 'run-1')
    const first = await applyRefine(session, p, applyLimits)
    const again = await applyRefine(session, p, applyLimits)
    expect(first.outcome).toBe('applied')
    expect(again).toEqual(first)
    expect(await refineRows(log)).toHaveLength(1)
    expect((await log.scan({ type: 'harness/entry', limit: 10 })).length).toBe(1)
    expect(session.latest('harness/entry', key('memory', 'm1'))).toMatchObject({ version: 1 })
    // A different run with the same proposalId is a new run.
    const other = await applyRefine(
      session,
      proposal(
        [{ op: 'upsert', entry: entry('m1', 'n') }],
        [{ key: key('memory', 'm1'), version: 1 }],
        [1],
        'run-2',
      ),
      applyLimits,
    )
    expect(other.outcome).toBe('applied')
    expect(session.latest('harness/entry', key('memory', 'm1'))).toMatchObject({ version: 2 })
  })

  it('a rejected run is also final: a replay returns the recorded rejection', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    const bad = proposal([{ op: 'upsert', entry: entry('m1') }], [], [999], 'run-x')
    const first = await applyRefine(session, bad, applyLimits)
    expect(first.outcome).toBe('rejected:evidence')
    expect(await applyRefine(session, bad, applyLimits)).toEqual(first)
    expect(await refineRows(log)).toHaveLength(1)
  })

  it('one stale touched edit rejects the whole proposal and writes no harness/entry', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1', 'a') }]), applyLimits)
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m2', 'a') }]), applyLimits)
    const entryRows = async () => (await log.scan({ type: 'harness/entry', limit: 100 })).length
    const before = await entryRows()
    const r = await applyRefine(
      session,
      proposal(
        [
          { op: 'upsert', entry: entry('m1', 'stale') },
          { op: 'upsert', entry: entry('m2', 'fresh') },
          { op: 'upsert', entry: entry('m3', 'new') },
        ],
        [
          { key: key('memory', 'm1'), version: 9 },
          { key: key('memory', 'm2'), version: 1 },
        ],
        [1],
        'run-p',
      ),
      applyLimits,
    )
    expect(r).toMatchObject({ outcome: 'rejected:conflict', reason: 'stale-edit' })
    expect(await entryRows()).toBe(before)
    expect(session.latest('harness/entry', key('memory', 'm1'))).toMatchObject({ content: 'a', version: 1 })
    expect(session.latest('harness/entry', key('memory', 'm2'))).toMatchObject({ content: 'a', version: 1 })
    expect(session.latest('harness/entry', key('memory', 'm3'))).toBeUndefined()
    const rows = await log.scan({ fromSeq: r.seq, limit: 10 })
    expect(rows.map((e) => e.type)).toEqual(['harness/refine'])
    expect(rows[0]?.data).toMatchObject({
      outcome: 'rejected:conflict',
      reason: 'stale-edit',
      runId: 'run-p',
      rejectedEdits: [{ index: 0, reason: 'stale-edit' }],
    })
    // A replay of the same run is the recorded rejection, not a fresh evaluation.
    const replay = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m1', 'x') }], [], [1], 'run-p'),
      applyLimits,
    )
    expect(replay).toEqual(r)
  })

  it('a stale baseline key no edit touches is reason stale-baseline, distinct from stale-edit', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await applyRefine(session, proposal([{ op: 'upsert', entry: entry('m1') }]), applyLimits)
    const r = await applyRefine(
      session,
      proposal([{ op: 'upsert', entry: entry('m2') }], [{ key: key('memory', 'm1'), version: 9 }], [1], 'u'),
      applyLimits,
    )
    expect(r).toMatchObject({ outcome: 'rejected:conflict', reason: 'stale-baseline' })
    const rows = await refineRows(log)
    expect(rows[1]?.rejectedEdits).toBeUndefined()
    expect(session.latest('harness/entry', key('memory', 'm2'))).toBeUndefined()
  })

  it('two edits on one key reject the whole proposal', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    const r = await applyRefine(
      session,
      proposal(
        [
          { op: 'upsert', entry: entry('m1', 'a') },
          { op: 'delete', kind: 'memory', id: 'm1' },
        ],
        [],
        [1],
        'dup',
      ),
      applyLimits,
    )
    expect(r.outcome).toBe('rejected:conflict')
    expect(session.latest('harness/entry', key('memory', 'm1'))).toBeUndefined()
  })

  it('more than maxEdits, or an entry over maxChars, rejects the whole proposal as rejected:limit', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    const six = Array.from({ length: 6 }, (_, i) => ({ op: 'upsert', entry: entry(`m${i}`) }))
    expect((await applyRefine(session, proposal(six, [], [1], 'six'), applyLimits)).outcome).toBe(
      'rejected:limit',
    )
    const big = proposal([{ op: 'upsert', entry: entry('m1', 'x'.repeat(2001)) }], [], [1], 'big')
    expect((await applyRefine(session, big, applyLimits)).outcome).toBe('rejected:limit')
    expect((await refineRows(log)).map((r) => r.reason)).toEqual(['max-edits', 'max-chars'])
    expect(await log.scan({ type: 'harness/entry', limit: 10 })).toHaveLength(0)
  })

  it('at 200 live entries of a kind the whole proposal is rejected with reason capacity and nothing is deleted', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    const seed = Array.from({ length: 200 }, (_, i) => ({ op: 'upsert', entry: entry(`m${i}`) }))
    expect((await applyRefine(session, proposal(seed, [], [1], 'seed'), seedLimits)).outcome).toBe('applied')
    const before = (await log.scan({ type: 'harness/entry', limit: 1000 })).length

    const r = await applyRefine(
      session,
      proposal(
        [
          { op: 'upsert', entry: entry('m-new') },
          { op: 'upsert', entry: { ...entry('m0', 'rewritten'), version: 1 } },
        ],
        [],
        [1],
        'over',
      ),
      applyLimits,
    )
    expect(r.outcome).toBe('rejected:limit')
    const rows = await refineRows(log)
    expect(rows[rows.length - 1]).toMatchObject({ outcome: 'rejected:limit', reason: 'capacity' })
    expect((await log.scan({ type: 'harness/entry', limit: 1000 })).length).toBe(before)
    expect(session.latest('harness/entry', key('memory', 'm-new'))).toBeUndefined()
    expect(session.latest('harness/entry', key('memory', 'm0'))).toMatchObject({ content: 'c' })

    // Replacing in place (an upsert of an existing key) or a delete that makes room still applies.
    const ok = await applyRefine(
      session,
      proposal(
        [
          { op: 'delete', kind: 'memory', id: 'm1' },
          { op: 'upsert', entry: entry('m-new') },
        ],
        [],
        [1],
        'swap',
      ),
      applyLimits,
    )
    expect(ok.outcome).toBe('applied')
    // The cap is per kind: a different kind is unaffected.
    const skill = { ...entry('s1'), kind: 'skill' as const }
    expect(
      (await applyRefine(session, proposal([{ op: 'upsert', entry: skill }], [], [1], 'skill'), applyLimits))
        .outcome,
    ).toBe('applied')
  })

  it('a kind at the safety cap accepts an in-place upsert that does not grow the count', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    const seed = Array.from({ length: 200 }, (_, i) => ({ op: 'upsert', entry: entry(`m${i}`) }))
    await applyRefine(session, proposal(seed, [], [1], 'seed'), seedLimits)
    const r = await applyRefine(
      session,
      proposal(
        [{ op: 'upsert', entry: entry('m7', 'rewritten') }],
        [{ key: key('memory', 'm7'), version: 1 }],
        [1],
        'in-place',
      ),
      applyLimits,
    )
    expect(r.outcome).toBe('applied')
    expect(session.latest('harness/entry', key('memory', 'm7'))).toMatchObject({
      content: 'rewritten',
      version: 2,
    })
  })

  it('entries handed off do not count toward the cap', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    // No handoff marker exists on entries yet; the counting predicate is the seam it will plug into.
    const isCounted = (e: { source: string }) => e.source !== 'handed-off'
    const limitsWithMarker = { ...seedLimits, safetyCap: 5, isCounted }
    const seed = Array.from({ length: 8 }, (_, i) => ({
      op: 'upsert',
      entry: { ...entry(`m${i}`), source: i < 4 ? 'handed-off' : 'refine' },
    }))
    // 4 handed-off + 4 counted: under a cap of 5 only the counted ones weigh.
    expect(
      (await applyRefine(session, proposal(seed, [], [1], 'seed'), { ...limitsWithMarker, safetyCap: 5 }))
        .outcome,
    ).toBe('applied')
    expect(
      (
        await applyRefine(
          session,
          proposal([{ op: 'upsert', entry: entry('a') }], [], [1], 'a'),
          limitsWithMarker,
        )
      ).outcome,
    ).toBe('applied')
    expect(
      (
        await applyRefine(
          session,
          proposal([{ op: 'upsert', entry: entry('b') }], [], [1], 'b'),
          limitsWithMarker,
        )
      ).outcome,
    ).toBe('rejected:limit')
    // Without the predicate every live entry counts.
    expect(
      (
        await applyRefine(session, proposal([{ op: 'upsert', entry: entry('c') }], [], [1], 'c'), {
          ...seedLimits,
          safetyCap: 5,
        })
      ).outcome,
    ).toBe('rejected:limit')
  })
})
