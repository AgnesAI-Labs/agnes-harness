import type {
  ChildAgentStatus,
  ChildExecutionState,
  RecapFactSnapshot,
  SubtaskFactRecord,
} from '@agnes/extension-api'

export type RecapLocale = 'en' | 'zh-CN'

export type ArtifactVerificationSummary = Readonly<{
  recordedCount: number
  verifiedCount: number
  missingCount: number
  nonFileCount?: number
  unverifiableCount: number
  missingCodes?: readonly string[]
  errorCodes?: readonly string[]
}>

export type ExtendedSubtaskFactRecord = SubtaskFactRecord & {
  providerId?: string
  ownerKey?: string
  artifactVerification?: ArtifactVerificationSummary
}

export type ExtendedRecapFactSnapshot = RecapFactSnapshot & {
  locale?: RecapLocale
  targetChildKey?: string
}

export function normalizeRecapLocale(language?: string): RecapLocale {
  if (!language) return 'en'
  const lower = language.trim().toLowerCase()
  if (lower === 'zh' || lower === 'zh-cn' || lower.startsWith('zh-') || lower === 'chinese') return 'zh-CN'
  return 'en'
}

function resolveLocale(snapshot: RecapFactSnapshot, locale?: string): RecapLocale {
  if (locale !== undefined) return normalizeRecapLocale(locale)
  const embedded = (snapshot as ExtendedRecapFactSnapshot).locale
  return embedded ? normalizeRecapLocale(embedded) : 'en'
}

/** The pointer survives even when the first line alone exceeds the preview budget. */
export function previewOutput(text: string, taskId: string): string {
  const lines = text.trim().split(/\r?\n/)
  if (text.length <= 1000 && lines.length <= 12) return text.trim()
  const kept: string[] = []
  let size = 0
  for (const line of lines.slice(0, 10)) {
    size += line.length + 1
    if (size > 760) break
    kept.push(line)
  }
  kept.push(
    `… (${lines.length} lines, ${new TextEncoder().encode(text).length} bytes) subagent_collect(${taskId})`,
  )
  return kept.join('\n')
}

// A recorded field may contain pipes, markup, or entire extra rows. Keep it literal inside its cell.
function literal(text: string): string {
  return text.replace(/[&<>|[\]*`\\~]/g, (char) => `&#${char.charCodeAt(0)};`).replace(/\r?\n/g, '<br>')
}

function taskRole(task: SubtaskFactRecord): string {
  return literal(task.role ?? '—')
}

function output(task: SubtaskFactRecord, locale: RecapLocale) {
  const preview = literal(previewOutput(task.summaryText, task.taskId))
  if (preview) return preview
  if (locale === 'zh-CN')
    return task.requestCount ? `（无输出，已请求 ${task.requestCount} 次）` : '（无输出）'
  return task.requestCount ? `(no output) after ${task.requestCount} req` : '(no output)'
}

const ZH_STATUS_LABELS: Record<ChildAgentStatus, string> = {
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

const ZH_EXECUTION_STATE_LABELS: Record<ChildExecutionState, string> = {
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

function localizedStatusCell(status: ChildAgentStatus, locale: RecapLocale): string {
  return locale === 'zh-CN' ? `${ZH_STATUS_LABELS[status]} (${status})` : status
}

function localizedExecutionStateCell(state: ChildExecutionState, locale: RecapLocale): string {
  if (locale !== 'zh-CN') return state
  const label = Object.hasOwn(ZH_EXECUTION_STATE_LABELS, state) ? ZH_EXECUTION_STATE_LABELS[state] : undefined
  return label ? `${label} (${state})` : state
}

function taskRow(task: SubtaskFactRecord, locale: RecapLocale) {
  return `| ${literal(task.taskId)} | ${taskRole(task)} | ${localizedStatusCell(task.status, locale)} | ${localizedExecutionStateCell(task.executionState, locale)} | ${output(task, locale)} |`
}

const ZH_BLOCKER_LABELS: Record<string, string> = {
  'Waiting for approval': '等待审批',
  'Execution paused': '执行已暂停',
  'Connection lost': '连接已断开',
  'Execution cancelled': '执行已取消',
}

const actions = {
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

const actionsZh: Record<Exclude<ChildAgentStatus, 'completed'>, string> = {
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

function localizedNextStep(task: SubtaskFactRecord, locale: RecapLocale): string {
  if (locale === 'en') return task.nextStep ?? 'Review the recorded state.'
  if (task.status !== 'completed' && (!task.nextStep || task.nextStep === actions[task.status])) {
    return actionsZh[task.status]
  }
  return task.nextStep ?? '请查看记录的状态。'
}

function localizedBlockerReason(reason: string | undefined, locale: RecapLocale): string | undefined {
  if (!reason) return undefined
  if (locale === 'zh-CN' && Object.hasOwn(ZH_BLOCKER_LABELS, reason)) return ZH_BLOCKER_LABELS[reason]
  return reason
}

function formatMissingCodes(verification?: ArtifactVerificationSummary): string {
  return verification?.missingCodes?.length ? verification.missingCodes.map(literal).join(', ') : ''
}

function formatUnverifiedSummary(
  owner: string,
  verification: ArtifactVerificationSummary,
  codes: string,
  locale: RecapLocale,
): string | undefined {
  const unverifiable = verification.unverifiableCount
  const nonFile = verification.nonFileCount ?? 0
  const missing = verification.missingCount
  const missingCodes = formatMissingCodes(verification)
  const kinds = Number(unverifiable > 0) + Number(nonFile > 0) + Number(missing > 0)
  if (kinds === 0) return undefined
  if (kinds > 1) {
    const parts = [
      unverifiable > 0
        ? locale === 'zh-CN'
          ? `${unverifiable} 项文件系统检查失败${codes}`
          : `${unverifiable} filesystem check failed${codes}`
        : '',
      nonFile > 0
        ? locale === 'zh-CN'
          ? `${nonFile} 项为目录或非普通文件`
          : `${nonFile} directory/non-file`
        : '',
      missing > 0
        ? locale === 'zh-CN'
          ? `${missing} 项当前不存在${missingCodes ? `（${missingCodes}）` : ''}`
          : `${missing} currently missing${missingCodes ? ` (${missingCodes})` : ''}`
        : '',
    ].filter(Boolean)
    return locale === 'zh-CN'
      ? `${owner} 无法完整复核产物（${parts.join('，')}；均未计入已验证文件）`
      : `${owner} Artifacts could not be fully verified (${parts.join(', ')}; none verified as regular files)`
  }
  if (unverifiable > 0) {
    return locale === 'zh-CN'
      ? `${owner} 无法复核产物（记录到 ${unverifiable} 项写入，文件系统检查失败${codes}）`
      : `${owner} Artifacts could not be verified (${unverifiable} recorded write(s), filesystem check failed${codes})`
  }
  if (nonFile > 0) {
    return locale === 'zh-CN'
      ? `${owner} 已记录路径为目录或非普通文件（记录到 ${nonFile} 项非普通文件，未计入已验证文件）`
      : `${owner} Recorded artifact path(s) are directories or non-regular files (${nonFile} non-file entry/entries, not verified as regular files)`
  }
  return locale === 'zh-CN'
    ? `${owner} 产物当前不存在（记录到 ${missing} 项写入，${missingCodes ? `文件检查返回 ${missingCodes}` : '未在磁盘找到'}）`
    : `${owner} Recorded artifacts currently missing (${missing} recorded write(s) not found on disk${missingCodes ? ` / ${missingCodes}` : ''})`
}

function artifactRows(snapshot: RecapFactSnapshot, locale: RecapLocale): string[] {
  return snapshot.subtasks.flatMap((task) => {
    const owner = `- [${literal(task.taskId)}] (${taskRole(task)})`
    const verification = (task as ExtendedSubtaskFactRecord).artifactVerification
    const verifiedLines = task.artifacts.map((ref) => `${owner} -> ${literal(ref.path)}`)
    const codes = verification?.errorCodes?.length
      ? ` (${verification.errorCodes.map(literal).join(', ')})`
      : ''
    const missingCodes = formatMissingCodes(verification)

    if (verifiedLines.length > 0) {
      const notes: string[] = []
      if (verification?.unverifiableCount) {
        notes.push(
          locale === 'zh-CN'
            ? `${owner} 另有 ${verification.unverifiableCount} 项写入无法复核（文件系统检查失败${codes}）`
            : `${owner} ${verification.unverifiableCount} additional recorded write(s) could not be verified (filesystem check failed${codes})`,
        )
      }
      if (verification?.nonFileCount) {
        notes.push(
          locale === 'zh-CN'
            ? `${owner} 另有 ${verification.nonFileCount} 项已记录路径为目录或非普通文件（未计入已验证文件）`
            : `${owner} ${verification.nonFileCount} additional recorded path(s) are directories or non-regular files (not verified as regular files)`,
        )
      }
      if (verification?.missingCount) {
        notes.push(
          locale === 'zh-CN'
            ? `${owner} 另有 ${verification.missingCount} 项已记录写入当前不存在${missingCodes ? `（${missingCodes}）` : ''}`
            : `${owner} ${verification.missingCount} additional recorded write(s) currently missing${missingCodes ? ` (${missingCodes})` : ''}`,
        )
      }
      return [...verifiedLines, ...notes]
    }

    if (verification && verification.recordedCount > 0) {
      const summary = formatUnverifiedSummary(owner, verification, codes, locale)
      if (summary) return [summary]
    }

    return [
      locale === 'zh-CN'
        ? `${owner} 没有写入记录（${task.status === 'failed' ? '任务失败，' : ''}未生成）`
        : `${owner} No write records (${task.status === 'failed' ? 'failed/' : ''}not generated)`,
    ]
  })
}

function blocker(task: SubtaskFactRecord, locale: RecapLocale) {
  const approval = task.approvalPending
  const nextStep = task.nextStep ? localizedNextStep(task, locale) : undefined
  const fields = [
    localizedBlockerReason(task.blockerReason, locale),
    approval && `requestId=${approval.requestId}`,
    approval?.toolName && `toolName=${approval.toolName}`,
    task.resumable && (locale === 'zh-CN' ? '可恢复 (resumable: true)' : 'resumable: true'),
    nextStep,
  ]
  const statusDisplay = localizedStatusCell(task.status, locale)
  return `- [${literal(task.taskId)}] (${taskRole(task)}) ${statusDisplay} · ${fields
    .filter(Boolean)
    .map((value) => literal(String(value)))
    .join(' · ')}`
}

export function renderTruthBase(snapshot: RecapFactSnapshot, locale?: string): string {
  const loc = resolveLocale(snapshot, locale)
  const { counts, subtasks } = snapshot
  const settled = counts.completed + subtasks.filter((x) => x.status === 'idle').length
  const targetChildKey = (snapshot as ExtendedRecapFactSnapshot).targetChildKey
  const pending = subtasks.filter(
    (x) => (x.status !== 'completed' && x.status !== 'idle') || x.approvalPending,
  )

  if (loc === 'zh-CN') {
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
      ...subtasks.map((task) => taskRow(task, loc)),
      '',
      '### 已验证产物',
      ...artifactRows(snapshot, loc),
      '',
      '### 待审批与阻塞项',
      ...(pending.length ? pending.map((task) => blocker(task, loc)) : ['无。']),
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
    ...subtasks.map((task) => taskRow(task, loc)),
    '',
    '### Verified artifacts',
    ...artifactRows(snapshot, loc),
    '',
    '### Pending approvals and blockers',
    ...(pending.length ? pending.map((task) => blocker(task, loc)) : ['None.']),
  ].join('\n')
}

const priority: readonly ChildAgentStatus[] = [
  'waiting_approval',
  'disconnected',
  'failed',
  'paused',
  'interrupted',
  'cancelled',
  'idle',
  'starting',
  'running',
]

export function renderDeterministicNarrative(snapshot: RecapFactSnapshot, locale?: string): string {
  const loc = resolveLocale(snapshot, locale)
  const { counts, subtasks } = snapshot
  if (!counts.total) return loc === 'zh-CN' ? '当前没有记录子任务。' : 'No child tasks are recorded.'
  const settled = counts.completed + subtasks.filter((x) => x.status === 'idle').length
  if (loc === 'zh-CN') {
    const nextActions = [
      ...priority.flatMap((status) =>
        snapshot.subtasks
          .filter((t) => t.status === status)
          .map(
            (t) =>
              `- [${literal(t.taskId)}] ${ZH_STATUS_LABELS[status]}。${literal(localizedNextStep(t, loc))}`,
          ),
      ),
      ...snapshot.subtasks
        .filter((t) => t.status === 'completed' && t.nextStep)
        .map((t) => `- [${literal(t.taskId)}] 已完成。${literal(localizedNextStep(t, loc))}`),
    ]
    return [
      `已完成 ${settled}/${counts.total} 项子任务。`,
      ...(nextActions.length ? ['', '后续操作', ...nextActions] : []),
    ].join('\n')
  }
  const nextActions = [
    ...priority.flatMap((status) =>
      snapshot.subtasks
        .filter((t) => t.status === status)
        .map(
          (t) => `- [${literal(t.taskId)}] ${status}. ${literal(t.nextStep ?? 'Review the recorded state.')}`,
        ),
    ),
    ...snapshot.subtasks
      .filter((t) => t.status === 'completed' && t.nextStep)
      .map((t) => `- [${literal(t.taskId)}] completed. ${literal(t.nextStep ?? '')}`),
  ]
  return [
    `${settled} of ${counts.total} tasks completed.`,
    ...(nextActions.length ? ['', 'Next actions', ...nextActions] : []),
  ].join('\n')
}

export function composeRecapMarkdown(
  snapshot: RecapFactSnapshot,
  narrative: string,
  locale?: string,
): string {
  const loc = resolveLocale(snapshot, locale)
  const heading = loc === 'zh-CN' ? '## 执行摘要' : '## Executive summary'
  return [heading, '', narrative.trim(), '', renderTruthBase(snapshot, loc)].join('\n')
}

export function stateFacts(
  status: ChildAgentStatus,
  failure: string,
  decision?: SubtaskFactRecord['approvalPending'],
) {
  // A provider can report the wait before it publishes a decision handle.
  const approval =
    decision ??
    (status === 'waiting_approval'
      ? { requestId: 'unavailable', summary: 'Waiting for approval' }
      : undefined)
  const blockerReasons: Partial<Record<ChildAgentStatus, string>> = {
    waiting_approval: approval?.summary ?? 'Waiting for approval',
    paused: 'Execution paused',
    disconnected: 'Connection lost',
    failed: failure,
    cancelled: 'Execution cancelled',
  }
  const blockerReason = blockerReasons[status]
  return {
    resumable: status === 'paused' || status === 'interrupted' || status === 'idle',
    ...(blockerReason ? { blockerReason } : {}),
    ...(status !== 'completed' ? { nextStep: actions[status] } : {}),
    ...(approval ? { approvalPending: approval } : {}),
  }
}
