import { describe, expect, it, vi } from 'vitest'
import { saveRefinementEntry } from '../src/refine-save.js'

const rejected = (reason: string) =>
  Object.assign(new Error('rejected'), { code: -32010, data: { code: 'SEMANTIC_REJECTED', reason } })

function client(
  refineSave: (sessionId: string, kind: string, id: string, target?: 'user') => Promise<unknown>,
) {
  return { session: { refineSave: vi.fn(refineSave) } }
}

describe('saving one kept entry to the workspace from the timeline', () => {
  it('asks the daemon for the entry and reports the receipt, never its text', async () => {
    const c = client(async () => ({
      receipt: { outcome: 'refused', reason: 'memory-full', source: { entryId: 'build' } },
    }))
    await expect(saveRefinementEntry(c, 'session-1', 'memory', 'build')).resolves.toEqual({
      kind: 'receipt',
      state: 'refused',
      reason: 'memory-full',
    })
    expect(c.session.refineSave).toHaveBeenCalledWith('session-1', 'memory', 'build')
    const saved = client(async () => ({ receipt: { outcome: 'saved' } }))
    await expect(saveRefinementEntry(saved, 's', 'prompt', 'style')).resolves.toEqual({
      kind: 'receipt',
      state: 'saved',
    })
  })

  it('asks for user memory with target user and reports where the save went', async () => {
    const c = client(async () => ({
      receipt: { outcome: 'saved', layer: 'user', initiator: 'user', userMemoryRead: false },
    }))
    await expect(saveRefinementEntry(c, 's', 'memory', 'style', 'user')).resolves.toEqual({
      kind: 'receipt',
      state: 'saved',
      target: 'user-memory',
      userMemoryRead: false,
      initiator: 'user',
    })
    expect(c.session.refineSave).toHaveBeenCalledWith('s', 'memory', 'style', 'user')
    // A save that fell back to the workspace carries no user memory layer.
    const fell = client(async () => ({ receipt: { outcome: 'saved', initiator: 'user' } }))
    await expect(saveRefinementEntry(fell, 's', 'memory', 'style', 'user')).resolves.toEqual({
      kind: 'receipt',
      state: 'saved',
      initiator: 'user',
    })
  })

  it('reports a refusal before any receipt and a failure to ask', async () => {
    const missing = client(async () => {
      throw rejected('not-found')
    })
    await expect(saveRefinementEntry(missing, 's', 'memory', 'x')).resolves.toEqual({
      kind: 'refused',
      reason: 'not-found',
    })
    const broken = client(async () => {
      throw new Error('connection lost')
    })
    await expect(saveRefinementEntry(broken, 's', 'memory', 'x')).resolves.toEqual({
      kind: 'failed',
      message: 'connection lost',
    })
  })
})
