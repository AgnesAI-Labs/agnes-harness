import type {
  ChildAgentStatus,
  ChildExecutionState,
  RecapFactSnapshot,
  SubtaskFactRecord,
} from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

type ArtifactVerification = Readonly<{
  recordedCount: number
  verifiedCount: number
  missingCount: number
  nonFileCount?: number
  unverifiableCount: number
  errorCodes?: readonly string[]
}>

type ExtendedSubtask = SubtaskFactRecord & {
  ownerKey?: string
  artifactVerification?: ArtifactVerification
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

function selectScopedSubtasks(
  subtasks: readonly SubtaskFactRecord[],
  childKey: string,
): { ambiguous: boolean; subtasks: SubtaskFactRecord[] } {
  const matches = subtasks.filter((t) => t.taskId === childKey)
  if (matches.length > 1) return { ambiguous: true, subtasks: [] }
  if (matches.length === 0) return { ambiguous: false, subtasks: [] }
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
  return { ambiguous: false, subtasks: subtasks.filter((t) => included.has(t.taskId)) }
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

const ZH_EXECUTION_STATE: Record<ChildExecutionState, string> = {
  creating: '创建中',
  ready: '就绪',
  idle: '空闲',
  paused: '已暂停',
  interrupted: '已中断',
  running: '运行中',
  waiting_approval: '等待审批',
  disconnected: '已断开',
  recovery_pending: '待恢复',
  cancelling: '取消中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const ZH_BLOCKER_LABELS: Record<string, string> = {
  'Waiting for approval': '等待审批',
  'Execution paused': '执行已暂停',
  'Connection lost': '连接已断开',
  'Execution cancelled': '执行已取消',
}

const EN_ACTIONS: Record<Exclude<ChildAgentStatus, 'completed'>, string> = {
  starting: 'Wait for startup.',
  running: 'Wait for the current run.',
  waiting_approval: 'Review the pending approval in the owning session.',
  paused: 'Resume from the checkpoint with subagent_resume.',
  disconnected: 'Check the provider connection before retrying.',
  idle: 'Send a follow-up message or close the child.',
  interrupted: 'Continue the interrupted child.',
  failed: 'Review the failure before retrying.',
  cancelled: 'Confirm whether the cancelled work is still needed.',
}

const ZH_ACTIONS: Record<Exclude<ChildAgentStatus, 'completed'>, string> = {
  starting: '等待子任务启动。',
  running: '等待当前执行结束。',
  waiting_approval: '请在所属会话中处理待审批请求。',
  paused: '可使用 subagent_resume 从检查点恢复。',
  disconnected: '请检查提供方连接后再重试。',
  idle: '可发送后续消息或关闭该子任务。',
  interrupted: '可继续该已中断的子任务。',
  failed: '请查看失败原因后再重试。',
  cancelled: '请确认是否仍需要该已取消的工作。',
}

function localizedBlockerReason(reason: string | undefined, zh: boolean): string | undefined {
  if (!reason) return undefined
  if (zh && Object.hasOwn(ZH_BLOCKER_LABELS, reason)) return ZH_BLOCKER_LABELS[reason]
  return reason
}

function localizedNextStep(task: SubtaskFactRecord, zh: boolean): string | undefined {
  if (!task.nextStep) return undefined
  if (!zh) return task.nextStep
  if (task.status !== 'completed' && task.nextStep === EN_ACTIONS[task.status]) {
    return ZH_ACTIONS[task.status]
  }
  return task.nextStep
}

function formatFallbackUnverified(
  owner: string,
  verification: ArtifactVerification,
  codes: string,
  zh: boolean,
): string | undefined {
  const unverifiable = verification.unverifiableCount
  const nonFile = verification.nonFileCount ?? 0
  const missing = verification.missingCount
  const kinds = Number(unverifiable > 0) + Number(nonFile > 0) + Number(missing > 0)
  if (kinds === 0) return undefined
  if (kinds > 1) {
    const parts = [
      unverifiable > 0
        ? zh
          ? `${unverifiable} 项文件系统检查失败${codes}`
          : `${unverifiable} filesystem check failed${codes}`
        : '',
      nonFile > 0 ? (zh ? `${nonFile} 项为目录或非普通文件` : `${nonFile} directory/non-file`) : '',
      missing > 0 ? (zh ? `${missing} 项当前不存在（ENOENT）` : `${missing} currently missing (ENOENT)`) : '',
    ].filter(Boolean)
    return zh
      ? `${owner} 无法完整复核产物（${parts.join('，')}；均未计入已验证文件）`
      : `${owner} Artifacts could not be fully verified (${parts.join(', ')}; none verified as regular files)`
  }
  if (unverifiable > 0) {
    return zh
      ? `${owner} 无法复核产物（记录到 ${unverifiable} 项写入，文件系统检查失败${codes}）`
      : `${owner} Artifacts could not be verified (${unverifiable} recorded write(s), filesystem check failed${codes})`
  }
  if (nonFile > 0) {
    return zh
      ? `${owner} 已记录路径为目录或非普通文件（记录到 ${nonFile} 项非普通文件，未计入已验证文件）`
      : `${owner} Recorded artifact path(s) are directories or non-regular files (${nonFile} non-file entry/entries, not verified as regular files)`
  }
  return zh
    ? `${owner} 产物当前不存在（记录到 ${missing} 项写入，文件检查返回 ENOENT）`
    : `${owner} Recorded artifacts currently missing (${missing} recorded write(s) not found on disk / ENOENT)`
}

function renderScopedArtifactLines(t: SubtaskFactRecord, zh: boolean): string[] {
  const owner = `- [${literal(t.taskId)}] (${literal(t.role ?? '—')})`
  const verification = (t as ExtendedSubtask).artifactVerification
  const verified = t.artifacts.map((a) => `${owner} -> ${literal(a.path)}`)
  const codes = verification?.errorCodes?.length
    ? ` (${verification.errorCodes.map(literal).join(', ')})`
    : ''
  if (verified.length > 0) {
    const notes: string[] = []
    if (verification?.unverifiableCount) {
      notes.push(
        zh
          ? `${owner} 另有 ${verification.unverifiableCount} 项写入无法复核（文件系统检查失败${codes}）`
          : `${owner} ${verification.unverifiableCount} additional recorded write(s) could not be verified (filesystem check failed${codes})`,
      )
    }
    if (verification?.nonFileCount) {
      notes.push(
        zh
          ? `${owner} 另有 ${verification.nonFileCount} 项已记录路径为目录或非普通文件（未计入已验证文件）`
          : `${owner} ${verification.nonFileCount} additional recorded path(s) are directories or non-regular files (not verified as regular files)`,
      )
    }
    if (verification?.missingCount) {
      notes.push(
        zh
          ? `${owner} 另有 ${verification.missingCount} 项已记录写入当前不存在（ENOENT）`
          : `${owner} ${verification.missingCount} additional recorded write(s) currently missing (ENOENT)`,
      )
    }
    return [...verified, ...notes]
  }
  if (verification && verification.recordedCount > 0) {
    const summary = formatFallbackUnverified(owner, verification, codes, zh)
    if (summary) return [summary]
  }
  return [
    zh
      ? `${owner} 没有写入记录（${t.status === 'failed' ? '任务失败，' : ''}未生成）`
      : `${owner} No write records (${t.status === 'failed' ? 'failed/' : ''}not generated)`,
  ]
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
    const statusCell = zh ? `${ZH_STATUS[t.status]} (${t.status})` : t.status
    const execLabel = Object.hasOwn(ZH_EXECUTION_STATE, t.executionState)
      ? ZH_EXECUTION_STATE[t.executionState]
      : undefined
    const execCell = zh && execLabel ? `${execLabel} (${t.executionState})` : t.executionState
    return `| ${literal(t.taskId)} | ${literal(t.role ?? '—')} | ${statusCell} | ${execCell} | ${summary} |`
  })
  const artifacts = subtasks.flatMap((t) => renderScopedArtifactLines(t, zh))
  const blockers = pending.map((t) => {
    const approval = t.approvalPending
    const fields = [
      localizedBlockerReason(t.blockerReason, zh),
      approval && `requestId=${approval.requestId}`,
      approval?.toolName && `toolName=${approval.toolName}`,
      t.resumable && (zh ? '可恢复 (resumable: true)' : 'resumable: true'),
      localizedNextStep(t, zh),
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
    const nonZero = [
      counts.running ? `运行中 ${counts.running}` : '',
      counts.paused ? `已暂停 ${counts.paused}` : '',
      counts.disconnected ? `已断开 ${counts.disconnected}` : '',
      counts.failed ? `失败 ${counts.failed}` : '',
      counts.cancelled ? `已取消 ${counts.cancelled}` : '',
    ].filter(Boolean)
    return [
      '## 运行时账本事实',
      '',
      ...(targetChildKey ? [`范围：${literal(targetChildKey)}`, ''] : []),
      `**${banner}（已完成 ${settled}/${counts.total}）**`,
      ...(nonZero.length ? [nonZero.join(' · ')] : []),
      '',
      '| 任务 ID | 角色 | 状态 | 执行态 | 摘要（子任务记录输出） |',
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
  const nonZero = [
    counts.running ? `Running ${counts.running}` : '',
    counts.paused ? `Paused ${counts.paused}` : '',
    counts.disconnected ? `Disconnected ${counts.disconnected}` : '',
    counts.failed ? `Failed ${counts.failed}` : '',
    counts.cancelled ? `Cancelled ${counts.cancelled}` : '',
  ].filter(Boolean)
  return [
    '## Runtime ledger facts',
    '',
    ...(targetChildKey ? [`Scope: ${literal(targetChildKey)}`, ''] : []),
    `**${banner} (${settled}/${counts.total} completed)**`,
    ...(nonZero.length ? [nonZero.join(' · ')] : []),
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
    let recap: RecapResult
    try {
      recap = await (childKey ? ctx.subagent.recap({ childKey }) : ctx.subagent.recap())
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'E_CHILD_AMBIGUOUS') {
        return {
          isError: true,
          details: { code: 'E_CHILD_AMBIGUOUS', ...(childKey ? { childKey } : {}) },
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : `ambiguous child ${childKey ?? ''}`,
            },
          ],
        }
      }
      throw error
    }
    if (!childKey) {
      return { content: [{ type: 'text', text: recap.markdown }], structured: recap }
    }
    const baseSnapshot = recap.snapshot as ExtendedSnapshot
    if (baseSnapshot.targetChildKey === childKey) {
      if (baseSnapshot.subtasks.length === 0) {
        return {
          isError: true,
          details: { code: 'E_CHILD_NOT_FOUND', childKey },
          content: [{ type: 'text', text: `unknown child ${childKey}` }],
        }
      }
      return { content: [{ type: 'text', text: recap.markdown }], structured: recap }
    }
    const selected = selectScopedSubtasks(baseSnapshot.subtasks, childKey)
    if (selected.ambiguous) {
      return {
        isError: true,
        details: { code: 'E_CHILD_AMBIGUOUS', childKey },
        content: [{ type: 'text', text: `ambiguous child ${childKey}` }],
      }
    }
    const scopedSubtasks = selected.subtasks
    if (scopedSubtasks.length === 0) {
      return {
        isError: true,
        details: { code: 'E_CHILD_NOT_FOUND', childKey },
        content: [{ type: 'text', text: `unknown child ${childKey}` }],
      }
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
