import { homeNavigation } from '@agnes/web-client'
import { useSyncExternalStore } from 'react'

/**
 * An application quick action launches its role through the agents page, which owns the launch
 * receipt. That page stays out of sight until the launch needs the user (review, failure, nothing
 * to launch), so a covered start goes straight from the click to the conversation.
 *
 * The page's own routing re-opens `agents` without the action selection, so the state is armed by
 * the action selection and survives that, until the user leaves the agents page.
 */
type State = 'idle' | 'quiet' | 'surfaced'
let state: State = 'idle'
const listeners = new Set<() => void>()
const set = (next: State) => {
  if (state === next) return
  state = next
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

homeNavigation.subscribe(() => {
  const nav = homeNavigation.getSnapshot()
  const selection = nav?.selection
  if (
    typeof selection === 'object' &&
    selection !== null &&
    ('workAction' in selection || 'composerLaunch' in selection)
  )
    set('quiet')
  else if (nav?.id !== 'agents') set('idle')
})

export const workLaunch = {
  /** The launch needs the page: a decision, a failure, or nothing to launch. */
  surface(): void {
    if (state === 'quiet') set('surfaced')
  },
}

export const useWorkLaunchQuiet = (): boolean => useSyncExternalStore(subscribe, () => state === 'quiet')
