import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import { describe, expect, it } from 'vitest'
import { applyRefine, entryKey } from '../src/refine/apply.js'
import { type InspectAnswer, type InspectOutcome, refinementFacade } from '../src/refinement/facade.js'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'
import { data, ofType } from './helpers/side-call-session.js'

const settings = { enabled: true, mode: 'manual' as const, revision: 'r1' }

/** A session with refinement on and one finished turn, so a proposal has evidence to cite. */
async function open(
  o: { storage?: MemoryStorage; key?: string; writerRunId?: string; outputMaxBytes?: number } = {},
) {
  const sw = { ...settings }
  const preset = presetDefaults()
  if (o.outputMaxBytes !== undefined) preset.tools.outputMaxBytes = o.outputMaxBytes
  const { session } = await openSession({
    provider: fakeProvider([textTurn('answer'), textTurn('answer'), textTurn('answer')]),
    preset,
    ...(o.storage ? { storage: o.storage } : {}),
    ...(o.key ? { key: o.key } : {}),
    ...(o.writerRunId ? { writerRunId: o.writerRunId } : {}),
    refinement: { settings: () => ({ ...sw }), planner: () => undefined },
    refinementEnabled: () => sw.enabled,
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first task' }], actor })
  await session.run({ until: 'turn-end', signal: new AbortController().signal })
  return { session, sw, facade: refinementFacade(session) }
}

type Seed = Pick<HarnessEntry, 'kind' | 'id' | 'title' | 'content'>
/** Saves entries as an apply does; `maxChars` is lifted so a legacy over-long entry can be made. */
async function seed(s: SessionImpl, entries: Seed[], runId = `seed-${entries[0]?.id}`) {
  const edits = entries.map((e) => ({
    op: 'upsert' as const,
    entry: { ...e, scope: 'local' as const, version: 1, source: 'refine' },
  }))
  const r = await s.locked(() =>
    applyRefine(
      s,
      { proposalId: runId, runId, trigger: 'manual', edits, baseline: [], rationale: 'r', evidenceSeqs: [1] },
      { maxEdits: 100, maxChars: 100_000, safetyCap: 200 },
    ),
  )
  expect(r.outcome).toBe('applied')
}

const answer = <T extends InspectAnswer['op']>(
  out: InspectOutcome,
  op: T,
): Extract<InspectAnswer, { op: T }> => {
  if (!('op' in out) || out.op !== op) throw new Error(`expected ${op}: ${JSON.stringify(out)}`)
  return out as Extract<InspectAnswer, { op: T }>
}

describe('reading entries with inspect', () => {
  it('inspect search returns 10, list pages by 20, get returns one entry', async () => {
    const { session, facade } = await open()
    const many = Array.from({ length: 25 }, (_, i) => ({
      kind: 'memory' as const,
      id: `deploy-${String(i).padStart(2, '0')}`,
      title: `Deploy step ${i}`,
      content: `Deploy with the staging profile, step ${i}. ${'detail '.repeat(40)}`,
    }))
    await seed(session, many)
    await seed(session, [{ kind: 'prompt', id: 'tone', title: 'Tone', content: 'Answer briefly.' }])

    const found = answer(await facade.inspect({ op: 'search', query: 'deploy staging' }), 'search')
    expect(found.matched).toBe(25)
    expect(found.entries).toHaveLength(10)
    for (const e of found.entries) {
      expect(e.kind).toBe('memory')
      expect([...e.summary].length).toBeLessThanOrEqual(140)
    }
    expect(answer(await facade.inspect({ op: 'search', query: 'nothing-like-this' }), 'search')).toEqual({
      op: 'search',
      entries: [],
      matched: 0,
    })

    const first = answer(await facade.inspect({ op: 'list', kind: 'memory' }), 'list')
    expect(first.total).toBe(25)
    expect(first.entries.map((e) => e.id)).toEqual(many.slice(0, 20).map((e) => e.id))
    expect(first.nextCursor).toBe('deploy-19')
    const second = answer(
      await facade.inspect({
        op: 'list',
        kind: 'memory',
        ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      }),
      'list',
    )
    expect(second.entries.map((e) => e.id)).toEqual(many.slice(20).map((e) => e.id))
    expect(second).not.toHaveProperty('nextCursor')

    const got = answer(await facade.inspect({ op: 'get', id: 'memory/deploy-03' }), 'get')
    expect(got.entry).toEqual({
      kind: 'memory',
      id: 'deploy-03',
      version: 1,
      title: 'Deploy step 3',
      content: many[3]?.content,
      truncated: false,
    })
    expect(answer(await facade.inspect({ op: 'get', id: 'tone' }), 'get').entry.content).toBe(
      'Answer briefly.',
    )
    expect(await facade.inspect({ op: 'get', id: 'missing' })).toEqual({
      refused: 'not-found',
      detail: 'missing',
    })
    expect(await facade.inspect({ op: 'list' })).toEqual({ refused: 'invalid', detail: 'kind' })
    expect(await facade.inspect({ op: 'search' })).toEqual({ refused: 'invalid', detail: 'query' })
    await session.close()
  })

  it('get returns at most 2,000 characters of a longer entry and says it was cut', async () => {
    const { session, facade } = await open()
    const long = `${'a'.repeat(1990)}MIDDLE${'b'.repeat(600)}TAIL-MUST-STAY`
    await seed(session, [{ kind: 'memory', id: 'legacy', title: 'Legacy', content: long }])
    const got = answer(await facade.inspect({ op: 'get', id: 'legacy', kind: 'memory' }), 'get')
    expect(got.entry.truncated).toBe(true)
    expect([...got.entry.content].length).toBe(2000)
    expect(got.entry.content).not.toContain('TAIL-MUST-STAY')
    await session.close()
  })

  it('reads write nothing to the ledger', async () => {
    const { session, facade } = await open()
    await seed(session, [{ kind: 'memory', id: 'm', title: 'M', content: 'kept' }])
    const before = session.lastSeq
    await facade.inspect({ op: 'search', query: 'kept' })
    await facade.inspect({ op: 'list', kind: 'memory' })
    await facade.inspect({ op: 'get', id: 'memory/m' })
    expect(session.lastSeq).toBe(before)
    await session.close()
  })

  it('inspect never returns another session’s entries', async () => {
    const storage = new MemoryStorage()
    const a = await open({ storage, key: 'a' })
    const b = await open({ storage, key: 'b' })
    await seed(a.session, [{ kind: 'memory', id: 'secret', title: 'Only in a', content: 'a-only fact' }])
    expect(answer(await a.facade.inspect({ op: 'get', id: 'memory/secret' }), 'get').entry.content).toBe(
      'a-only fact',
    )
    expect(
      answer(await b.facade.inspect({ op: 'search', query: 'a-only fact secret' }), 'search').entries,
    ).toEqual([])
    expect(answer(await b.facade.inspect({ op: 'list', kind: 'memory' }), 'list')).toEqual({
      op: 'list',
      kind: 'memory',
      entries: [],
      total: 0,
    })
    expect(await b.facade.inspect({ op: 'get', id: 'memory/secret' })).toEqual({
      refused: 'not-found',
      detail: 'memory/secret',
    })
    // A read in one session is no read in the other: b may not change an entry a has read.
    await seed(b.session, [{ kind: 'memory', id: 'secret', title: 'Only in b', content: 'b fact' }])
    const edit = { op: 'upsert' as const, kind: 'memory' as const, id: 'secret', title: 'T', content: 'x' }
    expect(await b.facade.propose({ rationale: 'r', evidenceSeqs: [1], edits: [edit] })).toEqual({
      refused: 'read-first',
      detail: 'memory/secret',
    })
    await a.session.close()
    await b.session.close()
  })

  it('is refused when refinement is off, and in a child session', async () => {
    const t = await open()
    await seed(t.session, [{ kind: 'memory', id: 'm', title: 'M', content: 'kept' }])
    t.sw.enabled = false
    expect(await t.facade.inspect({ op: 'list', kind: 'memory' })).toEqual({ refused: 'refinement-off' })
    t.sw.enabled = true
    // A child inherits its parent's entries but never plans or receives notes; it does not read them either.
    ;(t.session.d as { roleDelegation?: unknown }).roleDelegation = {}
    expect(await t.facade.inspect({ op: 'list', kind: 'memory' })).toEqual({ refused: 'child-session' })
    await t.session.close()
  })
})

describe('inspect fixes', () => {
  it('an exact id leads a search, whatever the term scores of other entries', async () => {
    const { session, facade } = await open()
    const noisy = Array.from({ length: 12 }, (_, i) => ({
      kind: 'memory' as const,
      id: `noisy-${String(i).padStart(2, '0')}`,
      title: 'target zz target',
      content: 'zz target notes',
    }))
    await seed(session, [
      ...noisy,
      { kind: 'memory', id: 'zz-target', title: 'Other', content: 'Unrelated words only.' },
    ])
    for (const query of ['zz-target', 'memory/zz-target']) {
      const found = answer(await facade.inspect({ op: 'search', query }), 'search')
      expect(found.matched, query).toBe(13)
      expect(found.entries).toHaveLength(10)
      expect(found.entries[0]?.id, query).toBe('zz-target')
    }
    await session.close()
  })
})

describe('a direct proposal changing a saved entry', () => {
  const edit = (content: string) => ({
    op: 'upsert' as const,
    kind: 'memory' as const,
    id: 'm',
    title: 'Corrected',
    content,
  })
  const proposal = (content: string) => ({ rationale: 'r', evidenceSeqs: [1], edits: [edit(content)] })

  it('needs a full read of its current version in this session', async () => {
    const { session, facade } = await open()
    await seed(session, [{ kind: 'memory', id: 'm', title: 'M', content: 'old' }])
    expect(await facade.propose(proposal('new'))).toEqual({ refused: 'read-first', detail: 'memory/m' })
    // A search shows a summary only: no read to change from.
    await facade.inspect({ op: 'search', query: 'old' })
    expect(await facade.propose(proposal('new'))).toEqual({ refused: 'read-first', detail: 'memory/m' })
    answer(await facade.inspect({ op: 'get', id: 'memory/m' }), 'get')
    const read = session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'm' }))?.seq
    const outcome = await facade.propose(proposal('new'))
    expect(outcome).toHaveProperty('runId')
    const run = session.state.refinementRuns.get((outcome as { runId: string }).runId)
    expect(run?.state).toBe('applied')
    // The version read, and the row that set it: its mutation token.
    expect(run?.plan?.baseline).toEqual([{ kind: 'memory', id: 'm', version: 1, seq: read }])
    expect(
      session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'm' }))?.value,
    ).toMatchObject({
      content: 'new',
      version: 2,
    })
    // The read was of version 1; version 2 must be read again before another change.
    expect(await facade.propose(proposal('newer'))).toEqual({ refused: 'read-first', detail: 'memory/m' })
    await session.close()
  })

  it('a cut read cannot be the base of a change', async () => {
    const { session, facade } = await open()
    const long = `${'a'.repeat(2100)}TAIL-MUST-STAY`
    await seed(session, [{ kind: 'memory', id: 'm', title: 'M', content: long }])
    expect(answer(await facade.inspect({ op: 'get', id: 'memory/m' }), 'get').entry.truncated).toBe(true)
    expect(await facade.propose(proposal('short'))).toEqual({ refused: 'read-first', detail: 'memory/m' })
    expect(
      session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'm' }))?.value.content,
    ).toBe(long)
    await session.close()
  })

  it('a read the tool output limit would cut is no full read', async () => {
    // 1,900 CJK characters are under 2,000 characters but about 5.7 KB of UTF-8, over a 4 KB limit.
    const { session, facade } = await open({ outputMaxBytes: 4096 })
    const long = `${'经验'.repeat(950)}`
    await seed(session, [{ kind: 'memory', id: 'm', title: 'M', content: long }])
    const got = answer(await facade.inspect({ op: 'get', id: 'memory/m' }), 'get')
    expect(got.entry.truncated).toBe(true)
    expect(Buffer.byteLength(got.entry.content, 'utf8')).toBeLessThanOrEqual(4096 - 512)
    expect(long.startsWith(got.entry.content)).toBe(true)
    expect(await facade.propose(proposal('short'))).toEqual({ refused: 'read-first', detail: 'memory/m' })
    expect(
      session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'm' }))?.value.content,
    ).toBe(long)
    await session.close()
    // Under the default limit the same entry is read whole.
    const wide = await open()
    await seed(wide.session, [{ kind: 'memory', id: 'm', title: 'M', content: long }])
    expect(answer(await wide.facade.inspect({ op: 'get', id: 'memory/m' }), 'get').entry.truncated).toBe(
      false,
    )
    expect(await wide.facade.propose(proposal('short'))).toHaveProperty('runId')
    await wide.session.close()
  })

  it('a read of an entry since written again at the same version does not count', async () => {
    const { session, facade } = await open()
    await seed(session, [{ kind: 'memory', id: 'm', title: 'M', content: 'old' }])
    answer(await facade.inspect({ op: 'get', id: 'memory/m' }), 'get')
    // The same version set by another row (removed and written afresh): the read was of the old cell.
    const cells = session.state.registers.harnessEntries as Map<string, { value: unknown; seq: number }>
    const key = entryKey({ kind: 'memory', id: 'm' })
    const was = cells.get(key) as { value: unknown; seq: number }
    cells.set(key, { value: was.value, seq: session.lastSeq + 1 })
    expect(await facade.propose(proposal('new'))).toEqual({ refused: 'read-first', detail: 'memory/m' })
    cells.set(key, was)
    expect(await facade.propose(proposal('new'))).toHaveProperty('runId')
    await session.close()
  })

  it('a restart forgets every read', async () => {
    const storage = new MemoryStorage()
    const first = await open({ storage, key: 'k' })
    await seed(first.session, [{ kind: 'memory', id: 'm', title: 'M', content: 'old' }])
    answer(await first.facade.inspect({ op: 'get', id: 'memory/m' }), 'get')
    await first.session.close()
    const second = await open({ storage, key: 'k', writerRunId: 'r2' })
    expect(second.session.state.registers.harnessEntries.has(entryKey({ kind: 'memory', id: 'm' }))).toBe(
      true,
    )
    expect(await second.facade.propose(proposal('new'))).toEqual({
      refused: 'read-first',
      detail: 'memory/m',
    })
    await second.session.close()
  })

  it('a saved cell without a numeric version, or with no value, is never taken as new', async () => {
    const { session, facade } = await open()
    // The schema requires a version on every row, so only a damaged register cell can lack one; it
    // is set directly. Inspect does not show such a cell, so it can never have been read.
    const cells = session.state.registers.harnessEntries as Map<string, unknown>
    const legacy = {
      kind: 'memory',
      id: 'm',
      title: 'M',
      content: 'legacy',
      scope: 'local',
      source: 'refine',
    }
    cells.set(entryKey({ kind: 'memory', id: 'm' }), { value: legacy, seq: session.lastSeq })
    expect(await facade.inspect({ op: 'get', id: 'memory/m' })).toEqual({
      refused: 'not-found',
      detail: 'memory/m',
    })
    expect(await facade.propose(proposal('new'))).toEqual({ refused: 'read-first', detail: 'memory/m' })
    // A damaged cell holding no value at all is refused the same way, without throwing.
    cells.set(entryKey({ kind: 'memory', id: 'n' }), { value: null, seq: session.lastSeq })
    const onN = { ...proposal('new'), edits: [{ ...edit('new'), id: 'n' }] }
    expect(await facade.propose(onN)).toEqual({ refused: 'read-first', detail: 'memory/n' })
    expect(
      session.state.registers.harnessEntries.get(entryKey({ kind: 'memory', id: 'm' }))?.value.content,
    ).toBe('legacy')
    await session.close()
  })

  it('may delete an entry only from a full read, and the next request withdraws it', async () => {
    const { session, facade } = await open()
    await seed(session, [{ kind: 'memory', id: 'm', title: 'M', content: 'old' }])
    const remove = { op: 'delete' as const, kind: 'memory' as const, id: 'm' }
    const del = { rationale: 'r', evidenceSeqs: [1], edits: [remove] }
    expect(await facade.propose(del)).toEqual({ refused: 'read-first', detail: 'memory/m' })
    expect(await facade.propose({ ...del, edits: [{ ...remove, id: 'missing' }] })).toEqual({
      refused: 'not-found',
      detail: 'memory/missing',
    })
    answer(await facade.inspect({ op: 'get', id: 'memory/m' }), 'get')
    const outcome = await facade.propose(del)
    const run = session.state.refinementRuns.get((outcome as { runId: string }).runId)
    expect(run?.state).toBe('applied')
    expect(session.state.registers.harnessEntries.has(entryKey({ kind: 'memory', id: 'm' }))).toBe(false)
    // What the removal left: the version it had, under a new mutation token.
    expect(session.state.refinementTombstones.get(entryKey({ kind: 'memory', id: 'm' }))).toMatchObject({
      version: 1,
    })
    await session.close()
  })
})
