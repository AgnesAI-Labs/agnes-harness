import type { ApprovalSeam, CheckpointSeam } from '@agnes/core'
import { describe, expect, it, vi } from 'vitest'
import type { SessionWorkspaceRuntime } from '../src/session-workspace-runtime.js'
import { openWorkspaceSeamContexts } from '../src/workspace-seam-contexts.js'

const runtime = {
  root: '/work/session-a',
  fencedFs: Object.freeze({}),
} as unknown as SessionWorkspaceRuntime

const approval = (): ApprovalSeam => ({
  ask: async () => 'rejected',
})

const checkpoint = (): CheckpointSeam => ({
  snapshot: async () => ({ id: 'checkpoint' }),
  rewind: async () => undefined,
  list: async () => [],
})

describe('workspace seam contexts', () => {
  it('fits the checkpoint to the authoritative runtime and passes the approval seam through', async () => {
    const order: string[] = []
    const fittedCheckpoint = Object.assign(checkpoint(), { close: () => void order.push('checkpoint') })
    const checkpointFit = vi.fn(async () => fittedCheckpoint)
    const delivery = approval()

    const contexts = await openWorkspaceSeamContexts(
      { approval: delivery, checkpoint: Object.assign(checkpoint(), { forWorkspace: checkpointFit }) },
      runtime,
    )

    expect(checkpointFit).toHaveBeenCalledWith({ root: runtime.root, fs: runtime.fencedFs })
    expect(contexts.approval).toBe(delivery)
    expect(contexts.checkpoint).toBe(fittedCheckpoint)
    await contexts.close()
    await contexts.close()
    expect(order).toEqual(['checkpoint'])
  })

  it('fails closed when the checkpoint cannot bind a workspace', async () => {
    await expect(
      openWorkspaceSeamContexts({ approval: approval(), checkpoint: checkpoint() }, runtime),
    ).rejects.toMatchObject({
      code: 'E_WORKSPACE_REQUIRED',
      detail: { seam: 'checkpoint', reason: 'workspace-fitting-unavailable' },
    })
  })
})
