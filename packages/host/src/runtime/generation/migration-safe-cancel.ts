import {
  type foldEvents,
  hasAuthenticToolPolicyHash,
  hasCompleteToolPolicyEnvelope,
  hasTrustedToolCallProvenance,
  type OpStateObj,
  type RegisterRow,
  type StorageAdapter,
  toolPolicyBindingProblem,
} from '@agnes/core'

type Fact = {
  name?: unknown
  toolUseId?: string
  effectId?: string
  tool?: unknown
  replay?: unknown
  argsSeq?: unknown
  code?: string
  partial?: boolean
  isError?: unknown
}
const object = (value: unknown): Fact =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Fact) : {}
type Intent = { kind?: string; toolUseId?: string }
type Result = { code?: string; partial: boolean; seq: number }
type Settlement = { effectId: string; outcome: string; seq: number }

/** Identify only cancelled effects whose durable facts prove a completed safe read. */
export function safeCancelledEffects(
  rows: Awaited<ReturnType<StorageAdapter['scan']>>,
  state: ReturnType<typeof foldEvents>,
  registers: readonly RegisterRow[],
  intents: ReadonlyMap<string, Intent>,
  results: ReadonlyMap<string, Result>,
  settlements: readonly Settlement[],
): ReadonlySet<string> {
  const rowsBySeq = new Map(rows.map((row) => [row.seq, row]))
  // A stopped read-only call cannot have an uncertain external write. Require the
  // exact durable policy and effect binding; never infer this from the tool name.
  const safeCancelled = new Set<string>()
  for (const [effectId, intent] of intents) {
    if (
      !intent.toolUseId ||
      results.get(intent.toolUseId)?.code !== 'CANCELLED' ||
      !results.get(intent.toolUseId)?.partial
    )
      continue
    const matchingIntents = rows.filter(
      (row) =>
        row.type === 'effect/intent' &&
        row.origin === 'system' &&
        row.trust === 'trusted' &&
        object(row.data).effectId === effectId,
    )
    const intentRow = matchingIntents[0]
    const intentData = object(intentRow?.data)
    const tool = object(intentData.tool)
    const call = intent.toolUseId ? state.toolCalls.get(intent.toolUseId) : undefined
    const callRow = call && rowsBySeq.get(call.seq)
    const callData = object(callRow?.data) as Parameters<typeof hasCompleteToolPolicyEnvelope>[0] & Fact
    const receipts = rows.filter(
      (row) =>
        row.type === 'tool/result' &&
        row.origin === 'system' &&
        row.trust === 'trusted' &&
        object(row.data).toolUseId === intent.toolUseId,
    )
    const effectSettlements = settlements.filter((row) => row.effectId === effectId)
    const receipt = receipts[0]
    const settlement = effectSettlements[0]
    const stateCalls = registers.flatMap((cell) => {
      if (cell.register !== 'op.state' || cell.data === null) return []
      const op = cell.data as OpStateObj
      // Compaction can park a tools phase in resumeAfter.
      const phase = op.phase.kind === 'compaction' ? (op.phase.resumeAfter as OpStateObj['phase']) : op.phase
      return phase?.kind === 'tools'
        ? phase.batch.calls
            .filter((candidate) => candidate.toolUseId === intent.toolUseId)
            .map((candidate) => ({ cell, candidate }))
        : []
    })
    const stateMatches = stateCalls.every(
      ({ cell, candidate }) =>
        call &&
        cell.key === call.lane &&
        candidate.status === 'completed' &&
        candidate.name === call.name &&
        candidate.argsSeq === call.seq &&
        candidate.effectId === effectId &&
        candidate.replay === 'safe' &&
        toolPolicyBindingProblem(candidate, callData) === undefined,
    )
    if (
      stateMatches &&
      matchingIntents.length === 1 &&
      intentRow &&
      intent.kind === 'tool' &&
      call &&
      callRow &&
      hasTrustedToolCallProvenance(callRow) &&
      hasCompleteToolPolicyEnvelope(callData) &&
      hasAuthenticToolPolicyHash(callData) &&
      callData.resolvedPolicy.isReadOnly === true &&
      callData.resolvedPolicy.isDestructive === false &&
      callData.resolvedPolicy.replay === 'safe' &&
      intentData.replay === 'safe' &&
      intentData.argsSeq === call.seq &&
      tool.name === call.name &&
      (intentRow.lane ?? 'main') === call.lane &&
      intentRow.seq > call.seq &&
      receipts.length === 1 &&
      receipt &&
      (receipt.lane ?? 'main') === call.lane &&
      receipt.seq > intentRow.seq &&
      object(receipt.data).code === 'CANCELLED' &&
      object(receipt.data).partial === true &&
      object(receipt.data).isError === true &&
      effectSettlements.length === 1 &&
      settlement &&
      settlement.outcome === 'aborted' &&
      settlement.seq > receipt.seq &&
      [...intents.values()].filter((other) => other.toolUseId === intent.toolUseId).length === 1
    )
      safeCancelled.add(effectId)
  }
  return safeCancelled
}

/** Add unresolved cancellations and effect outcomes without changing the supplied facts. */
export function classifyUnknown(
  initial: ReadonlyMap<string, number>,
  intents: ReadonlyMap<string, Intent>,
  results: ReadonlyMap<string, Result>,
  settlements: readonly Settlement[],
  safeCancelled: ReadonlySet<string>,
): Map<string, number> {
  const unknown = new Map(initial)
  const receiptFor = (effectId: string) => {
    const toolUseId = intents.get(effectId)?.toolUseId
    return toolUseId ? results.get(toolUseId) : undefined
  }
  const toolEffect = (effectId: string) => {
    const intent = intents.get(effectId)
    return intent?.kind === 'tool' || typeof intent?.toolUseId === 'string'
  }
  for (const event of settlements) {
    const receipt = receiptFor(event.effectId)
    const sentCancel = receipt?.code === 'CANCELLED' && receipt?.partial === true
    // A CANCELLED receipt without partial is the not-sent proof. Anything weaker may have run.
    const neverSent = receipt?.code === 'CANCELLED' && receipt?.partial !== true
    if (event.outcome === 'unknown') unknown.set(event.effectId, event.seq)
    else if ((event.outcome === 'ok' || event.outcome === 'error') && !sentCancel)
      unknown.delete(event.effectId)
    else if (
      event.outcome === 'aborted' &&
      toolEffect(event.effectId) &&
      !neverSent &&
      !safeCancelled.has(event.effectId)
    )
      unknown.set(event.effectId, event.seq)
  }
  for (const [toolUseId, receipt] of results)
    if (
      receipt.code === 'CANCELLED' &&
      receipt.partial &&
      ![...safeCancelled].some((id) => intents.get(id)?.toolUseId === toolUseId)
    )
      unknown.set(`tool:${toolUseId}`, receipt.seq)
  return unknown
}
