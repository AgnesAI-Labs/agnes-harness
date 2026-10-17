import type { OwnedStore } from '@agnes/extension-api'
import { type JsonValue, jcs, rpcError } from '@agnes/protocol'

type Owner = { owner: string; revision: string; integrity: string; activation?: string }
export type ManagedPredecessor = Owner & { store: OwnedStore }

/** Retain uncertainty across a replacement; only the liveness reconciliation may clear it. */
export function handoverManagedMarker(
  store: OwnedStore,
  id: string,
  owner: Owner,
  previous?: ManagedPredecessor,
) {
  const binding = {
    owner: owner.owner,
    activation: owner.activation ?? owner.revision,
    integrity: owner.integrity,
  }
  const shutdown = `managed-shutdown:${id}`
  const identity = `managed-process:${id}`
  const bindingKey = `managed-binding:${id}`
  store.transaction(() => {
    const unconfirmed = previous?.store.get(shutdown) === true
    const predecessor =
      unconfirmed && previous
        ? {
            owner: previous.owner,
            activation: previous.activation ?? previous.revision,
            integrity: previous.integrity,
          }
        : (store.get(bindingKey) ?? null)
    if (unconfirmed && previous) {
      // A different unresolved identity in the destination cannot be discarded during handover.
      if (
        store.get(shutdown) === true &&
        jcs(store.get(identity) ?? null) !== jcs(previous.store.get(identity) ?? null)
      )
        throw rpcError('CAPABILITY_DENIED')
      store.set(shutdown, true)
      store.set(identity, previous.store.get(identity) ?? null)
    }
    if (store.get(shutdown) === true && jcs(predecessor) !== jcs(binding))
      store.set(`managed-predecessor:${id}`, predecessor)
    store.set(bindingKey, binding)
  })
}

export function managedMarkerBinding(store: OwnedStore, id: string): Record<string, JsonValue> {
  return {
    binding: store.get(`managed-binding:${id}`) ?? null,
    predecessor: store.get(`managed-predecessor:${id}`) ?? null,
  }
}
