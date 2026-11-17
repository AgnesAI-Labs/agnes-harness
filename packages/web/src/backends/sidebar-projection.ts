import { useEffect, useState } from 'react'
import { SESSION_SEARCH_EVENT } from '../regions/session-tools.js'
import { backendFrame } from './frame-context.js'
import {
  BACKEND_FRAME_COMMAND,
  BACKEND_FRAME_MESSAGE,
  type BackendCommand,
  type BackendId,
  type BackendSnapshot,
} from './frame-contract.js'

type Projection = { active: BackendId; cloud?: string; states: Partial<Record<BackendId, BackendSnapshot>> }
/** The renderer is a vendor export: subscribe in the component, never a private cross-bundle singleton. */
export function useSidebarProjection(): Projection | undefined {
  const [projection, setProjection] = useState<Projection>()
  useEffect(() => {
    const context = backendFrame()
    if (!context || context.remote) return
    const receive = (event: MessageEvent) => {
      if (
        event.source === window.parent &&
        event.origin === context.parentOrigin &&
        event.data?.type === BACKEND_FRAME_MESSAGE &&
        event.data.kind === 'sidebar-projection'
      )
        setProjection(event.data.projection)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
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
  const context = backendFrame()
  if (!context || context.remote) return
  window.parent.postMessage(
    {
      type: BACKEND_FRAME_MESSAGE,
      kind: 'sidebar-command',
      backend,
      command: { type: BACKEND_FRAME_COMMAND, ...command },
    },
    context.parentOrigin,
  )
}

export function publishSidebarLayout(): void {
  const context = backendFrame()
  if (!context || context.remote) return
  const mobile = matchMedia('(max-width: 900px)').matches
  const right = mobile ? 0 : (document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0)
  window.parent.postMessage(
    {
      type: BACKEND_FRAME_MESSAGE,
      kind: 'sidebar-layout',
      right: Math.max(0, right),
      open: document.body.classList.contains('sidebar-open'),
    },
    context.parentOrigin,
  )
}
