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

  it('forwards childKey directly to Core recap, preserves Core scoped markdown, and surfaces E_CHILD_AMBIGUOUS (#21, #13)', async () => {
    const scopedSnap = {
      ...sampleSnapshot(),
      subtasks: sampleSnapshot().subtasks.slice(0, 1),
      counts: {
        total: 1,
        completed: 1,
        running: 0,
        waitingApproval: 0,
        paused: 0,
        disconnected: 0,
        failed: 0,
        cancelled: 0,
      },
      hasIncompleteWork: false,
      targetChildKey: 'root/alpha',
    }
    const recap = vi.fn(async (opts?: { childKey?: string }) => {
      if (opts?.childKey === 'p:x') {
        throw Object.assign(new Error('Ambiguous childKey "p:x"'), { code: 'E_CHILD_AMBIGUOUS' })
      }
      return {
        snapshot: scopedSnap,
        markdown: '## Runtime ledger facts\nCORE_SCOPED_MARKDOWN',
        allowedArtifactPaths: ['alpha.md'],
        hasIncompleteWork: false,
      }
    })
    const ctx = { subagent: { recap } } as unknown as ToolContext
    const res = await subagentRecapTool.execute({ childKey: 'root/alpha' }, ctx)
    expect(recap).toHaveBeenCalledWith({ childKey: 'root/alpha' })
    expect(res.isError).toBeUndefined()
    expect(JSON.stringify(res.content)).toContain('CORE_SCOPED_MARKDOWN')

    const amb = await subagentRecapTool.execute({ childKey: 'p:x' }, ctx)
    expect(amb.isError).toBe(true)
    expect(amb.details).toMatchObject({ code: 'E_CHILD_AMBIGUOUS', childKey: 'p:x' })
  })

  it('fallback scoping preserves mixed verified + EIO/non-file/missing notes and localizes zh-CN blockers (#21, #34)', async () => {
    const snapshot = {
      ...sampleSnapshot(),
      locale: 'zh-CN' as const,
      subtasks: [
        {
          taskId: 'root/mixed',
          ownerKey: 'root',
          label: 'Mixed artifacts',
          status: 'paused' as const,
          executionState: 'paused' as const,
          summaryText: 'Half done',
          resumable: true,
          blockerReason: 'Execution paused',
          nextStep: 'Resume from the checkpoint with subagent_resume.',
          artifacts: [{ path: 'ok.md', kind: 'file' as const, verified: true }],
          artifactVerification: {
            recordedCount: 4,
            verifiedCount: 1,
            missingCount: 1,
            nonFileCount: 1,
            unverifiableCount: 1,
            errorCodes: ['EIO'],
          },
          updatedAt: 1_700_000_000_000,
        } as RecapFactSnapshot['subtasks'][number],
      ],
      allowedArtifactPaths: ['ok.md'],
    }
    const { ctx } = makeCtx(snapshot)
    const res = await subagentRecapTool.execute({ childKey: 'root/mixed' }, ctx)
    expect(res.isError).toBeUndefined()
    const markdown = (res.structured as { markdown: string }).markdown
    expect(markdown).toContain('-> ok.md')
    expect(markdown).toContain('另有 1 项写入无法复核（文件系统检查失败 (EIO)）')
    expect(markdown).toContain('另有 1 项已记录路径为目录或非普通文件')
    expect(markdown).toContain('另有 1 项已记录写入当前不存在')
    expect(markdown).not.toContain('ENOENT')
    expect(markdown).toContain('| 已暂停 (paused) | 已暂停 (paused) |')
    expect(markdown).toContain('执行已暂停')
    expect(markdown).toContain('可使用 subagent_resume 从检查点恢复。')
    expect(markdown).toContain('可恢复 (resumable: true)')
  })

  it('fallback scoping preserves missingCodes (ENOTDIR/ENOENT) and uses neutral wording when absent (#21)', async () => {
    const makeMissingSnapshot = (
      locale: 'en' | 'zh-CN',
      verification: Record<string, unknown>,
      withVerified = false,
    ) =>
      ({
        ...sampleSnapshot(),
        locale,
        subtasks: [
          {
            taskId: 'root/alpha',
            ownerKey: 'root',
            label: 'Alpha task',
            status: 'completed' as const,
            executionState: 'completed' as const,
            summaryText: 'Done',
            artifacts: withVerified ? [{ path: 'ok.md', kind: 'file' as const, verified: true }] : [],
            artifactVerification: verification,
            updatedAt: 1_700_000_000_000,
          } as RecapFactSnapshot['subtasks'][number],
          ...sampleSnapshot().subtasks.slice(2),
        ],
        allowedArtifactPaths: withVerified ? ['ok.md'] : [],
      }) as RecapFactSnapshot

    // Standalone ENOTDIR (EN & ZH)
    const enEnotdir = await subagentRecapTool.execute(
      { childKey: 'root/alpha' },
      makeCtx(
        makeMissingSnapshot('en', {
          recordedCount: 1,
          verifiedCount: 0,
          missingCount: 1,
          unverifiableCount: 0,
          missingCodes: ['ENOTDIR'],
        }),
      ).ctx,
    )
    const enEnotdirMd = (enEnotdir.structured as { markdown: string }).markdown
    expect(enEnotdirMd).toContain('Recorded artifacts currently missing')
    expect(enEnotdirMd).toContain('ENOTDIR')
    expect(enEnotdirMd).not.toContain('ENOENT')

    const zhEnotdir = await subagentRecapTool.execute(
      { childKey: 'root/alpha' },
      makeCtx(
        makeMissingSnapshot('zh-CN', {
          recordedCount: 1,
          verifiedCount: 0,
          missingCount: 1,
          unverifiableCount: 0,
          missingCodes: ['ENOTDIR'],
        }),
      ).ctx,
    )
    const zhEnotdirMd = (zhEnotdir.structured as { markdown: string }).markdown
    expect(zhEnotdirMd).toContain('产物当前不存在')
    expect(zhEnotdirMd).toContain('ENOTDIR')
    expect(zhEnotdirMd).not.toContain('ENOENT')

    // Mixed unverified + ENOTDIR (kinds > 1) and verified + additional ENOTDIR
    const enMixedEnotdir = await subagentRecapTool.execute(
      { childKey: 'root/alpha' },
      makeCtx(
        makeMissingSnapshot('en', {
          recordedCount: 2,
          verifiedCount: 0,
          missingCount: 1,
          nonFileCount: 1,
          unverifiableCount: 0,
          missingCodes: ['ENOTDIR'],
        }),
      ).ctx,
    )
    const enMixedMd = (enMixedEnotdir.structured as { markdown: string }).markdown
    expect(enMixedMd).toContain('1 currently missing (ENOTDIR)')
    expect(enMixedMd).not.toContain('ENOENT')

    const enAdditionalEnotdir = await subagentRecapTool.execute(
      { childKey: 'root/alpha' },
      makeCtx(
        makeMissingSnapshot(
          'en',
          {
            recordedCount: 2,
            verifiedCount: 1,
            missingCount: 1,
            unverifiableCount: 0,
            missingCodes: ['ENOTDIR'],
          },
          true,
        ),
      ).ctx,
    )
    const enAddMd = (enAdditionalEnotdir.structured as { markdown: string }).markdown
    expect(enAddMd).toContain('1 additional recorded write(s) currently missing (ENOTDIR)')
    expect(enAddMd).not.toContain('ENOENT')

    // Legacy snapshot missing error code omits fabricated ENOENT (EN & ZH)
    const enLegacy = await subagentRecapTool.execute(
      { childKey: 'root/alpha' },
      makeCtx(
        makeMissingSnapshot('en', {
          recordedCount: 1,
          verifiedCount: 0,
          missingCount: 1,
          unverifiableCount: 0,
        }),
      ).ctx,
    )
    const enLegacyMd = (enLegacy.structured as { markdown: string }).markdown
    expect(enLegacyMd).toContain(
      'Recorded artifacts currently missing (1 recorded write(s) not found on disk)',
    )
    expect(enLegacyMd).not.toContain('ENOENT')

    const zhLegacy = await subagentRecapTool.execute(
      { childKey: 'root/alpha' },
      makeCtx(
        makeMissingSnapshot('zh-CN', {
          recordedCount: 1,
          verifiedCount: 0,
          missingCount: 1,
          unverifiableCount: 0,
        }),
      ).ctx,
    )
    const zhLegacyMd = (zhLegacy.structured as { markdown: string }).markdown
    expect(zhLegacyMd).toContain('产物当前不存在（记录到 1 项写入，未在磁盘找到）')
    expect(zhLegacyMd).not.toContain('ENOENT')
  })
})
