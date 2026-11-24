import type { ChildAgentStatus, RecapFactSnapshot, SubtaskFactRecord } from '@agnes/extension-api'

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

function output(task: SubtaskFactRecord) {
  return (
    literal(previewOutput(task.summaryText, task.taskId)) ||
    (task.requestCount ? `(no output) after ${task.requestCount} req` : '(no output)')
  )
}

function taskRow(task: SubtaskFactRecord) {
  return `| ${literal(task.taskId)} | ${taskRole(task)} | ${task.status} | ${task.executionState} | ${output(task)} |`
}

function artifactRows(snapshot: RecapFactSnapshot) {
  return snapshot.subtasks.flatMap((task) => {
    const owner = `- [${literal(task.taskId)}] (${taskRole(task)})`
    return task.artifacts.length
      ? task.artifacts.map((ref) => `${owner} -> ${literal(ref.path)}`)
      : [`${owner} 无已落盘产物（${task.status === 'failed' ? 'failed/' : ''}未生成）`]
  })
}

function blocker(task: SubtaskFactRecord) {
  const approval = task.approvalPending
  const fields = [
    task.blockerReason,
    approval && `requestId=${approval.requestId}`,
    approval?.toolName && `toolName=${approval.toolName}`,
    task.resumable && 'resumable: true',
    task.nextStep,
  ]
  return `- [${literal(task.taskId)}] (${taskRole(task)}) ${task.status} · ${fields
    .filter(Boolean)
    .map((value) => literal(String(value)))
    .join(' · ')}`
}

export function renderTruthBase(snapshot: RecapFactSnapshot): string {
  const { counts, subtasks } = snapshot
  const settled = counts.completed + subtasks.filter((x) => x.status === 'idle').length
  const banner = snapshot.hasIncompleteWork
    ? `部分完成 / 等待审批 ${counts.waitingApproval} 项`
    : counts.total
      ? '全部完成'
      : '没有子任务'
  const nonZero = [
    counts.running ? `Running ${counts.running}` : '',
    counts.paused ? `Paused ${counts.paused}` : '',
    counts.disconnected ? `Disconnected ${counts.disconnected}` : '',
    counts.failed ? `Failed ${counts.failed}` : '',
    counts.cancelled ? `Cancelled ${counts.cancelled}` : '',
  ].filter(Boolean)
  const pending = subtasks.filter(
    (x) => (x.status !== 'completed' && x.status !== 'idle') || x.approvalPending,
  )
  return [
    '## 运行时账本事实 · Runtime ledger facts',
    '',
    `**${banner}（已完成 ${settled}/${counts.total}）**`,
    ...(nonZero.length ? [nonZero.join(' · ')] : []),
    '',
    '| taskId | role | status | executionState | summary (recorded child output) |',
    '| --- | --- | --- | --- | --- |',
    ...subtasks.map(taskRow),
    '',
    '### Verified artifacts',
    ...artifactRows(snapshot),
    '',
    '### Pending approvals and blockers',
    ...(pending.length ? pending.map(blocker) : ['None.']),
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

export function renderDeterministicNarrative(snapshot: RecapFactSnapshot): string {
  const { counts, subtasks } = snapshot
  if (!counts.total) return 'No child tasks are recorded.'
  const settled = counts.completed + subtasks.filter((x) => x.status === 'idle').length
  const actions = [
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
    ...(actions.length ? ['', 'Next actions', ...actions] : []),
  ].join('\n')
}

export function composeRecapMarkdown(snapshot: RecapFactSnapshot, narrative: string): string {
  return ['## Executive summary', '', narrative.trim(), '', renderTruthBase(snapshot)].join('\n')
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
  const blocker: Partial<Record<ChildAgentStatus, string>> = {
    waiting_approval: approval?.summary ?? 'Waiting for approval',
    paused: 'Execution paused',
    disconnected: 'Connection lost',
    failed: failure,
    cancelled: 'Execution cancelled',
  }
  const blockerReason = blocker[status]
  return {
    resumable: status === 'paused' || status === 'interrupted' || status === 'idle',
    ...(blockerReason ? { blockerReason } : {}),
    ...(status !== 'completed' ? { nextStep: actions[status] } : {}),
    ...(approval ? { approvalPending: approval } : {}),
  }
}
