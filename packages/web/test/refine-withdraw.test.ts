import { describe, expect, it, vi } from 'vitest'
import { withdrawRefinement } from '../src/refine-withdraw.js'

const rejected = (data: Record<string, unknown>) =>
  Object.assign(new Error('rejected'), { code: -32010, data: { code: 'SEMANTIC_REJECTED', ...data } })

function client(refineRollback: (sessionId: string, appliedSeq: number) => Promise<{ seq: number }>) {
  return { session: { refineRollback: vi.fn(refineRollback) } }
}

describe('withdrawing an applied refinement from the timeline', () => {
  it('asks the daemon for the applied row of the session and reports it withdrawn', async () => {
    const c = client(async () => ({ seq: 12 }))
    await expect(withdrawRefinement(c, 'session-1', 7)).resolves.toEqual({ kind: 'withdrawn' })
    expect(c.session.refineRollback).toHaveBeenCalledWith('session-1', 7)
  })

  it('reports a later change as a conflict a person has to resolve, with the entries named', async () => {
    const c = client(async () => {
      throw rejected({ reason: 'changed-since', changed: ['memory/build', 3, 'skill/x'] })
    })
    await expect(withdrawRefinement(c, 's', 7)).resolves.toEqual({
      kind: 'changed-since',
      changed: ['memory/build', 'skill/x'],
    })
    const bare = client(async () => {
      throw rejected({ reason: 'changed-since' })
    })
    await expect(withdrawRefinement(bare, 's', 7)).resolves.toEqual({ kind: 'changed-since' })
  })

  it('passes another refusal on with its reason', async () => {
    const c = client(async () => {
      throw rejected({ reason: 'not-applied' })
    })
    await expect(withdrawRefinement(c, 's', 7)).resolves.toEqual({ kind: 'refused', reason: 'not-applied' })
  })

  it('reports any other error as a failure with its message', async () => {
    const denied = client(async () => {
      throw Object.assign(new Error('local owner only'), {
        code: -32003,
        data: { code: 'CAPABILITY_DENIED' },
      })
    })
    await expect(withdrawRefinement(denied, 's', 7)).resolves.toEqual({
      kind: 'failed',
      message: 'local owner only',
    })
  })
})
