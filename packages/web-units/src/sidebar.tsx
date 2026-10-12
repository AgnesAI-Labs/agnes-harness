import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { Button, Icon, IconButton } from '@agnes/web-ui'
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { Translate } from './locales/index.js'
export type SessionAction = 'rename' | 'fork' | 'archive'

export interface SidebarNavigationOptions {
  sessions: PageSessionMeta['items']
  workspaces: readonly WorkspaceEntry[]
  currentId?: string
  activeId?: string
  activeWorkspace?: string
  labels: ReadonlyMap<string, string>
  disabled?: boolean
  newDisabled?: boolean
  next?: string
  loadMore?(cursor: string): void
  action?(action: SessionAction, id: string, title: string, trigger: HTMLElement): void
  newSession(workspace: WorkspaceEntry): void
  open(id: string): void
}

export interface SidebarShell {
  close(): void
  dismiss(): void
  dispose(): void
}

export interface SidebarDependencies {
  /** Locale-bound translate (host injects); called during render, never cached. */
  translate: Translate
  renderNavigation(options: SidebarNavigationOptions): ReactNode
  bindSidebar(narrow: MediaQueryList): SidebarShell
}

export interface SidebarState {
  sessions: PageSessionMeta['items']
  workspaces: readonly WorkspaceEntry[]
  labels: ReadonlyMap<string, string>
  locale?: string
  currentId?: string
  next?: string
  sessionPending: boolean
  newDisabled: boolean
}

export interface SidebarActions {
  newSession(workspace?: WorkspaceEntry): void
  addWorkspace(): void
  openSettings(): void
  openSession(id: string): void
  sessionAction(action: SessionAction, id: string, title: string, trigger: HTMLElement): void
  loadMore(cursor: string): void
}

export interface SidebarHandle {
  update(state: SidebarState): void
  close(): void
  dismiss(): void
  focusNew(): void
}

export interface SidebarSlots {
  brandMark?: ReactNode
  brandName?: ReactNode
  panellist?: ReactNode
  footerAction?: ReactNode
  settings?: ReactNode
  workspaces?: ReactNode
}

export const EMPTY_SIDEBAR_STATE: SidebarState = {
  sessions: [],
  workspaces: [],
  labels: new Map(),
  sessionPending: false,
  newDisabled: true,
}

const BRAND_NAME = 'Agnes Harness'
const noop = () => {}
const EMPTY_ACTIONS: SidebarActions = {
  newSession: noop,
  addWorkspace: noop,
  openSettings: noop,
  openSession: noop,
  sessionAction: noop,
  loadMore: noop,
}

type SidebarSessionRow = SidebarState['sessions'][number] & { cwd?: string }

function navigationSignature(state: SidebarState): string {
  const labels: [string, string][] = []
  for (const [id, label] of state.labels) labels.push([id, label])
  labels.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return JSON.stringify([
    state.sessions.map((session) => {
      const row = session as SidebarSessionRow
      return [row.sessionId, row.title, row.cwd ?? '', row.archived ?? false]
    }),
    state.workspaces.map((workspace) => [workspace.path, workspace.name, workspace.available]),
    labels,
    state.locale ?? null,
    state.currentId ?? null,
    state.next ?? null,
    state.sessionPending,
    state.newDisabled,
  ])
}

const SidebarBuiltin = forwardRef<
  SidebarHandle,
  {
    state: SidebarState
    actions: SidebarActions
    dependencies?: SidebarDependencies
    slots?: SidebarSlots
  }
>(function SidebarBuiltin({ state, actions, dependencies, slots }, ref) {
  const store = useRef({
    state,
    signature: navigationSignature(state),
    listeners: new Set<() => void>(),
  }).current
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    },
    [store],
  )
  const snapshot = useCallback(() => store.state, [store])
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  const update = useCallback(
    (next: SidebarState) => {
      const signature = navigationSignature(next)
      if (signature === store.signature) return
      store.state = { ...next }
      store.signature = signature
      for (const listener of store.listeners) listener()
    },
    [store],
  )
  useLayoutEffect(() => update(state), [state, update])
  const newButton = useRef<HTMLButtonElement>(null)
  const shell = useRef<SidebarShell | undefined>(undefined)
  const t: Translate = dependencies?.translate ?? ((key) => key)
  useImperativeHandle(
    ref,
    () => ({
      update,
      close: () => shell.current?.close(),
      dismiss: () => shell.current?.dismiss(),
      focusNew: () => newButton.current?.focus(),
    }),
    [update],
  )
  useLayoutEffect(() => {
    if (!dependencies) return
    const toggle = document.getElementById('sidebar-toggle')
    const close = document.getElementById('sidebar-close')
    const backdrop = document.getElementById('sidebar-backdrop')
    if (
      !(toggle instanceof HTMLButtonElement) ||
      !(close instanceof HTMLButtonElement) ||
      !(backdrop instanceof HTMLButtonElement)
    )
      return
    // Match the existing mobile drawer breakpoint and retain its focus/inert lifecycle.
    const controller = dependencies.bindSidebar(window.matchMedia('(max-width: 900px)'))
    shell.current = controller
    return () => {
      controller.dispose()
      shell.current = undefined
    }
  }, [dependencies])
  return (
    <div style={{ display: 'contents' }} data-agnes-region-owner="builtin" data-agnes-region-unit="sidebar">
      <div className="sidebar-head">
        <div className="brand-lockup">
          <span className="agnes-mark brand-mark-image" aria-hidden="true" />
          <span className="brand-wordmark-text">{BRAND_NAME}</span>
          {slots?.brandMark}
          {slots?.brandName}
        </div>
        <IconButton
          id="sidebar-close"
          className="sidebar-close"
          name="panel-left"
          label={t('sidebar.closeNav')}
          title={t('sidebar.closeNav')}
        />
      </div>
      <div className="sidebar-actions">
        <Button
          id="new"
          ref={newButton}
          appearance="primary"
          disabled={current.newDisabled}
          onClick={() => actions.newSession()}
        >
          <Icon name="plus" />
          <span>{t('sidebar.newSession')}</span>
        </Button>
      </div>
      <div className="sidebar-section-heading">
        <p className="section-label">{t('sidebar.sectionHeading')}</p>
        <IconButton
          id="workspace-add"
          name="plus"
          label={t('sidebar.addWorkspace')}
          title={t('sidebar.addWorkspace')}
          onClick={actions.addWorkspace}
        />
        {slots?.workspaces}
      </div>
      <nav id="sessions" aria-label={t('sidebar.sessionsNav')}>
        {dependencies?.renderNavigation({
          sessions: current.sessions,
          workspaces: current.workspaces,
          labels: current.labels,
          ...(current.currentId ? { currentId: current.currentId } : {}),
          disabled: current.sessionPending,
          newDisabled: current.newDisabled,
          ...(current.next ? { next: current.next } : {}),
          loadMore: actions.loadMore,
          action: actions.sessionAction,
          newSession: actions.newSession,
          open: actions.openSession,
        })}
      </nav>
      {slots?.panellist}
      <div className="sidebar-footer">
        {slots?.footerAction}
        <Button id="settings" appearance="ghost" onClick={actions.openSettings}>
          <Icon name="settings" />
          <span>{t('sidebar.settings')}</span>
        </Button>
        {slots?.settings}
      </div>
    </div>
  )
})

export const Sidebar = forwardRef<
  SidebarHandle,
  {
    state: SidebarState
    actions?: Partial<SidebarActions> | undefined
    dependencies?: SidebarDependencies
    slots?: SidebarSlots
  }
>(function Sidebar(props, ref) {
  return (
    <SidebarBuiltin
      ref={ref}
      state={props.state}
      actions={{ ...EMPTY_ACTIONS, ...props.actions }}
      {...(props.dependencies ? { dependencies: props.dependencies } : {})}
      {...(props.slots ? { slots: props.slots } : {})}
    />
  )
})
