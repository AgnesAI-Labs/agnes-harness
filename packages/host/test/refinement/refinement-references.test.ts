import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kernel, RefinementPlanner, SessionImpl } from '@agnes/core'
import { refinementFacade } from '@agnes/core'
import { actor, fakeProvider, openSession, sent, textTurn, usage } from '@agnes/core/testkit'
import type { SkillRuntimeDiscovery } from '@agnes/host-extensions/assemble/packages'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { ModelRecord, Provider } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRefinementHost } from '../../src/runtime/assemble/refinement.js'
import { createRefinementReferences } from '../../src/runtime/refinement/references.js'

const at = { key: 'k', lane: 'main' }
const ID = 'skill:workspace-agnes:notes'
type Skill = ReturnType<SkillRuntimeDiscovery['list']>[number]
type Flags = ReturnType<NonNullable<SkillRuntimeDiscovery['invocation']>>
const USER_ONLY: Flags = { modelInvocable: false, userInvocable: true, disabled: false }
const skill = (over: Partial<Skill> = {}): Skill =>
  ({
    kind: 'skill',
    resourceId: ID,
    name: 'notes',
    revision: 'rev1',
    priority: 500,
    resolution: { winner: true },
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    stale: false,
    ...over,
  }) as Skill

/** A discovery view that lists `inside` only within the session's workspace, as the real one does. */
function discovery(inside: Skill[], flags: () => Flags = () => undefined) {
  const entered: string[] = []
  let scoped = false
  const view: SkillRuntimeDiscovery = {
    list: () => (scoped ? inside : []),
    invocation: () => flags(),
    runInWorkspace: async (sessionKey, invoke) => {
      entered.push(sessionKey)
      scoped = true
      try {
        return await invoke()
      } finally {
        scoped = false
      }
    },
  }
  return { view, entered }
}

const sessionWith = (roles: string[]) =>
  ({
    key: 'k',
    lane: 'main',
    d: { childRoles: { list: async () => roles.map((ref) => ({ ref, title: { en: ref } })) } },
  }) as unknown as SessionImpl

const usable = async (view: SkillRuntimeDiscovery) =>
  (await createRefinementReferences({ session: () => sessionWith([]), skills: () => view }).skills(at))[0]
    ?.usable

describe('the host answer for skill and role references', () => {
  it('skills are listed in the session workspace, usable only while ready, enabled, trusted, winning and model-visible', async () => {
    const { view, entered } = discovery([skill()])
    const refs = createRefinementReferences({ session: () => sessionWith([]), skills: () => view })
    expect(await refs.skills(at)).toEqual([{ resourceId: ID, revision: 'rev1', usable: true, name: 'notes' }])
    expect(entered).toEqual(['k'])
    for (const over of [
      { desired: 'disabled' },
      { trust: 'untrusted' },
      { actual: 'failed' },
      { resolution: { winner: false } },
    ] as Partial<Skill>[])
      expect(await usable(discovery([skill(over)]).view)).toBe(false)
    expect(await usable(discovery([skill()], () => USER_ONLY).view)).toBe(false)
    const disabled = { modelInvocable: true, userInvocable: true, disabled: true }
    expect(await usable(discovery([skill()], () => disabled).view)).toBe(false)
    // No session open here, or no skills at all: nothing is listed.
    expect(
      await createRefinementReferences({ session: () => undefined, skills: () => view }).skills(at),
    ).toEqual([])
    expect(
      await createRefinementReferences({ session: () => sessionWith([]), skills: () => undefined }).skills(
        at,
      ),
    ).toEqual([])
  })

  it("roles are the session's delegable list", async () => {
    const refs = createRefinementReferences({
      session: () => sessionWith(['@fixture/roles#reader']),
      skills: () => undefined,
    })
    expect(await refs.agents(at)).toEqual(['@fixture/roles#reader'])
    const none = { key: 'k', lane: 'main', d: {} } as unknown as SessionImpl
    expect(
      await createRefinementReferences({ session: () => none, skills: () => undefined }).agents(at),
    ).toEqual([])
    expect(
      await createRefinementReferences({ session: () => undefined, skills: () => undefined }).agents(at),
    ).toEqual([])
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const PLAN_SYSTEM = 'Plan one refinement.'
const TEXT = 'Draft the release notes with the notes skill.'
const edit = { op: 'upsert', kind: 'skill', id: 'notes', title: 'Release notes', content: TEXT }
const PLAN = JSON.stringify({
  summary: 's',
  rationale: 'r',
  expectedOutcome: 'o',
  edits: [{ ...edit, applicability: 'session', evidenceIds: ['e1'], reference: `${ID}@rev1` }],
  confirmations: [],
  evidenceIds: ['e1'],
})
const planner: RefinementPlanner = {
  buildPrompt: (snapshot) => ({
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(snapshot.items) }] }],
    evidenceIds: snapshot.items.map((item) => item.id),
    fullEntries: [],
    referenceEntries: [],
    omitted: { referenceEntries: 0, evidence: 0, fullEntries: 0 },
    inputTokens: 0,
  }),
  parseOutput: (text) => JSON.parse(text),
}
const primary = {
  id: 'm',
  name: 'model',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://test.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1000,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
} as ModelRecord

describe('a skill hidden from the model, through the real host bridge', () => {
  it('is unavailable at plan, propose, apply and delivery, with no skill_read line', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-refinement-refs-'))
    dirs.push(dataDir)
    const store = new RefinementSettingsStore(dataDir, 'p')
    store.save({ enabled: true, mode: 'auto' }, store.read().revision)
    let flags: Flags = USER_ONLY
    const bridge = createRefinementHost(dataDir, 'p', Date.now, {
      skills: () => discovery([skill()], () => flags).view,
    })
    bridge.connect(planner)
    const talk = fakeProvider([textTurn('done')])
    const plans = fakeProvider([
      [sent(), { type: 'text_delta', delta: PLAN }, usage(), { type: 'done', reason: 'stop' }],
    ])
    const holds = new Map<number, Promise<void>>()
    let turns = 0
    const provider: Provider = {
      ...talk,
      models: () => [primary],
      async *infer(request, options) {
        if (request.system === PLAN_SYSTEM) return yield* plans.infer(request, options)
        await holds.get(turns++)
        yield* talk.infer(request, options)
      },
    }
    const { session } = await openSession({
      provider,
      refinement: bridge.kernelOptions.refinement,
      refinementEnabled: bridge.kernelOptions.refinementEnabled,
    })
    bridge.bindKernel({ sessions: new Map([[session.key, session]]) } as unknown as Kernel)
    const facade = refinementFacade(session)
    const run = () => session.run({ until: 'turn-end', signal: new AbortController().signal })
    const say = async (text: string) => {
      await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      return run()
    }
    const runOf = (out: unknown) => session.state.refinementRuns.get((out as { runId: string }).runId)
    const proposal = () => ({
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [{ ...edit, reference: `${ID}@rev1` }],
    })
    expect(await say('write the notes')).toMatchObject({ reason: 'completed' })

    // Plan.
    const planned = await facade.request({ kind: 'manual', seq: session.lastSeq })
    await vi.waitFor(() => expect(runOf(planned)?.state).toBe('rejected'))
    expect(runOf(planned)).toMatchObject({ reason: 'reference-unavailable' })
    // Propose.
    expect(await facade.propose(proposal() as never)).toEqual({
      refused: 'invalid',
      detail: 'reference-unavailable: skill/notes',
    })
    // Apply: visible when proposed during a turn, hidden from the model before the turn ends.
    flags = undefined
    let release!: () => void
    holds.set(
      1,
      new Promise((resolve) => {
        release = resolve
      }),
    )
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'second' }], actor })
    const second = run()
    await vi.waitFor(() => expect(turns).toBe(2))
    const held = await facade.propose(proposal() as never)
    expect(runOf(held)?.state).toBe('proposed')
    flags = USER_ONLY
    release()
    await second
    expect(runOf(held)).toMatchObject({ state: 'rejected', reason: 'reference-unavailable' })
    // Delivery: applied while visible, hidden before the next request.
    flags = undefined
    expect(runOf(await facade.propose(proposal() as never))?.state).toBe('applied')
    flags = USER_ONLY
    expect(await say('third')).toMatchObject({ reason: 'completed' })
    const sentText = JSON.stringify(talk.requests.at(-1))
    expect(sentText).toContain('Release notes: unavailable')
    expect(sentText).not.toContain('skill_read')
    expect(sentText).not.toContain(TEXT)
    await session.close()
  })
})
