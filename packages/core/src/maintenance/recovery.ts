import type { Event, EventInput, Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import { type EffectNode, effectTree, MAINTENANCE_LANE } from '@agnes/core-ledger/reduce/state'
import { sysEvent } from '../step/events.js'
import type { SessionImpl } from '../step/session.js'
import { MAINTENANCE_INTENT, MAINTENANCE_RESULT } from './execute.js'
import { maintenanceInFlight } from './in-flight.js'

export { drainMaintenance } from './in-flight.js'

/** What a maintenance intent recorded for pricing a call nobody saw finish. */
type Intent = {
  runId: string
  route: string
  model: string
  inputTokens: number
  projectedCredits: number | null
}

const row = (s: SessionImpl, type: string, data: unknown, extra: Partial<EventInput> = {}) =>
  sysEvent({ actor: s.d.actor, lane: MAINTENANCE_LANE }, type, data, extra)

/** The intent's own record, written by Core in the same commit, or undefined when it cannot be trusted. */
function intentOf(rows: readonly Event[], node: EffectNode): Intent | undefined {
  const found = rows.find(
    (event) =>
      event.seq === node.intentSeq + 1 &&
      event.type === MAINTENANCE_INTENT &&
      event.origin === 'system' &&
      event.trust === 'trusted' &&
      (event.data as { effectId?: unknown } | null)?.effectId === node.effectId,
  )
  const data = found?.data as (Partial<Intent> & { version?: unknown }) | undefined
  if (
    data?.version !== 1 ||
    typeof data.runId !== 'string' ||
    typeof data.route !== 'string' ||
    typeof data.model !== 'string' ||
    !Number.isSafeInteger(data.inputTokens) ||
    (data.projectedCredits !== null &&
      !(typeof data.projectedCredits === 'number' && Number.isFinite(data.projectedCredits)))
  )
    return undefined
  return data as Intent
}

/**
 * The rows that settle a maintenance call the process died inside. It may have reached the provider
 * and is never sent again, so it settles as unknown, with the estimate frozen into its intent as an
 * interrupted cost, ahead of the settlement in the same commit; a cost row already on the ledger is
 * never written twice. Neither the billing seam nor the budget root is reached from here.
 */
function strandedRows(s: SessionImpl, node: EffectNode, rows: readonly Event[]): EventInput[] {
  const { effectId } = node
  const intent = intentOf(rows, node)
  const charged = rows.some(
    (event) =>
      event.type === 'cost/ledger' && (event.data as { effectId?: unknown } | null)?.effectId === effectId,
  )
  const cost =
    intent && !charged
      ? [
          row(s, 'cost/ledger', {
            purpose: 'side-call',
            effectId,
            model: intent.model,
            route: intent.route,
            tokens: { input: intent.inputTokens, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(intent.projectedCredits === null ? {} : { credits: intent.projectedCredits }),
            creditSource: 'estimated',
            interrupted: true,
          }),
        ]
      : []
  return [
    ...cost,
    row(s, 'effect/settled', { effectId, outcome: 'unknown' }),
    row(
      s,
      MAINTENANCE_RESULT,
      {
        version: 1,
        ...(intent ? { runId: intent.runId } : {}),
        effectId,
        outcome: 'unknown',
        dispatch: 'may-have-sent',
        reason: 'interrupted',
      },
      { ignorable: true },
    ),
  ]
}

/**
 * Settles every maintenance call a previous process left unfinished, as unknown, and returns how
 * many it settled. It runs whenever the session opens, idle or not, and never touches a call this
 * process is still running. Nothing is resent: a run that wants a new plan starts a new call.
 */
export async function recoverMaintenance(s: SessionImpl): Promise<number> {
  if (effectTree(s.state, MAINTENANCE_LANE).length === 0) return 0
  return s.locked(async () => {
    // Read both under the lock: intents are only appended under it, and a call claims its id before
    // its first await, so a call this process runs or settles meanwhile is never taken for stranded.
    const running = maintenanceInFlight(s)
    const nodes = effectTree(s.state, MAINTENANCE_LANE).filter((node) => !running.has(node.effectId))
    if (nodes.length === 0) return 0
    const from = Math.min(...nodes.map((node) => node.intentSeq)) as Seq
    const rows = await scanAll((q) => s.scan(q), {
      fromSeq: from,
      toSeq: s.lastSeq,
      lane: MAINTENANCE_LANE,
      type: [MAINTENANCE_INTENT, 'cost/ledger'],
    })
    const unusable = nodes.filter((node) => !intentOf(rows, node)).map((node) => node.effectId)
    // The gap is recorded on the maintenance lane, beside the settlement it explains.
    const gap = unusable.length
      ? [
          row(
            s,
            'x/core/invariant',
            { kind: 'maintenance-intent-unusable', effectIds: unusable },
            { ignorable: true },
          ),
        ]
      : []
    await s.append([...nodes.flatMap((node) => strandedRows(s, node, rows)), ...gap])
    return nodes.length
  })
}
