import { type LocaleService, SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import {
  EMPTY_SIDEBAR_STATE,
  Sidebar,
  type SidebarActions,
  type SidebarDependencies,
  type SidebarHandle,
  type SidebarState,
} from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { renderSessionNavigation } from '../navigation.js'
import {
  type EmptyStateRegionMount,
  SIDEBAR_DEPENDENCIES_BASE,
  SIDEBAR_SLOT,
  rootStableRegistry,
} from './contracts.js'

export const DSH_SIDEBAR_CHILDREN = Object.freeze({
  'sidebar.brand.mark': { kind: 'single', scope: 'root' },
  'sidebar.brand.name': { kind: 'single', scope: 'root' },
  'sidebar.footer.action': { kind: 'list', scope: 'root' },
  'sidebar.panellist': { kind: 'list', scope: 'root' },
  'sidebar.settings': { kind: 'single', scope: 'root' },
  'sidebar.workspaces': { kind: 'single', scope: 'root' },
  'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
} as const)

export function SidebarDshFrame({
  handle,
  state,
  actions,
  dependencies,
}: {
  handle: { current: SidebarHandle | null }
  state: SidebarState
  actions?: Partial<SidebarActions>
  dependencies: SidebarDependencies
}): ReturnType<typeof createElement> {
  const outlet = (name: string) => createElement(SlotOutlet, { name: name as never, hideWhenEmpty: true })
  return createElement(Sidebar, {
    ref: handle,
    state,
    actions,
    dependencies,
    slots: {
      brandMark: outlet('sidebar.brand.mark'),
      brandName: outlet('sidebar.brand.name'),
      panellist: outlet('sidebar.panellist'),
      footerAction: outlet('sidebar.footer.action'),
      settings: outlet('sidebar.settings'),
      workspaces: createElement(
        'span',
        { style: { display: 'contents' } },
        outlet('sidebar.workspaces'),
        outlet('sidebar.workspaces.directoryFlow'),
      ),
    },
  })
}

/** Render the built-in sidebar behind the root-scoped slot ledger without replacing its outer landmark. */
export interface SidebarRegionMount extends EmptyStateRegionMount, SidebarHandle {}

export function mountSidebarRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: { state?: SidebarState; actions?: Partial<SidebarActions> } = {},
  locale: LocaleService,
): SidebarRegionMount {
  let state = options.state ?? EMPTY_SIDEBAR_STATE
  // Render-time lookup: navigation copy resolves on each rebuild against the current locale.
  const sidebarDependencies: SidebarDependencies = {
    ...SIDEBAR_DEPENDENCIES_BASE,
    translate: (key, vars) => locale.t(key, vars),
    renderNavigation: (options) => renderSessionNavigation(options, (key, vars) => locale.t(key, vars)),
  }
  registry.declare(SIDEBAR_SLOT as string, { kind: 'single', scope: 'root' }, 'web-shell')
  if (!registry.spec('sidebar')) registry.declare('sidebar', { kind: 'single', scope: 'root' }, 'web-shell')
  const handle = { current: null as SidebarHandle | null }
  const removeDshBuiltin = registry.register(
    {
      name: 'sidebar',
      id: 'builtin-sidebar-dsh',
      owner: '@agnes/web-sidebar',
      priority: 0,
      children: DSH_SIDEBAR_CHILDREN,
    },
    () =>
      SidebarDshFrame({
        handle,
        state,
        ...(options.actions === undefined ? {} : { actions: options.actions }),
        dependencies: sidebarDependencies,
      }),
  )
  const removeBuiltin = registry.register(
    { name: SIDEBAR_SLOT as string, id: 'builtin-sidebar', owner: '@agnes/web-sidebar', priority: 0 },
    () =>
      createElement(
        SlotsProvider,
        { registry, locale },
        createElement(SlotOutlet, { name: 'sidebar' as never }),
      ),
  )
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry: rootStableRegistry(registry), locale },
        createElement(SlotOutlet, { name: SIDEBAR_SLOT }),
      ),
    )
  })
  let disposed = false
  return {
    update(next) {
      state = next
      flushSync(() => handle.current?.update(next))
    },
    close() {
      handle.current?.close()
    },
    dismiss() {
      handle.current?.dismiss()
    },
    focusNew() {
      handle.current?.focusNew()
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
      removeDshBuiltin()
    },
  }
}
