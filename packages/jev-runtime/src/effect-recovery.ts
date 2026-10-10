/** Host-attested reconciliation after model-led inspection; never interpret model claims as proof. */
import type { ReplayState } from './ledger.js'
import type { JsonValue, RuntimePorts, RuntimeRecord, TurnId } from './types.js'

export async function reconcileEffects<C>(
  port: NonNullable<RuntimePorts<C>['effectRecovery']>,
  state: ReplayState,
  records: readonly RuntimeRecord[],
  signal: AbortSignal,
  write: (
    kind: 'resource.observed' | 'action.resolved',
    turn: TurnId,
    values: object,
  ) => Promise<RuntimeRecord>,
): Promise<void> {
  for (const intentId of [...state.unresolved]) {
    signal.throwIfAborted()
    const intent = state.intents.get(intentId)
    const settled = state.actions.get(intentId)
    if (!intent || !settled) throw new Error('Missing uncertain action')
    const resolution = await port.reconcile(intent, settled.outcome, [...records], signal)
    signal.throwIfAborted()
    if (!resolution) continue
    const settledIndex = records.findIndex((record) => record.id === settled.id)
    const evidence = new Set(resolution.evidence)
    if (
      !['confirmed_applied', 'confirmed_not_applied', 'reconciled_state'].includes(resolution.resolution) ||
      !resolution.explanation.trim() ||
      evidence.size === 0 ||
      [...evidence].some((id) => !records.some((record) => record.id === id)) ||
      !records.some(
        (record, index) =>
          index > settledIndex &&
          record.kind === 'action.settled' &&
          evidence.has(record.id) &&
          record.outcome.kind === 'success' &&
          record.effect === 'none' &&
          state.intents.get(record.intentId)?.effectClass === 'read_only',
      ) ||
      (resolution.resolution === 'reconciled_state' && intent.effectClass !== 'workspace_mutation')
    )
      throw new Error('Invalid Host effect recovery proof')
    const proof = await write('resource.observed', settled.turn, {
      resource: {
        kind: 'jev.effect-recovery.proof.v1',
        intentId,
        settlementRecordId: settled.id,
        resolution: resolution.resolution,
        evidence: [...evidence],
        proof: resolution.proof,
      } satisfies Record<string, JsonValue>,
    })
    signal.throwIfAborted()
    await write('action.resolved', settled.turn, {
      intentId,
      resolution: resolution.resolution,
      actor: 'host:effect-recovery',
      explanation: resolution.explanation,
      evidence: [settled.id, ...evidence, proof.id],
    })
  }
}
