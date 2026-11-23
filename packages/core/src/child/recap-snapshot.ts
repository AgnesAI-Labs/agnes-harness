import { externalChildren } from '@agnes/core-child-control/child/directory'
import { projectChildStatus } from '@agnes/core-child-control/child/status-projection'
import { requireChildControl } from '@agnes/core-child-control/child/store'
import type { Event } from '@agnes/core-common/types'
import { normalizeWorkspacePath } from '@agnes/core-common/workspace-path'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type {
  ChildAgentListing,
  ChildAgentStatus,
  ChildTaskRecord,
  RecapFactSnapshot,
  SubtaskArtifactRef,
  SubtaskFactRecord,
} from '@agnes/extension-api'
import type { DecisionSnapshot } from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { childEnd, childFailureSuffix, clipText } from './failure.js'
import { previewOutput, renderTruthBase, stateFacts } from './recap-formatter.js'
import { ROLE_DELEGATION } from './roles.js'

type SnapshotOptions = { stat?: (absolutePath: string) => Promise<{ kind: string }> }
type Pending = NonNullable<SubtaskFactRecord['approvalPending']>

async function children(parent: SessionImpl) {
  const rows = await requireChildControl(parent.d.log.storage).listByParent(parent.key)
  // Memory storage returns live records. Freeze the observed states before awaiting ledger reads.
  const records = rows.map((row) => ({ ...row }))
  const local = new Set(records.map((r) => r.childKey))
  const external = externalChildren(parent.key)
    .map((x) => x.listing)
    .filter((x) => !local.has(x.id))
  return { records, external }
}

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

/** Notices only need the roster. Do not replay every sibling ledger on every completion. */
export async function childBatchCounts(parent: SessionImpl) {
  const { records, external } = await children(parent)
  return countStatuses([
    ...records.map((r) => projectChildStatus(r).status),
    ...external.map((x) => x.status),
  ])
}

function textBlocks(data: unknown) {
  const content = (data as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

function openDecision(open: Map<string, Pending>, row: Event) {
  const decision = row.data as DecisionSnapshot
  if (row.origin !== 'system' || row.trust !== 'trusted' || row.register !== 'decision/state') return
  const id = decision.handle.id
  if (decision.result || decision.invalidation || decision.consumption) {
    open.delete(id)
    return
  }
  const spec = decision.request.spec
  const toolName = (spec.subject as { call?: { name?: string } } | null)?.call?.name
  open.set(id, { requestId: id, summary: clipText(spec.prompt, 300), ...(toolName ? { toolName } : {}) })
}

type WriteCall = { toolUseId: string; name: string; path?: string }
function trackCall(calls: Map<number, WriteCall>, row: Event) {
  const { name, args, toolUseId } = row.data as { name: string; toolUseId: string; args?: { path?: string } }
  if (name === 'write' || name === 'edit' || name === 'apply_patch')
    calls.set(row.seq, { name, toolUseId, ...(typeof args?.path === 'string' ? { path: args.path } : {}) })
}

/** Join through the result's source sequence, so a reused toolUseId cannot credit a different call. */
function trackWrites(
  calls: Map<number, WriteCall>,
  paths: Map<string, SubtaskArtifactRef>,
  row: Event,
  cwd: string,
) {
  const result = row.data as { toolUseId: string; isError?: boolean }
  const call = calls.get(row.sourceEventSeqs?.[0] ?? -1)
  if (
    !call ||
    result.isError === true ||
    result.toolUseId !== call.toolUseId ||
    row.origin !== `tool:${call.name}`
  )
    return
  const changes =
    call.name === 'apply_patch'
      ? [...textBlocks(row.data).matchAll(/^([AMD]) (.+)$/gm)].map((m) => ({
          removed: m[1] === 'D',
          path: m[2],
        }))
      : [{ removed: false, path: call.path }]
  for (const { path, removed } of changes) {
    if (!path || /[\r\n\0]/.test(path)) continue
    const { abs, rel, inside } = normalizeWorkspacePath(path, cwd)
    if (!inside || rel === '.') continue
    if (removed) paths.delete(abs)
    else paths.set(abs, { path: rel, kind: call.name === 'write' ? 'file' : 'patch', verified: true })
  }
}

async function verifiedFiles(paths: Map<string, SubtaskArtifactRef>, { stat }: SnapshotOptions) {
  const artifacts = []
  for (const [abs, ref] of paths) {
    if (!stat || (await stat(abs).catch(() => undefined))?.kind === 'file') artifacts.push(ref)
  }
  return artifacts
}

const factTypes = [
  'tool/call',
  'tool/result',
  'assistant/message',
  'request/sent',
  'turn/end',
  'decision/state',
  ROLE_DELEGATION,
]

async function localTask(
  parent: SessionImpl,
  record: ChildTaskRecord,
  options: SnapshotOptions,
): Promise<SubtaskFactRecord> {
  const { childKey: taskId, cwd } = record
  const storage = parent.d.log.storage
  const fromSeq = record.boundarySeq + 1
  const [tail] = await storage.scan(taskId, { fromSeq, order: 'desc', limit: 1 })
  const paths = new Map<string, SubtaskArtifactRef>()
  const calls = new Map<number, WriteCall>()
  const open = new Map<string, Pending>()
  let summaryText = ''
  let requestCount = 0
  let producer = 'in-process/unknown'
  let end: ReturnType<typeof childEnd> = {}
  let role: string | undefined
  for await (const page of scanPages((q) => storage.scan(taskId, q), {
    fromSeq,
    toSeq: tail?.seq ?? fromSeq - 1,
    type: factTypes,
  })) {
    for (const row of page) {
      switch (row.type) {
        case 'tool/call':
          trackCall(calls, row)
          break
        case 'tool/result':
          trackWrites(calls, paths, row, cwd)
          break
        case 'decision/state':
          openDecision(open, row)
          break
        case 'request/sent': {
          const model = (row.data as { model?: { route: string; id: string } }).model
          producer = `${model?.route ?? 'in-process'}/${model?.id ?? 'unknown'}`
          requestCount++
          break
        }
        case 'turn/end':
          end = childEnd(row.data)
          break
        case 'assistant/message':
          summaryText = previewOutput(textBlocks(row.data), taskId)
          break
        case ROLE_DELEGATION:
          if (row.origin === 'system' && row.trust === 'trusted')
            role = (row.data as { role?: { ref?: string } }).role?.ref
          break
      }
    }
  }
  const { status, executionState } = projectChildStatus(record)
  const approval = open.values().next().value
  return {
    taskId,
    label: clipText(record.inputText.trim().split('\n')[0] || taskId, 120),
    ...(role ? { role } : {}),
    status,
    executionState,
    summaryText,
    requestCount,
    artifacts: await verifiedFiles(paths, options),
    ...stateFacts(status, `[${producer}] Failed${childFailureSuffix(end)}`, approval),
    updatedAt: tail ? Date.parse(tail.ts) : record.attemptStartedAt,
  }
}

function externalTask(child: ChildAgentListing, now: number): SubtaskFactRecord & { providerId: string } {
  const { id, status, providerId } = child
  return {
    taskId: id,
    label: child.role?.title.en ?? id,
    providerId,
    ...(child.role ? { role: child.role.ref } : {}),
    status,
    executionState: child.executionState ?? (status === 'starting' ? 'creating' : status),
    summaryText: previewOutput(child.text ?? '', id),
    artifacts: [],
    ...stateFacts(status, `[${providerId}/unknown] Failed`),
    updatedAt: child.lastHeartbeatAt ?? now,
  }
}

export async function buildRecapFactSnapshot(
  parent: SessionImpl,
  options: SnapshotOptions = {},
): Promise<RecapFactSnapshot> {
  const { records, external } = await children(parent)
  const generatedAt = parent.d.clock()
  const subtasks = await Promise.all(records.map((r) => localTask(parent, r, options)))
  subtasks.push(...external.map((x) => externalTask(x, generatedAt)))
  subtasks.sort((a, b) => (a.taskId < b.taskId ? -1 : Number(a.taskId > b.taskId)))
  const counts = countStatuses(subtasks.map((x) => x.status))
  const allowedArtifactPaths = [...new Set(subtasks.flatMap((x) => x.artifacts.map((a) => a.path)))].sort()
  return {
    parentKey: parent.key,
    generatedAt,
    counts,
    hasIncompleteWork: counts.completed < counts.total,
    subtasks,
    allowedArtifactPaths,
  }
}

export async function buildChildRecap(parent: SessionImpl) {
  const snapshot = await buildRecapFactSnapshot(parent)
  return {
    snapshot,
    markdown: renderTruthBase(snapshot),
    allowedArtifactPaths: snapshot.allowedArtifactPaths,
    hasIncompleteWork: snapshot.hasIncompleteWork,
  }
}
