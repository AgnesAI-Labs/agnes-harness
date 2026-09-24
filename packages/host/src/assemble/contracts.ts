import { type ContractStore, PARSER_VERSION } from '@agnes/ai'
import type { KernelOptions } from '@agnes/core'
import type { ModelRecord } from '@agnes/protocol'
import { HostError } from '../errors.js'

/** Snapshot a verified catalog; never consult mutable provider or profile data during inference. */
export function bindModelContracts(
  models: readonly ModelRecord[],
  store: ContractStore,
): NonNullable<KernelOptions['contractForModel']> {
  const contracts = new Map<string, Readonly<{ contract_id: string | null; parser_version: string }>>()
  const key = (route: string, model: string) => JSON.stringify([route, model])
  for (const model of models) {
    const id = model.contract_id
    if (id !== null && store.prefixHash(id) === null)
      throw new HostError('E_PRESET_UNRESOLVED', 'model contract is not loaded', {
        detail: { reason: 'contract-unloaded', route: model.route, model: model.id },
      })
    const k = key(model.route, model.id)
    if (contracts.has(k))
      throw new HostError('E_PRESET_UNRESOLVED', 'duplicate model identity in contract catalog', {
        detail: { reason: 'model-duplicate', route: model.route, model: model.id },
      })
    contracts.set(k, Object.freeze({ contract_id: id, parser_version: PARSER_VERSION }))
  }
  return (target) => {
    const contract = contracts.get(key(target.route, target.model))
    if (!contract)
      throw new HostError('E_PRESET_UNRESOLVED', 'selected model is absent from contract catalog', {
        detail: { reason: 'model-unserved', ...target },
      })
    return contract
  }
}
