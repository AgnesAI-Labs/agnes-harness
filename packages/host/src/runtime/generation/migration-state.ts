import { createHash } from 'node:crypto'
import {
  foldEvents,
  hasChildControl,
  isTerminalChildState,
  scanAll,
  type StorageAdapter,
  type OpStateObj,
} from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import { DEFERRED_INVOCATION_EVENT } from '@agnes/host-providers/assemble/deferred-invocations'

type Reason = { kind: string; id: string; sessionKey: string; seq?: number }
type Fact = {
  id?: string
  kind?: string
  effectId?: string
  outcome?: string
  toolUseId?: string
  code?: string
  jobId?: string
  status?: string
  state?: string
  sessionKey?: string
  recoveryRequired?: boolean
  answer?: unknown
  details?: unknown
  invocation?: unknown
  record?: unknown
  surface?: unknown
  request?: unknown
  receipt?: unknown
  failure?: unknown
  commandId?: string
  outcomeUnknown?: boolean
  structured?: unknown
  content?: unknown
}
const object = (value: unknown): Fact =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Fact) : {}

/** Read only. The caller holds generation admission serialization through the subsequent pin CAS. */
export async function assertMigrationSettled(
  storage: StorageAdapter,
  sessionKey: string,
  generationId: string,
  recoveryRequired = false,
): Promise<void> {
  const reasons: Reason[] = []
  const visited = new Set<string>()
  async function inspect(key: string): Promise<void> {
    if (visited.has(key)) return
    visited.add(key)
    const [head] = await storage.scan(key, { order: 'desc', limit: 1 })
    const rows = await scanAll((query) => storage.scan(key, query), { order: 'asc', toSeq: head?.seq ?? 0 })
    const state = foldEvents(rows)
    const add = (kind: string, id: string, seq?: number) =>
      reasons.push({ kind, id, sessionKey: key, ...(seq === undefined ? {} : { seq }) })
    for (const [id, approval] of state.pendingApprovals) add('pending-approval', id, approval.seq)
    for (const [id, decision] of state.decisions) {
      if (decision.via === 'sync' || decision.via === 'guardian' || state.resumedRequests.has(id)) continue
      const asked = rows.find((row) => row.seq === decision.askedSeq)
      if (['tool', 'unknown-outcome'].includes(object(asked?.data).kind ?? ''))
        add('parked-continuation', id, decision.seq)
    }
    for (const [id, effect] of state.pendingEffects)
      add(effect.kind === 'job' ? 'unfinished-background-job' : 'unfinished-effect', id, effect.intentSeq)
    for (const [id, cell] of state.registers.artifactJobs)
      if (!['done', 'failed', 'cancelled'].includes(cell.value.status))
        add('unfinished-background-job', id, cell.seq)
    const completedCalls = new Set(
      rows.filter((row) => row.type === 'tool/result').map((row) => object(row.data).toolUseId),
    )
    for (const [id, call] of state.toolCalls)
      if (!completedCalls.has(id)) add('unfinished-tool-call', id, call.seq)

    const unknown = new Map<string, number>()
    const deferred = new Map<string, { state: string; seq: number }>()
    const jobs = new Map<string, { status: string; seq: number }>()
    const questions = new Map<string, number>()
    const closedSurfaces = new Set<string>()
    const openSurfaces = new Set<string>()
    const uiActions = new Map<
      string,
      { status: string; delivered: boolean; outcomeUnknown: boolean; seq: number }
    >()
    for (const row of rows) {
      const data = object(row.data)
      if (row.origin === 'system' && row.trust === 'trusted') {
        if (row.type === 'effect/settled' && typeof data.effectId === 'string') {
          if (data.outcome === 'unknown') unknown.set(data.effectId, row.seq)
          // Cancellation cannot establish whether an external effect happened.
          else if (data.outcome === 'ok' || data.outcome === 'error') unknown.delete(data.effectId)
        }
        if (row.type === 'tool/result') {
          const details = object(data.structured)
          if (typeof details.jobId === 'string' && typeof details.status === 'string')
            jobs.set(details.jobId, { status: details.status, seq: row.seq })
          // Older shell receipts only persisted the producer's text. Do not let that legacy
          // background binding disappear merely because it predates structured status receipts.
          if (
            data.toolUseId &&
            state.toolCalls.get(data.toolUseId)?.name === 'shell' &&
            Array.isArray(data.content)
          ) {
            for (const block of data.content) {
              const text = (block as { text?: unknown }).text
              const match = typeof text === 'string' ? /^background job (\S+) started/.exec(text) : null
              if (match) jobs.set(match[1]!, { status: 'running', seq: row.seq })
            }
          }
          if (['TOOL_OUTCOME_UNKNOWN', 'JOB_OUTCOME_UNKNOWN'].includes(data.code ?? ''))
            unknown.set(`tool:${data.toolUseId}`, row.seq)
        }
        if (row.type === DEFERRED_INVOCATION_EVENT) {
          const invocation = object(data.invocation)
          if (invocation.sessionKey === key && typeof invocation.id === 'string')
            deferred.set(invocation.id, { state: data.state ?? 'unknown', seq: row.seq })
        }
        if (data.recoveryRequired === true) add('recovery-required', row.id, row.seq)
      }
      if (
        row.type === 'x/agnes/interaction/requested' &&
        row.origin === 'ext:agnes/interaction' &&
        typeof data.toolUseId === 'string' &&
        !data.answer
      )
        questions.set(data.toolUseId, row.seq)
      if (row.type === 'x/agnes/intelligent-ui/surface.closed' && row.origin === 'ext:agnes/intelligent-ui') {
        const record = object(data.record),
          surface = object(record.surface)
        if (record.status === 'closed' && typeof surface.id === 'string') closedSurfaces.add(surface.id)
      }
      if (
        row.origin === 'ext:agnes/intelligent-ui' &&
        row.trust === 'untrusted' &&
        row.type.startsWith('x/agnes/intelligent-ui/')
      ) {
        const name = row.type.slice('x/agnes/intelligent-ui/'.length)
        const record = object(data.record)
        const surface = object(record.surface)
        if (name === 'surface.opened' || name === 'surface.updated' || name === 'surface.closed') {
          const id = typeof surface.id === 'string' ? surface.id : undefined
          const closed = name === 'surface.closed'
          if (!id || (closed ? record.status !== 'closed' : record.status !== 'open'))
            add('corrupt-ui-chain', id ?? row.id ?? name, row.seq)
          else if (closed) openSurfaces.delete(id)
          else openSurfaces.add(id)
        } else if (name.startsWith('action.') && name !== 'action.retried') {
          const request = object(record.request)
          const commandId =
            typeof request.commandId === 'string'
              ? request.commandId
              : typeof data.commandId === 'string'
                ? data.commandId
                : undefined
          if (!commandId) add('corrupt-ui-chain', row.id ?? name, row.seq)
          else if (name === 'action.delivered') {
            const current = uiActions.get(commandId) ?? {
              status: '',
              delivered: false,
              outcomeUnknown: false,
              seq: row.seq,
            }
            current.delivered = true
            uiActions.set(commandId, current)
          } else {
            const receipt = object(record.receipt ?? data.receipt)
            const status = typeof receipt.status === 'string' ? receipt.status : ''
            if (!status) add('corrupt-ui-chain', commandId, row.seq)
            else {
              const failure = object(receipt.failure)
              const previous = uiActions.get(commandId)
              uiActions.set(commandId, {
                status,
                delivered: previous?.delivered ?? false,
                outcomeUnknown: failure.outcomeUnknown === true,
                seq: row.seq,
              })
            }
          }
        }
      }
    }
    for (const id of openSurfaces) add('open-surface', id)
    for (const [id, action] of uiActions) {
      if (['received', 'pending-approval', 'executing'].includes(action.status) || action.outcomeUnknown)
        add('unfinished-ui-action', id, action.seq)
      else if (['rejected', 'succeeded', 'failed'].includes(action.status) && !action.delivered)
        add('undelivered-ui-receipt', id, action.seq)
    }
    for (const [id, seq] of unknown) add('unknown-external-outcome', id, seq)
    for (const [id, call] of deferred)
      if (!['succeeded', 'failed'].includes(call.state)) add('unfinished-deferred-invocation', id, call.seq)
    for (const [id, job] of jobs)
      if (!['completed', 'failed', 'killed'].includes(job.status))
        add('unfinished-background-job', id, job.seq)
    for (const [id, seq] of questions) {
      const surface = 'card-' + createHash('sha256').update(id).digest('hex').slice(0, 48)
      if (!closedSurfaces.has(surface)) add('pending-user-answer', id, seq)
    }
    for (const cell of await storage.registers(key)) {
      if (cell.register !== 'op.state' || cell.data === null) continue
      const op = cell.data as OpStateObj
      if (op.phase.kind === 'deferred') add('unfinished-background-job', cell.key, cell.seq)
      if (op.phase.kind === 'tools' && op.phase.batch.calls.some((call) => call.status !== 'completed'))
        add('parked-continuation', cell.key, cell.seq)
    }
    if (hasChildControl(storage)) {
      for (const child of await storage.listByParent(key)) {
        if (!isTerminalChildState(child.state)) add('unfinished-sub-agent', child.childKey)
        // A cancelled child may still hold an unknown external outcome.
        await inspect(child.childKey)
      }
    }
  }
  if (recoveryRequired) reasons.push({ kind: 'recovery-required', id: generationId, sessionKey })
  await inspect(sessionKey)
  if (reasons.length)
    throw new HostError(
      'E_GENERATION_EXECUTION_UNSETTLED',
      `generation migration refused: ${reasons.map((reason) => `${reason.kind}:${reason.id}`).join(', ')}`,
      { detail: { generationId, reasons } },
    )
}
