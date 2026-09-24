import type { ApprovalSeam, CheckpointSeam, SeamImplementations } from '@agnes/core'
import { HostError } from './errors.js'
import type { SessionWorkspaceRuntime } from './session-workspace-runtime.js'

type Closeable = Readonly<{ close?: () => Promise<void> | void }>

export type WorkspaceSeamContexts = Readonly<{
  approval: ApprovalSeam
  checkpoint: CheckpointSeam
  close(): Promise<void>
}>

const unavailable = (seam: 'approval' | 'checkpoint'): HostError =>
  new HostError('E_WORKSPACE_REQUIRED', `${seam} seam cannot be fitted to the session workspace`, {
    detail: { seam, reason: 'workspace-fitting-unavailable' },
  })

async function closeReverse(values: readonly Closeable[]): Promise<void> {
  const errors: unknown[] = []
  for (const value of [...values].reverse()) {
    try {
      await value.close?.()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'workspace seam context cleanup failed')
}

/** Fits shared dynamic seams to the already-authorized runtime before it can be published. */
export async function openWorkspaceSeamContexts(
  seams: Pick<SeamImplementations, 'approval' | 'checkpoint'>,
  runtime: SessionWorkspaceRuntime,
): Promise<WorkspaceSeamContexts> {
  if (!runtime.fencedFs) throw unavailable('checkpoint')
  const fitApproval = seams.approval.forWorkspace
  if (!fitApproval) throw unavailable('approval')
  const fitCheckpoint = seams.checkpoint.forWorkspace
  if (!fitCheckpoint) throw unavailable('checkpoint')

  const opened: Closeable[] = []
  try {
    const approval = await fitApproval.call(seams.approval, { root: runtime.root })
    opened.push(approval as ApprovalSeam & Closeable)
    const checkpoint = await fitCheckpoint.call(seams.checkpoint, {
      root: runtime.root,
      fs: runtime.fencedFs,
    })
    opened.push(checkpoint as CheckpointSeam & Closeable)
    let closed = false
    return Object.freeze({
      approval,
      checkpoint,
      async close() {
        if (closed) return
        closed = true
        await closeReverse(opened)
      },
    })
  } catch (error) {
    try {
      await closeReverse(opened)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'workspace seam context open and rollback failed')
    }
    throw error
  }
}
