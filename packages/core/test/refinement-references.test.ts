import type { Event } from '@agnes/core-common/types'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { refinementFacade } from '../src/refinement/facade.js'
import type { RefinementReferences } from '../src/refinement/references.js'
import {
  deliveredReferences,
  REFERENCE_LOOKUP_MS,
  unavailableReferences,
} from '../src/refinement/references.js'
import type { RefinementDeps } from '../src/refinement/scheduler.js'
import type { RefinementPlanner } from '../src/refinement/types.js'
import { deriveExperienceNotes } from '../src/request/experience.js'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, sentFor, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'
import { data, ofType, record } from './helpers/side-call-session.js'

const plannerModel = record({
  id: 'planner',
  route: 'rsi',
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
})
const target = { route: 'rsi', model: 'planner' }
const SKILL = 'skill:workspace-agnes:release-notes'
const ROLE = '@fixture/roles#reader'
const SKILL_TEXT = 'Draft release notes with the release-notes skill before tagging.'
const ROLE_TEXT = 'Hand long log reading to the reader role.'

const planner: RefinementPlanner = {
  buildPrompt(snapshot, entries) {
    const text = JSON.stringify({ entries, evidence: snapshot.items })
    return {
      system: 'Plan one refinement.',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      evidenceIds: snapshot.items.map((item) => item.id),
      fullEntries: entries.map(({ kind, id }) => ({ kind, id })),
      referenceEntries: [],
      omitted: { referenceEntries: 0, evidence: 0, fullEntries: 0 },
      inputTokens: 0,
    }
  },
  parseOutput(text) {
    try {
      return JSON.parse(text)
    } catch {
      return { error: 'invalid-json' }
    }
  },
}

/** A plan of one skill edit bound to `reference`, plus whatever extra fields the edit is given. */
const planOf = (edit: Record<string, unknown>) =>
  JSON.stringify({
    summary: 'Bind the skill.',
    rationale: 'The skill did the job.',
    expectedOutcome: 'Reuse it.',
    edits: [
      {
        op: 'upsert',
        kind: 'skill',
        id: 'notes',
        title: 'Release notes',
        content: SKILL_TEXT,
        applicability: 'task',
        evidenceIds: ['e1'],
        ...edit,
      },
    ],
    confirmations: [],
    evidenceIds: ['e1'],
  })

function provider(plans: string[]) {
  const base = fakeProvider([textTurn('answer')])
  const queue = [...plans]
  const holds: Promise<void>[] = []
  const calls = { turns: 0 }
  const p: Provider = {
    ...base,
    models: () => [plannerModel],
    async *infer(request: RequestBody, options) {
      if (request.route !== 'rsi') {
        await holds[calls.turns++]
        yield* base.infer(request, options)
        return
      }
      yield sentFor(request)
      yield { type: 'text_delta', delta: queue.shift() ?? '' }
      yield {
        type: 'usage',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        credits: 0.001,
        creditSource: 'gateway',
      } as InferenceEvent
      yield { type: 'done', reason: 'stop' }
    },
  }
  return { provider: p, holds, calls, requests: base.requests }
}

/** What the host says of skills and roles; tests change it between steps. */
type World = {
  skills: Map<string, { revision: string; usable: boolean; name?: string }>
  roles: Set<string>
  asked: string[]
}

async function open(o: { plans?: string[]; references?: false } = {}) {
  const world: World = {
    skills: new Map([[SKILL, { revision: 'rev1', usable: true, name: 'release-notes' }]]),
    roles: new Set([ROLE]),
    asked: [],
  }
  const references: RefinementReferences = {
    skills: async () => {
      world.asked.push('skills')
      return [...world.skills].map(([resourceId, skill]) => ({ resourceId, ...skill }))
    },
    agents: async () => {
      world.asked.push('agents')
      return [...world.roles]
    },
  }
  const sw = { enabled: true, mode: 'auto' as const, revision: 'r1' }
  const refinement: RefinementDeps = {
    settings: () => ({ ...sw }),
    planner: () => planner,
    target,
    ...(o.references === false ? {} : { references }),
  }
  const p = provider(o.plans ?? [])
  const opened = await openSession({
    provider: p.provider,
    refinement,
    refinementEnabled: () => sw.enabled,
  })
  const s = opened.session
  const say = async (text: string) => {
    await s.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
    return s.run({ until: 'turn-end', signal: new AbortController().signal })
  }
  const rows = () => s.scan({ toSeq: s.lastSeq })
  const lastUserSeq = async () => ofType(await rows(), 'user/message').at(-1)?.seq ?? 0
  const state = (runId: string) => s.state.refinementRuns.get(runId)
  const facade = refinementFacade(s)
  const delivered = async () =>
    (await deriveExperienceNotes(s, [])).map((note) => `${note.text}\n${note.data ?? ''}`).join('\n')
  return { ...opened, ...p, s, world, say, rows, lastUserSeq, state, facade, delivered }
}

const runId = (outcome: unknown): string => {
  const id = (outcome as { runId?: string }).runId
  if (!id) throw new Error(`no run: ${JSON.stringify(outcome)}`)
  return id
}
const skillEdit = (reference = `${SKILL}@rev1`) => ({
  op: 'upsert' as const,
  kind: 'skill' as const,
  id: 'notes',
  title: 'Release notes',
  content: SKILL_TEXT,
  reference,
})
const roleEdit = (reference = ROLE) => ({
  op: 'upsert' as const,
  kind: 'subagent' as const,
  id: 'logs',
  title: 'Log reader',
  content: ROLE_TEXT,
  reference,
})
const propose = (seq: number, edits: unknown[]) =>
  ({ rationale: 'It worked.', evidenceSeqs: [seq], edits }) as Parameters<
    ReturnType<typeof refinementFacade>['propose']
  >[0]

describe('references to approved skills and subagents', () => {
  it('a reference to a disabled or untrusted skill is unavailable at plan, apply and delivery', async () => {
    // Plan: the planner binds a skill that is not usable now; the plan is refused.
    const planned = await open({ plans: [planOf({ reference: `${SKILL}@rev1` })] })
    planned.world.skills.set(SKILL, { revision: 'rev1', usable: false })
    expect(await planned.say('write the release notes')).toMatchObject({ reason: 'completed' })
    const id = runId(await planned.facade.request({ kind: 'manual', seq: planned.s.lastSeq }))
    await vi.waitFor(() => expect(planned.state(id)?.state).toBe('rejected'))
    expect(planned.state(id)).toMatchObject({ reason: 'reference-unavailable', detail: 'skill/notes' })
    expect(ofType(await planned.rows(), 'harness/entry')).toHaveLength(0)
    // The model's own proposal is refused for that edit, and nothing is written.
    const seq = await planned.lastUserSeq()
    expect(await planned.facade.propose(propose(seq, [skillEdit()]))).toEqual({
      refused: 'invalid',
      detail: 'reference-unavailable: skill/notes',
    })
    await planned.s.close()

    // Apply: usable when proposed, disabled before the apply; the whole proposal is rejected.
    const t = await open()
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    let release!: () => void
    t.holds[1] = new Promise<void>((resolve) => {
      release = resolve
    })
    await t.s.enqueue('next-turn', { content: [{ type: 'text', text: 'second task' }], actor })
    const second = t.s.run({ until: 'turn-end', signal: new AbortController().signal })
    await vi.waitFor(() => expect(t.calls.turns).toBe(2))
    const held = runId(await t.facade.propose(propose(await t.lastUserSeq(), [skillEdit(), roleEdit()])))
    expect(t.state(held)?.state).toBe('proposed')
    t.world.skills.set(SKILL, { revision: 'rev1', usable: false })
    release()
    expect(await second).toMatchObject({ reason: 'completed' })
    expect(t.state(held)).toMatchObject({
      state: 'rejected',
      reason: 'reference-unavailable',
      detail: 'rejected:evidence',
    })
    const refine = ofType(await t.rows(), 'harness/refine')
    expect(refine.map((row) => [data(row).outcome, data(row).reason])).toEqual([
      ['rejected:evidence', 'reference-unavailable'],
    ])
    expect(ofType(await t.rows(), 'harness/entry')).toHaveLength(0)

    // Delivery: applied while usable, then disabled; the line says so and carries no instructions.
    t.world.skills.set(SKILL, { revision: 'rev1', usable: true, name: 'release-notes' })
    const ok = runId(await t.facade.propose(propose(await t.lastUserSeq(), [skillEdit(), roleEdit()])))
    expect(t.state(ok)?.state).toBe('applied')
    const usable = await t.delivered()
    expect(usable).toContain('skill_read')
    expect(usable).toContain('release-notes')
    expect(usable).toContain(SKILL_TEXT)
    expect(usable).toContain(`subagent_spawn with role "${ROLE}"`)
    t.world.skills.set(SKILL, { revision: 'rev1', usable: false })
    const disabled = await t.delivered()
    expect(disabled).toMatch(/\[skill\/notes v1\] Release notes: unavailable/)
    expect(disabled).not.toContain(SKILL_TEXT)
    expect(disabled).toContain(ROLE_TEXT)
    await t.s.close()
  })

  it('a revision mismatch is unavailable', async () => {
    const t = await open()
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = await t.lastUserSeq()
    // The skill was upgraded since: the reference names the old revision.
    t.world.skills.set(SKILL, { revision: 'rev2', usable: true, name: 'release-notes' })
    expect(await t.facade.propose(propose(seq, [skillEdit()]))).toEqual({
      refused: 'invalid',
      detail: 'reference-unavailable: skill/notes',
    })
    expect(t.state(runId(await t.facade.propose(propose(seq, [skillEdit(`${SKILL}@rev2`)]))))?.state).toBe(
      'applied',
    )
    // Upgraded again after it was saved: the saved binding no longer holds.
    t.world.skills.set(SKILL, { revision: 'rev3', usable: true, name: 'release-notes' })
    const out = await t.delivered()
    expect(out).toMatch(/\[skill\/notes v1\] Release notes: unavailable/)
    expect(out).not.toContain(SKILL_TEXT)
    // A full read still returns the text, marked as unavailable now.
    expect(await t.facade.inspect({ op: 'get', id: 'skill/notes' })).toMatchObject({
      entry: { content: SKILL_TEXT, unavailable: true },
    })
    t.world.skills.set(SKILL, { revision: 'rev2', usable: true, name: 'release-notes' })
    expect(await t.facade.inspect({ op: 'get', id: 'skill/notes' })).not.toHaveProperty('entry.unavailable')
    t.world.skills.set(SKILL, { revision: 'rev3', usable: true, name: 'release-notes' })
    // A missing skill, a malformed reference and a reference on a kind that cannot have one.
    t.world.skills.delete(SKILL)
    expect(
      await t.facade.propose(propose(seq, [{ ...skillEdit(`${SKILL}@rev3`), id: 'gone' }])),
    ).toMatchObject({ refused: 'invalid', detail: 'reference-unavailable: skill/gone' })
    expect(await t.facade.propose(propose(seq, [{ ...skillEdit('no-revision'), id: 'bad' }]))).toMatchObject({
      refused: 'invalid',
      detail: 'edits[0].reference',
    })
    const memory = { ...skillEdit(), kind: 'memory' as const, id: 'mem' }
    expect(await t.facade.propose(propose(seq, [memory]))).toMatchObject({
      refused: 'invalid',
      detail: 'edits[0].reference',
    })
    await t.s.close()
  })

  it('a subagent reference outside delegableAgents is refused', async () => {
    const OTHER = '@fixture/roles#writer'
    const planned = await open({
      plans: [planOf({ kind: 'subagent', id: 'writer', content: ROLE_TEXT, reference: OTHER })],
    })
    expect(await planned.say('read the logs')).toMatchObject({ reason: 'completed' })
    const id = runId(await planned.facade.request({ kind: 'manual', seq: planned.s.lastSeq }))
    await vi.waitFor(() => expect(planned.state(id)?.state).toBe('rejected'))
    expect(planned.state(id)).toMatchObject({ reason: 'reference-unavailable', detail: 'subagent/writer' })
    const seq = await planned.lastUserSeq()
    expect(await planned.facade.propose(propose(seq, [roleEdit(OTHER)]))).toEqual({
      refused: 'invalid',
      detail: 'reference-unavailable: subagent/logs',
    })
    expect(planned.world.asked).toContain('agents')
    // A role that is delegable is accepted; once the application drops it, it is unavailable.
    expect(planned.state(runId(await planned.facade.propose(propose(seq, [roleEdit()]))))?.state).toBe(
      'applied',
    )
    planned.world.roles.delete(ROLE)
    const out = await planned.delivered()
    expect(out).toMatch(/\[subagent\/logs v1\] Log reader: unavailable/)
    expect(out).not.toContain(ROLE_TEXT)
    expect(out).not.toContain('subagent_spawn with role')
    await planned.s.close()

    // Without a host that can check references, every reference is unavailable.
    const bare = await open({ references: false })
    expect(await bare.say('first task')).toMatchObject({ reason: 'completed' })
    expect(await bare.facade.propose(propose(await bare.lastUserSeq(), [roleEdit()]))).toEqual({
      refused: 'invalid',
      detail: 'reference-unavailable: subagent/logs',
    })
    await bare.s.close()
  })

  it('a reference never grants delegatedFullAccess', async () => {
    // The planner may not set anything but the reference string itself.
    const planned = await open({
      plans: [planOf({ kind: 'subagent', id: 'logs', reference: ROLE, delegatedFullAccess: true })],
    })
    expect(await planned.say('read the logs')).toMatchObject({ reason: 'completed' })
    const id = runId(await planned.facade.request({ kind: 'manual', seq: planned.s.lastSeq }))
    await vi.waitFor(() => expect(planned.state(id)?.state).toBe('rejected'))
    expect(planned.state(id)).toMatchObject({ reason: 'invalid-output', detail: 'invalid-shape: edits[0]' })
    await planned.s.close()

    const t = await open()
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const tools = [...t.s.currentTools().snapshot(t.s.lastSeq).byName.keys()].sort()
    const extra = { ...roleEdit(), delegatedFullAccess: true, tools: ['bash'], model: 'big', budget: 9 }
    const ok = runId(await t.facade.propose(propose(await t.lastUserSeq(), [extra])))
    expect(t.state(ok)?.state).toBe('applied')
    const entry = data(ofType(await t.rows(), 'harness/entry')[0] as Event) as HarnessEntry
    // The entry holds the reference string and nothing that could widen what a role may do.
    expect(Object.keys(entry).sort()).toEqual(
      ['content', 'id', 'kind', 'reference', 'scope', 'source', 'title', 'version'].sort(),
    )
    expect(entry.reference).toBe(ROLE)
    expect(t.s.roleAuthority).toBeUndefined()
    expect([...t.s.currentTools().snapshot(t.s.lastSeq).byName.keys()].sort()).toEqual(tools)
    // The model is pointed at the existing spawn tool and its role, nothing else.
    expect(await t.delivered()).toContain(`subagent_spawn with role "${ROLE}"`)
    await t.s.close()
  })
})

/** A session as the reference checks read it: only its key, lane and host port. */
const bare = (references: RefinementReferences) =>
  ({ key: 'k', lane: 'main', d: { refinement: { references } } }) as unknown as SessionImpl
const bound = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({
    op: 'upsert',
    kind: 'skill' as const,
    id: `s${i}`,
    reference: `skill:x${i}@r`,
  })),
  ...Array.from({ length: n }, (_, i) => ({
    op: 'upsert',
    kind: 'subagent' as const,
    id: `a${i}`,
    reference: `@p/r#a${i}`,
  })),
]

describe('host lookups for references', () => {
  it('one check lists skills and roles once, however many entries are bound', async () => {
    const calls = { skills: 0, agents: 0 }
    const s = bare({
      skills: () => {
        calls.skills++
        return Array.from({ length: 50 }, (_, i) => ({
          resourceId: `skill:x${i}`,
          revision: 'r',
          usable: true,
        }))
      },
      agents: () => {
        calls.agents++
        return Array.from({ length: 50 }, (_, i) => `@p/r#a${i}`)
      },
    })
    expect(await unavailableReferences(s, bound(50))).toEqual([])
    expect(calls).toEqual({ skills: 1, agents: 1 })
    const entries = bound(50).map(({ kind, id, reference }) => ({
      entry: {
        kind,
        id,
        reference,
        title: id,
        content: 'c',
        scope: 'local',
        version: 1,
        source: 's',
      } as HarnessEntry,
    }))
    expect((await deliveredReferences(s, entries)).every((item) => item.entry.content !== 'c')).toBe(true)
    expect(calls).toEqual({ skills: 2, agents: 2 })
  })

  it('a lookup that throws or hangs counts as unavailable', async () => {
    const thrown = bare({
      skills: () => {
        throw new Error('drain')
      },
      agents: async () => {
        throw new Error('drain')
      },
    })
    expect(await unavailableReferences(thrown, bound(1))).toEqual(['skill/s0', 'subagent/a0'])
    vi.useFakeTimers()
    try {
      const hung = bare({ skills: () => new Promise(() => {}), agents: () => new Promise(() => {}) })
      const out = unavailableReferences(hung, bound(1))
      // Skills and roles are each given the bound once.
      await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_MS)
      await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_MS)
      expect(await out).toEqual(['skill/s0', 'subagent/a0'])
    } finally {
      vi.useRealTimers()
    }
  })
})
