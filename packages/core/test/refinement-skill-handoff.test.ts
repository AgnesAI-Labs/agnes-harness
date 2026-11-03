import { REFINEMENT_ENTRY_META_EVENT } from '@agnes/core-ledger/reduce/refinement-entry-meta'
import type { SaveReceipt } from '@agnes/core-ledger/reduce/refinement-save'
import { describe, expect, it, vi } from 'vitest'
import { applyRefine, entryKey } from '../src/refine/apply.js'
import type { RefinementWorkspacePort, WorkspaceSaveRequest } from '../src/refinement/workspace.js'
import { saveToWorkspace } from '../src/refinement/workspace.js'
import { experienceNotes } from '../src/request/experience.js'
import { textTurn, toolTurn } from './helpers/fake-provider.js'
import { type Answer, open, output, QUOTE, REQUEST, upsert } from './helpers/refinement-session.js'
import { ofType } from './helpers/side-call-session.js'

const NAME = 'read-b'

/** A host save path: a skill is installed (unless told otherwise), anything else saved. */
function host(answer: (request: WorkspaceSaveRequest) => Partial<SaveReceipt> = () => ({})) {
  const asked: WorkspaceSaveRequest[] = []
  const workspace: RefinementWorkspacePort = {
    save: async (request) => {
      asked.push(request)
      const skill = request.entry.kind === 'skill'
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
        outcome: skill ? 'installed' : 'saved',
        steps: [{ step: 'switch', verdict: 'pass' }],
        ...(skill
          ? {
              target: {
                kind: 'skill' as const,
                name: request.entry.id,
                resourceId: 'skill/workspace/workspace-agnes/abc',
                revision: 'a'.repeat(64),
              },
            }
          : {}),
        at: 1,
        ...answer(request),
      }
    },
  }
  return { asked, workspace }
}

const pair = () => [toolTurn('read', { path: 'b' }), toolTurn('read', { path: 'b' }), textTurn('ok')]
const grant = () =>
  output({ edits: [upsert(NAME, { kind: 'skill', quote: QUOTE, title: 'Read b' })], evidenceIds: ['e1'] })
/** A session-level skill entry, confirmed by `answers`, in auto mode. */
async function confirmable(answers: Answer[], workspace: RefinementWorkspacePort) {
  const t = await open({
    scripts: [textTurn('ok'), ...pair(), ...pair()],
    reads: [false, true, false, true],
    answers: [grant, ...answers],
    workspace,
  })
  expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
  expect(await t.refine()).toMatchObject({ state: 'applied' })
  expect(await t.say('read b again')).toMatchObject({ reason: 'completed' })
  return t
}

const skillMeta = (t: Awaited<ReturnType<typeof open>>) =>
  t.session.state.refinementEntryMeta.get(entryKey({ kind: 'skill', id: NAME }))
const handOffRows = async (t: Awaited<ReturnType<typeof open>>) =>
  ofType(await t.rows(), REFINEMENT_ENTRY_META_EVENT).filter(
    (row) => (row.data as { handedOff?: unknown }).handedOff === true,
  )
const catalogChanges = async (t: Awaited<ReturnType<typeof open>>) =>
  (await t.session.d.log.scan({ type: 'x/core/refinement-prefix-change', limit: 50 })).filter(
    (row) => (row.data as { reason?: unknown }).reason === 'skill-catalog',
  )

describe('skills installed into the workspace hand off their session entries', () => {
  it('a skill a review wrote is installed at its first apply and its entry hands off once', async () => {
    const h = host()
    const t = await confirmable([], h.workspace)
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]).toMatchObject({
      initiator: 'auto',
      confirmations: 1,
      entry: { kind: 'skill', id: NAME },
    })
    await vi.waitFor(() => expect(skillMeta(t)?.handedOff).toBe(true))
    expect(await handOffRows(t)).toHaveLength(1)
    // The skill catalogue in the system prefix changes on the next turn: an expected change, on record.
    expect(await catalogChanges(t)).toHaveLength(1)
    // The same save again (a repeat answered with the same receipt) hands off nothing more.
    await saveToWorkspace(t.session, {
      initiator: 'auto',
      kind: 'skill',
      id: NAME,
      commandId: h.asked[0]?.commandId as string,
    })
    expect(await handOffRows(t)).toHaveLength(1)
    expect(await catalogChanges(t)).toHaveLength(1)
    await t.session.close()
  })

  it('a handed-off entry is not delivered and the model is told to use the skill once', async () => {
    const h = host()
    const t = await open({
      scripts: [textTurn('ok'), textTurn('ok'), textTurn('ok'), textTurn('ok')],
      answers: [grant],
      workspace: h.workspace,
      sw: { enabled: true, mode: 'manual', revision: 'r1' },
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    // The model is given the entry (as metadata) with the next request.
    expect(await t.say('next')).toMatchObject({ reason: 'completed' })
    expect(t.lastRequest()).toContain(`[skill/${NAME} v1]`)
    const saved = await saveToWorkspace(t.session, { initiator: 'user', kind: 'skill', id: NAME })
    expect(saved).toMatchObject({ receipt: { outcome: 'installed' } })
    expect(skillMeta(t)?.handedOff).toBe(true)
    const notes = await experienceNotes(t.session, t.session.surface())
    const text = notes.map((note) => `${note.text}\n${note.data ?? ''}`).join('\n')
    expect(text).toContain(`[skill/${NAME} v1] withdrawn: installed as the workspace skill ${NAME}`)
    expect(text).not.toContain('it was removed')
    // Once told, the model is not told again, and the entry is never delivered again.
    expect(await t.say('again')).toMatchObject({ reason: 'completed' })
    expect(await t.say('and again')).toMatchObject({ reason: 'completed' })
    const last = t.lastRequest()
    expect(last.split(`installed as the workspace skill ${NAME}`)).toHaveLength(2)
    // Given once (as metadata), then said once to be installed.
    expect(last.split(`[skill/${NAME} v1]`)).toHaveLength(3)
    await t.session.close()
  })

  it('no hand-off when nothing was installed, or the entry changed while the install ran', async () => {
    let during: (() => Promise<unknown>) | undefined
    const h = host((request) =>
      request.initiator === 'model'
        ? ({ outcome: 'refused', reason: 'static-check', target: undefined } as never)
        : {},
    )
    const workspace: RefinementWorkspacePort = {
      save: async (request) => {
        await during?.()
        return h.workspace.save(request)
      },
    }
    const t = await open({
      answers: [grant],
      workspace,
      sw: { enabled: true, mode: 'manual', revision: 'r1' },
    })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    expect(await t.refine()).toMatchObject({ state: 'applied' })
    await saveToWorkspace(t.session, { initiator: 'model', kind: 'skill', id: NAME })
    expect(skillMeta(t)?.handedOff).toBeUndefined()
    // A new version of the entry lands while the install of the old one runs: the new one stays.
    during = () =>
      t.session.locked(() =>
        applyRefine(
          t.session,
          {
            proposalId: 'p2',
            runId: 'r2',
            trigger: 'manual',
            edits: [
              {
                op: 'upsert',
                entry: {
                  kind: 'skill',
                  id: NAME,
                  title: 'Read b',
                  content: 'Read c.',
                  scope: 'local',
                  version: 1,
                  source: 'refine',
                } as never,
              },
            ],
            baseline: [],
            rationale: 'r',
            evidenceSeqs: [1],
          },
          { maxEdits: 5, maxChars: 2000, safetyCap: 200 },
        ),
      )
    expect(await saveToWorkspace(t.session, { initiator: 'user', kind: 'skill', id: NAME })).toMatchObject({
      receipt: { outcome: 'installed' },
    })
    expect(skillMeta(t)?.handedOff).toBeUndefined()
    expect(await handOffRows(t)).toHaveLength(0)
    // The older version was installed all the same: the catalogue still changes.
    expect(await catalogChanges(t)).toHaveLength(1)
    await t.session.close()
  })
})
