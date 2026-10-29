import { randomUUID } from 'node:crypto'
import type { OwnedStore } from '@agnes/extension-api'
import { type JsonValue, jcs, rpcError } from '@agnes/protocol'

type Owner = { owner: string; revision: string; integrity: string; activation?: string }
export type ManagedShutdownConfirmation = {
  id: string
  incarnation: string
  identity: JsonValue
  confirmed: boolean
  origin: OwnedStore
  current: OwnedStore
}
export type ManagedPredecessor = Owner & {
  store: OwnedStore
  shutdownConfirmation?: ManagedShutdownConfirmation
}

/** Retain uncertainty across a replacement, including the exact instance still being drained. */
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
  const incarnation = `managed-incarnation:${id}`
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
        (jcs(store.get(identity) ?? null) !== jcs(previous.store.get(identity) ?? null) ||
          jcs(store.get(incarnation) ?? null) !== jcs(previous.store.get(incarnation) ?? null))
      )
        throw rpcError('CAPABILITY_DENIED')
      store.set(shutdown, true)
      store.set(identity, previous.store.get(identity) ?? null)
      store.set(incarnation, previous.store.get(incarnation) ?? null)
    }
    if (store.get(shutdown) === true && jcs(predecessor) !== jcs(binding))
      store.set(`managed-predecessor:${id}`, predecessor)
    store.set(bindingKey, binding)
  })
  const confirmation = previous?.shutdownConfirmation
  if (confirmation?.id === id && matchesShutdownInstance(confirmation, store)) {
    confirmation.current = store
    if (confirmation.confirmed) confirmManagedShutdown(confirmation)
    return confirmation
  }
}

function matchesShutdownInstance(confirmation: ManagedShutdownConfirmation, store: OwnedStore): boolean {
  return (
    store.get(`managed-incarnation:${confirmation.id}`) === confirmation.incarnation &&
    jcs(store.get(`managed-process:${confirmation.id}`) ?? null) === jcs(confirmation.identity)
  )
}

export function hasManagedShutdownConfirmation(
  confirmation: ManagedShutdownConfirmation | undefined,
  store: OwnedStore,
): boolean {
  return !!confirmation?.confirmed && matchesShutdownInstance(confirmation, store)
}

/** A late acknowledgement is evidence for its own instance, never for a newer live resource. */
export function confirmManagedShutdown(confirmation: ManagedShutdownConfirmation): void {
  confirmation.confirmed = true
  for (const store of new Set([confirmation.origin, confirmation.current])) {
    try {
      store.transaction(() => {
        if (
          matchesShutdownInstance(confirmation, store) &&
          store.get(`managed-shutdown:${confirmation.id}`) === true
        )
          markShutdown(store, confirmation.id, false)
      })
    } catch {
      // A retired Host may have closed its namespace. A live retry must recheck its own store.
    }
  }
}

export function markShutdown(store: OwnedStore, id: string, unconfirmed: boolean): void {
  store.transaction(() => {
    store.set(`managed-shutdown:${id}`, unconfirmed)
    if (!unconfirmed) store.delete(`managed-predecessor:${id}`)
    store.set(`managed-marker-revision:${id}`, randomUUID())
  })
}

export function managedMarkerBinding(store: OwnedStore, id: string): Record<string, JsonValue> {
  return {
    binding: store.get(`managed-binding:${id}`) ?? null,
    predecessor: store.get(`managed-predecessor:${id}`) ?? null,
  }
}
