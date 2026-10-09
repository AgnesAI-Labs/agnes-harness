import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import type { HostSession } from '@agnes/host'
import type { EventEnvelope, ToolCall, ToolResult } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { reviewDiff } from './review-diff.js'
import {
  assertWorkspacePublicRoot,
  normalizeWorkspacePath,
  readWorkspace,
  type WorkspaceAuthority,
  type WorkspaceRead,
} from './workspace-files.js'

const RECEIPT_TYPE = 'x/agnes/tools-core/file-change'
const MAX_ROWS = 500,
  MAX_EFFECTS = 100,
  MAX_FILES = 50,
  MAX_TEXT_BYTES = 16 * 1024
const MAX_RESULT_BYTES = 750 * 1024
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

type Reader = Pick<HostSession, 'key' | 'scan' | 'lastSeq'>
type Receipt = {
  path: string
  turn: number
  toolUseId: string
  operation: 'write' | 'edit'
  existed: boolean
  beforeHash: string
  afterHash: string
  before?: string
  after?: string
  status: 'available' | 'binary' | 'too-large'
}
export type ReviewEvidence = {
  callSeq: number
  resultSeq: number
  receiptSeq: number
  toolUseId: string
  tool: 'write' | 'edit'
  laneId?: string
  turn: number
  observedAt: string
  decisionId: string
  enforcement: 'full' | 'partial' | 'none'
}
type Effect = { receipt: Receipt; evidence: ReviewEvidence }
type Snapshot = {
  effects: Effect[]
  fromSeq: number
  toSeq: number
  turn: number | null
  truncated: boolean
  unrecorded: boolean
}
export type WorkspaceChange = {
  path: string
  kind: 'added' | 'modified'
  basis: 'session' | 'turn' | 'latest-effect'
  added?: number
  removed?: number
  diffStatus: Receipt['status'] | 'diff-limit'
  freshness: 'current' | 'changed' | 'unavailable'
  afterRevision: string
  currentRevision: string
  effects: ReviewEvidence[]
}
export type WorkspaceChanges = {
  scope: 'session' | 'turn'
  revision: string
  observedAt: string
  fromSeq: number
  toSeq: number
  turn: number | null
  truncated: boolean
  unrecorded: boolean
  files: WorkspaceChange[]
  selected?: WorkspaceChange & { beforeRevision: string; diff?: string; viewerChanged?: boolean }
}
const cached = new WeakMap<Reader, Map<string, Snapshot>>()
function receipt(row: EventEnvelope, sessionId: string): Receipt | undefined {
  const data = record(row.data)
  if (
    !data ||
    row.type !== RECEIPT_TYPE ||
    row.origin !== 'ext:agnes/tools-core' ||
    data.version !== 1 ||
    data.sessionId !== sessionId ||
    !['write', 'edit'].includes(String(data.operation)) ||
    typeof data.path !== 'string' ||
    typeof data.existed !== 'boolean' ||
    typeof data.toolUseId !== 'string' ||
    data.toolUseId.length > 128 ||
    !Number.isSafeInteger(data.turn) ||
    Number(data.turn) < 1 ||
    !['available', 'binary', 'too-large'].includes(String(data.status))
  )
    return undefined
  let path: string
  try {
    path = normalizeWorkspacePath(data.path)
  } catch {
    return undefined
  }
  if (
    !path ||
    path !== data.path ||
    !/^[a-f0-9]{64}$/.test(String(data.beforeHash)) ||
    !/^[a-f0-9]{64}$/.test(String(data.afterHash))
  )
    return undefined
  if (data.status === 'available') {
    if (
      typeof data.before !== 'string' ||
      typeof data.after !== 'string' ||
      Buffer.byteLength(data.before) > MAX_TEXT_BYTES ||
      Buffer.byteLength(data.after) > MAX_TEXT_BYTES ||
      hash(data.before) !== data.beforeHash ||
      hash(data.after) !== data.afterHash ||
      (!data.existed && data.before !== '')
    )
      return undefined
  }
  if (data.status !== 'available' && (data.before !== undefined || data.after !== undefined)) return undefined
  return data as unknown as Receipt
}

/** Read a bounded ledger window one row at a time; large unrelated results are never retained. */
async function snapshot(session: Reader, scope: 'session' | 'turn', root: string): Promise<Snapshot> {
  const key = `${scope}:${session.lastSeq}:${root}`,
    previous = cached.get(session)?.get(key)
  if (previous) return previous
  const upto = session.lastSeq
  const [start] = await session.scan({ type: 'session/start', order: 'desc', toSeq: upto, limit: 1 })
  const owned = start && record(start.data)?.key === session.key
  const [turnRow] = owned
    ? await session.scan({ type: 'turn/start', order: 'desc', fromSeq: start.seq, toSeq: upto, limit: 1 })
    : []
  const turn = Number(record(turnRow?.data)?.turn) || null
  const floor = owned ? (scope === 'turn' && turnRow ? turnRow.seq : start.seq) : upto + 1
  const results = new Map<
    string,
    { row: EventEnvelope; result: Pick<ToolResult, 'isError' | 'authz' | 'enforcement'>; callSeq: number }
  >()
  const calls = new Map<string, string>(),
    successful = new Set<string>(),
    recorded = new Set<string>()
  const candidates: {
    row: EventEnvelope
    value: Receipt
    result: NonNullable<ReturnType<typeof results.get>>
  }[] = []
  let cursor = upto,
    count = 0,
    truncated = false,
    fromSeq = floor,
    incomplete = false
  while (cursor >= floor && count < MAX_ROWS) {
    const [row] = await session.scan({
      type: [RECEIPT_TYPE, 'tool/call', 'tool/result'],
      fromSeq: floor,
      toSeq: cursor,
      order: 'desc',
      limit: 1,
    })
    if (!row) break
    count++
    cursor = row.seq - 1
    fromSeq = row.seq
    if (row.type === 'tool/result') {
      const result = row.data as ToolResult,
        callSeq = row.sourceEventSeqs?.[0]
      if (
        typeof result.toolUseId === 'string' &&
        callSeq &&
        result.isError === false &&
        !result.partial &&
        !result.interrupted &&
        !result.cancelledBy &&
        !result.transformedBy
      ) {
        successful.add(result.toolUseId)
        // Keep only coordinates and verified metadata, not the possibly large content field.
        results.set(result.toolUseId, {
          row: { ...row, data: null },
          result: { isError: result.isError, authz: result.authz, enforcement: result.enforcement },
          callSeq,
        })
      }
    } else if (row.type === 'tool/call') {
      const call = row.data as ToolCall
      if (call.executionDomain === 'workspace' && call.resolvedPolicy?.isReadOnly !== true)
        calls.set(call.toolUseId, call.name)
    } else {
      const value = receipt(row, session.key),
        result = value && results.get(value.toolUseId)
      if (value && !result) incomplete = true
      if (scope === 'turn' && value?.turn !== turn) continue
      if (value && result && result.callSeq < row.seq && result.row.seq > row.seq) {
        candidates.push({ row: { ...row, data: null }, value, result })
      }
      if (candidates.length >= MAX_EFFECTS) {
        truncated = cursor >= floor
        break
      }
    }
  }
  if (count >= MAX_ROWS && cursor >= floor) truncated = true
  const effects: Effect[] = []
  for (const item of candidates.reverse()) {
    if (!owned || item.result.callSeq < start.seq) continue
    const [row] = await session.scan({ fromSeq: item.result.callSeq, toSeq: item.result.callSeq, limit: 1 })
    const call = row?.type === 'tool/call' ? (row.data as ToolCall) : undefined,
      args = record(call?.args)
    if (
      !row ||
      !call ||
      call.toolUseId !== item.value.toolUseId ||
      call.name !== item.value.operation ||
      call.executionDomain !== 'workspace' ||
      typeof args?.path !== 'string'
    )
      continue
    try {
      if (
        args.path.includes('\\') ||
        normalizeWorkspacePath(relative(root, resolve(root, args.path))) !== item.value.path
      )
        continue
    } catch {
      continue
    }
    // Absolute spellings are admitted by tools; the receipt supplies a relative identity. The
    // verified current file read below is still required before that identity leaves the worker.
    const authz = item.result.result.authz,
      enforcement = item.result.result.enforcement
    if (
      !authz ||
      typeof authz.decisionId !== 'string' ||
      !enforcement ||
      !['full', 'partial', 'none'].includes(enforcement.level)
    )
      continue
    recorded.add(item.value.toolUseId)
    if (item.value.existed && item.value.beforeHash === item.value.afterHash) continue
    effects.push({
      receipt: item.value,
      evidence: {
        callSeq: row.seq,
        resultSeq: item.result.row.seq,
        receiptSeq: item.row.seq,
        toolUseId: call.toolUseId,
        ...(typeof row.lane === 'string' &&
        row.lane.length > 0 &&
        row.lane.length <= 64 &&
        row.lane === item.row.lane &&
        row.lane === item.result.row.lane
          ? { laneId: row.lane }
          : {}),
        tool: item.value.operation,
        turn: item.value.turn,
        observedAt: item.row.ts,
        decisionId: authz.decisionId,
        enforcement: enforcement.level,
      },
    })
  }
  const value: Snapshot = {
    effects,
    fromSeq,
    toSeq: upto,
    turn,
    truncated,
    unrecorded: incomplete || !owned || [...successful].some((id) => calls.has(id) && !recorded.has(id)),
  }
  const table = cached.get(session) ?? new Map<string, Snapshot>()
  table.clear()
  table.set(key, value)
  cached.set(session, table)
  return value
}

export async function readWorkspaceChanges(
  session: Reader,
  root: string,
  authority: WorkspaceAuthority,
  input: { scope?: 'session' | 'turn'; path?: string; expectedRevision?: string },
): Promise<WorkspaceChanges> {
  await assertWorkspacePublicRoot(root, authority)
  const scope = input.scope ?? 'session',
    path = input.path === undefined ? undefined : normalizeWorkspacePath(input.path)
  const selectedCurrent = path === undefined ? undefined : await readWorkspace(root, path, authority)
  const history = await snapshot(session, scope, root),
    groups = new Map<string, Effect[]>()
  for (const effect of history.effects) {
    const group = groups.get(effect.receipt.path) ?? []
    group.push(effect)
    groups.set(effect.receipt.path, group)
  }
  let truncated = history.truncated,
    unrecorded = history.unrecorded
  const result: WorkspaceChanges = {
    scope,
    revision: '',
    observedAt: new Date().toISOString(),
    fromSeq: history.fromSeq,
    toSeq: history.toSeq,
    turn: history.turn,
    truncated,
    unrecorded,
    files: [],
  }
  const entries = [...groups].sort(
    (a, b) => b[1].at(-1)!.evidence.receiptSeq - a[1].at(-1)!.evidence.receiptSeq,
  )
  if (path !== undefined) entries.sort((a, b) => Number(b[0] === path) - Number(a[0] === path))
  for (const [file, effects] of entries) {
    if (result.files.length >= MAX_FILES) {
      truncated = true
      break
    }
    let current: WorkspaceRead
    try {
      current =
        file === path && selectedCurrent ? selectedCurrent : await readWorkspace(root, file, authority)
    } catch {
      unrecorded = true
      continue
    }
    const last = effects.at(-1)!,
      discontinuous = effects.some(
        (effect, index) => index > 0 && effects[index - 1]!.receipt.afterHash !== effect.receipt.beforeHash,
      )
    const latestOnly = history.truncated || discontinuous
    const first = latestOnly ? last : effects[0]!
    const before = first.receipt.before,
      after = last.receipt.after
    const diff = before === undefined || after === undefined ? undefined : reviewDiff(file, before, after)
    const status =
      first.receipt.status !== 'available'
        ? first.receipt.status
        : last.receipt.status !== 'available'
          ? last.receipt.status
          : diff
            ? 'available'
            : 'diff-limit'
    const value: WorkspaceChange = {
      path: file,
      kind: first.receipt.existed ? 'modified' : 'added',
      basis: latestOnly ? 'latest-effect' : scope,
      ...(diff ? { added: diff.added, removed: diff.removed } : {}),
      diffStatus: status,
      freshness: current.truncated
        ? 'unavailable'
        : current.revision === last.receipt.afterHash
          ? 'current'
          : 'changed',
      afterRevision: last.receipt.afterHash,
      currentRevision: current.revision,
      effects: (latestOnly ? [last] : effects).map((effect) => effect.evidence),
    }
    result.files.push(value)
    if (file === path)
      result.selected = {
        ...value,
        beforeRevision: first.receipt.beforeHash,
        ...(diff ? { diff: diff.diff } : {}),
        ...(input.expectedRevision ? { viewerChanged: input.expectedRevision !== current.revision } : {}),
      }
  }
  result.truncated = truncated
  result.unrecorded = unrecorded
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES - 128 && result.files.length > 1) {
    const index = result.files.findLastIndex((file) => file.path !== path)
    result.files.splice(index, 1)
    result.truncated = true
  }
  result.revision = hash(JSON.stringify([scope, history.toSeq, result.files]))
  return result
}

/** Historical receipts grant no access. Every response re-enters the current workspace authority. */
export async function sessionWorkspaceChanges(
  session: HostSession,
  input: { scope?: 'session' | 'turn'; path?: string; expectedRevision?: string },
) {
  const port = session.d.workspaceInvocation
  if (!port) throw rpcError('CAPABILITY_DENIED')
  const invoke = (view: Parameters<Parameters<typeof port.run>[0]>[0]) =>
    readWorkspaceChanges(session, view.root, view.fs(), input)
  return session.d.workspacePublication
    ? session.d.workspacePublication.workspace(() => ({ port, handler: invoke }))
    : port.run(invoke)
}
