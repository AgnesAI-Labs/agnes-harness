import type { NavigationHistory } from '@agnes/web-client'
import { sessionInventory } from './session-inventory.js'
/** Default view reads the host projection; the renderer never binds a second controller. */
export let navigationHistory: NavigationHistory = sessionInventory
export function bindNavigationHistory(source: NavigationHistory): () => void {
  const previous = navigationHistory
  navigationHistory = source
  return () => {
    if (navigationHistory === source) navigationHistory = previous
  }
}
