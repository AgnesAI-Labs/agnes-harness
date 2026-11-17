import type { RefinementRunRecord } from '@agnes/core-ledger/reduce/state'
import { describe, expect, it, vi } from 'vitest'
import { createMaintenancePort } from '../src/maintenance/port.js'
import { planRefinementRun, queueRefinementRun, type RefinementRunDeps } from '../src/refinement/run.js'
import { tryApply } from '../src/refinement/scheduler.js'
import type { RefinementPlanner } from '../src/refinement/types.js'
import type { RefinementWorkspaceRefs, WorkspaceReference } from '../src/refinement/workspace-refs.js'
import { textTurn, toolTurn } from './helpers/fake-provider.js'
import {
  type Answer,
  BODY,
  ids,
  open,
  output,
  QUOTE,
  REQUEST,
  type Seen,
  target,
  upsert,
} from './helpers/refinement-session.js'
import { ofType } from './helpers/side-call-session.js'

const REF = 'workspace-memory/p1'
const paragraph = (over: Partial<WorkspaceReference> = {}): WorkspaceReference => ({
  ref: REF,
  title: 'Read the right file',
  summary: BODY,
  version: 'v1',
  ...over,
})

/** A host that lists `refs` (read on every call, so a test may change them) and records renewals. */
function workspace(refs: WorkspaceReference[]) {
  const renewed: { ref: string; version: string }[] = []
  const listed: number[] = []
  const port: RefinementWorkspaceRefs = {
    list: () => {
      listed.push(1)
      return refs
    },
    renew: (_at, ref, version) => {
      renewed.push({ ref, version })
      return true
    },
  }
  return { port, renewed, listed, refs }
}

/** The newest request of the user's own in what the planner was shown: turns before it are shown too. */
const newest = (seen: Seen) => ids(seen, (e) => e.kind === 'user').slice(-1)
const confirmBy = (evidenceIds: string[], quote?: string, entryId = REF) =>
  output({
    confirmations: [{ entryId, evidenceIds, ...(quote === undefined ? {} : { quote }) }],
    evidenceIds,
  })

/** Waits until the run's renewals (if any) have gone out, then reads what was renewed. */
const settled = async (w: ReturnType<typeof workspace>, count: number) => {
  await vi.waitFor(() => expect(w.renewed).toHaveLength(count))
  // Nothing more arrives after a short while.
  await new Promise((resolve) => setTimeout(resolve, 20))
  return w.renewed
}

describe('workspace references in a plan', () => {
  it('workspace references are shown as confirm-only', async () => {
    const w = workspace([paragraph()])
    let seen: Seen | undefined
    const t = await open({
      workspaceRefs: w.port,
      answers: [
        (s) => {
          seen = s
          return output({})
        },
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const run = (await t.refine()) as RefinementRunRecord
    expect(seen?.guidance?.workspace).toEqual([{ ref: REF, title: 'Read the right file', summary: BODY }])
    // Shown as references only, never among the entries a plan may rewrite.
    expect(seen?.entries).toEqual([])
    expect(run.workspaceRefs).toEqual([{ ref: REF, version: 'v1' }])
    await t.session.close()
  })

  it('with no workspace entries the planner input and the run are as before', async () => {
    for (const port of [undefined, workspace([]).port]) {
      let seen: Seen | undefined
      const t = await open({
        ...(port ? { workspaceRefs: port } : {}),
        answers: [
          (s) => {
            seen = s
            return output({})
          },
        ],
      })
      expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
      const run = (await t.refine()) as RefinementRunRecord
      expect(seen?.guidance).not.toHaveProperty('workspace')
      expect(seen?.guidance).not.toHaveProperty('saveTo')
      expect(run).not.toHaveProperty('workspaceRefs')
      await t.session.close()
    }
  })

  it('an update or delete of a workspace reference rejects the plan', async () => {
    const w = workspace([paragraph()])
    const t = await open({
      workspaceRefs: w.port,
      answers: [
        () => output({ edits: [upsert('p1', { kind: 'workspace-memory' })], evidenceIds: ['e1'] }),
        () =>
          output({
            edits: [{ op: 'delete', kind: 'workspace-memory', id: 'p1', evidenceIds: ['e1'] }],
            evidenceIds: ['e1'],
          }),
        // A reference the prompt never showed cannot be confirmed either.
        () => confirmBy(['e1'], QUOTE, 'workspace-memory/other'),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({
      state: 'rejected',
      reason: 'invalid-output',
      detail: `confirm-only: ${REF}`,
    })
    expect(await t.refine()).toMatchObject({
      state: 'rejected',
      reason: 'invalid-output',
      detail: `confirm-only: ${REF}`,
    })
    expect(await t.refine()).toMatchObject({
      state: 'rejected',
      reason: 'invalid-output',
      detail: 'unknown-entry: workspace-memory/other',
    })
    expect(ofType(await t.rows(), 'harness/entry')).toEqual([])
    expect(w.renewed).toEqual([])
    await t.session.close()
  })
})

describe('confirming a workspace entry', () => {
  it('a confirmation renews reviewAfter and writes no memory file', async () => {
    const w = workspace([paragraph()])
    const t = await open({ workspaceRefs: w.port, answers: [() => confirmBy(['e1'], QUOTE)] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const run = await t.refine()
    expect(run).toMatchObject({ state: 'applied' })
    expect(run?.plan?.workspaceConfirmations).toEqual([
      expect.objectContaining({
        ref: REF,
        confirmedBy: expect.objectContaining({ identity: expect.any(String) }),
      }),
    ])
    // Renewed at the version it was shown at; no session entry is written for it.
    expect(await settled(w, 1)).toEqual([{ ref: REF, version: 'v1' }])
    const all = await t.rows()
    expect(ofType(all, 'harness/entry')).toEqual([])
    expect(ofType(all, 'x/core/refinement-entry-meta')).toEqual([])
    await t.session.close()
  })

  it('a session opened with memory writes off renews nothing', async () => {
    const w = workspace([paragraph()])
    const t = await open({
      workspaceRefs: w.port,
      attrs: { memoryWrites: 'off' },
      answers: [() => confirmBy(['e1'], QUOTE)],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await settled(w, 0)).toEqual([])
    await t.session.close()
  })

  it('the same evidence confirms a workspace reference once', async () => {
    const w = workspace([paragraph()])
    const t = await open({
      workspaceRefs: w.port,
      answers: [
        () => confirmBy(['e1'], QUOTE),
        () => confirmBy(['e1'], QUOTE),
        // New evidence, a newer request quoted, counts again.
        (seen) => confirmBy(newest(seen), 'read file b once more'),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    await settled(w, 1)
    // The same request cited again: already counted, so there is nothing to apply or renew.
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(await settled(w, 1)).toHaveLength(1)
    expect(await t.say('second task: read file b once more')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await settled(w, 2)).toHaveLength(2)
    await t.session.close()
  })

  it('evidence that renewed one content version cannot renew the next', async () => {
    const w = workspace([paragraph()])
    const t = await open({
      workspaceRefs: w.port,
      answers: [() => confirmBy(['e1'], QUOTE), () => confirmBy(['e1'], QUOTE)],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await settled(w, 1)).toEqual([{ ref: REF, version: 'v1' }])
    // The paragraph was edited: a new content version, which the same request cannot bear out.
    w.refs.splice(0, 1, paragraph({ version: 'v2' }))
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(await settled(w, 1)).toHaveLength(1)
    await t.session.close()
  })

  it('two plans settled on the same evidence before either applied renew once', async () => {
    const w = workspace([paragraph()])
    const t = await open({
      workspaceRefs: w.port,
      answers: [() => confirmBy(['e1'], QUOTE), () => confirmBy(['e1'], QUOTE)],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const s = t.session
    const planDeps: RefinementRunDeps = {
      maintenance: createMaintenancePort(s),
      planner: s.d.refinement?.planner() as RefinementPlanner,
      settings: () => ({ enabled: true, revision: 'r1' }),
      target,
    }
    const plan = async () => {
      const runId = await queueRefinementRun(s, { kind: 'manual', seq: s.lastSeq }, 'r1')
      return planRefinementRun(s, runId, planDeps, new AbortController().signal)
    }
    const a = await plan()
    const b = await plan()
    expect(a?.plan?.workspaceConfirmations?.[0]?.confirmedBy).toBeDefined()
    expect(b?.plan?.workspaceConfirmations?.[0]?.confirmedBy).toEqual(
      a?.plan?.workspaceConfirmations?.[0]?.confirmedBy,
    )
    expect(await tryApply(s, a?.runId as string)).toBe('applied')
    expect(await tryApply(s, b?.runId as string)).toBe('applied')
    expect(await settled(w, 1)).toHaveLength(1)
    await s.close()
  })

  it('tool output echoing a workspace entry, or harness_inspect, never confirms it', async () => {
    // The second entry's words appear in no result: only its being an inspect result rules it out.
    const other = paragraph({
      ref: 'workspace-memory/p2',
      title: 'Unrelated title',
      summary: 'Unrelated summary.',
    })
    const w = workspace([paragraph(), other])
    const pair = (tool: string, args: object) => [toolTurn(tool, args), toolTurn(tool, args)]
    const t = await open({
      workspaceRefs: w.port,
      scripts: [
        ...pair('cat', { path: 'MEMORY.md' }),
        ...pair('harness_inspect', { path: 'workspace-memory/p1' }),
        textTurn('ok'),
        ...pair('read', { path: 'b' }),
        textTurn('ok'),
      ],
      reads: [false, true],
      tools: { cat: [false, true], harness_inspect: [false, true] },
      answers: [
        (seen) => {
          const echoed = seen.evidence.filter((e) => e.tool === 'cat' || e.tool === 'harness_inspect')
          expect(echoed.map((e) => e.isError)).toEqual([true, false, true, false])
          expect(echoed[1]?.text).toContain(BODY)
          const of = (tool: string) => seen.evidence.filter((e) => e.tool === tool).map((e) => e.id)
          return output({
            confirmations: [
              { entryId: REF, evidenceIds: of('cat') },
              { entryId: other.ref, evidenceIds: of('harness_inspect') },
            ],
            evidenceIds: [...of('cat'), ...of('harness_inspect')],
          })
        },
        (seen) => confirmBy(ids(seen, (e) => e.tool === 'read')),
      ],
    })
    expect(await t.say('look the saved entry up')).toMatchObject({ reason: 'completed' })
    const echo = await t.refine()
    expect(echo).toMatchObject({ state: 'no-op' })
    expect(echo?.plan?.workspaceConfirmations).toHaveLength(2)
    for (const c of echo?.plan?.workspaceConfirmations ?? []) expect(c).not.toHaveProperty('confirmedBy')
    expect(await settled(w, 0)).toEqual([])
    // A failed and then successful read of something else is evidence of the entry's shape.
    expect(await t.say('read b')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await settled(w, 1)).toEqual([{ ref: REF, version: 'v1' }])
    await t.session.close()
  })

  it('the evidence that saved an entry from this session never renews it', async () => {
    const w = workspace([])
    const tools = (seen: Seen) => ids(seen, (e) => e.kind === 'tool')
    const t = await open({
      workspaceRefs: w.port,
      scripts: [
        textTurn('ok'),
        toolTurn('read', { path: 'b' }),
        toolTurn('read', { path: 'b' }),
        textTurn('ok'),
      ],
      reads: [false, true],
      answers: [
        () => output({ edits: [upsert('read-b', { quote: QUOTE })], evidenceIds: ['e1'] }),
        // A failed and then successful read confirms the session entry.
        (seen) => confirmBy(tools(seen), undefined, 'memory/read-b'),
        // The entry is then saved to the workspace from this session: the request that granted it
        // and the pair that confirmed it are both spent for the saved copy.
        () => confirmBy(['e1'], QUOTE),
        (seen) => confirmBy(tools(seen)),
        (seen) => confirmBy(newest(seen), 'read file b once more'),
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await t.say('read b again')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(t.meta('read-b')?.confirmations.count).toBe(1)
    w.refs.push(paragraph({ source: { sessionKey: t.session.key, kind: 'memory', entryId: 'read-b' } }))
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(await settled(w, 0)).toEqual([])
    // A newer request of the user's own does bear it out.
    expect(await t.say('second task: read file b once more')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    expect(await settled(w, 1)).toHaveLength(1)
    await t.session.close()
  })

  it('an entry whose content changed before the plan settled is not renewed', async () => {
    const w = workspace([paragraph()])
    const changed: Answer = () => {
      w.refs.splice(0, 1, paragraph({ version: 'v2' }))
      return confirmBy(['e1'], QUOTE)
    }
    const gone: Answer = (seen) => {
      w.refs.splice(0, 1)
      return confirmBy(newest(seen), 'read file b once more')
    }
    const t = await open({ workspaceRefs: w.port, answers: [changed, gone] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    w.refs.splice(0, 1, paragraph())
    expect(await t.say('second task: read file b once more')).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(await settled(w, 0)).toEqual([])
    await t.session.close()
  })

  it('a host that fails to list or renew leaves the session as it would be without it', async () => {
    const throwing: RefinementWorkspaceRefs = {
      list: () => {
        throw new Error('disk gone')
      },
      renew: () => false,
    }
    let seen: Seen | undefined
    const t = await open({
      workspaceRefs: throwing,
      answers: [
        (s) => {
          seen = s
          return output({})
        },
      ],
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'no-op' })
    expect(seen?.guidance).not.toHaveProperty('workspace')
    await t.session.close()

    const refusing = workspace([paragraph()])
    refusing.port.renew = () => {
      throw new Error('locked')
    }
    const u = await open({ workspaceRefs: refusing.port, answers: [() => confirmBy(['e1'], QUOTE)] })
    expect(await u.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await u.refine()).toMatchObject({ state: 'applied' })
    await u.session.close()
  })
})
