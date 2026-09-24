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
  resume: async () => null,
})

const checkpoint = (): CheckpointSeam => ({
  snapshot: async () => ({ id: 'checkpoint' }),
  rewind: async () => undefined,
  list: async () => [],
})

describe('workspace seam contexts', () => {
  it('fits both seams to the authoritative runtime and closes them in reverse order', async () => {
    const order: string[] = []
    const fittedApproval = Object.assign(approval(), { close: () => void order.push('approval') })
    const fittedCheckpoint = Object.assign(checkpoint(), { close: () => void order.push('checkpoint') })
    const approvalFit = vi.fn(async () => fittedApproval)
    const checkpointFit = vi.fn(async () => fittedCheckpoint)

    const contexts = await openWorkspaceSeamContexts(
      {
        approval: Object.assign(approval(), { forWorkspace: approvalFit }),
        checkpoint: Object.assign(checkpoint(), { forWorkspace: checkpointFit }),
      },
      runtime,
    )

    expect(approvalFit).toHaveBeenCalledWith({ root: runtime.root })
    expect(checkpointFit).toHaveBeenCalledWith({ root: runtime.root, fs: runtime.fencedFs })
    expect(contexts.approval).toBe(fittedApproval)
    expect(contexts.checkpoint).toBe(fittedCheckpoint)
    await contexts.close()
    await contexts.close()
    expect(order).toEqual(['checkpoint', 'approval'])
  })

  it('fails closed when either dynamic seam cannot bind a workspace', async () => {
    await expect(
      openWorkspaceSeamContexts({ approval: approval(), checkpoint: checkpoint() }, runtime),
    ).rejects.toMatchObject({
      code: 'E_WORKSPACE_REQUIRED',
      detail: { seam: 'approval', reason: 'workspace-fitting-unavailable' },
    })
  })

  it('rolls back the fitted approval when checkpoint fitting fails', async () => {
    const close = vi.fn()
    await expect(
      openWorkspaceSeamContexts(
        {
          approval: Object.assign(approval(), {
            forWorkspace: async () => Object.assign(approval(), { close }),
          }),
          checkpoint: Object.assign(checkpoint(), {
            forWorkspace: async () => {
              throw new Error('checkpoint failed')
            },
          }),
        },
        runtime,
      ),
    ).rejects.toThrow('checkpoint failed')
    expect(close).toHaveBeenCalledOnce()
  })
})
