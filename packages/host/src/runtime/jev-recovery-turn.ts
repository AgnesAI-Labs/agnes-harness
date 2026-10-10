import {
  budgetOverrideEvent,
  CoreError,
  canonicalJson,
  type SessionImpl,
  scanAll,
  TURN_BUDGET_EVENT,
} from '@agnes/core'
import { type JsonValue, type RuntimeLedger, replayRecords } from '@agnes/jev-runtime'

const BINDING = 'x/host/jev-loop/turn-decision'

function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('E_ENVELOPE', 'Invalid Jev recovery turn evidence')
  return value as Record<string, unknown>
}

function turnNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new CoreError('E_RELATION', 'Invalid Jev recovery turn identity')
  return value
}

function coordinates(value: unknown): JsonValue {
  const data = fields(value)
  if (
    Object.keys(data).sort().join(',') !== 'backend,endpoint,model' ||
    (data.backend !== 'jev' && data.backend !== 'laya') ||
    typeof data.endpoint !== 'string' ||
    !data.endpoint ||
    typeof data.model !== 'string' ||
    !data.model
  )
    throw new CoreError('E_RELATION', 'Invalid Jev recovery decision binding')
  return { backend: data.backend, endpoint: data.endpoint, model: data.model }
}

/** Open presentation for an unfinished logical turn without admitting new user input.
 * The caller holds session.locked and has no open turn. Cancellation leaves the
 * unresolved actions intact. Portable execution must use the returned runtimeTurn.
 */
export async function claimJevRecoveryTurn(
  session: SessionImpl,
  ledger: RuntimeLedger<number>,
  signal: AbortSignal,
): Promise<{ turn: number; runtimeTurn: number; selection: JsonValue; budget?: number } | undefined> {
  if (signal.aborted) return undefined
  if (session.state.openTurn.has(session.lane))
    throw new CoreError('E_LANE_BUSY', 'Jev recovery requires a closed presentation turn')
  const entries = await ledger.read()
  const state = replayRecords(entries)
  if (!state.unresolved.length || signal.aborted) return undefined
  const logical = new Set(
    state.unresolved.map((intentId) => {
      const intended = state.records.find(
        (record) => record.kind === 'action.intended' && record.intent.id === intentId,
      )
      if (!intended) throw new CoreError('E_RELATION', 'Missing unresolved Jev intent')
      const prefix = `${session.key}:${session.lane}:`
      const suffix = intended.turn.slice(prefix.length)
      if (!intended.turn.startsWith(prefix) || !/^[1-9][0-9]*$/.test(suffix))
        throw new CoreError('E_RELATION', 'Unresolved Jev intent belongs to another session or lane')
      const number = turnNumber(Number(suffix))
      if (intended.turn !== `${prefix}${number}`)
        throw new CoreError('E_RELATION', 'Noncanonical Jev runtime turn identity')
      return number
    }),
  )
  const [runtimeTurn] = logical
  if (logical.size !== 1 || runtimeTurn === undefined)
    throw new CoreError('E_RELATION', 'Unresolved Jev intents belong to multiple logical turns')
  const runtimeId = `${session.key}:${session.lane}:${runtimeTurn}`
  if (
    state.records.some(
      (record) => record.turn === runtimeId && record.kind === 'run.stopped' && record.reason === 'cancelled',
    )
  )
    return undefined
  const rows = (
    await scanAll((query) => session.scan(query), {
      type: ['turn/start', 'turn/end', 'step/start', BINDING, TURN_BUDGET_EVENT, 'runtime/cancel'],
      toSeq: session.lastSeq,
    })
  ).filter((row) => row.lane === session.lane)
  if (signal.aborted) return undefined
  const starts = rows.filter((row) => row.type === 'turn/start')
  const byTurn = new Map(starts.map((row) => [turnNumber(fields(row.data).turn), row]))
  if (byTurn.size !== starts.length || !byTurn.has(runtimeTurn))
    throw new CoreError('E_RELATION', 'Missing or duplicate original Jev presentation turn')
  const bindings = rows.filter((row) => row.type === BINDING)
  const chain = [runtimeTurn]
  for (const start of starts) {
    const turn = turnNumber(fields(start.data).turn)
    if (turn <= runtimeTurn) continue
    const selected = bindings.filter((row) => fields(row.data).turn === turn)
    if (!selected.some((row) => fields(row.data).runtimeTurn === runtimeTurn)) continue
    if (selected.length !== 1) throw new CoreError('E_RELATION', 'Duplicate Jev recovery decision binding')
    const continues = fields(fields(start.data).continues)
    if (continues.turn !== chain.at(-1) || fields(start.data).trigger !== 'follow_up')
      throw new CoreError('E_RELATION', 'Invalid Jev recovery continuation chain')
    chain.push(turn)
  }
  let selection: JsonValue | undefined
  let budget: number | undefined
  let budgetItem: string | undefined
  let lastStep = 0
  for (const turn of chain) {
    const start = byTurn.get(turn)
    if (!start) throw new CoreError('E_RELATION', 'Missing Jev recovery presentation start')
    if (turn !== runtimeTurn && fields(fields(start.data).continues).step !== lastStep)
      throw new CoreError('E_RELATION', 'Recovery continuation changed its source step')
    const next = starts.find((row) => row.seq > start.seq)
    const end = rows.find(
      (row) => row.type === 'turn/end' && row.seq > start.seq && (!next || row.seq < next.seq),
    )
    if (start.origin !== 'system' || start.trust !== 'trusted' || !end)
      throw new CoreError('E_RELATION', 'Recovery presentation is not a closed trusted turn')
    if (end.origin !== 'system' || end.trust !== 'trusted')
      throw new CoreError('E_RELATION', 'Invalid Jev recovery terminal evidence')
    const reason = fields(end.data).reason
    if (reason === 'aborted') return undefined
    if (reason !== 'blocked')
      throw new CoreError('E_RELATION', 'Jev recovery requires a blocked presentation turn')
    if (
      rows.some(
        (row) =>
          row.type === 'runtime/cancel' &&
          fields(row.data).turnId === `${session.key}:${session.lane}:${turn}`,
      )
    )
      return undefined
    const selected = bindings.filter((row) => fields(row.data).turn === turn)
    if (
      selected.length > 1 ||
      selected.some(
        (row) =>
          row.origin !== 'system' ||
          row.trust !== 'trusted' ||
          row.seq <= start.seq ||
          row.seq >= end.seq ||
          (fields(row.data).runtimeTurn !== undefined && fields(row.data).runtimeTurn !== runtimeTurn),
      )
    )
      throw new CoreError('E_RELATION', 'Invalid Jev recovery decision binding')
    if (selected.length) {
      const bound = coordinates(fields(selected[0]?.data).selection)
      if (selection !== undefined && canonicalJson(selection) !== canonicalJson(bound))
        throw new CoreError('E_RELATION', 'Recovery changed the logical decision selection')
      selection = bound
    } else if (turn !== runtimeTurn) {
      throw new CoreError('E_RELATION', 'Missing Jev continuation decision binding')
    }
    const budgets = rows.filter((row) => row.type === TURN_BUDGET_EVENT && fields(row.data).turn === turn)
    if (budgets.length > 1) throw new CoreError('E_RELATION', 'Duplicate Jev recovery budget source')
    if (budgets[0]) {
      const row = budgets[0],
        data = fields(row.data)
      if (
        row.origin !== 'system' ||
        row.trust !== 'trusted' ||
        row.seq <= start.seq ||
        row.seq >= end.seq ||
        typeof data.creditsCap !== 'number' ||
        !Number.isFinite(data.creditsCap) ||
        data.creditsCap < 0 ||
        typeof data.itemId !== 'string' ||
        !data.itemId ||
        (turn !== runtimeTurn && (budget !== data.creditsCap || budgetItem !== data.itemId)) ||
        (selected.length &&
          fields(selected[0]?.data).itemId !== undefined &&
          fields(selected[0]?.data).itemId !== data.itemId)
      )
        throw new CoreError('E_RELATION', 'Invalid Jev recovery budget binding')
      budget = data.creditsCap
      budgetItem = data.itemId
    } else if (turn !== runtimeTurn && budget !== undefined) {
      throw new CoreError('E_RELATION', 'Continuation lost its original Jev budget')
    }
    const steps = rows.filter((row) => row.type === 'step/start' && fields(row.data).turn === turn)
    if (
      steps.some(
        (row) =>
          row.origin !== 'system' || row.trust !== 'trusted' || row.seq <= start.seq || row.seq >= end.seq,
      )
    )
      throw new CoreError('E_RELATION', 'Invalid Jev recovery presentation step evidence')
    const last = steps.at(-1)
    lastStep = last ? turnNumber(fields(last.data).step) : 0
  }
  if (selection === undefined) {
    const requested = state.records.find(
      (record) =>
        record.turn === runtimeId && record.kind === 'model.requested' && record.call.purpose === 'decision',
    )
    if (requested?.kind !== 'model.requested')
      throw new CoreError('E_RELATION', 'Missing original Jev decision coordinates')
    selection = coordinates({
      backend: requested.call.backend,
      endpoint: requested.call.endpoint,
      model: requested.call.requestedModel,
    })
  }
  const turn = session.lastTurnNumber() + 1
  turnNumber(turn)
  if (signal.aborted) return undefined
  await session.d.log.append([
    session.ev('turn/start', {
      turn,
      trigger: 'follow_up',
      continues: { turn: chain.at(-1) ?? runtimeTurn, step: lastStep },
    }),
    session.ev(BINDING, { turn, runtimeTurn, selection }, { ignorable: true }),
    ...(budget === undefined || budgetItem === undefined
      ? []
      : [
          {
            ...budgetOverrideEvent(TURN_BUDGET_EVENT, session.d.actor, {
              turn,
              itemId: budgetItem,
              creditsCap: budget,
            }),
            lane: session.lane,
          },
        ]),
  ])
  session.hooks.resetTurn?.()
  return { turn, runtimeTurn, selection, ...(budget === undefined ? {} : { budget }) }
}
