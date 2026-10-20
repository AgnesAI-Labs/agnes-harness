import type { ApprovalView } from '@agnes/web-units/shell'

let current: ApprovalView | undefined
const listeners = new Set<() => void>()
/** Same host actions and lifecycle as the conversation card; no independent decision path. */
export const workbenchApproval = {
  getSnapshot: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  set(value: ApprovalView | undefined) {
    current = value
    for (const listener of listeners) listener()
  },
}
