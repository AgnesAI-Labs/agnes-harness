import type { DefineStoreSpec, StoreHandle } from './types.js'

/** A small dependency-free store seat. Hosts may provide a richer handle. */
export function defineStore<State, Actions extends object = Record<string, never>>(
  spec: DefineStoreSpec<State, Actions>,
): StoreHandle<State, Actions> {
  if (spec.create) return { create: spec.create }
  return {
    create() {
      let state = spec.initial
      const listeners = new Set<() => void>()
      const set = (next: State | ((previous: State) => State)) => {
        state = typeof next === 'function' ? (next as (previous: State) => State)(state) : next
        for (const listener of [...listeners]) listener()
      }
      const get = () => state
      const actions = spec.actions?.(set, get) ?? ({} as Actions)
      return {
        getSnapshot: get,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        actions,
        destroy() {
          listeners.clear()
        },
      }
    },
  }
}
