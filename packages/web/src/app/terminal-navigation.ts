import { workbenchNavigation } from '@agnes/web-client'
import { onSurfaceEvent } from './global-events.js'

/** Terminal requests from settings and the composer share the current session's dock. */
export function bindTerminalNavigation(closeSettings: () => void): () => void {
  const stopSettings = onSurfaceEvent('agnes:settings-terminal', (event) => {
    closeSettings()
    if (workbenchNavigation.open('terminal')) event.preventDefault()
  })
  const stopChild = onSurfaceEvent('agnes:open-terminal-job', (event) => {
    const childId =
      event instanceof CustomEvent ? (event.detail as { childId?: unknown } | null)?.childId : undefined
    if (typeof childId !== 'string' || !childId) return
    closeSettings()
    workbenchNavigation.open('terminal', { childId })
  })
  return () => {
    stopSettings()
    stopChild()
  }
}
