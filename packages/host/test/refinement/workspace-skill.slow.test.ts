import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type PlannerGuidance,
  type PlannerSnapshot,
  type RefinementDeps,
  type RefinementPlanner,
  refinementFacade,
  type SaveReceipt,
} from '@agnes/core'
import { actor, fakeProvider, openSession, sent, textTurn } from '@agnes/core/testkit'
import type { InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostSession } from '../../src/runtime/lifecycle/host.js'
import { createSkillDraftStore } from '../../src/runtime/refinement/skill-drafts.js'
import { savedSkillFolderGone } from '../../src/runtime/refinement/skill-folders.js'
import { recordSkillRevocation } from '../../src/runtime/refinement/skill-review.js'
import { skillSender } from '../../src/runtime/refinement/skill-sender.js'
import { createWorkspaceRefs } from '../../src/runtime/refinement/workspace-refs.js'
import { createWorkspaceSave } from '../../src/runtime/refinement/workspace-save.js'
import { requestRefinement, saveEntryToWorkspace } from '../../src/runtime/sessions/session-refinement.js'
import { registryOf, skillWorkspace } from './skill-fixtures.js'

/**
 * The skills path end to end against the real save path, the real background installer and resource
 * control over the real skill folders: a session learns a skill, two confirmations install it without
 * a turn, the next session finds it on and listed, the user takes it back, and a person's edit is never
 * overwritten.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NAME = 'read-b'
const QUOTE = 'read file b, not a'
const TITLE = 'Read the right file'
const BODY = 'The file to read is b; a does not exist.'

const plannerModel = {
  id: 'planner',
  name: 'planner',
  api: 'openai-completions',
  route: 'rsi',
  baseUrl: 'https://test.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1000,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
} as ModelRecord

type Seen = { evidence: PlannerSnapshot['items']; guidance?: PlannerGuidance }
type Answer = (seen: Seen) => unknown
const output = (o: { edits?: unknown[]; confirmations?: unknown[]; evidenceIds: string[] }) => ({
  summary: 'A lesson.',
  rationale: 'The evidence shows it.',
  expectedOutcome: 'Fewer failures.',
  edits: o.edits ?? [],
  confirmations: o.confirmations ?? [],
  evidenceIds: o.evidenceIds,
})
const requestId = (seen: Seen, text: string): string => {
  const found = seen.evidence.find((e) => e.kind === 'user' && e.text.includes(text))
  if (!found) throw new Error(`no request with ${text}`)
  return found.id
}
const grant: Answer = (seen) =>
  output({
    edits: [
      {
        op: 'upsert',
        kind: 'skill',
        id: NAME,
        title: TITLE,
        content: BODY,
        applicability: 'session',
        evidenceIds: [requestId(seen, QUOTE)],
        quote: QUOTE,
      },
    ],
    evidenceIds: [requestId(seen, QUOTE)],
  })
/** One workspace: resource control over its skill folders, the installer, and the host's save path. */
function workspace() {
  const s = skillWorkspace(dirs)
  const switchState = { enabled: true, mode: 'auto' as 'manual' | 'auto', revision: 'r1' }
  const settings = () => ({ ...switchState })
  const transportCalls: Record<string, unknown>[] = []
  const transport = async (key: string, params: Record<string, unknown>) => {
    transportCalls.push(params)
    return s.request(key, params)
  }
  const saves = createWorkspaceSave({
    registry: () => registryOf(s.dataDir, s.workspace),
    settings,
    memory: () => undefined,
    skills: {
      request: skillSender(transport, { enabled: () => switchState.enabled }),
      drafts: createSkillDraftStore(s.dataDir),
      gone: (root, name) => savedSkillFolderGone(s.dataDir, root, name),
    },
    clock: Date.now,
  })
  return { ...s, switchState, settings, saves, transportCalls }
}
type Workspace = ReturnType<typeof workspace>

/** A top-level session in the workspace whose planner answers with `answers` in turn. */
async function session(w: Workspace, answers: Answer[]) {
  const queue = [...answers]
  let seen: Seen = { evidence: [] }
  const shown: (PlannerGuidance | undefined)[] = []
  const planner: RefinementPlanner = {
    buildPrompt(snapshot, entries, guidance) {
      seen = { evidence: snapshot.items, guidance }
      shown.push(guidance)
      return {
        system: 'Plan one refinement.',
        messages: [
          { role: 'user', content: [{ type: 'text', text: JSON.stringify({ guidance, entries }) }] },
        ],
        evidenceIds: snapshot.items.map((item) => item.id),
        fullEntries: entries.map(({ kind, id }) => ({ kind, id })),
        referenceEntries: [],
        ...(guidance.workspace ? { workspaceRefs: guidance.workspace.map((ref) => ref.ref) } : {}),
        omitted: { referenceEntries: 0, evidence: 0, fullEntries: 0 },
        inputTokens: 0,
      }
    },
    parseOutput: (text) => JSON.parse(text),
  }
  const conversation = fakeProvider([textTurn('ok')])
  let turns = 0
  const provider: Provider = {
    ...conversation,
    models: () => [plannerModel],
    async *infer(request: RequestBody, options) {
      if (request.route !== 'rsi') {
        turns++
        yield* conversation.infer(request, options)
        return
      }
      const answer = queue.shift()
      const reply = JSON.stringify(answer ? answer(seen) : output({ evidenceIds: [] }))
      const events: InferenceEvent[] = [
        sent('planner'),
        { type: 'text_delta', delta: reply },
        {
          type: 'usage',
          tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          credits: 0.001,
          creditSource: 'gateway',
        } as InferenceEvent,
        { type: 'done', reason: 'stop' },
      ]
      yield* fakeProvider([events]).infer(request, options)
    },
  }
  const refinement: RefinementDeps = {
    settings: w.settings,
    planner: () => planner,
    target: { route: 'rsi', model: 'planner' },
    workspace: w.saves,
    workspaceRefs: createWorkspaceRefs({
      dataDir: w.dataDir,
      session: () => ({ workspaceRoot: w.workspace }),
      clock: Date.now,
    }),
  }
  const { session: s } = await openSession({
    provider,
    cwd: w.workspace,
    refinement,
    refinementEnabled: () => true,
  })
  const say = async (text: string) => {
    await s.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
    return s.run({ until: 'turn-end', signal: new AbortController().signal })
  }
  const ended = async (runId: string) => {
    await vi.waitFor(() =>
      expect(['applied', 'no-op', 'rejected', 'cancelled']).toContain(
        s.state.refinementRuns.get(runId)?.state,
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    return s.state.refinementRuns.get(runId)
  }
  const refine = async () => ended((await requestRefinement(s as unknown as HostSession, undefined)).runId)
  const receipts = () => [...s.state.refinementSaves.values()]
  return { session: s, say, refine, ended, receipts, shown, turns: () => turns }
}

/** The skills resource control lists for the workspace, read from the skill folders, and their state. */
async function listed(w: Workspace) {
  const { items } = (await w.fake.resources('_agnes/v1/resources.list', {})) as {
    items: { name: string; actual: string; trust: string; desired: string }[]
  }
  return items.map(({ name, actual, trust, desired }) => ({ name, actual, trust, desired }))
}

describe('saved skills end to end', () => {
  it('learned, installed on its first apply without a turn, on in the next session, then taken back by the user', async () => {
    const w = workspace()
    const first = await session(w, [grant])
    expect(await first.say(`first task: ${QUOTE}`)).toMatchObject({ reason: 'completed' })
    const turnsBefore = first.turns()
    expect(await first.refine()).toMatchObject({ state: 'applied' })
    // The first apply installs the skill: no turn, no approval.
    await vi.waitFor(() => expect(first.receipts()).toHaveLength(1))
    const [receipt] = first.receipts()
    expect(receipt).toMatchObject({
      outcome: 'installed',
      initiator: 'auto',
      target: { kind: 'skill', name: NAME },
    })
    expect(first.turns()).toBe(turnsBefore)
    const record = registryOf(w.dataDir, w.workspace)
      .read()
      .skills.find((k) => k.name === NAME)
    expect(record).toMatchObject({
      state: 'active',
      source: { sessionKey: first.session.key, entryId: NAME },
    })
    expect(w.fake.entries.get(record?.resourceId as string)).toMatchObject({
      trust: 'trusted',
      desired: 'enabled',
    })
    // The session entry hands off to the skill.
    await vi.waitFor(() =>
      expect(
        [...first.session.state.refinementEntryMeta.values()].some((meta) => meta.handedOff === true),
      ).toBe(true),
    )
    await first.session.close()

    // The next session: the skill is in the workspace skill folder, on, and a plan may confirm it.
    expect(await listed(w)).toEqual([{ name: NAME, actual: 'ready', trust: 'trusted', desired: 'enabled' }])
    const second = await session(w, [])
    expect(await second.say('another task')).toMatchObject({ reason: 'completed' })
    await second.refine()
    expect(second.shown.at(-1)?.workspace?.map((ref) => ref.ref)).toContain(`workspace-skill/${NAME}`)

    // The user removes it on the skills page: resource control removes it and the page records it.
    await w.fake.resources('_agnes/v1/skills.remove', {
      resourceId: record?.resourceId,
      expectedRevision: record?.revision,
      commandId: 'user-remove',
    })
    recordSkillRevocation(registryOf(w.dataDir, w.workspace), {
      action: 'skill-uninstalled',
      resourceId: record?.resourceId as string,
      revision: record?.revision as string,
      actor: 'local-owner',
      at: Date.now(),
    })
    expect(existsSync(w.skillDir(NAME))).toBe(false)

    // A later session learns the same skill: the model's save and the automatic one are refused.
    const third = await session(w, [grant])
    expect(await third.say(`first task: ${QUOTE}`)).toMatchObject({ reason: 'completed' })
    expect(await third.refine()).toMatchObject({ state: 'applied' })
    const proposed = await refinementFacade(third.session).propose(
      {
        rationale: 'The user said which file to read.',
        evidenceSeqs: [1],
        edits: [{ op: 'upsert', kind: 'skill', id: 'read-b-copy', title: TITLE, content: BODY }],
      },
      { saveTo: 'workspace' },
    )
    await third.ended((proposed as { runId: string }).runId)
    const refused = third.receipts().find((r) => r.initiator === 'model') as SaveReceipt
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    const auto = await w.saves.save({
      initiator: 'auto',
      commandId: 'auto-again',
      session: {
        key: third.session.key,
        lane: 'main',
        workspaceRoot: w.workspace,
        lastSeq: third.session.lastSeq,
        child: false,
      },
      settingsRevision: 'r1',
      entry: {
        kind: 'skill',
        id: NAME,
        version: 1,
        contentHash: 'x',
        title: TITLE,
        content: BODY,
        applicability: 'session',
      },
      evidenceSeqs: [1],
      confirmations: 2,
    })
    expect(auto).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(existsSync(w.skillDir(NAME))).toBe(false)
    expect(existsSync(w.skillDir('read-b-copy'))).toBe(false)
    // Only the user's own save brings it back.
    const { receipt: back } = await saveEntryToWorkspace(third.session as unknown as HostSession, {
      kind: 'skill',
      id: NAME,
    })
    expect(back).toMatchObject({ outcome: 'installed', initiator: 'user' })
    expect(existsSync(w.skillDir(NAME))).toBe(true)
    await second.session.close()
    await third.session.close()
  })

  it("a person's edit of a saved skill is never overwritten: the change becomes a draft", async () => {
    const w = workspace()
    const s = await session(w, [grant])
    expect(await s.say(`first task: ${QUOTE}`)).toMatchObject({ reason: 'completed' })
    expect(await s.refine()).toMatchObject({ state: 'applied' })
    const host = s.session as unknown as HostSession
    expect((await saveEntryToWorkspace(host, { kind: 'skill', id: NAME })).receipt.outcome).toBe('installed')
    const file = join(w.skillDir(NAME), 'SKILL.md')
    const edited = `${readFileSync(file, 'utf8')}\nAlso check the file exists first.\n`
    writeFileSync(file, edited)
    // The model saves a new version of the same skill.
    const save = await w.saves.save({
      initiator: 'model',
      commandId: 'model-update',
      session: {
        key: s.session.key,
        lane: 'main',
        workspaceRoot: w.workspace,
        lastSeq: s.session.lastSeq,
        child: false,
      },
      settingsRevision: 'r1',
      entry: {
        kind: 'skill',
        id: NAME,
        version: 2,
        contentHash: 'x',
        title: TITLE,
        content: `${BODY} Then read c.`,
        applicability: 'session',
      },
      evidenceSeqs: [1],
      confirmations: 0,
    })
    expect(save).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    expect(readFileSync(file, 'utf8')).toBe(edited)
    const drafts = createSkillDraftStore(w.dataDir)(w.workspace).list()
    expect(drafts).toEqual([expect.objectContaining({ name: NAME, reason: 'changed-since', base: edited })])
    await s.session.close()
  })
})
