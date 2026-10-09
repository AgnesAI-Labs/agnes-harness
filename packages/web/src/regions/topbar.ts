import { type LocaleService, SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import { Topbar, type TopbarConnectionState, type TopbarHandle } from '@agnes/web-units'
import { createElement } from 'react'
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
  let taskTitle: string | undefined
  let status: { text: string; state?: string } | undefined
  let connectionState: TopbarConnectionState | undefined
  const setHandle = (value: TopbarHandle | null): void => {
    handle.current = value
    if (!value) return
    resolveReady()
    if (taskTitle !== undefined) value.setTaskTitle(taskTitle)
    if (status !== undefined) value.setStatus(status.text, status.state)
    if (connectionState !== undefined) value.setConnectionState(connectionState)
  }
  registry.declare(TOPBAR_SLOT as string, { kind: 'single', scope: 'root' }, 'web-shell')
  const removeBuiltin = registry.register(
    { name: TOPBAR_SLOT as string, id: 'builtin-topbar', owner: '@agnes/web-topbar', priority: 0 },
    () =>
      createElement(Topbar, {
        ref: setHandle,
        translate: (key, vars) => locale.t(key, vars),
      }),
  )
  container.replaceChildren()
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry: rootStableRegistry(registry) },
        createElement(SlotOutlet, { name: TOPBAR_SLOT }),
      ),
    )
  })
  let disposed = false
  return {
    ready,
    setTaskTitle(title) {
      taskTitle = title
      handle.current?.setTaskTitle(title)
    },
    setStatus(text, state) {
      status = { text, ...(state === undefined ? {} : { state }) }
      handle.current?.setStatus(text, state)
    },
    setConnectionState(value) {
      connectionState = value
      handle.current?.setConnectionState(value)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}
