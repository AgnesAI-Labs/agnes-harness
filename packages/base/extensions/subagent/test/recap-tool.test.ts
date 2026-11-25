import type { RecapFactSnapshot, ToolContext } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { subagentRecapTool } from '../src/recap-tool.js'

function sampleSnapshot(): RecapFactSnapshot {
  return {
    parentKey: 'root',
    generatedAt: 1_700_000_000_000,
    counts: {
      total: 3,
      completed: 1,
      running: 1,
      waitingApproval: 1,
      paused: 0,
      disconnected: 0,
      failed: 0,
      cancelled: 0,
    },
    hasIncompleteWork: true,
    subtasks: [
      {
        taskId: 'root/alpha',
        ownerKey: 'root',
        label: 'Alpha task',
        status: 'completed',
        executionState: 'completed',
        summaryText: 'Alpha finished',
        artifacts: [{ path: 'alpha.md', kind: 'file', verified: true }],
        updatedAt: 1_700_000_000_000,
      } as RecapFactSnapshot['subtasks'][number],
      {
        taskId: 'root/alpha-ext',
        ownerKey: 'root/alpha',
        label: 'Alpha external grandchild',
        status: 'running',
        executionState: 'running',
        summaryText: '',
        artifacts: [],
        updatedAt: 1_700_000_000_000,
      } as RecapFactSnapshot['subtasks'][number],
      {
        taskId: 'root/beta',
        ownerKey: 'root',
        label: 'Beta task',
        status: 'waiting_approval',
        executionState: 'waiting_approval',
        summaryText: '',
        artifacts: [],
        approvalPending: { requestId: 'req-1', summary: 'Approve beta' },
        blockerReason: 'Approve beta',
        updatedAt: 1_700_000_000_000,
      } as RecapFactSnapshot['subtasks'][number],
    ],
    allowedArtifactPaths: ['alpha.md'],
  }
}

function makeCtx(snapshot: RecapFactSnapshot) {
  const recap = vi.fn(async () => ({
    snapshot,
    markdown: '## Runtime ledger facts\nFULL_TREE',
    allowedArtifactPaths: snapshot.allowedArtifactPaths,
    hasIncompleteWork: snapshot.hasIncompleteWork,
  }))
  return {
    recap,
    ctx: { subagent: { recap } } as unknown as ToolContext,
  }
}

describe('subagent_recap tool (#23)', () => {
  it('returns the full tree recap when called with empty arguments', async () => {
    const { ctx, recap } = makeCtx(sampleSnapshot())
    const result = await subagentRecapTool.execute({}, ctx)
    expect(result.isError).toBeUndefined()
    expect(recap).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result.content)).toContain('FULL_TREE')
    expect((result.structured as { snapshot: RecapFactSnapshot }).snapshot.subtasks).toHaveLength(3)
  })

  it('scopes recap output and snapshot to the requested childKey and its descendants, excluding siblings', async () => {
    const { ctx } = makeCtx(sampleSnapshot())
    const alpha = await subagentRecapTool.execute({ childKey: 'root/alpha' }, ctx)
    expect(alpha.isError).toBeUndefined()
    const alphaStructured = alpha.structured as {
      snapshot: RecapFactSnapshot
      markdown: string
      allowedArtifactPaths: readonly string[]
      hasIncompleteWork: boolean
    }
    expect(alphaStructured.snapshot.subtasks.map((t) => t.taskId)).toEqual(['root/alpha', 'root/alpha-ext'])
    expect(alphaStructured.hasIncompleteWork).toBe(true)
    expect(alphaStructured.allowedArtifactPaths).toEqual(['alpha.md'])
    expect(alphaStructured.markdown).toContain('Scope: root/alpha')
    expect(alphaStructured.markdown).not.toContain('root/beta')

    const beta = await subagentRecapTool.execute({ childKey: 'root/beta' }, ctx)
    expect(beta.isError).toBeUndefined()
    const betaStructured = beta.structured as { snapshot: RecapFactSnapshot; markdown: string }
    expect(betaStructured.snapshot.subtasks.map((t) => t.taskId)).toEqual(['root/beta'])
    expect(betaStructured.markdown).not.toContain('root/alpha')
  })

  it('returns E_CHILD_NOT_FOUND when childKey does not exist in the session tree', async () => {
    const { ctx } = makeCtx(sampleSnapshot())
    const missing = await subagentRecapTool.execute({ childKey: 'unknown/child' }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.details).toMatchObject({ code: 'E_CHILD_NOT_FOUND', childKey: 'unknown/child' })
  })
})
