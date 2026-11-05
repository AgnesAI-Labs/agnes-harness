import { describe, expect, it } from 'vitest'
import { entryKey } from '../src/refine/apply.js'
import { refinementFacade } from '../src/refinement/facade.js'
import { workspaceSaveRequest } from '../src/refinement/workspace.js'
import type {
  RefinementWorkspaceRefs,
  SavedEntry,
  WorkspaceReference,
} from '../src/refinement/workspace-refs.js'
import { ids, open, output, REQUEST, upsert } from './helpers/refinement-session.js'

const PID = 'r0000000001'
const saved = (over: Partial<SavedEntry> = {}): SavedEntry => ({
  ref: `ws.${PID}`,
  kind: 'memory',
  title: 'Notes file',
  content: 'The notes live in docs/notes.txt.',
  version: 'v1',
  savedAt: 1,
  untouched: true,
  ...over,
})

/** A host port with one saved paragraph, listed for confirmation and in full for the snapshot. */
function port(entry: SavedEntry) {
  const renewed: string[] = []
  const ref: WorkspaceReference = {
    ref: `workspace-memory/${PID}`,
    title: entry.title,
    summary: entry.content,
    version: entry.version,
  }
  const refs: RefinementWorkspaceRefs = {
    list: () => [ref],
    renew: (_at, r) => {
      renewed.push(r)
      return true
    },
    entries: () => [entry],
    revision: () => 'r1',
  }
  return { refs, renewed }
}

describe('a later session rewrites a saved entry by id', () => {
  it('an untouched saved entry is offered in full and an upsert applies with a save that replaces it', async () => {
    const p = port(saved())
    const t = await open({
      workspaceRefs: p.refs,
      answers: [
        (seen) => {
          expect(seen.entries).toContainEqual(
            expect.objectContaining({ id: `ws.${PID}`, content: 'The notes live in docs/notes.txt.' }),
          )
          return output({
            edits: [
              upsert(`ws.${PID}`, {
                content: 'The notes live in docs/notes.md.',
                evidenceIds: ids(seen, (e) => e.kind === 'user'),
              }),
            ],
          })
        },
      ],
    })
    await t.say(REQUEST)
    expect((await t.refine())?.state).toBe('applied')
    expect(t.entries()).toContain(`ws.${PID}`)
    const request = workspaceSaveRequest(t.session, {
      kind: 'memory',
      id: `ws.${PID}`,
      initiator: 'auto',
    } as never)
    expect(request?.entry.replaces).toEqual({ layer: 'workspace', paragraphId: PID })
  })

  it('a saved entry a person edited is not offered for rewriting, and an upsert of it is dropped', async () => {
    const p = port(saved({ untouched: false }))
    const t = await open({
      workspaceRefs: p.refs,
      answers: [
        (seen) => {
          expect(seen.entries.map((e) => e.id)).not.toContain(`ws.${PID}`)
          return output({
            edits: [upsert(`ws.${PID}`, { evidenceIds: ids(seen, (e) => e.kind === 'user') })],
          })
        },
      ],
    })
    await t.say(REQUEST)
    expect((await t.refine())?.state).toBe('rejected')
    expect(t.entries()).not.toContain(`ws.${PID}`)
  })

  it('deleting a saved entry is refused', async () => {
    const p = port(saved())
    const t = await open({
      workspaceRefs: p.refs,
      answers: [
        (seen) =>
          output({
            edits: [
              {
                op: 'delete',
                kind: 'memory',
                id: `ws.${PID}`,
                evidenceIds: ids(seen, (e) => e.kind === 'user'),
              },
            ],
          }),
      ],
    })
    await t.say(REQUEST)
    expect((await t.refine())?.state).toBe('rejected')
  })

  it('confirming the saved entry by its ws. id renews the saved paragraph', async () => {
    const p = port(saved())
    const t = await open({
      workspaceRefs: p.refs,
      answers: [
        (seen) =>
          output({
            confirmations: [
              {
                entryId: `memory/ws.${PID}`,
                evidenceIds: ids(seen, (e) => e.kind === 'user'),
                quote: 'read file b, not a',
              },
            ],
          }),
      ],
    })
    await t.say(REQUEST)
    const run = await t.refine()
    expect(run?.plan?.workspaceConfirmations?.map((c) => c.ref)).toEqual([`workspace-memory/${PID}`])
  })

  it('the model may rewrite an untouched saved entry it read in full, never delete it', async () => {
    const p = port(saved())
    const t = await open({ workspaceRefs: p.refs })
    await t.say(REQUEST)
    const facade = refinementFacade(t.session)
    expect(await facade.inspect({ op: 'get', kind: 'memory', id: `ws.${PID}` })).toMatchObject({ op: 'get' })
    expect(
      await facade.propose({
        rationale: 'r',
        evidenceSeqs: [1],
        edits: [{ op: 'delete', kind: 'memory', id: `ws.${PID}` }],
      }),
    ).toMatchObject({ refused: 'invalid' })
    const proposed = await facade.propose({
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [
        { op: 'upsert', kind: 'memory', id: `ws.${PID}`, title: 'Notes file', content: 'docs/notes.md' },
      ],
    })
    expect(proposed).toHaveProperty('runId')
    expect(entryKey({ kind: 'memory', id: `ws.${PID}` })).toBeTruthy()
  })
})

describe('user memory entries', () => {
  const USER_PID = 'r0000000009'
  function userPort() {
    const renewed: string[] = []
    const entry = saved({
      ref: `user.${USER_PID}`,
      title: 'Short answers',
      content: 'Answer in short sentences.',
    })
    const refs: RefinementWorkspaceRefs = {
      list: () => [
        { ref: `user-memory/${USER_PID}`, title: entry.title, summary: entry.content, version: 'v1' },
      ],
      renew: (_at, r) => {
        renewed.push(r)
        return true
      },
      entries: () => [entry],
      revision: () => 'r1',
    }
    return { refs, renewed }
  }

  it('confirming a user. entry renews the user memory section', async () => {
    const p = userPort()
    const t = await open({
      workspaceRefs: p.refs,
      answers: [
        (seen) =>
          output({
            confirmations: [
              {
                entryId: `memory/user.${USER_PID}`,
                evidenceIds: ids(seen, (e) => e.kind === 'user'),
                quote: 'read file b, not a',
              },
            ],
          }),
      ],
    })
    await t.say(REQUEST)
    const run = await t.refine()
    expect(run?.plan?.workspaceConfirmations?.map((c) => c.ref)).toEqual([`user-memory/${USER_PID}`])
  })

  it('a rewrite of a user. entry is saved to user memory, whatever its reach says', async () => {
    const p = userPort()
    const t = await open({
      workspaceRefs: p.refs,
      answers: [
        (seen) =>
          output({
            edits: [
              upsert(`user.${USER_PID}`, {
                content: 'Answer briefly.',
                evidenceIds: ids(seen, (e) => e.kind === 'user'),
              }),
            ],
          }),
      ],
    })
    await t.say(REQUEST)
    expect((await t.refine())?.state).toBe('applied')
    const request = workspaceSaveRequest(t.session, {
      kind: 'memory',
      id: `user.${USER_PID}`,
      initiator: 'auto',
    } as never)
    expect(request?.target).toBe('user')
    expect(request?.entry.replaces).toEqual({ layer: 'user', paragraphId: USER_PID })
    const forced = workspaceSaveRequest(t.session, {
      kind: 'memory',
      id: `user.${USER_PID}`,
      initiator: 'auto',
      target: undefined,
    } as never)
    expect(forced?.target).toBe('user')
  })
})
