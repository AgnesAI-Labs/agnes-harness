/** Argument-only correction of proposals rejected before any execution. */
import type { LanguageInput, ModelSettlement, RecordId, RuntimeRecord, TurnId } from './types.js'

export const MAX_ARGUMENT_REPAIRS = 3
export type ArgumentRepair = NonNullable<LanguageInput['argumentRepair']>

/** Read the exact unexecuted call shape, without treating a proposal as an action. */
export function proposedArguments(output: ModelSettlement['output']): ArgumentRepair['calls'] {
  if (output === null || typeof output !== 'object' || Array.isArray(output))
    throw new Error('Argument repair has no recorded proposal')
  const calls = output.kind === 'calls' && Array.isArray(output.calls) ? output.calls : [output]
  if (calls.length < 1 || calls.length > 32) throw new Error('Invalid argument repair proposal size')
  return calls.map((call) => {
    if (
      call === null ||
      typeof call !== 'object' ||
      Array.isArray(call) ||
      call.kind !== 'call' ||
      typeof call.name !== 'string' ||
      call.arguments === null ||
      typeof call.arguments !== 'object' ||
      Array.isArray(call.arguments)
    )
      throw new Error('Invalid argument repair call')
    return { name: call.name, arguments: call.arguments }
  })
}

/** Reconstruct consumed correction opportunities from committed records, including interrupted requests. */
export function pendingArgumentRepair(
  records: readonly RuntimeRecord[],
  turn: TurnId,
): ArgumentRepair | undefined {
  const outputs = new Map<RecordId, ModelSettlement['output']>()
  let pending: ArgumentRepair | undefined
  for (const record of records) {
    if (record.turn !== turn) continue
    if (record.kind === 'input.admitted' && record.input.source === 'user') pending = undefined
    if (record.kind === 'model.settled') outputs.set(record.requested, record.settlement.output)
    if (record.kind !== 'resource.observed') continue
    const value = record.resource
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.kind !== 'jev.argument-repair.v1'
    )
      continue
    if (typeof value.root !== 'string' || typeof value.requested !== 'string')
      throw new Error('Invalid argument repair references')
    const root = value.root as RecordId
    const requested = value.requested as RecordId
    if (value.phase === 'rejected') {
      const error = value.error
      if (
        error === null ||
        typeof error !== 'object' ||
        Array.isArray(error) ||
        typeof error.code !== 'string' ||
        typeof error.message !== 'string'
      )
        throw new Error('Invalid argument repair rejection')
      const proposal = (value.proposal ?? requested) as RecordId
      pending = {
        root,
        requested,
        attempt: pending?.root === root ? pending.attempt : 0,
        calls: proposedArguments(outputs.get(proposal)),
        error: { code: error.code, message: error.message },
      }
    } else if (value.phase === 'requested') {
      if (
        pending?.root !== root ||
        requested !== pending.requested ||
        value.attempt !== pending.attempt + 1 ||
        value.attempt > MAX_ARGUMENT_REPAIRS
      )
        throw new Error('Invalid argument repair attempt')
      pending = { ...pending, attempt: value.attempt }
    } else if (value.phase === 'accepted' || value.phase === 'arbitrated') {
      if (pending?.root !== root) throw new Error('Argument repair resolution has no pending proposal')
      pending = undefined
    } else throw new Error('Invalid argument repair phase')
  }
  return pending
}
