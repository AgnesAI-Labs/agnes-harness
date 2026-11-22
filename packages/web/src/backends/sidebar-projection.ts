import { useEffect, useSyncExternalStore } from 'react'
import { SESSION_SEARCH_EVENT } from '../regions/session-tools.js'
import { backendFrame } from './frame-context.js'
import type { BackendCommand, BackendId } from './frame-contract.js'
import {
  dispatchWorkbenchCommand,
  dispatchWorkbenchSelect,
  localSidebarProjection,
  type SidebarProjection,
} from './local-workbench-bus.js'

const subscribeEmpty = () => () => {}
const readEmpty = (): SidebarProjection | undefined => undefined

/** Subscribe in the component through the local workbench store; Cloud frames hide their own sidebar. */
export function useSidebarProjection(): SidebarProjection | undefined {
  const remote = Boolean(backendFrame())
  const projection = useSyncExternalStore(
    remote ? subscribeEmpty : localSidebarProjection.subscribe,
    remote ? readEmpty : localSidebarProjection.read,
  )
  useEffect(() => {
    if (projection?.active !== 'cloud') return
    const redirect = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      sidebarCommand('cloud', { kind: 'search' })
    }
    document.addEventListener(SESSION_SEARCH_EVENT, redirect, true)
    return () => document.removeEventListener(SESSION_SEARCH_EVENT, redirect, true)
  }, [projection?.active])
  return projection
}

export function sidebarCommand(backend: BackendId, command: BackendCommand): void {
  if (backendFrame()) return
  dispatchWorkbenchCommand(backend, command)
}

/** Select an existing view without creating a session or rebuilding the cloud frame. */
export function selectSidebarBackend(backend: BackendId): void {
  if (backendFrame()) return
  dispatchWorkbenchSelect(backend, { keepSidebar: true })
}
