import {
  applicationBrand,
  applicationIdentity,
  type LocaleService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { createRegionRenderer } from '@agnes/web-ui'
import {
  EMPTY_SIDEBAR_STATE,
  type SessionListMark,
  Sidebar,
  type SidebarActions,
  type SidebarDependencies,
  type SidebarHandle,
  type SidebarState,
} from '@agnes/web-units/shell'
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { SessionNavigation } from '../navigation.js'
import { sidebarGrouping } from '../sidebar-grouping.js'
import { ApplicationSwitch } from './application-switch.js'
import {
  type EmptyStateRegionMount,
  rootStableRegistry,
  SIDEBAR_DEPENDENCIES_BASE,
  SIDEBAR_SLOT,
} from './contracts.js'
import { HomeEntriesNav } from './home-entries.js'
import { SessionListLabel, SessionListTools } from './session-tools.js'

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
  running,
  marks,
  actions,
  dependencies,
  profileApprovals,
}: {
  handle: { current: SidebarHandle | null }
  state: SidebarState
  running?: readonly string[]
  marks?: Readonly<Record<string, SessionListMark>>
  actions?: Partial<SidebarActions>
  dependencies: SidebarDependencies
  profileApprovals?: ReactNode
}) {
  const identity = useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const grouping = useSyncExternalStore(sidebarGrouping.subscribe, sidebarGrouping.getSnapshot)
  const brand = applicationBrand(document.documentElement.lang)
  const outlet = (name: string) => <SlotOutlet name={name as never} hideWhenEmpty />
  return (
    <Sidebar
      ref={handle}
      state={state}
      {...(running ? { running } : {})}
      {...(marks ? { marks } : {})}
      actions={actions}
      dependencies={dependencies}
      slots={{
        entries: (
          <HomeEntriesNav t={dependencies.translate} onSelect={() => handle.current?.close()}>
            {profileApprovals}
          </HomeEntriesNav>
        ),
        // The grouped view puts 置顶 / 临时会话 / 工作区 inside the list, so the row above it is
        // only a toolbar: a null label tells the shell not to print a heading it does not own.
        sectionLabel: grouping === 'workspace' ? null : <SessionListLabel t={dependencies.translate} />,
        sessionTools: <SessionListTools t={dependencies.translate} />,
        brandMark: (
          <SlotOutlet
            name={'sidebar.brand.mark' as never}
            fallback={
              identity?.assets.mark ? (
                <img src={identity.assets.mark} alt="" className="brand-mark-image" />
              ) : (
                <span className="agnes-mark brand-mark-image" aria-hidden="true" />
              )
            }
          />
        ),
        brandName: (
          <SlotOutlet
            name={'sidebar.brand.name' as never}
            fallback={<span className="brand-wordmark-text">{brand.name}</span>}
          />
        ),
        panellist: outlet('sidebar.panellist'),
        footerAction: outlet('sidebar.footer.action'),
        settings: outlet('sidebar.settings'),
        workspaces: (
          <span className="sidebar-slot-group">
            {outlet('sidebar.workspaces')}
            {outlet('sidebar.workspaces.directoryFlow')}
          </span>
        ),
      }}
    />
  )
}

/** Render the built-in sidebar behind the root-scoped slot ledger without replacing its outer landmark. */
export interface SidebarRegionMount extends EmptyStateRegionMount, SidebarHandle {}

export function mountSidebarRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: { state?: SidebarState; actions?: Partial<SidebarActions>; profileApprovals?: ReactNode } = {},
  locale: LocaleService,
): SidebarRegionMount {
  let state = options.state ?? EMPTY_SIDEBAR_STATE
  let running: readonly string[] = []
  let marks: Readonly<Record<string, SessionListMark>> = {}
  // Render-time lookup: navigation copy resolves on each rebuild against the current locale.
  const sidebarDependencies: SidebarDependencies = {
    ...SIDEBAR_DEPENDENCIES_BASE,
    translate: (key, vars) => locale.t(key, vars),
    renderNavigation: (options) => (
      <SessionNavigation options={options} t={(key, vars) => locale.t(key, vars)} />
    ),
    // Single-list view only: pinned rows and the managed chats workspace sit above 「会话」.
    // The grouped view renders those as sections inside the list and returns null here.
    renderLeadingNavigation: (options) => (
      <SessionNavigation leading options={options} t={(key, vars) => locale.t(key, vars)} />
    ),
  }
  if (!registry.spec(SIDEBAR_SLOT))
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
        running,
        marks,
        ...(options.actions === undefined ? {} : { actions: options.actions }),
        dependencies: sidebarDependencies,
        profileApprovals: options.profileApprovals,
      }),
  )
  const removeBuiltin = registry.register(
    { name: SIDEBAR_SLOT as string, id: 'builtin-sidebar', owner: '@agnes/web-sidebar', priority: 0 },
    () => (
      <SlotsProvider registry={registry} locale={locale}>
        <SlotOutlet name={'sidebar' as never} />
      </SlotsProvider>
    ),
  )
  const root = createRegionRenderer(container)
  flushSync(() => {
    root.render(
      <SlotsProvider registry={rootStableRegistry(registry)} locale={locale}>
        <SlotOutlet name={SIDEBAR_SLOT} />
        <ApplicationSwitch locale={locale} />
      </SlotsProvider>,
    )
  })
  let disposed = false
  return {
    update(next) {
      state = next
      flushSync(() => handle.current?.update(next))
    },
    setRunning(ids) {
      running = ids
      handle.current?.setRunning(ids)
    },
    setMarks(next) {
      marks = next
      handle.current?.setMarks?.(next)
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
