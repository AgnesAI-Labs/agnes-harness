import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPlugin } from '@agnes/base'
import {
  type PlannerGuidance,
  type PlannerSnapshot,
  type RefinementDeps,
  type RefinementPlanner,
  refinementFacade,
  type SaveReceipt,
  saveToWorkspace,
} from '@agnes/core'
import { actor, fakeProvider, openSession, sent, textTurn } from '@agnes/core/testkit'
import type { MemoryProvider } from '@agnes/extension-api'
import { REVIEW_AFTER_MS, RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import type { InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostSession } from '../../src/runtime/lifecycle/host.js'
import { WORKSPACE_MEMORY_KEY } from '../../src/runtime/refinement/reconcile.js'
import { registryView } from '../../src/runtime/refinement/registry-view.js'
import { createWorkspaceRefs } from '../../src/runtime/refinement/workspace-refs.js'
import { createWorkspaceSave } from '../../src/runtime/refinement/workspace-save.js'
import { requestRefinement, saveEntryToWorkspace } from '../../src/runtime/sessions/session-refinement.js'

/**
 * Every entry point to "save to workspace" against the real host services: the save path, the
 * registry, the bundled file memory and the workspace references a later plan may confirm.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 10, 4)
const DAY = 86_400_000
const QUOTE = 'read file b, not a'
const REQUEST = `first task: ${QUOTE}`
const TITLE = 'Read the right file'
const BODY = 'The file to read is b; a does not exist.'

const plannerModel: ModelRecord = {
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

const memoryProvider = (): MemoryProvider => {
  let found: MemoryProvider | undefined
  memoryPlugin.apply({
    providers: {
      register: (_kind: unknown, value: MemoryProvider) => {
        found = value
      },
    },
  } as never)
  if (!found) throw new Error('memory provider not registered')
  return found
}

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
/** The id of the user request the planner was shown whose text holds `text`. */
const requestId = (seen: Seen, text: string): string => {
  const found = seen.evidence.find((e) => e.kind === 'user' && e.text.includes(text))
  if (!found) throw new Error(`no request with ${text} among ${JSON.stringify(seen.evidence)}`)
  return found.id
}
const grantAs =
  (id: string): Answer =>
  (seen) =>
    output({
      edits: [
        {
          op: 'upsert',
          kind: 'memory',
          id,
          title: TITLE,
          content: BODY,
          applicability: 'session',
          evidenceIds: [requestId(seen, QUOTE)],
          quote: QUOTE,
        },
      ],
      evidenceIds: [requestId(seen, QUOTE)],
    })
const grant: Answer = (seen) =>
  output({
    edits: [
      {
        op: 'upsert',
        kind: 'memory',
        id: 'read-b',
        title: TITLE,
        content: BODY,
        applicability: 'session',
        evidenceIds: [requestId(seen, QUOTE)],
        quote: QUOTE,
      },
    ],
    evidenceIds: [requestId(seen, QUOTE)],
  })
/** Confirms `entryId` with a verbatim quote of the shown request that holds it. */
const confirmBy =
  (entryId: () => string, quote: string): Answer =>
  (seen) =>
    output({
      confirmations: [{ entryId: entryId(), evidenceIds: [requestId(seen, quote)], quote }],
      evidenceIds: [requestId(seen, quote)],
    })

/**
 * A workspace with the bundled file memory under auto, the real save path and workspace references, and
 * one top-level session in it whose planner answers with `answers` in turn.
 */
async function setup(o: {
  answers: Answer[]
  mode?: 'manual' | 'auto'
  goal?: boolean
  /** Another session's home: this session opens in the same workspace. */
  home?: string
  key?: string
}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'agnes-entry-points-'))
  const root = join(home, 'ws')
  if (!o.home) {
    dirs.push(home)
    mkdirSync(root)
  }
  const dataDir = join(home, 'data')
  const now = { value: T0 }
  const clock = () => now.value
  const sw = { enabled: true, mode: o.mode ?? 'auto', revision: 'r1' } as const
  const switchState: { enabled: boolean; mode: 'manual' | 'auto'; revision: string } = { ...sw }
  const registry = () => new RefinementRegistry(dataDir, root, clock)
  const openMemory = (sessionKey: string) =>
    memoryProvider().open({
      home,
      workspaceRoot: root,
      sessionKey,
      validity: registryView(registry(), clock),
    })
  if (!o.home) await openMemory(WORKSPACE_MEMORY_KEY).configure({ mode: 'auto' })
  const saves = createWorkspaceSave({
    registry: () => registry(),
    settings: () => ({ ...switchState }),
    memory: () => openMemory(WORKSPACE_MEMORY_KEY),
    clock,
  })
  const workspaceRefs = createWorkspaceRefs({
    dataDir,
    session: (at) => ({ workspaceRoot: root, memory: openMemory(at.key) }),
    clock,
  })
  const answers = [...o.answers]
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
        ...(guidance.workspace ? { workspaceRefs: guidance.workspace.map((w) => w.ref) } : {}),
        omitted: { referenceEntries: 0, evidence: 0, fullEntries: 0 },
        inputTokens: 0,
      }
    },
    parseOutput: (text) => JSON.parse(text),
  }
  const conversation = fakeProvider([textTurn('ok')])
  const provider: Provider = {
    ...conversation,
    models: () => [plannerModel],
    async *infer(request: RequestBody, options) {
      if (request.route !== 'rsi') {
        yield* conversation.infer(request, options)
        return
      }
      const answer = answers.shift()
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
    settings: () => ({ ...switchState }),
    planner: () => planner,
    target: { route: 'rsi', model: 'planner' },
    workspace: saves,
    workspaceRefs,
    ...(o.goal ? { taskScope: () => ({ id: 'goal-1', revision: 1, phase: 'active' as const }) } : {}),
  }
  const { session } = await openSession({
    provider,
    cwd: root,
    refinement,
    refinementEnabled: () => true,
    ...(o.key ? { key: o.key } : {}),
  })
  const say = async (text: string) => {
    await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
    return session.run({ until: 'turn-end', signal: new AbortController().signal })
  }
  /** Waits for a run to end and for what follows its apply (renewals, saves) to settle. */
  const ended = async (runId: string) => {
    await vi.waitFor(() =>
      expect(['applied', 'no-op', 'rejected', 'cancelled']).toContain(
        session.state.refinementRuns.get(runId)?.state,
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    return session.state.refinementRuns.get(runId)
  }
  const refine = async (saveTo?: 'workspace') => {
    const { runId } = await requestRefinement(session as unknown as HostSession, undefined, saveTo)
    return ended(runId)
  }
  const receipts = () => [...session.state.refinementSaves.values()]
  const memoryText = async () => (await openMemory(WORKSPACE_MEMORY_KEY).readFile('MEMORY.md')).content
  return {
    session,
    now,
    switchState,
    registry,
    say,
    refine,
    ended,
    receipts,
    memoryText,
    shown,
    root,
    home,
    saves,
    openMemory,
  }
}

const STEP_ORDER = ['switch', 'revocation', 'confirmations', 'rules', 'memory-mode', 'capacity']
/**
 * Whether a receipt went through every step of the fixed order, in that order: every step listed, and
 * nothing judged after the step that failed. A saved receipt passed every step that applies to it.
 */
function inOrder(receipt: Pick<SaveReceipt, 'steps' | 'outcome' | 'initiator'>): void {
  expect(receipt.steps.map((s) => s.step)).toEqual(STEP_ORDER)
  const verdicts = receipt.steps.map((s) => s.verdict).join(' ')
  expect(verdicts).toMatch(/^((pass|skip) )*(fail( skip)*)?(pass|skip)?$/u)
  if (receipt.outcome === 'saved') {
    expect(receipt.steps.filter((s) => s.verdict === 'fail')).toEqual([])
    for (const step of ['switch', 'revocation', 'rules', 'memory-mode'])
      expect(receipt.steps.find((s) => s.step === step)?.verdict, step).toBe('pass')
    expect(receipt.steps.find((s) => s.step === 'confirmations')?.verdict).toBe(
      receipt.initiator === 'auto' ? 'pass' : 'skip',
    )
  }
}

describe('the entry points against the real save path', () => {
  it('a later plan in the same session citing the evidence that granted a saved entry renews nothing (user save)', async () => {
    let paragraph = ''
    const ref = () => `workspace-memory/${paragraph}`
    const t = await setup({
      answers: [
        grant,
        // The same request that granted the entry, cited again in the session it was saved from.
        confirmBy(ref, QUOTE),
        // A newer request of the user's does bear it out.
        confirmBy(ref, 'read b again next time'),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // The per-entry save: the user's, through the host's one path.
    const { receipt } = await saveEntryToWorkspace(t.session as unknown as HostSession, {
      kind: 'memory',
      id: 'read-b',
    })
    expect(receipt).toMatchObject({ outcome: 'saved', initiator: 'user' })
    inOrder(receipt)
    const saved = t.registry().read().paragraphs
    expect(saved).toHaveLength(1)
    // The registry names the source by the session key and the bare entry id.
    expect(saved[0]?.source).toMatchObject({ sessionKey: t.session.key, kind: 'memory', entryId: 'read-b' })
    paragraph = saved[0]?.id as string
    const due = saved[0]?.reviewAfter as number
    expect(due).toBe(T0 + REVIEW_AFTER_MS)
    t.now.value = T0 + 5 * DAY
    // The plan is shown the saved paragraph and confirms it with the very request that granted it.
    await t.refine()
    expect(t.shown.at(-1)?.workspace?.map((w) => w.ref)).toEqual([ref()])
    expect(t.registry().read().paragraphs[0]?.reviewAfter).toBe(due)
    // Control: a newer request of the user's renews it.
    expect(await t.say('please read b again next time')).toMatchObject({ reason: 'completed' })
    await t.refine()
    expect(t.registry().read().paragraphs[0]?.reviewAfter).toBe(T0 + 5 * DAY + REVIEW_AFTER_MS)
    await t.session.close()
  })

  it('a later plan in the same session citing the evidence that led to an automatic save renews nothing', async () => {
    let paragraph = ''
    const ref = () => `workspace-memory/${paragraph}`
    const t = await setup({
      answers: [
        grant,
        confirmBy(() => 'memory/read-b', 'read b again please'),
        confirmBy(() => 'memory/read-b', 'read b a third time'),
        // The confirmation that made the entry count twice, cited again for the saved paragraph.
        confirmBy(ref, 'read b a third time'),
        confirmBy(ref, 'and read b once more today'),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('read b again please')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.receipts()).toEqual([])
    expect(await t.say('read b a third time')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // The second confirmation saved it automatically.
    await vi.waitFor(() => expect(t.receipts()).toHaveLength(1))
    const [receipt] = t.receipts()
    expect(receipt).toMatchObject({ outcome: 'saved', initiator: 'auto' })
    inOrder(receipt as SaveReceipt)
    const saved = t.registry().read().paragraphs
    expect(saved[0]?.source).toMatchObject({
      sessionKey: t.session.key,
      entryId: 'read-b',
      initiator: 'auto',
    })
    paragraph = saved[0]?.id as string
    const due = saved[0]?.reviewAfter as number
    t.now.value = T0 + 3 * DAY
    await t.refine()
    expect(t.shown.at(-1)?.workspace?.map((w) => w.ref)).toEqual([ref()])
    expect(t.registry().read().paragraphs[0]?.reviewAfter).toBe(due)
    // Control: new evidence renews it.
    expect(await t.say('and read b once more today')).toMatchObject({ reason: 'completed' })
    await t.refine()
    expect(t.registry().read().paragraphs[0]?.reviewAfter).toBe(T0 + 3 * DAY + REVIEW_AFTER_MS)
    await t.session.close()
  })

  it('the user overrides a revocation only through its own entry point; the model never does', async () => {
    const t = await setup({ answers: [grant] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    const host = t.session as unknown as HostSession
    expect((await saveEntryToWorkspace(host, { kind: 'memory', id: 'read-b' })).receipt.outcome).toBe('saved')
    // The person deletes the paragraph from the memory file: a revocation.
    const memory = await t.memoryText()
    expect(memory).toContain(BODY)
    const file = memoryProvider().open({
      home: join(t.root, '..'),
      workspaceRoot: t.root,
      sessionKey: WORKSPACE_MEMORY_KEY,
      validity: registryView(t.registry(), () => t.now.value),
    })
    await file.editFile('MEMORY.md', '', (await file.readFile('MEMORY.md')).hash)
    // The model saves the same content under another id: refused as revoked, whatever it says.
    const outcome = await refinementFacade(t.session).propose(
      {
        rationale: 'The user said which file to read.',
        evidenceSeqs: [1],
        edits: [{ op: 'upsert', kind: 'memory', id: 'read-b-again', title: TITLE, content: BODY }],
      },
      { saveTo: 'workspace' },
    )
    await t.ended((outcome as { runId: string }).runId)
    const refused = t.receipts().find((r) => r.initiator === 'model') as SaveReceipt
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    inOrder(refused)
    expect(await t.memoryText()).toBe('')
    expect(t.registry().read().revocations).toHaveLength(1)
    // The owner's own save overrides it and clears the record.
    const { receipt } = await saveEntryToWorkspace(host, { kind: 'memory', id: 'read-b' })
    expect(receipt).toMatchObject({ outcome: 'saved', initiator: 'user' })
    inOrder(receipt)
    expect(t.registry().read().revocations).toEqual([])
    expect(await t.memoryText()).toContain(BODY)
    await t.session.close()
  })

  it('/refine --workspace saves session entries and leaves task-level ones in the session, refused by the rules', async () => {
    const t = await setup({
      goal: true,
      answers: [
        (seen) =>
          output({
            edits: [
              {
                op: 'upsert',
                kind: 'memory',
                id: 'read-b',
                title: TITLE,
                content: BODY,
                applicability: 'session',
                evidenceIds: [requestId(seen, QUOTE)],
                quote: QUOTE,
              },
              {
                op: 'upsert',
                kind: 'memory',
                id: 'this-task',
                title: 'This task',
                content: 'Only for this task: b is the file.',
                applicability: 'task',
                evidenceIds: [requestId(seen, QUOTE)],
              },
            ],
            evidenceIds: [requestId(seen, QUOTE)],
          }),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine('workspace')).toMatchObject({ state: 'applied' })
    expect(t.shown[0]?.saveTo).toBe('workspace')
    await vi.waitFor(() => expect(t.receipts()).toHaveLength(2))
    const byId = new Map(t.receipts().map((r) => [r.source.entryId, r]))
    expect(byId.get('read-b')).toMatchObject({ outcome: 'saved', initiator: 'user' })
    expect(byId.get('this-task')).toMatchObject({
      outcome: 'refused',
      reason: 'source-rules',
      initiator: 'user',
    })
    for (const receipt of byId.values()) inOrder(receipt)
    const text = await t.memoryText()
    expect(text).toContain(BODY)
    expect(text).not.toContain('Only for this task')
    // The task-level entry stays in the session.
    expect(t.session.state.registers.harnessEntries.size).toBe(2)
    await t.session.close()
  })

  it('a model save of an entry with no evidence of this session is refused by the rules', async () => {
    const t = await setup({ answers: [grant] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // The model cannot make an entry count as confirmed, nor cite evidence from outside the session.
    const outcome = await saveToWorkspace(t.session, {
      initiator: 'model',
      kind: 'memory',
      id: 'read-b',
      evidenceSeqs: [t.session.lastSeq + 50],
    })
    expect(outcome).toMatchObject({ receipt: { outcome: 'refused', reason: 'source-rules' } })
    inOrder((outcome as { receipt: SaveReceipt }).receipt)
    expect(await t.memoryText()).toBe('')
    await t.session.close()
  })

  it('with refinement off every entry point refuses and writes nothing', async () => {
    const t = await setup({ answers: [grant] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    t.switchState.enabled = false
    const host = t.session as unknown as HostSession
    const before = t.session.lastSeq
    await expect(requestRefinement(host, undefined, 'workspace')).rejects.toMatchObject({
      data: { reason: 'refinement-off' },
    })
    const { receipt } = await saveEntryToWorkspace(host, { kind: 'memory', id: 'read-b' })
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    expect(
      await refinementFacade(t.session).propose(
        {
          rationale: 'r',
          evidenceSeqs: [1],
          edits: [{ op: 'upsert', kind: 'memory', id: 'm', title: 'M', content: 'x' }],
        },
        { saveTo: 'workspace' },
      ),
    ).toEqual({ refused: 'refinement-off' })
    expect(t.session.lastSeq).toBe(before)
    // Nothing reached the registry or the memory file.
    expect(t.registry().read().receipts).toEqual([])
    expect(await t.memoryText()).toBe('')
    await t.session.close()
  })

  it('an entry id of 128 characters is saved through the automatic, the user and the model entry points', async () => {
    const long = `prefer-pnpm-workspace-filter-${'x'.repeat(99)}`
    const other = `use-the-lockfile-from-the-root-${'y'.repeat(97)}`
    expect([long.length, other.length]).toEqual([128, 128])
    const t = await setup({
      answers: [
        grantAs(long),
        confirmBy(() => `memory/${long}`, 'read b again please'),
        confirmBy(() => `memory/${long}`, 'read b a third time'),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    // /refine --workspace: the user's save of what the run wrote.
    expect(await t.refine('workspace')).toMatchObject({ state: 'applied' })
    await vi.waitFor(() => expect(t.receipts()).toHaveLength(1))
    expect(t.receipts()[0]).toMatchObject({ initiator: 'user', outcome: 'saved' })
    // Two confirmations: the automatic offer.
    for (const said of ['read b again please', 'read b a third time']) {
      expect(await t.say(said)).toMatchObject({ reason: 'completed' })
      expect(await t.refine()).toMatchObject({ state: 'applied' })
    }
    await vi.waitFor(() => expect(t.receipts()).toHaveLength(2))
    // The model's save of another long id.
    const outcome = await refinementFacade(t.session).propose(
      {
        rationale: 'The user said which lockfile to use.',
        evidenceSeqs: [1],
        edits: [
          { op: 'upsert', kind: 'memory', id: other, title: 'Lockfile', content: 'Use the root lockfile.' },
        ],
      },
      { saveTo: 'workspace' },
    )
    await t.ended((outcome as { runId: string }).runId)
    await vi.waitFor(() => expect(t.receipts()).toHaveLength(3))
    for (const receipt of t.receipts()) {
      expect(receipt, receipt.initiator).toMatchObject({ outcome: 'saved' })
      expect(receipt.commandId.length).toBeLessThanOrEqual(64)
      expect(receipt.commandId).not.toContain(String.fromCharCode(0))
      inOrder(receipt)
    }
    expect(t.receipts().map((r) => r.initiator)).toEqual(['user', 'auto', 'model'])
    await t.session.close()
  })

  it('two sessions in one workspace with the same entry are each judged on their own', async () => {
    const answers = () => [
      grant,
      confirmBy(() => 'memory/read-b', 'read b again please'),
      confirmBy(() => 'memory/read-b', 'read b a third time'),
    ]
    const confirmTwice = async (t: Awaited<ReturnType<typeof setup>>) => {
      expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
      expect(await t.refine()).toMatchObject({ state: 'applied' })
      for (const said of ['read b again please', 'read b a third time']) {
        expect(await t.say(said)).toMatchObject({ reason: 'completed' })
        expect(await t.refine()).toMatchObject({ state: 'applied' })
      }
      await vi.waitFor(() => expect(t.receipts()).toHaveLength(1))
      return t.receipts()[0] as SaveReceipt
    }
    const a = await setup({ answers: answers(), key: 'session-a' })
    // Workspace memory is off while the first session's entry is offered.
    await a.openMemory(WORKSPACE_MEMORY_KEY).configure({ mode: 'off' })
    expect(await confirmTwice(a)).toMatchObject({
      initiator: 'auto',
      outcome: 'refused',
      reason: 'memory-off',
      source: { sessionKey: 'session-a' },
    })
    await a.openMemory(WORKSPACE_MEMORY_KEY).configure({ mode: 'auto' })
    // The second session's offer of the same entry and content is its own, judged now.
    const b = await setup({ answers: answers(), key: 'session-b', home: a.home })
    expect(await confirmTwice(b)).toMatchObject({
      initiator: 'auto',
      outcome: 'saved',
      source: { sessionKey: 'session-b' },
    })
    await a.session.close()
    await b.session.close()
  })

  it("a repeated command id from another session is never answered with that session's receipt", async () => {
    const t = await setup({ answers: [grant] })
    const request = (key: string) => ({
      initiator: 'model' as const,
      commandId: 'same-command',
      session: { key, lane: 'main', workspaceRoot: t.root, lastSeq: 10, child: false },
      settingsRevision: 'r1',
      entry: {
        kind: 'memory' as const,
        id: 'read-b',
        version: 1,
        contentHash: 'v1',
        title: TITLE,
        content: BODY,
        applicability: 'session' as const,
      },
      evidenceSeqs: [1],
      confirmations: 0,
    })
    const first = await t.saves.save(request('session-a'))
    expect(first).toMatchObject({ outcome: 'saved', source: { sessionKey: 'session-a' } })
    const second = await t.saves.save(request('session-b'))
    expect(second.receiptId).not.toBe(first.receiptId)
    expect(second.source.sessionKey).toBe('session-b')
    // The same session repeating its command still gets its first receipt.
    expect((await t.saves.save(request('session-a'))).receiptId).toBe(first.receiptId)
    await t.session.close()
  })
})
