import { foldEntryMeta } from '@agnes/core-ledger/reduce/refinement-entry-meta'
import type { SaveReceipt } from '@agnes/core-ledger/reduce/refinement-save'
import { describe, expect, it, vi } from 'vitest'
import { entryKey } from '../src/refine/apply.js'
import { refinementFacade } from '../src/refinement/facade.js'
import { checkedReach, namesWorkspace } from '../src/refinement/reach.js'
import type { RefinementWorkspacePort, WorkspaceSaveRequest } from '../src/refinement/workspace.js'
import { textTurn, toolTurn } from './helpers/fake-provider.js'
import {
  type Answer,
  ids,
  open,
  output,
  QUOTE,
  REQUEST,
  type Seen,
  upsert,
} from './helpers/refinement-session.js'

const ROOT = '/srv/projects/shop-api'
const lesson = {
  kind: 'memory' as const,
  title: 'Answers',
  content: 'Answer in short sentences.',
  applicability: 'session' as const,
  usedEvidence: ['user:4', 'user:4:0:18'],
  reach: 'user',
}

describe('the reach a lesson may keep', () => {
  it('content naming a workspace falls back to workspace level', () => {
    expect(checkedReach(lesson, { kind: 'manual' }, { root: ROOT })).toBe('user')
    for (const content of [
      'Run tests from /srv/projects/shop-api/test.',
      'Keep notes in ~/notes.md.',
      'Logs are under /var/log/app/.',
      'Use C:\\tools\\bin for scripts.',
      'In shop-api, run make first.',
      'In SHOP-API, run make first.',
    ]) {
      expect(namesWorkspace(content, ROOT), content).toBe(true)
      expect(checkedReach({ ...lesson, content }, { kind: 'manual' }, { root: ROOT }), content).toBe(
        'workspace',
      )
    }
    // A slash command, a relative path or a word that only contains the folder name names no workspace.
    for (const content of ['Use /compact before long tasks.', 'Prefer docs/ over wiki.', 'shop-apis differ.'])
      expect(namesWorkspace(content, ROOT), content).toBe(false)
    // The title counts too.
    expect(checkedReach({ ...lesson, title: 'shop-api answers' }, { kind: 'manual' }, { root: ROOT })).toBe(
      'workspace',
    )
  })

  it('evidence from tool output alone cannot back reach user', () => {
    expect(checkedReach({ ...lesson, usedEvidence: ['tool:9'] }, { kind: 'manual' }, { root: ROOT })).toBe(
      'workspace',
    )
    expect(checkedReach({ ...lesson, usedEvidence: [] }, { kind: 'manual' }, { root: ROOT })).toBe(
      'workspace',
    )
    expect(checkedReach({ ...lesson, applicability: 'task' }, { kind: 'manual' }, { root: ROOT })).toBe(
      'workspace',
    )
  })

  it('only planned prompt or memory lessons the model did not ask for can keep it', () => {
    for (const trigger of [{ kind: 'compaction' }, { kind: 'repeated-failure' }, { kind: 'manual' }] as const)
      expect(checkedReach(lesson, trigger, { root: ROOT })).toBe('user')
    expect(checkedReach(lesson, { kind: 'model' }, { root: ROOT })).toBe('workspace')
    expect(checkedReach(lesson, { kind: 'manual', saveTo: 'workspace' }, { root: ROOT })).toBe('workspace')
    expect(checkedReach({ ...lesson, kind: 'skill' as never }, { kind: 'manual' }, { root: ROOT })).toBe(
      'workspace',
    )
    expect(checkedReach({ ...lesson, reach: 'workspace' }, { kind: 'manual' }, { root: ROOT })).toBe(
      'workspace',
    )
    const { reach: _none, ...unmarked } = lesson
    expect(checkedReach(unmarked, { kind: 'manual' }, { root: ROOT })).toBe('workspace')
  })

  it('entries without reach read as workspace', () => {
    const cell = { seq: 3, value: { kind: 'memory', id: 'a' } }
    const row = (extra: Record<string, unknown>) => ({
      seq: 4,
      origin: 'system' as const,
      trust: 'trusted' as const,
      data: {
        version: 1,
        kind: 'memory',
        id: 'a',
        contentHash: 'h',
        applicability: 'session',
        confirmations: { count: 0, usedEvidence: [] },
        ...extra,
      },
    })
    expect(foldEntryMeta(cell, row({}))).not.toHaveProperty('reach')
    expect(foldEntryMeta(cell, row({ reach: 'user' }))).toMatchObject({ reach: 'user' })
    // Any other value is not what Core writes: the row is not trusted at all.
    expect(foldEntryMeta(cell, row({ reach: 'everywhere' }))).toBeUndefined()
  })
})

const userLesson = (over: Record<string, unknown> = {}) =>
  output({ edits: [upsert('short', { quote: QUOTE, reach: 'user', ...over })], evidenceIds: ['e1'] })

describe('the planner hint in a session', () => {
  it('a planned lesson quoting the user keeps reach user in its metadata', async () => {
    const t = await open({ answers: [() => userLesson()] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const run = await t.refine()
    expect(run).toMatchObject({ state: 'applied' })
    expect(run?.plan?.edits[0]).toMatchObject({ reach: 'user' })
    expect(t.meta('short')).toMatchObject({ applicability: 'session', reach: 'user' })
    await t.session.close()
  })

  it('reach user on a skill or subagent rejects the plan', async () => {
    const t = await open({
      answers: [
        () =>
          output({
            edits: [upsert('s', { kind: 'skill', quote: QUOTE, reach: 'user' })],
            evidenceIds: ['e1'],
          }),
        () => output({ edits: [upsert('s', { quote: QUOTE, reach: 'everywhere' })], evidenceIds: ['e1'] }),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({
      state: 'rejected',
      reason: 'invalid-output',
      detail: 'reach-kind: 0',
    })
    expect(await t.refine()).toMatchObject({
      state: 'rejected',
      reason: 'invalid-output',
      detail: 'invalid-shape: edits[0]',
    })
    expect(t.entries()).toEqual([])
    await t.session.close()
  })

  it('content naming a workspace falls back to workspace level', async () => {
    const t = await open({ answers: [() => userLesson({ content: 'Build output goes to /srv/build/out.' })] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('short')).toMatchObject({ applicability: 'session' })
    expect(t.meta('short')).not.toHaveProperty('reach')
    await t.session.close()
  })

  it('evidence from tool output alone cannot back reach user', async () => {
    const t = await open({
      scripts: [toolTurn('read', { path: 'b' }), toolTurn('read', { path: 'b' }), textTurn('ok')],
      reads: [false, true],
      answers: [
        (seen: Seen) =>
          output({
            edits: [upsert('short', { reach: 'user', evidenceIds: ids(seen, (e) => e.kind === 'tool') })],
          }),
      ],
    })
    expect(await t.say('read b')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('short')).toMatchObject({ applicability: 'session' })
    expect(t.meta('short')).not.toHaveProperty('reach')
    await t.session.close()
  })
})

/** A host save path that records every request and answers `saved`. */
function host() {
  const asked: WorkspaceSaveRequest[] = []
  const workspace: RefinementWorkspacePort = {
    save: async (request) => {
      asked.push(request)
      return {
        receiptId: `rc-${request.commandId}`,
        commandId: request.commandId,
        initiator: request.initiator,
        source: {
          sessionKey: request.session.key,
          kind: request.entry.kind,
          entryId: request.entry.id,
          contentHash: 'c'.repeat(64),
          initiator: request.initiator,
        },
        outcome: 'saved',
        steps: [{ step: 'switch', verdict: 'pass' }],
        at: 1,
      } satisfies SaveReceipt
    },
  }
  return { asked, workspace }
}

const pair = () => [toolTurn('read', { path: 'b' }), toolTurn('read', { path: 'b' }), textTurn('ok')]
const byTools: Answer = (seen) =>
  output({
    confirmations: [{ entryId: 'memory/short', evidenceIds: ids(seen, (e) => e.kind === 'tool') }],
    evidenceIds: ids(seen, (e) => e.kind === 'tool'),
  })
const byQuote: Answer = () =>
  output({
    confirmations: [{ entryId: 'memory/short', evidenceIds: ['e1'], quote: 'read b again' }],
    evidenceIds: ['e1'],
  })

describe('the automatic offer of a lesson that may reach every workspace', () => {
  async function confirmedTwice(first: Answer, trigger: { kind?: 'manual' | 'model' } = {}) {
    const h = host()
    const t = await open({
      scripts: [textTurn('ok'), ...pair(), ...pair()],
      reads: [false, true, false, true],
      answers: [first, byTools, byQuote],
      workspace: h.workspace,
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine(trigger)).toMatchObject({ state: 'applied' })
    expect(await t.say('read b again')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    return { t, asked: h.asked }
  }

  it('goes to user memory as an automatic save after two confirmations', async () => {
    const { t, asked } = await confirmedTwice(() => userLesson())
    expect(asked[0]).toMatchObject({ initiator: 'auto', target: 'user', confirmations: 2 })
    expect(asked[0]?.commandId).toMatch(/^auto:[0-9a-f]{48}$/u)
    await t.session.close()
  })

  it('the model can never reach user memory, directly or through a planner hint', async () => {
    // The model's own review asks for reach user: the lesson is still offered to the workspace only.
    const { t, asked } = await confirmedTwice(() => userLesson(), { kind: 'model' })
    expect(asked[0]).toMatchObject({ initiator: 'auto' })
    expect(asked[0]).not.toHaveProperty('target')
    expect(t.meta('short')).not.toHaveProperty('reach')
    // A direct proposal has no reach to give.
    await refinementFacade(t.session).propose(
      {
        rationale: 'r',
        evidenceSeqs: [1],
        edits: [
          { op: 'upsert', kind: 'memory', id: 'direct', title: 't', content: 'c', reach: 'user' } as never,
        ],
      },
      {},
    )
    expect(
      t.session.state.refinementEntryMeta.get(entryKey({ kind: 'memory', id: 'direct' })),
    ).not.toHaveProperty('reach')
    await t.session.close()
  })
})
