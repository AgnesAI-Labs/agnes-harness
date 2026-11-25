import type { ChildAgentStatus, RecapFactSnapshot, SubtaskFactRecord } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

type ExtendedSubtask = SubtaskFactRecord & {
  ownerKey?: string
  artifactVerification?: Readonly<{
    recordedCount: number
    verifiedCount: number
    missingCount: number
    unverifiableCount: number
    errorCodes?: readonly string[]
  }>
}

type ExtendedSnapshot = RecapFactSnapshot & {
  locale?: 'en' | 'zh-CN'
  targetChildKey?: string
}

type RecapResult = {
  snapshot: RecapFactSnapshot
  markdown: string
  allowedArtifactPaths: readonly string[]
  hasIncompleteWork: boolean
}

const isIncomplete = (status: ChildAgentStatus) => status !== 'completed' && status !== 'idle'

function countStatuses(statuses: ChildAgentStatus[]): RecapFactSnapshot['counts'] {
  const counts = {
    total: statuses.length,
    completed: 0,
    running: 0,
    waitingApproval: 0,
    paused: 0,
    disconnected: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const status of statuses) {
    if (status === 'waiting_approval') counts.waitingApproval++
    else if (status !== 'idle' && status !== 'interrupted' && status !== 'starting') counts[status]++
  }
  return counts
}

function selectScopedSubtasks(subtasks: readonly SubtaskFactRecord[], childKey: string): SubtaskFactRecord[] {
  const exact = subtasks.find((t) => t.taskId === childKey)
  if (!exact) return []
  const included = new Set<string>([childKey])
  let grew = true
  while (grew) {
    grew = false
    for (const task of subtasks as readonly ExtendedSubtask[]) {
      if (task.ownerKey && included.has(task.ownerKey) && !included.has(task.taskId)) {
        included.add(task.taskId)
        grew = true
      }
    }
  }
  return subtasks.filter((t) => included.has(t.taskId))
}

function literal(text: string): string {
  return text.replace(/[&<>|[\]*`\\~]/g, (char) => `&#${char.charCodeAt(0)};`).replace(/\r?\n/g, '<br>')
}

const ZH_STATUS: Record<ChildAgentStatus, string> = {
  starting: '启动中',
  running: '运行中',
  waiting_approval: '等待审批',
  paused: '已暂停',
  disconnected: '已断开',
  idle: '空闲',
  interrupted: '已中断',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function renderScopedMarkdown(snapshot: ExtendedSnapshot): string {
  const zh = snapshot.locale === 'zh-CN'
  const { counts, subtasks, targetChildKey } = snapshot
  const settled = counts.completed + subtasks.filter((x) => x.status === 'idle').length
  const pending = subtasks.filter((x) => isIncomplete(x.status) || x.approvalPending)
  const taskRows = subtasks.map((t) => {
    const summary =
      literal(t.summaryText.trim()) ||
      (zh
        ? t.requestCount
          ? `（无输出，已请求 ${t.requestCount} 次）`
          : '（无输出）'
        : t.requestCount
          ? `(no output) after ${t.requestCount} req`
          : '(no output)')
    return `| ${literal(t.taskId)} | ${literal(t.role ?? '—')} | ${t.status} | ${t.executionState} | ${summary} |`
  })
  const artifacts = subtasks.flatMap((t) => {
    const owner = `- [${literal(t.taskId)}] (${literal(t.role ?? '—')})`
    const verification = (t as ExtendedSubtask).artifactVerification
    const verified = t.artifacts.map((a) => `${owner} -> ${literal(a.path)}`)
    const codes = verification?.errorCodes?.length
      ? ` (${verification.errorCodes.map(literal).join(', ')})`
      : ''
    if (verified.length > 0) return verified
    if (verification?.unverifiableCount) {
      return [
        zh
          ? `${owner} 无法复核产物（记录到 ${verification.unverifiableCount} 项写入，文件系统检查失败${codes}）`
          : `${owner} Artifacts could not be verified (${verification.unverifiableCount} recorded write(s), filesystem check failed${codes})`,
      ]
    }
    if (verification?.missingCount) {
      return [
        zh
          ? `${owner} 产物当前不存在（记录到 ${verification.missingCount} 项写入，文件检查返回 ENOENT）`
          : `${owner} Recorded artifacts currently missing (${verification.missingCount} recorded write(s) not found on disk / ENOENT)`,
      ]
    }
    return [
      zh
        ? `${owner} 没有写入记录（${t.status === 'failed' ? '任务失败，' : ''}未生成）`
        : `${owner} No write records (${t.status === 'failed' ? 'failed/' : ''}not generated)`,
    ]
  })
  const blockers = pending.map((t) => {
    const approval = t.approvalPending
    const fields = [
      t.blockerReason,
      approval && `requestId=${approval.requestId}`,
      approval?.toolName && `toolName=${approval.toolName}`,
      t.resumable && 'resumable: true',
      t.nextStep,
    ]
    const status = zh ? `${ZH_STATUS[t.status]} (${t.status})` : t.status
    return `- [${literal(t.taskId)}] (${literal(t.role ?? '—')}) ${status} · ${fields
      .filter(Boolean)
      .map((v) => literal(String(v)))
      .join(' · ')}`
  })
  if (zh) {
    const banner = snapshot.hasIncompleteWork
      ? `部分完成${counts.waitingApproval ? ` / 等待审批 ${counts.waitingApproval} 项` : ''}`
      : counts.total
        ? '全部完成'
        : '没有子任务'
    return [
      '## 运行时账本事实',
      '',
      ...(targetChildKey ? [`范围：${literal(targetChildKey)}`, ''] : []),
      `**${banner}（已完成 ${settled}/${counts.total}）**`,
      '',
      '| 任务 ID | 角色 | 状态 (status) | 执行态 (executionState) | 摘要（子任务记录输出） |',
      '| --- | --- | --- | --- | --- |',
      ...taskRows,
      '',
      '### 已验证产物',
      ...artifacts,
      '',
      '### 待审批与阻塞项',
      ...(blockers.length ? blockers : ['无。']),
    ].join('\n')
  }
  const banner = snapshot.hasIncompleteWork
    ? `Partially completed${counts.waitingApproval ? ` / Waiting approval ${counts.waitingApproval}` : ''}`
    : counts.total
      ? 'All completed'
      : 'No child tasks'
  return [
    '## Runtime ledger facts',
    '',
    ...(targetChildKey ? [`Scope: ${literal(targetChildKey)}`, ''] : []),
    `**${banner} (${settled}/${counts.total} completed)**`,
    '',
    '| taskId | role | status | executionState | summary (recorded child output) |',
    '| --- | --- | --- | --- | --- |',
    ...taskRows,
    '',
    '### Verified artifacts',
    ...artifacts,
    '',
    '### Pending approvals and blockers',
    ...(blockers.length ? blockers : ['None.']),
  ].join('\n')
}

export const subagentRecapTool = defineTool({
  name: 'subagent_recap',
  description:
    'Read the runtime recap of child tasks, verified artifacts, approvals and next actions. Pass childKey to scope to a single child task.',
  parameters: Type.Object(
    {
      childKey: Type.Optional(
        Type.String({
          minLength: 1,
          description: 'Optional child task ID to scope the recap to a single subtask.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    deferLoading: 'auto',
    requiresApproval: 'never',
  },
  async execute(args, ctx) {
    if (!ctx.subagent.recap)
      return {
        isError: true,
        content: [{ type: 'text', text: 'Child recap is unavailable in this session.' }],
      }
    const childKey = args.childKey?.trim() || undefined
    const callRecap = ctx.subagent.recap as (opts?: { childKey?: string }) => Promise<RecapResult>
    const recap = await (childKey ? callRecap({ childKey }) : callRecap())
    if (!childKey) {
      return { content: [{ type: 'text', text: recap.markdown }], structured: recap }
    }
    const baseSnapshot = recap.snapshot as ExtendedSnapshot
    const scopedSubtasks = selectScopedSubtasks(baseSnapshot.subtasks, childKey)
    if (scopedSubtasks.length === 0) {
      return {
        isError: true,
        details: { code: 'E_CHILD_NOT_FOUND', childKey },
        content: [{ type: 'text', text: `unknown child ${childKey}` }],
      }
    }
    if (baseSnapshot.targetChildKey === childKey && scopedSubtasks.length === baseSnapshot.subtasks.length) {
      return { content: [{ type: 'text', text: recap.markdown }], structured: recap }
    }
    const allowedArtifactPaths = [
      ...new Set(scopedSubtasks.flatMap((t) => t.artifacts.map((a) => a.path))),
    ].sort()
    const hasIncompleteWork = scopedSubtasks.some((t) => isIncomplete(t.status))
    const scopedSnapshot: ExtendedSnapshot = {
      parentKey: baseSnapshot.parentKey,
      generatedAt: baseSnapshot.generatedAt,
      counts: countStatuses(scopedSubtasks.map((t) => t.status)),
      hasIncompleteWork,
      subtasks: scopedSubtasks,
      allowedArtifactPaths,
      ...(baseSnapshot.locale ? { locale: baseSnapshot.locale } : {}),
      targetChildKey: childKey,
    }
    const markdown = renderScopedMarkdown(scopedSnapshot)
    const scopedRecap: RecapResult = {
      snapshot: scopedSnapshot,
      markdown,
      allowedArtifactPaths,
      hasIncompleteWork,
    }
    return { content: [{ type: 'text', text: markdown }], structured: scopedRecap }
  },
})
