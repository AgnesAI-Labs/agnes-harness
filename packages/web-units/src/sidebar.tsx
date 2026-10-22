import type { PageSessionMeta, SessionGroup, WorkspaceEntry } from '@agnes/protocol'
import { Button, Icon, IconButton, Kbd, Tooltip } from '@agnes/web-ui'
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Translate } from './locales/index.js'
import { isNewSessionShortcut, newSessionShortcutKeys } from './session-groups.js'
export type SessionAction =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'fork'
  | 'archive'
  | 'unarchive'
  | 'runtime'
  | 'revealWorkspace'
export type SidebarGroupState = SessionGroup & {
  items: PageSessionMeta['items']
  opened: boolean
  loaded: boolean
  loading: boolean
  next?: string | undefined
  stale?: boolean
  error?: string
}
export type SidebarPaging = { groups: SidebarGroupState[]; ready: boolean; loading: boolean; error?: string }
export type SidebarGroupAction = 'toggle' | 'more' | 'collapse' | 'reload' | 'retry'

export interface SidebarNavigationOptions {
  runtimePlatform?: string

  sessions: PageSessionMeta['items']
  paging?: SidebarPaging
  groupAction?(id: string, action: SidebarGroupAction): void
  refreshGroups?(): void
  workspaces: readonly WorkspaceEntry[]
  currentId?: string
  activeId?: string
  activeWorkspace?: string
  labels: ReadonlyMap<string, string>
  /** Sessions with a turn in flight; they show a breathing dot. */
  runningIds?: readonly string[]
  disabled?: boolean
  newDisabled?: boolean
  next?: string
  loadMore?(cursor: string): void
  action?(action: SessionAction, id: string, title: string, trigger: HTMLElement): void
  workspaceAction?(action: 'reveal' | 'remove', workspace: WorkspaceEntry): Promise<void>
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
  runtimePlatform?: string

  sessions: PageSessionMeta['items']
  paging?: SidebarPaging
  workspaces: readonly WorkspaceEntry[]
  labels: ReadonlyMap<string, string>
  locale?: string
  currentId?: string
  next?: string
  sessionPending: boolean
  newDisabled: boolean
}

export interface SidebarActions {
  workspaceAction?(action: 'reveal' | 'remove', workspace: WorkspaceEntry): Promise<void>
  groupAction?(id: string, action: SidebarGroupAction): void
  refreshGroups?(): void
  newSession(workspace?: WorkspaceEntry): void
  addWorkspace(): void
  openSettings(): void
  openSession(id: string): void
  sessionAction(action: SessionAction, id: string, title: string, trigger: HTMLElement): void
  loadMore(cursor: string): void
}

export interface SidebarHandle {
  update(state: SidebarState): void
  /** Mark the sessions that currently have a turn in flight. */
  setRunning(ids: readonly string[]): void
  close(): void
  dismiss(): void
  focusNew(): void
}

export interface SidebarSlots {
  /** Host navigation between the new-session action and the workspace list. */
  entries?: ReactNode
  /** Replaces the list heading while the host shows something other than workspaces. */
  sectionLabel?: ReactNode
  /** Host controls for the session list, before the add-workspace action. */
  sessionTools?: ReactNode
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
    state.paging,
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
    running?: readonly string[]
    dependencies?: SidebarDependencies
    slots?: SidebarSlots
  }
>(function SidebarBuiltin({ state, actions, running: initialRunning, dependencies, slots }, ref) {
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
  const [running, setRunning] = useState<readonly string[]>(initialRunning ?? [])
  const newButton = useRef<HTMLButtonElement>(null)
  const newSession = useRef(actions.newSession)
  newSession.current = actions.newSession
  // One chord starts a session from anywhere on the page; it yields to an open dialog.
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isNewSessionShortcut(event)) return
      if (store.state.newDisabled || document.querySelector('dialog[open]')) return
      event.preventDefault()
      newSession.current()
    }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [store])
  const shell = useRef<SidebarShell | undefined>(undefined)
  const t: Translate = dependencies?.translate ?? ((key) => key)
  useImperativeHandle(
    ref,
    () => ({
      update,
      setRunning: (ids) =>
        setRunning((previous) =>
          previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids,
        ),
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
          {slots?.brandMark ?? <span className="agnes-mark brand-mark-image" aria-hidden="true" />}
          {slots?.brandName ?? <span className="brand-wordmark-text">{BRAND_NAME}</span>}
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
        <Tooltip title={t('sidebar.newSession')}>
          <Button
            id="new"
            ref={newButton}
            appearance="secondary"
            aria-keyshortcuts="Meta+Shift+O Control+Shift+O"
            aria-label={t('sidebar.newSession')}
            disabled={current.newDisabled}
            onClick={() => actions.newSession()}
          >
            <Icon name="plus" />
            <span>{t('sidebar.newSession')}</span>
            <Kbd aria-hidden="true" keys={newSessionShortcutKeys(globalThis.navigator?.platform ?? '')} />
          </Button>
        </Tooltip>
      </div>
      {slots?.entries}
      <div className="sidebar-section-heading">
        <p className="section-label">{slots?.sectionLabel ?? t('sidebar.sectionHeading')}</p>
        {slots?.sessionTools}
        <IconButton
          id="workspace-add"
          name="folder-plus"
          label={t('sidebar.addWorkspace')}
          title={t('sidebar.addWorkspace')}
          onClick={actions.addWorkspace}
        />
        {slots?.workspaces}
      </div>
      <nav id="sessions" aria-label={t('sidebar.sessionsNav')}>
        {dependencies?.renderNavigation({
          sessions: current.sessions,
          ...(current.paging ? { paging: current.paging } : {}),
          ...(actions.groupAction ? { groupAction: actions.groupAction } : {}),
          ...(actions.refreshGroups ? { refreshGroups: actions.refreshGroups } : {}),
          workspaces: current.workspaces,
          labels: current.labels,
          runningIds: running,
          ...(current.runtimePlatform ? { runtimePlatform: current.runtimePlatform } : {}),
          ...(current.currentId ? { currentId: current.currentId } : {}),
          disabled: false,
          newDisabled: current.newDisabled,
          ...(current.next ? { next: current.next } : {}),
          loadMore: actions.loadMore,
          action: actions.sessionAction,
          ...(actions.workspaceAction ? { workspaceAction: actions.workspaceAction } : {}),
          newSession: actions.newSession,
          open: actions.openSession,
        })}
      </nav>
      {slots?.panellist}
      <div className="sidebar-footer">
        {slots?.footerAction}
        <Tooltip title={t('sidebar.settings')}>
          <Button
            id="settings"
            appearance="ghost"
            aria-label={t('sidebar.settings')}
            onClick={actions.openSettings}
          >
            <Icon name="settings" />
            <span>{t('sidebar.settings')}</span>
          </Button>
        </Tooltip>
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
    running?: readonly string[]
    dependencies?: SidebarDependencies
    slots?: SidebarSlots
  }
>(function Sidebar(props, ref) {
  return (
    <SidebarBuiltin
      ref={ref}
      state={props.state}
      actions={{ ...EMPTY_ACTIONS, ...props.actions }}
      {...(props.running ? { running: props.running } : {})}
      {...(props.dependencies ? { dependencies: props.dependencies } : {})}
      {...(props.slots ? { slots: props.slots } : {})}
    />
  )
})
