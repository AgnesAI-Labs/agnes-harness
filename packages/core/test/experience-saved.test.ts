import type { Event } from '@agnes/core-common/types'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import { describe, expect, it } from 'vitest'
import { applyRefine } from '../src/refine/apply.js'
import { refinementFacade } from '../src/refinement/facade.js'
import type { RefinementWorkspaceRefs, SavedEntry } from '../src/refinement/workspace-refs.js'
import { deriveExperienceNotes, EXPERIENCE_PREFIX, type ExperienceNote } from '../src/request/experience.js'
import { CONTROL_FORMAT_LINE } from '../src/request/experience-control.js'
import { REFINEMENT_GUIDANCE } from '../src/request/experience-guidance.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const pid = (n: number) => `r${String(n).padStart(10, '0')}`
const saved = (n: number, over: Partial<SavedEntry> = {}): SavedEntry => ({
  ref: `ws.${pid(n)}`,
  kind: 'memory',
  title: `Saved ${n}`,
  content: `lesson number ${n}`,
  version: `h${n}`,
  savedAt: 1_000 + n,
  untouched: true,
  ...over,
})

/** A host port whose saved entries a test sets; its revision moves with every change. */
function port(initial: SavedEntry[], o: { fail?: boolean; hang?: boolean } = {}) {
  let list = initial
  let revision = 1
  let calls = 0
  const refs: RefinementWorkspaceRefs = {
    list: () => [],
    renew: () => false,
    entries: async () => {
      calls++
      if (o.fail) throw new Error('memory is unavailable')
      if (o.hang) return new Promise<readonly SavedEntry[]>(() => undefined)
      return list
    },
    revision: () => `r${revision}`,
  }
  return {
    refs,
    set(next: SavedEntry[]) {
      list = next
      revision++
    },
    calls: () => calls,
  }
}

async function open(refs: RefinementWorkspaceRefs, over: { refinementEnabled?: () => boolean } = {}) {
  return openSession({
    provider: fakeProvider([textTurn('ok')]),
    refinementEnabled: over.refinementEnabled ?? (() => true),
    refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: refs },
  })
}

let seq = 0
const note = (text: string, data?: string): SurfaceNode => {
  seq++
  return {
    seq,
    kind: 'user',
    pinned: false,
    event: {
      seq,
      ts: '2026-11-05T00:00:00.000Z',
      id: `note-${seq}`,
      type: 'user/message',
      // Core's header first; the entry lines, when there are any, ride the second block.
      data: {
        kind: 'runtime_context',
        content: [{ type: 'text', text }, ...(data ? [{ type: 'text', text: data }] : [])],
      },
      actor,
      origin: 'system',
      trust: data ? 'untrusted' : 'trusted',
      lane: 'main',
      v: 1,
    } as Event,
  }
}
const ask = (text: string): SurfaceNode => {
  seq++
  return {
    seq,
    kind: 'user',
    pinned: false,
    event: {
      seq,
      ts: '2026-11-05T00:00:00.000Z',
      id: `ask-${seq}`,
      type: 'user/message',
      data: { content: [{ type: 'text', text }] },
      actor,
      origin: 'principal',
      trust: 'untrusted',
      lane: 'main',
      v: 1,
    } as Event,
  }
}
/** A delivered note as the surface holds it: the trusted header and the entry lines in one text. */
const delivered = (n: ExperienceNote): SurfaceNode => note(`${n.prefix}${n.text}`, n.data)
const textOf = (notes: ExperienceNote[]) => notes.map((n) => `${n.text}\n${n.data ?? ''}`).join('\n')

const entry = (kind: HarnessEntry['kind'], id: string, title: string, content: string): HarnessEntry => ({
  kind,
  id,
  title,
  content,
  scope: 'local',
  version: 1,
  source: 'refine',
})
async function apply(session: Awaited<ReturnType<typeof open>>['session'], entries: HarnessEntry[]) {
  const r = await applyRefine(
    session,
    {
      proposalId: `p-${entries.map((e) => e.id).join('-')}`,
      runId: `p-${entries.map((e) => e.id).join('-')}`,
      trigger: 'manual',
      edits: entries.map((value) => ({ op: 'upsert', entry: value })),
      baseline: [],
      rationale: 'fixture',
      evidenceSeqs: [1],
    } as never,
    { maxEdits: 50, maxChars: 4000, safetyCap: 50 },
  )
  expect(r.outcome).toBe('applied')
}

describe('entries saved in earlier sessions reach the model through the snapshot', () => {
  it('a new session snapshot carries saved entries, top 3 per kind, the rest counted', async () => {
    for (const n of [10, 200]) {
      const p = port(Array.from({ length: n }, (_, i) => saved(i + 1)))
      const { session } = await open(p.refs)
      const notes = await deriveExperienceNotes(session, [ask('first request')])
      const text = textOf(notes)
      expect(text.split('\n').filter((line) => line.includes('(saved)'))).toHaveLength(3)
      expect(text).toMatch(/^- \[memory\/ws\.r\d{10} v1\] \(saved\) Saved \d+: lesson number \d+$/mu)
      expect(text).toContain(
        `${n - 3} more memory entries are not shown here (including any saved from earlier sessions); use harness_inspect to list them.`,
      )
    }
  })

  it('a session entry with the same id, the same source or the same text appears once', async () => {
    const p = port([
      saved(1, { ref: 'ws.r0000000001', title: 'Same id', content: 'old text' }),
      saved(2, {
        title: 'From here',
        content: 'saved copy',
        source: { sessionKey: 'k', kind: 'memory', entryId: 'mine' },
      }),
      saved(3, { title: 'Same text', content: 'identical lesson' }),
      saved(4, { kind: 'prompt', title: 'Kept', content: 'a different saved lesson' }),
    ])
    const { session } = await open(p.refs)
    await apply(session, [
      entry('memory', 'ws.r0000000001', 'Same id', 'rewritten text'),
      entry('memory', 'mine', 'From here', 'session copy'),
      entry('memory', 'other', 'Same text', 'identical  lesson'),
    ])
    const text = textOf(await deriveExperienceNotes(session, [ask('Same id From here Same text Kept')]))
    expect(text).toContain('(saved) Kept: a different saved lesson')
    expect(text).toContain('rewritten text')
    expect(text).not.toContain('old text')
    expect(text).toContain('session copy')
    expect(text).not.toContain('saved copy')
    expect(text.match(/identical/g)).toHaveLength(1)
    expect(text.split('\n').filter((line) => line.includes('(saved)'))).toHaveLength(1)
  })

  it('a saved entry larger than the body budget is counted, not thrown', async () => {
    // About 2,350 tokens: more than the body budget and all the metadata budget it may borrow.
    const p = port([saved(1, { title: '长段中文', content: '这是一条很长的经验。'.repeat(400) })])
    const { session } = await open(p.refs)
    const text = textOf(await deriveExperienceNotes(session, [ask('长段中文')]))
    expect(text).not.toContain('这是一条很长的经验')
    expect(text).toContain('1 entry was left out to fit the context budget')
  })

  it('a failed listing still sends the snapshot and withdraws nothing', async () => {
    const good = port([saved(1)])
    const { session, storage } = await open(good.refs)
    const first = await deriveExperienceNotes(session, [ask('Saved 1')])
    expect(textOf(first)).toContain('(saved) Saved 1')
    const surface = [ask('Saved 1'), ...first.map(delivered), ask('next')]
    const failing = port([], { fail: true })
    const reopened = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      storage,
      refinementEnabled: () => true,
      refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: failing.refs },
    })
    expect(textOf(await deriveExperienceNotes(reopened.session, surface))).not.toContain('withdrawn')
    // A cold boundary with a failed listing gives the snapshot without saved entries.
    const cold = await deriveExperienceNotes(reopened.session, [ask('new')])
    expect(cold[0]?.text.startsWith(REFINEMENT_GUIDANCE)).toBe(true)
  })

  it('a listing that hangs is given up after a second', async () => {
    const p = port([saved(1)], { hang: true })
    const { session } = await open(p.refs)
    const notes = await deriveExperienceNotes(session, [ask('Saved 1')])
    expect(notes[0]?.text.startsWith(REFINEMENT_GUIDANCE)).toBe(true)
    expect(textOf(notes)).not.toContain('(saved)')
    expect(p.calls()).toBe(1)
  }, 5_000)

  it('a withdrawn saved entry gets a control line, also after a host restart', async () => {
    const p = port([saved(1), saved(2)])
    const { session, storage } = await open(p.refs)
    const first = await deriveExperienceNotes(session, [ask('Saved 1 Saved 2')])
    const surface = [ask('Saved 1 Saved 2'), ...first.map(delivered), ask('next')]
    expect(await deriveExperienceNotes(session, surface)).toEqual([])
    p.set([saved(2)])
    const control = textOf(await deriveExperienceNotes(session, surface))
    expect(control).toContain(CONTROL_FORMAT_LINE)
    expect(control).toContain('[memory/ws.r0000000001 v1] withdrawn')
    // A new session object over the same ledger (the host restarted) decides the same.
    const restarted = port([saved(2)])
    const reopened = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      storage,
      refinementEnabled: () => true,
      refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: restarted.refs },
    })
    expect(textOf(await deriveExperienceNotes(reopened.session, surface))).toContain(
      '[memory/ws.r0000000001 v1] withdrawn',
    )
  })

  it('a withdrawn saved entry in force again is given again', async () => {
    const p = port([saved(1)])
    const { session } = await open(p.refs)
    const first = await deriveExperienceNotes(session, [ask('Saved 1')])
    p.set([])
    const withdrawn = await deriveExperienceNotes(session, [
      ask('Saved 1'),
      ...first.map(delivered),
      ask('a'),
    ])
    expect(textOf(withdrawn)).toContain('[memory/ws.r0000000001 v1] withdrawn')
    p.set([saved(1)])
    const surface = [ask('Saved 1'), ...first.map(delivered), ask('a'), ...withdrawn.map(delivered), ask('b')]
    expect(textOf(await deriveExperienceNotes(session, surface))).toContain('(saved) Saved 1')
  })

  it('a cold boundary lists the saved entries again, whatever the cached revision says', async () => {
    const p = port([saved(1, { content: 'old text' })])
    p.refs.revision = () => 'unchanging'
    const { session } = await open(p.refs)
    expect(textOf(await deriveExperienceNotes(session, [ask('Saved 1')]))).toContain('old text')
    p.set([saved(1, { content: 'text a person edited' })])
    // The revision did not move (a hand edit of the file): the next snapshot still reads the file.
    const cold = textOf(await deriveExperienceNotes(session, [ask('Saved 1')]))
    expect(cold).toContain('text a person edited')
    expect(cold).not.toContain('old text')
  })

  it('a listing that fails at the cold boundary is tried again on the next request', async () => {
    const p = port([saved(1)])
    let fail = true
    const entries = p.refs.entries
    p.refs.entries = async (at) => {
      if (fail) throw new Error('busy')
      return entries?.(at) ?? []
    }
    const { session } = await open(p.refs)
    const first = await deriveExperienceNotes(session, [ask('Saved 1')])
    expect(textOf(first)).not.toContain('(saved)')
    fail = false
    const next = await deriveExperienceNotes(session, [ask('Saved 1'), ...first.map(delivered), ask('again')])
    expect(textOf(next)).toContain('(saved) Saved 1')
  })

  it('a format 1 surface with nothing saved lists the saved entries once, not on every request', async () => {
    const p = port([])
    const { session } = await open(p.refs)
    const legacy = note(`${EXPERIENCE_PREFIX}Task experience snapshot, format 1.\nOld guidance.`)
    for (const text of ['a', 'b', 'c']) await deriveExperienceNotes(session, [legacy, ask(text)])
    expect(p.calls()).toBe(1)
  })

  it('a reset notice gives the saved entries still in force again', async () => {
    const all = Array.from({ length: 15 }, (_, i) => saved(i + 1))
    const p = port(all)
    const { session } = await open(p.refs)
    const snapshot = await deriveExperienceNotes(session, [ask('x')])
    // An update that delivered all fifteen, then fourteen of them are withdrawn at once.
    const update = note(
      `${EXPERIENCE_PREFIX}Task experience update, format 1.`,
      all.map((e) => `- [memory/${e.ref} v1] (saved) ${e.title}: ${e.content}`).join('\n'),
    )
    p.set([saved(15)])
    const notes = await deriveExperienceNotes(session, [
      ask('x'),
      ...snapshot.map(delivered),
      update,
      ask('y'),
    ])
    expect(textOf(notes)).toContain('No task-experience note before this one applies any longer')
    expect(textOf(notes)).toContain('(saved) Saved 15')
  })

  it("another session's new save waits for the next cold boundary", async () => {
    const p = port([saved(1)])
    const { session } = await open(p.refs)
    const first = await deriveExperienceNotes(session, [ask('Saved 1 Saved 2')])
    const surface = [ask('Saved 1 Saved 2'), ...first.map(delivered), ask('next')]
    p.set([saved(1), saved(2)])
    expect(textOf(await deriveExperienceNotes(session, surface))).not.toContain('Saved 2')
    expect(textOf(await deriveExperienceNotes(session, [ask('Saved 1 Saved 2')]))).toContain(
      '(saved) Saved 2',
    )
  })

  it('sends no saved entries while refinement is off', async () => {
    const p = port([saved(1)])
    const { session } = await open(p.refs, { refinementEnabled: () => false })
    expect(await deriveExperienceNotes(session, [ask('Saved 1')])).toEqual([])
    expect(p.calls()).toBe(0)
  })

  it('a surface whose snapshot is format 1 gets the saved entries once', async () => {
    const p = port([saved(1)])
    const { session } = await open(p.refs)
    const legacy = note(`${EXPERIENCE_PREFIX}Task experience snapshot, format 1.\nOld guidance.`)
    const notes = await deriveExperienceNotes(session, [ask('Saved 1'), legacy, ask('again')])
    expect(textOf(notes)).toContain('(saved) Saved 1')
    const after = [ask('Saved 1'), legacy, ...notes.map(delivered), ask('later')]
    expect(await deriveExperienceNotes(session, after)).toEqual([])
  })

  it('ranking weighs the current request over earlier messages', async () => {
    const p = port([
      saved(1, { title: 'alpha', content: 'alpha alpha alpha' }),
      // The oldest saved entry: on a tie it would be the one left out.
      saved(2, { title: 'beta', content: 'beta', savedAt: 0 }),
      saved(3, { title: 'gamma', content: 'gamma' }),
      saved(4, { title: 'delta', content: 'delta' }),
    ])
    const { session } = await open(p.refs)
    // Earlier messages repeat alpha, gamma and delta; the current request is about beta.
    const surface = [ask('alpha alpha gamma gamma delta delta'), ask('alpha gamma delta'), ask('beta please')]
    const text = textOf(await deriveExperienceNotes(session, surface))
    expect(text).toContain('(saved) beta')
  })

  it('on a tie, session entries come first, then the newest saved entries', async () => {
    const p = port([saved(1, { savedAt: 1 }), saved(2, { savedAt: 3 }), saved(3, { savedAt: 2 })])
    const { session } = await open(p.refs)
    await apply(session, [entry('memory', 'live', 'Live', 'unrelated')])
    const text = textOf(await deriveExperienceNotes(session, [ask('nothing in common')]))
    const shown = text.split('\n').filter((line) => line.startsWith('- ['))
    expect(shown.map((line) => line.match(/\[memory\/([^ ]+)/)?.[1])).toEqual([
      'live',
      'ws.r0000000002',
      'ws.r0000000003',
    ])
  })
})

describe('saved entries through the inspect and propose tools, and the snapshot row', () => {
  const settings = { enabled: true, mode: 'manual' as const, revision: 'r1' }
  async function withTurn(refs: RefinementWorkspaceRefs) {
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('answer'), textTurn('answer')]),
      refinementEnabled: () => true,
      refinement: { settings: () => ({ ...settings }), planner: () => undefined, workspaceRefs: refs },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'Saved 1 please' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    return { session, log, facade: refinementFacade(session) }
  }

  it('harness_inspect lists and reads saved entries', async () => {
    const t = await withTurn(port([saved(1), saved(2)]).refs)
    expect(await t.facade.inspect({ op: 'list', kind: 'memory' })).toMatchObject({
      op: 'list',
      total: 2,
      entries: [{ id: 'ws.r0000000001' }, { id: 'ws.r0000000002' }],
    })
    expect(await t.facade.inspect({ op: 'get', kind: 'memory', id: 'ws.r0000000002' })).toMatchObject({
      op: 'get',
      entry: { id: 'ws.r0000000002', title: 'Saved 2', content: 'lesson number 2', truncated: false },
    })
  })

  it('harness_propose cannot use the ws. or user. prefix for an entry of its own', async () => {
    const t = await withTurn(port([]).refs)
    for (const id of ['ws.notes', 'user.prefs'])
      expect(
        await t.facade.propose({
          rationale: 'r',
          evidenceSeqs: [1],
          edits: [{ op: 'upsert', kind: 'memory', id, title: 'Forged', content: 'forged' }],
        }),
      ).toMatchObject({ refused: 'invalid' })
  })

  it('harness_propose cannot make an entry under a saved id it has not read in full', async () => {
    const t = await withTurn(port([]).refs)
    for (const id of ['ws.r0000000009', 'user.r0000000009'])
      expect(
        await t.facade.propose({
          rationale: 'r',
          evidenceSeqs: [1],
          edits: [{ op: 'upsert', kind: 'memory', id, title: 'Forged', content: 'forged' }],
        }),
      ).toMatchObject({ refused: 'read-first' })
  })

  it('the snapshot row records the candidates, how many were saved earlier and which were included', async () => {
    const t = await withTurn(port([saved(1), saved(2)]).refs)
    const rows = await t.log.scan({ type: 'x/core/refinement-prefix-change', limit: 10 })
    expect(rows[0]?.data).toMatchObject({
      reason: 'experience-snapshot',
      candidates: { prompt: 0, memory: 2, skill: 0, subagent: 0 },
      saved: 2,
      // The most recently saved first, on a tie.
      included: ['memory/ws.r0000000002', 'memory/ws.r0000000001'],
    })
  })
})
