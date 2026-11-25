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
import { promptLanguage } from '../request/note-language.js'
import type { SessionImpl } from '../step/session.js'
import { childEnd, childFailureSuffix, clipText } from './failure.js'
import {
  type ArtifactVerificationSummary,
  type ExtendedRecapFactSnapshot,
  type ExtendedSubtaskFactRecord,
  normalizeRecapLocale,
  previewOutput,
  type RecapLocale,
  renderTruthBase,
  stateFacts,
} from './recap-formatter.js'
import { ROLE_DELEGATION } from './roles.js'
import { ownedChildTree } from './sessions.js'

export type SnapshotOptions = {
  stat?: (absolutePath: string) => Promise<{ kind: string }>
  childKey?: string
  locale?: RecapLocale
}
type Pending = NonNullable<SubtaskFactRecord['approvalPending']>

type ExternalEntry = {
  ownerKey: string
  listing: ChildAgentListing
  taskId: string
}

function localSubtreeKeys(records: readonly ChildTaskRecord[], rootChildKey: string): Set<string> {
  const byParent = new Map<string, ChildTaskRecord[]>()
  for (const record of records) {
    const list = byParent.get(record.parentKey) ?? []
    list.push(record)
    byParent.set(record.parentKey, list)
  }
  const included = new Set<string>([rootChildKey])
  const queue = [rootChildKey]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const child of byParent.get(current) ?? []) {
      if (included.has(child.childKey)) continue
      included.add(child.childKey)
      queue.push(child.childKey)
    }
  }
  return included
}

async function children(parent: SessionImpl, descendants = false, targetChildKey?: string) {
  const storage = requireChildControl(parent.d.log.storage)
  const records: ChildTaskRecord[] = []
  if (descendants) {
    for await (const record of ownedChildTree(storage, parent.key)) records.push(record)
  } else {
    records.push(...(await storage.listByParent(parent.key)).map((row) => ({ ...row })))
  }
  const owners = descendants ? [...new Set([parent.key, ...records.map((r) => r.childKey)])] : [parent.key]
  const rawExternal: Array<{ ownerKey: string; listing: ChildAgentListing }> = []
  for (const ownerKey of owners) {
    for (const entry of externalChildren(ownerKey)) {
      rawExternal.push({ ownerKey, listing: entry.listing })
    }
  }
  const localIds = new Set(records.map((r) => r.childKey))
  const idCounts = new Map<string, number>()
  const providerIdCounts = new Map<string, number>()
  for (const { listing } of rawExternal) {
    idCounts.set(listing.id, (idCounts.get(listing.id) ?? 0) + 1)
    const qualified = `${listing.providerId}:${listing.id}`
    providerIdCounts.set(qualified, (providerIdCounts.get(qualified) ?? 0) + 1)
  }
  const external: ExternalEntry[] = rawExternal.map(({ ownerKey, listing }) => {
    const collides = (idCounts.get(listing.id) ?? 0) > 1 || localIds.has(listing.id)
    if (!collides) return { ownerKey, listing, taskId: listing.id }
    const byProvider = `${listing.providerId}:${listing.id}`
    const providerCollides = (providerIdCounts.get(byProvider) ?? 0) > 1 || localIds.has(byProvider)
    return {
      ownerKey,
      listing,
      taskId: providerCollides ? `${ownerKey}::${byProvider}` : byProvider,
    }
  })

  if (!targetChildKey) return { records, external }

  if (localIds.has(targetChildKey)) {
    const subtree = localSubtreeKeys(records, targetChildKey)
    return {
      records: records.filter((r) => subtree.has(r.childKey)),
      external: external.filter((x) => subtree.has(x.ownerKey)),
    }
  }
  const exactExternal = external.filter((x) => x.taskId === targetChildKey)
  if (exactExternal.length > 0) return { records: [], external: exactExternal }
  const byListingId = external.filter((x) => x.listing.id === targetChildKey)
  if (byListingId.length === 1) return { records: [], external: byListingId }
  return { records: [], external: [] }
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

const isIncompleteStatus = (status: ChildAgentStatus) => status !== 'completed' && status !== 'idle'

/** Notices only need the roster. Do not replay every sibling ledger on every completion. */
export async function childBatchCounts(parent: SessionImpl) {
  const { records, external } = await children(parent)
  const statuses = [
    ...records.map((r) => projectChildStatus(r).status),
    ...external.map((x) => x.listing.status),
  ]
  const counts = countStatuses(statuses)
  const idle = statuses.filter((status) => status === 'idle').length
  return {
    ...counts,
    idle,
    hasIncompleteWork: statuses.some(isIncompleteStatus),
  }
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

function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  if (error instanceof Error) {
    const match = /\b(E[A-Z0-9_]+)\b/.exec(error.message)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function isMissingError(error: unknown): boolean {
  const code = errorCodeOf(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function verifyArtifacts(
  paths: Map<string, SubtaskArtifactRef>,
  stat: SnapshotOptions['stat'],
): Promise<{ artifacts: SubtaskArtifactRef[]; verification: ArtifactVerificationSummary }> {
  const recordedCount = paths.size
  if (recordedCount === 0) {
    return {
      artifacts: [],
      verification: { recordedCount: 0, verifiedCount: 0, missingCount: 0, unverifiableCount: 0 },
    }
  }
  if (!stat) {
    return {
      artifacts: [],
      verification: {
        recordedCount,
        verifiedCount: 0,
        missingCount: 0,
        unverifiableCount: recordedCount,
        errorCodes: ['STAT_UNAVAILABLE'],
      },
    }
  }
  const artifacts: SubtaskArtifactRef[] = []
  let missingCount = 0
  let unverifiableCount = 0
  const codes = new Set<string>()
  for (const [abs, ref] of paths) {
    try {
      const entry = await stat(abs)
      if (entry?.kind === 'file') artifacts.push(ref)
      else missingCount++
    } catch (error) {
      if (isMissingError(error)) {
        missingCount++
      } else {
        unverifiableCount++
        codes.add(errorCodeOf(error) ?? 'STAT_FAILED')
      }
    }
  }
  return {
    artifacts,
    verification: {
      recordedCount,
      verifiedCount: artifacts.length,
      missingCount,
      unverifiableCount,
      ...(codes.size > 0 ? { errorCodes: [...codes].sort() } : {}),
    },
  }
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
): Promise<ExtendedSubtaskFactRecord> {
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
  const invocation = parent.d.workspaceInvocation
  const stat =
    options.stat ?? (invocation && (async (path: string) => invocation.run((view) => view.fs().stat(path))))
  const { artifacts, verification } = await verifyArtifacts(paths, stat)
  return {
    taskId,
    ownerKey: record.parentKey,
    label: clipText(record.inputText.trim().split('\n')[0] || taskId, 120),
    ...(role ? { role } : {}),
    status,
    executionState,
    summaryText,
    requestCount,
    artifacts,
    artifactVerification: verification,
    ...stateFacts(status, `[${producer}] Failed${childFailureSuffix(end)}`, approval),
    updatedAt: tail ? Date.parse(tail.ts) : record.attemptStartedAt,
  }
}

function externalTask(
  entry: ExternalEntry,
  now: number,
): ExtendedSubtaskFactRecord & { providerId: string; ownerKey: string } {
  const { listing: child, ownerKey, taskId } = entry
  const { status, providerId } = child
  return {
    taskId,
    ownerKey,
    label: child.role?.title.en ?? child.id,
    providerId,
    ...(child.role ? { role: child.role.ref } : {}),
    status,
    executionState: child.executionState ?? (status === 'starting' ? 'creating' : status),
    summaryText: previewOutput(child.text ?? '', taskId),
    artifacts: [],
    artifactVerification: { recordedCount: 0, verifiedCount: 0, missingCount: 0, unverifiableCount: 0 },
    ...stateFacts(status, `[${providerId}/unknown] Failed`),
    updatedAt: child.lastHeartbeatAt ?? now,
  }
}

export async function sessionRecapLocale(parent: SessionImpl): Promise<RecapLocale> {
  const rows = await parent.scan({ type: 'user/message', lane: parent.lane, order: 'desc', limit: 5 })
  for (const row of rows) {
    if (row.origin === 'system') continue
    const data = row.data as { kind?: string; content?: { type: string; text?: string }[] }
    if (data.kind === 'runtime_context') continue
    const detected = promptLanguage(textBlocks(data))
    if (detected) return normalizeRecapLocale(detected)
  }
  return 'en'
}

export async function buildRecapFactSnapshot(
  parent: SessionImpl,
  options: SnapshotOptions = {},
): Promise<ExtendedRecapFactSnapshot> {
  const { records, external } = await children(parent, true, options.childKey)
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
    hasIncompleteWork: subtasks.some((x) => isIncompleteStatus(x.status)),
    subtasks,
    allowedArtifactPaths,
    ...(options.locale ? { locale: normalizeRecapLocale(options.locale) } : {}),
    ...(options.childKey ? { targetChildKey: options.childKey } : {}),
  }
}

export async function buildChildRecap(parent: SessionImpl, options: SnapshotOptions = {}) {
  const locale = options.locale ?? (await sessionRecapLocale(parent))
  const snapshot = await buildRecapFactSnapshot(parent, { ...options, locale })
  return {
    snapshot,
    markdown: renderTruthBase(snapshot, locale),
    allowedArtifactPaths: snapshot.allowedArtifactPaths,
    hasIncompleteWork: snapshot.hasIncompleteWork,
  }
}
