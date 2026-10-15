import { type LocaleService, SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createRegionRenderer } from '@agnes/web-ui'
import {
  Topbar,
  type TopbarConnectionState,
  type TopbarHandle,
  type TopbarStatusDetails,
} from '@agnes/web-units'
import { flushSync } from 'react-dom'
import { type EmptyStateRegionMount, rootStableRegistry, TOPBAR_SLOT } from './contracts.js'
export interface TopbarRegionMount extends EmptyStateRegionMount, TopbarHandle {
  ready: Promise<void>
}
/** Mount the component-owned topbar behind a replaceable SlotOutlet. */
export function mountTopbarRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  locale: LocaleService,
): TopbarRegionMount {
  const handle = { current: null as TopbarHandle | null }
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let sessionId: string | undefined
  let taskTitle: string | undefined
  let status:
    | {
        text: string
        state?: string | undefined
        details?: TopbarStatusDetails | undefined
      }
    | undefined
  let stopAction: (() => void) | undefined
  let connectionState: TopbarConnectionState | undefined
  let agent: { name: string | undefined } | undefined
  let runtimeAvailable: boolean | undefined
  const setHandle = (value: TopbarHandle | null): void => {
    handle.current = value
    if (!value) return
    resolveReady()
    queueMicrotask(() => {
      if (handle.current !== value) return
      value.setSession(sessionId)
      if (taskTitle !== undefined) value.setTaskTitle(taskTitle)
      if (status !== undefined) value.setStatus(status.text, status.state, status.details)
      if (stopAction !== undefined) value.setStopAction(stopAction)
      if (connectionState !== undefined) value.setConnectionState(connectionState)
      if (agent !== undefined) value.setAgent(agent.name)
      if (runtimeAvailable !== undefined) value.setRuntimeAvailable(runtimeAvailable)
    })
  }
  registry.declare(TOPBAR_SLOT as string, { kind: 'single', scope: 'root' }, 'web-shell')
  const removeBuiltin = registry.register(
    { name: TOPBAR_SLOT as string, id: 'builtin-topbar', owner: '@agnes/web-topbar', priority: 0 },
    () => <Topbar ref={setHandle} translate={(key, vars) => locale.t(key, vars)} />,
  )
  container.replaceChildren()
  const root = createRegionRenderer(container)
  flushSync(() => {
    root.render(
      <SlotsProvider registry={rootStableRegistry(registry)}>
        <SlotOutlet name={TOPBAR_SLOT} />
      </SlotsProvider>,
    )
  })
  let disposed = false
  return {
    ready,
    setSession(id) {
      if (sessionId === id) return
      sessionId = id
      handle.current?.setSession(id)
    },
    editTitle(request) {
      handle.current?.editTitle(request)
    },
    setTaskTitle(title) {
      taskTitle = title
      handle.current?.setTaskTitle(title)
    },
    setStatus(text, state, details) {
      status = { text, state, details }
      handle.current?.setStatus(text, state, details)
    },
    setStopAction(action) {
      stopAction = action
      handle.current?.setStopAction(action)
    },
    setConnectionState(value) {
      connectionState = value
      handle.current?.setConnectionState(value)
    },
    setAgent(name) {
      if (agent?.name === name) return
      agent = { name }
      handle.current?.setAgent(name)
    },
    setRuntimeAvailable(available) {
      if (runtimeAvailable === available) return
      runtimeAvailable = available
      handle.current?.setRuntimeAvailable(available)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}
