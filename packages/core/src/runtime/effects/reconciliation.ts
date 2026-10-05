import type { CallContext } from '@agnes/extension-api/runtime'
import type { EffectsDispatchResult, EffectsReconcileRequest } from '@agnes/protocol/runtime'
import type { EffectsAuthority } from './authority.js'

/** Lookup-only owner is distinct from the physical send gate. This never invokes a leaf. */
export async function reconcileCommittedEffect(
  owner: EffectsAuthority,
  request: EffectsReconcileRequest,
  context: CallContext,
  current: () => void,
): Promise<EffectsDispatchResult> {
  current()
  await owner.checkCurrent(context)
  current()
  const result = await owner.reconcile(request, context)
  current()
  return result
}
