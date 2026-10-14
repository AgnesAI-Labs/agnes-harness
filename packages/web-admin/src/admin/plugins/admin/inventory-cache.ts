import type { AdminPageState } from '../types.js'

type Inventory = Pick<AdminPageState, 'context' | 'installed' | 'generations' | 'surfaceLinks' | 'tree'>

/** The last inventory this page session read, so coming back shows it at once while it is read again. */
let last: Inventory | undefined

/** Keep what a successful read returned; the state is handed back unchanged. */
export function rememberInventory(state: AdminPageState): AdminPageState {
  const { context, installed, generations, surfaceLinks, tree } = state
  last = { context, installed, generations, surfaceLinks, tree }
  return state
}

/**
 * The state a new controller starts from: the remembered inventory, shown as connected but still
 * loading (it is not authoritative until the new read lands), or the empty first state.
 */
export function seededState(state: AdminPageState): AdminPageState {
  return last ? { ...state, ...last, connection: 'connected', loading: true } : state
}

/** Forget the remembered inventory (tests). */
export function forgetInventory(): void {
  last = undefined
}
