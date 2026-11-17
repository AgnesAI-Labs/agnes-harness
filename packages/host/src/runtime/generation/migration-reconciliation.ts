import type { Event, foldEvents } from '@agnes/core'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const trusted = (row: Event) => row.origin === 'system' && row.trust === 'trusted'

/** Read-only acknowledgement of exact human-reconciled calls, never new execution authority.
 * The caller's fold has verified the formal answer chain, subject digest, receipts and deadlines.
 * Original unknown results remain on the ledger; a person's answer is not a machine effect receipt. */
export function unreconciled(
  rows: readonly Event[],
  state: ReturnType<typeof foldEvents>,
  sessionKey: string,
  unknown: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const results = new Map(
    rows
      .filter((row) => trusted(row) && row.type === 'tool/result')
      .map((row) => [object(row.data).toolUseId, object(row.data).code]),
  )
  const settlements = new Map(
    rows
      .filter((row) => trusted(row) && row.type === 'effect/settled')
      .map((row) => [object(row.data).effectId, object(row.data).outcome]),
  )
  const reconciled = new Set<string>()
  for (const { value, seq } of state.registers.decisionStates.values()) {
    const { request, result, consumption } = value
    const id = request.operationId
    const call = state.toolCalls.get(id)
    const subject = object(request.spec.subject)
    const recorded = call && rows.find((row) => row.seq === call.seq)
    if (
      request.owner !== 'core/unknown-outcome' ||
      request.sourcePackage !== '@agnes/core' ||
      request.spec.purpose !== 'unknown-outcome' ||
      request.spec.key !== id ||
      value.handle.sessionId !== sessionKey ||
      !call ||
      request.lane !== call.lane ||
      recorded?.type !== 'tool/call' ||
      !trusted(recorded) ||
      subject.toolUseId !== id ||
      subject.name !== call.name ||
      subject.turn !== call.turn ||
      subject.step !== call.step ||
      result?.reason !== 'answered' ||
      result.code === 'full-access' ||
      result.answeredBy.role === 'system' ||
      result.answeredBy.role === 'agent' ||
      !value.answerCommand ||
      !['allowed-once', 'allowed-session', 'rejected'].includes(result.response.option) ||
      !consumption ||
      consumption.operationId !== id ||
      consumption.effectId !== null ||
      value.invalidation ||
      results.get(id) !== 'TOOL_OUTCOME_UNKNOWN'
    )
      continue
    const checkpoint = rows.some((row) => {
      const data = object(row.data),
        handle = object(data.handle)
      return (
        row.type === 'x/core/decision-checkpoint' &&
        trusted(row) &&
        row.seq > seq &&
        (row.lane ?? 'main') === call.lane &&
        data.operationId === id &&
        handle.id === value.handle.id &&
        handle.sessionId === sessionKey
      )
    })
    if (checkpoint) reconciled.add(id)
  }
  const remaining = new Map(unknown)
  for (const toolUseId of reconciled) remaining.delete(`tool:${toolUseId}`)
  for (const row of rows) {
    if (row.type !== 'effect/intent' || !trusted(row)) continue
    const data = object(row.data),
      tool = object(data.tool)
    if (typeof tool.toolUseId !== 'string' || typeof data.effectId !== 'string') continue
    const call = state.toolCalls.get(tool.toolUseId)
    if (
      data.kind === 'tool' &&
      call &&
      reconciled.has(tool.toolUseId) &&
      tool.name === call.name &&
      (row.lane ?? 'main') === call.lane &&
      row.seq > call.seq &&
      settlements.get(data.effectId) === 'unknown'
    )
      remaining.delete(data.effectId)
  }
  return remaining
}
