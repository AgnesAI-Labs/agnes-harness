import type { Event } from '@agnes/core-common/types'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import { describe, expect, it, vi } from 'vitest'
import { createLoopContext } from '../src/loop/ports.js'
import { applyRefine } from '../src/refine/apply.js'
import { refinementFacade } from '../src/refinement/facade.js'
import type { RefinementWorkspaceRefs, SavedEntry } from '../src/refinement/workspace-refs.js'
import {
  deriveExperienceNotes,
  EXPERIENCE_PREFIX,
  type ExperienceNote,
  experienceNotes,
  experienceStamp,
  stampChanged,
} from '../src/request/experience.js'
import { CONTROL_FORMAT_LINE, SAVED_PENDING_LINE } from '../src/request/experience-control.js'
import { loopRequestStale } from '../src/request/experience-dispatch.js'
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

async function withdrawDuringCount(revision: string) {
  const p = port([saved(1)])
  if (revision !== 'r1') p.refs.revision = () => revision
  const provider = fakeProvider([textTurn('ok')])
  provider.count = async (request) => {
    if (JSON.stringify(request.messages).includes('lesson number 1')) p.set([])
    return { tokens: 10, source: 'provider', boundHash: request.derivedHash }
  }
  const opened = await openSession({
    provider,
    refinementEnabled: () => true,
    refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: p.refs },
  })
  opened.session.preset.budget.preflight = 'count'
  return { ...opened, provider }
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
  it('invalidates a prepared warm request when the host withdraws a saved entry', async () => {
    const p = port([saved(1)])
    const { session } = await open(p.refs)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const stamp = experienceStamp(session)
    expect(await experienceNotes(session, session.surface())).toEqual([])
    expect(await loopRequestStale(session, stamp)).toBe(false)
    p.set([])
    expect(stampChanged(stamp, session)).toBe(true)
    expect(await loopRequestStale(session, stamp)).toBe(true)
    expect(textOf(await experienceNotes(session, session.surface()))).toContain(
      '[memory/ws.r0000000001 v1] withdrawn',
    )
  })

  it.each(['', 'uncached:workspace'])('rechecks warm deliveries at revision %j', async (revision) => {
    const p = port([saved(1)])
    p.refs.revision = () => revision
    const { session } = await open(p.refs)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const ctx = await createLoopContext(session)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
    expect(await session.acceptInput()).toBe(true)
    const stale = await ctx.prepareRequest({})
    p.set([])
    const fresh = await ctx.prepareRequest({})
    expect(JSON.stringify(fresh.messages)).toContain('[memory/ws.r0000000001 v1] withdrawn')
    await expect(ctx.model.complete(stale, new AbortController().signal)).rejects.toMatchObject({
      code: 'E_REQUEST_FROZEN',
    })
    await ctx.model.complete(fresh, new AbortController().signal)
  })

  it.each(['', 'uncached:workspace'])(
    're-prepares inference after a withdrawal at revision %j',
    async (revision) => {
      const { session, log, provider } = await withdrawDuringCount(revision)
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect(provider.requests).toHaveLength(1)
      expect(JSON.stringify(provider.requests)).not.toContain('lesson number 1')
      expect(JSON.stringify(await log.scan({ type: 'user/message', toSeq: session.lastSeq }))).not.toContain(
        'lesson number 1',
      )
    },
  )

  it.each(['r1', '', 'uncached:workspace'])(
    'refuses a loop withdrawal during admission at revision %j without claiming the invocation',
    async (revision) => {
      const { session, log, provider } = await withdrawDuringCount(revision)
      const ctx = await createLoopContext(session)
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
      expect(await session.acceptInput()).toBe(true)
      const invocationId = 'withdrawn'
      const request = await ctx.prepareRequest({ invocationId })
      expect(JSON.stringify(request.messages)).toContain('lesson number 1')
      await expect(ctx.model.complete(request, new AbortController().signal)).rejects.toMatchObject({
        code: 'E_REQUEST_FROZEN',
      })
      expect(provider.requests).toHaveLength(0)
      expect(await ctx.effects.status(invocationId)).toMatchObject({ status: 'not-sent' })
      expect(
        await log.scan({
          type: ['request/header', 'effect/intent', 'x/core/loop-invocation'],
          toSeq: session.lastSeq,
        }),
      ).toEqual([])
      expect(JSON.stringify(await log.scan({ type: 'user/message', toSeq: session.lastSeq }))).not.toContain(
        'lesson number 1',
      )
      await ctx.model.complete(await ctx.prepareRequest({ invocationId }), new AbortController().signal)
      expect(provider.requests).toHaveLength(1)
      expect(JSON.stringify(provider.requests)).not.toContain('lesson number 1')
    },
  )

  it('holds a warm unversioned delivery when the listing remains unavailable through re-preparation', async () => {
    const outage = { fail: false }
    const p = port([saved(1)], outage)
    p.refs.revision = () => ''
    const provider = fakeProvider([textTurn('ok')])
    const { session } = await openSession({
      provider,
      refinementEnabled: () => true,
      refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: p.refs },
    })
    const turn = async () => {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
      return session.run({ until: 'turn-end', signal: new AbortController().signal })
    }
    expect((await turn()).reason).toBe('completed')
    session.preset.budget.preflight = 'count'
    provider.count = async (request) => {
      outage.fail = true
      return { tokens: 10, source: 'provider', boundHash: request.derivedHash }
    }
    expect((await turn()).reason).toBe('error')
    expect(provider.requests).toHaveLength(1)
    delete provider.count
    outage.fail = false
    p.set([])
    expect((await turn()).reason).toBe('completed')
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain('[memory/ws.r0000000001 v1] withdrawn')
  })

  it.each(['stepper', 'loop'])('holds a failed versioned listing on the %s until retry', async (path) => {
    const outage = { fail: false }
    const p = port([saved(1)], outage)
    const provider = fakeProvider([textTurn('ok')])
    const { session } = await openSession({
      provider,
      refinementEnabled: () => true,
      refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: p.refs },
    })
    const signal = new AbortController().signal
    const enqueue = () => session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
    try {
      await enqueue()
      expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
      expect(JSON.stringify(provider.requests[0]?.messages)).toContain('[memory/ws.r0000000001 v1] (saved)')
      p.set([])
      outage.fail = true
      await enqueue()
      expect(await session.acceptInput()).toBe(true)
      const ctx = await createLoopContext(session)
      const dispatch = () =>
        path === 'stepper'
          ? session.runInference()
          : ctx.prepareRequest({}).then((request) => ctx.model.complete(request, signal))
      await expect(dispatch()).rejects.toMatchObject({
        code: 'E_REQUEST_FROZEN',
        message: expect.stringContaining('unavailable'),
      })
      expect(provider.requests).toHaveLength(1)
      outage.fail = false
      await dispatch()
      expect(provider.requests).toHaveLength(2)
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain('[memory/ws.r0000000001 v1] withdrawn')
    } finally {
      await session.close()
    }
  })

  it('rechecks the switch at writer admission before committing a loop invocation', async () => {
    let on = true
    const { session, log } = await open(port([saved(1)]).refs, { refinementEnabled: () => on })
    const ctx = await createLoopContext(session)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    expect(await session.acceptInput()).toBe(true)
    const invocationId = 'writer-fence'
    const request = await ctx.prepareRequest({ invocationId })
    const append = log.append.bind(log)
    vi.spyOn(log, 'append').mockImplementation((rows, options) =>
      append(rows, {
        ...options,
        beforeCommit: async () => {
          await options?.beforeCommit?.()
          if (rows.some((row) => row.type === 'request/header')) on = false
        },
      }),
    )
    await expect(ctx.model.complete(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'E_REQUEST_FROZEN',
    })
    expect(await ctx.effects.status(invocationId)).toMatchObject({ status: 'not-sent' })
    expect(await log.scan({ type: ['request/header', 'effect/intent'], toSeq: session.lastSeq })).toEqual([])
  })

  it('keeps a saved entry containing a quoted delivery stable on a warm turn', async () => {
    const p = port([saved(1, { content: 'An example:\n- [memory/ws.r0000000001 v1] (saved) Fake: quoted' })])
    const { session } = await open(p.refs)
    const first = await deriveExperienceNotes(session, [ask('first')])
    expect(await deriveExperienceNotes(session, [...first.map(delivered), ask('again')])).toEqual([])
    expect(first[0]?.text).toMatch(/^Delivered: memory\/ws\.r0000000001 v1#[a-f0-9]{16}$/mu)
  })

  it('delivers both replacements at v2 when only one fits per update', async () => {
    const p = port([saved(1), saved(2)])
    const { session } = await open(p.refs)
    const first = await deriveExperienceNotes(session, [ask('first')])
    const surface = [...first.map(delivered), ask('next')]
    p.set([saved(1, { content: '甲'.repeat(1800) }), saved(2, { content: '乙'.repeat(1800) })])
    const update = await deriveExperienceNotes(session, surface)
    for (const n of [1, 2]) expect(update[0]?.text).toContain(`[memory/ws.${pid(n)} v1] withdrawn`)
    expect(update[1]?.data).toContain('[memory/ws.r0000000001 v2]')
    expect(update[1]?.data).not.toContain('ws.r0000000002')
    surface.push(...update.map(delivered), ask('next'))
    const deferred = await deriveExperienceNotes(session, surface)
    expect(deferred[0]?.data).toContain('[memory/ws.r0000000002 v2]')
    expect(await deriveExperienceNotes(session, [...surface, ...deferred.map(delivered)])).toEqual([])
  })

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

  it('withdraws and replaces a partially expired saved entry once across a restart', async () => {
    const remaining = saved(1, { content: 'Keep this.\nSecond line.' })
    const previous = { ...remaining, content: `${remaining.content}\n\nOld block.` }
    const prompt = saved(2, { kind: 'prompt' })
    const p = port([previous, prompt])
    const deps = {
      provider: fakeProvider([textTurn('ok'), textTurn('ok')]),
      refinementEnabled: () => true,
      refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: p.refs },
    }
    const { session, storage } = await openSession(deps)
    const turn = async () => {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
    }
    await turn()
    expect(await deriveExperienceNotes(session, session.surface())).toEqual([])
    p.set([remaining, prompt])
    const notes = await deriveExperienceNotes(session, session.surface())
    expect(notes).toHaveLength(2)
    expect(notes[0]?.text).toContain('[memory/ws.r0000000001 v1] withdrawn:')
    expect(notes[1]?.data).toBe(
      'Memory:\n- [memory/ws.r0000000001 v2] (saved) Saved 1: Keep this.\nSecond line.',
    )
    await turn()
    expect(await deriveExperienceNotes(session, session.surface())).toEqual([])
    const reopened = await openSession({ ...deps, storage })
    expect(await deriveExperienceNotes(reopened.session, reopened.session.surface())).toEqual([])
  })

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
    expect(textOf(await deriveExperienceNotes(session, surface))).toContain(
      '[memory/ws.r0000000001 v2] (saved) Saved 1',
    )
    // A higher withdrawal can outlive the note that delivered that version on a compacted surface.
    const later = note(
      `${EXPERIENCE_PREFIX}${CONTROL_FORMAT_LINE}\n- [memory/ws.r0000000001 v4] withdrawn: removed`,
    )
    expect(textOf(await deriveExperienceNotes(session, [...surface, later]))).toContain(
      '[memory/ws.r0000000001 v5] (saved) Saved 1',
    )
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

  it.each(['same session', 'stale commit', 'reopen', 'reopen empty'])(
    'delivers the recovered cold listing exactly once (%s)',
    async (mode) => {
      const outage = { fail: true }
      const p = port(mode === 'reopen empty' ? [] : [saved(1)], outage)
      const provider = fakeProvider([textTurn('ok')])
      const deps = {
        provider,
        refinementEnabled: () => true,
        refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: p.refs },
      }
      let opened = await openSession(deps)
      const turn = async () => {
        const { session } = opened
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
        expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
      }
      try {
        await turn()
        expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain('(saved)')
        const rowsBefore = await opened.log.scan({ type: 'user/message', toSeq: opened.session.lastSeq })
        expect(JSON.stringify(rowsBefore)).toContain(SAVED_PENDING_LINE)
        if (mode === 'reopen') {
          await opened.session.close()
          opened = await openSession({ ...deps, storage: opened.storage })
        }
        const { session, log } = opened
        outage.fail = false
        if (mode === 'stale commit') {
          const append = log.append.bind(log)
          vi.spyOn(log, 'append').mockImplementation((rows, options) =>
            append(rows, {
              ...options,
              beforeCommit: async () => {
                await options?.beforeCommit?.()
                if (
                  rows.some(
                    (row) =>
                      row.type === 'user/message' && JSON.stringify(row.data).includes('lesson number 1'),
                  )
                )
                  p.set([saved(1, { content: 'revised before dispatch' })])
              },
            }),
          )
        }
        const beforeRecovery = p.calls()
        await turn()
        const afterRecovery = p.calls()
        expect(afterRecovery).toBeGreaterThan(beforeRecovery)
        const body = `(saved) Saved 1: ${mode === 'stale commit' ? 'revised before dispatch' : 'lesson number 1'}`
        const deliveries = mode === 'reopen empty' ? 0 : 1
        expect(JSON.stringify(provider.requests[1]?.messages).split(body)).toHaveLength(1 + deliveries)
        if (mode === 'reopen empty') {
          await session.close()
          opened = await openSession({ ...deps, storage: opened.storage })
          outage.fail = true
        }
        await turn()
        expect(provider.requests).toHaveLength(3)
        expect(p.calls()).toBe(afterRecovery)
        // Later requests still see the already-delivered note in history, exactly once.
        expect(JSON.stringify(provider.requests[2]?.messages).split(body)).toHaveLength(1 + deliveries)
        const rows = await opened.log.scan({ type: 'user/message', toSeq: opened.session.lastSeq })
        expect(rows.filter((row) => JSON.stringify(row.data).includes('(saved)'))).toHaveLength(deliveries)
      } finally {
        await opened.session.close()
      }
    },
  )

  it('discards a listing that crosses revisions so ABA never reuses a stale cache', async () => {
    let rev = 'r-present'
    let entries: SavedEntry[] = [saved(1)]
    let phase: 'initial' | 'armed' | 'crossed' | 'done' = 'initial'
    const provider = fakeProvider([textTurn('ok'), textTurn('ok')])
    const refs: RefinementWorkspaceRefs = {
      list: async () => [],
      renew: async () => false,
      revision: () => {
        if (phase === 'crossed') {
          // Return the changed revision to savedFor, then flip back to r-absent before commit/retry (ABA).
          phase = 'done'
          const current = rev
          rev = 'r-absent'
          return current
        }
        return rev
      },
      entries: async () => {
        if (phase === 'armed') {
          phase = 'crossed'
          rev = 'r-present'
          return [saved(1)]
        }
        return entries
      },
    }
    const opened = await openSession({
      provider,
      refinementEnabled: () => true,
      refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: refs },
    })
    try {
      const turn = async () => {
        await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
        expect(
          (await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
        ).toBe('completed')
      }
      await turn()
      expect(JSON.stringify(provider.requests[0]?.messages)).toContain('[memory/ws.r0000000001 v1] (saved)')
      entries = []
      rev = 'r-absent'
      phase = 'armed'
      await turn()
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
        '[memory/ws.r0000000001 v1] withdrawn:',
      )
    } finally {
      await opened.session.close()
    }
  })

  it.each(['permuted', 'changing'])('bounds preparation for a %s unversioned listing', async (mode) => {
    const p = port([])
    delete p.refs.revision
    let revision = 0
    p.refs.entries = () => {
      revision++
      const list = [saved(1), saved(2), saved(3, { savedAt: saved(2).savedAt })]
      if (mode === 'changing') return [saved(1, { content: `revision ${revision}` })]
      return revision % 2 === 1 ? list : list.reverse()
    }
    const provider = fakeProvider([textTurn('ok')])
    const { session, log } = await openSession({
      provider,
      refinementEnabled: () => true,
      refinement: { settings: () => ({}) as never, planner: () => undefined, workspaceRefs: p.refs },
    })
    try {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
      expect(await session.acceptInput()).toBe(true)
      if (mode === 'permuted') {
        await session.runInference()
        expect(provider.requests).toHaveLength(1)
        expect(JSON.stringify(provider.requests[0]?.messages)).toContain('(saved) Saved 1')
      } else {
        // A finite driver also terminates if the retry ceiling regresses.
        const prepare = async () => {
          for (let attempt = 0; attempt < 10; attempt++) await session.runInference()
        }
        await expect(prepare()).rejects.toMatchObject({
          code: 'E_REQUEST_FROZEN',
          message: expect.stringContaining('repeatedly'),
        })
        expect(provider.requests).toEqual([])
        expect(await log.scan({ type: 'request/header', toSeq: session.lastSeq })).toEqual([])
      }
    } finally {
      await session.close()
    }
  })

  it('a format 1 surface with nothing saved lists the saved entries once, not on every request', async () => {
    const p = port([])
    const { session } = await open(p.refs)
    const legacy = note(`${EXPERIENCE_PREFIX}Task experience snapshot, format 1.\nOld guidance.`)
    for (const text of ['a', 'b', 'c']) await deriveExperienceNotes(session, [legacy, ask(text)])
    expect(p.calls()).toBe(1)
  })

  it('withdraws a stale delivery even when its replacement cannot fit the update', async () => {
    const p = port([saved(1)])
    const { session } = await open(p.refs)
    const snapshot = await deriveExperienceNotes(session, [ask('first')])
    p.set([saved(1, { content: '这是一条很长的经验。'.repeat(500) })])
    const surface = [...snapshot.map(delivered), ask('next')]
    const notes = await deriveExperienceNotes(session, surface)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.text).toContain('[memory/ws.r0000000001 v1] withdrawn:')
    expect(await deriveExperienceNotes(session, [...surface, ...notes.map(delivered)])).toEqual([])
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
    p.set([saved(15, { content: 'Remaining block' })])
    const notes = await deriveExperienceNotes(session, [
      ask('x'),
      ...snapshot.map(delivered),
      update,
      ask('y'),
    ])
    expect(textOf(notes)).toContain('No task-experience note before this one applies any longer')
    expect(textOf(notes)).toContain('[memory/ws.r0000000015 v2] (saved) Saved 15: Remaining block')
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
    const revision = vi.spyOn(p.refs, 'revision')
    const { session } = await open(p.refs, { refinementEnabled: () => false })
    const stamp = experienceStamp(session)
    expect(await experienceNotes(session, [ask('Saved 1')])).toEqual([])
    p.set([])
    expect(stampChanged(stamp, session)).toBe(false)
    expect(revision).not.toHaveBeenCalled()
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
    const update = note(
      `${EXPERIENCE_PREFIX}Task experience update, format 1.`,
      '- [memory/ws.r0000000001 v4] (saved) Saved 1: lesson number 1',
    )
    await t.log.append([t.session.ev('user/message', update.event.data, { trust: 'untrusted' })])
    expect(await t.facade.inspect({ op: 'list', kind: 'memory' })).toMatchObject({
      op: 'list',
      total: 2,
      entries: [
        { id: 'ws.r0000000001', version: 4 },
        { id: 'ws.r0000000002', version: 1 },
      ],
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
