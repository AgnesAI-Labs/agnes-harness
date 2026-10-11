import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { Icon } from '@agnes/web-ui'
import {
  createElement,
  type ForwardedRef,
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import type { Translate } from './locales/index.js'
export type SessionAction = 'rename' | 'fork' | 'archive'

export interface SidebarNavigationOptions {
  nav: HTMLElement
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
  renderNavigation(options: SidebarNavigationOptions): void
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

/** 导航区渲染所依赖的全部数据，压成一个可比较的字符串。
 *
 *  更新入口挂在事件流上（一次回答期间会被调用数十次），但侧边栏自身的数据在多数调用之间
 *  并不变化。导航区是整体重建的，重建会丢掉键盘焦点、悬停态与滚动位置，所以签名一致时
 *  跳过重绘。字段清单必须与 `renderNavigation` 实际读取的输入保持一致 —— 漏字段会让
 *  界面停留在旧数据上。 */
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
>(function SidebarBuiltin(
  {
    state,
    actions,
    dependencies,
    slots,
  }: {
    state: SidebarState
    actions: SidebarActions
    dependencies?: SidebarDependencies
    slots?: SidebarSlots
  },
  ref: ForwardedRef<SidebarHandle>,
) {
  const nav = useRef<HTMLElement>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const workspaceAdd = useRef<HTMLButtonElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const shell = useRef<SidebarShell | undefined>(undefined)
  const stateRef = useRef(state)
  const t: Translate = dependencies?.translate ?? ((key) => key)
  /** 上一次真正渲染的导航区数据签名；未渲染过时为 undefined，首次更新不得短路。 */
  const renderedSignature = useRef<string | undefined>(undefined)
  const renderNavigation = useCallback(
    (next: SidebarState): boolean => {
      const navElement = nav.current
      if (!navElement || !dependencies) return false
      const focused =
        navElement.contains(document.activeElement) && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined
      const active = focused?.dataset.session
      const activeWorkspace = focused?.dataset.workspaceNewSession
      dependencies.renderNavigation({
        nav: navElement,
        sessions: next.sessions,
        workspaces: next.workspaces,
        labels: next.labels,
        ...(next.currentId ? { currentId: next.currentId } : {}),
        ...(active ? { activeId: active } : {}),
        ...(activeWorkspace ? { activeWorkspace } : {}),
        disabled: next.sessionPending,
        newDisabled: next.newDisabled,
        ...(next.next ? { next: next.next } : {}),
        loadMore: actions.loadMore,
        action: actions.sessionAction,
        newSession: actions.newSession,
        open: actions.openSession,
      })
      return true
    },
    [actions, dependencies],
  )
  useImperativeHandle(
    ref,
    () => ({
      update: (next) => {
        stateRef.current = next
        if (newButton.current) newButton.current.disabled = next.newDisabled
        const signature = navigationSignature(next)
        if (signature === renderedSignature.current) return
        // 依赖未就绪时 renderNavigation 不渲染，此时不能记签名，否则这次更新会永久丢失。
        if (renderNavigation(next)) renderedSignature.current = signature
      },
      close: () => shell.current?.close(),
      dismiss: () => shell.current?.dismiss(),
      focusNew: () => newButton.current?.focus(),
    }),
    [renderNavigation],
  )
  // 依赖变化（actions / dependencies 换引用）必须强制重绘，因此这条路径不走签名闸门；
  // 但渲染成功后要记下签名，避免紧随其后的同数据 update 再白画一次。
  useLayoutEffect(() => {
    if (renderNavigation(stateRef.current)) {
      renderedSignature.current = navigationSignature(stateRef.current)
    }
  }, [renderNavigation])
  useLayoutEffect(() => {
    const newElement = newButton.current
    const workspaceElement = workspaceAdd.current
    const settingsElement = settingsButton.current
    if (!newElement || !workspaceElement || !settingsElement) return
    newElement.onclick = () => actions.newSession()
    workspaceElement.onclick = actions.addWorkspace
    settingsElement.onclick = actions.openSettings
    return () => {
      newElement.onclick = null
      workspaceElement.onclick = null
      settingsElement.onclick = null
    }
  }, [actions])
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
    // 断点必须与 style.css 的移动抽屉媒体查询一致（`.sidebar-backdrop` 所在的那个
    // `@media (max-width: …)`）。两者不一致时，中间那段宽度里 JS 走桌面折叠分支、
    // CSS 却已把侧栏移出视口，按钮点了没有任何反应。回归由 sidebar-breakpoint.test.ts 兜住。
    const controller = dependencies.bindSidebar(window.matchMedia('(max-width: 900px)'))
    shell.current = controller
    return () => {
      controller.dispose()
      shell.current = undefined
    }
  }, [dependencies])
  return createElement(
    'div',
    {
      style: { display: 'contents' },
      'data-agnes-region-owner': 'builtin',
      'data-agnes-region-unit': 'sidebar',
    },
    createElement(
      'div',
      { className: 'sidebar-head' },
      createElement(
        'div',
        { className: 'brand-lockup' },
        createElement('span', { className: 'agnes-mark brand-mark-image', 'aria-hidden': true }),
        createElement('span', { className: 'brand-wordmark-text' }, 'Agnes Harness'),
        slots?.brandMark,
        slots?.brandName,
      ),
      createElement(
        'button',
        {
          id: 'sidebar-close',
          className: 'agh-btn agh-btn--ghost agh-btn--md sidebar-close',
          type: 'button',
          'aria-label': t('sidebar.closeNav'),
          title: t('sidebar.closeNav'),
        },
        createElement(Icon, { name: 'panel-left', size: 20 }),
      ),
    ),
    createElement(
      'div',
      { className: 'sidebar-actions' },
      createElement(
        'button',
        {
          id: 'new',
          ref: newButton,
          className: 'agh-btn agh-btn--primary agh-btn--md',
          type: 'button',
          disabled: state.newDisabled,
        },
        createElement(Icon, { name: 'plus' }),
        createElement('span', null, t('sidebar.newSession')),
      ),
    ),
    createElement(
      'div',
      { className: 'sidebar-section-heading' },
      createElement('p', { className: 'section-label' }, t('sidebar.sectionHeading')),
      createElement(
        'button',
        {
          id: 'workspace-add',
          ref: workspaceAdd,
          className: 'agh-btn agh-btn--ghost agh-btn--md',
          type: 'button',
          'aria-label': t('sidebar.addWorkspace'),
          title: t('sidebar.addWorkspace'),
        },
        createElement(Icon, { name: 'plus' }),
      ),
      slots?.workspaces,
    ),
    createElement('nav', { id: 'sessions', 'aria-label': t('sidebar.sessionsNav'), ref: nav }),
    slots?.panellist,
    createElement(
      'div',
      { className: 'sidebar-footer' },
      slots?.footerAction,
      createElement(
        'button',
        {
          id: 'settings',
          ref: settingsButton,
          className: 'agh-btn agh-btn--ghost agh-btn--md',
          type: 'button',
        },
        createElement(Icon, { name: 'settings' }),
        createElement('span', null, t('sidebar.settings')),
      ),
      slots?.settings,
    ),
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
  return createElement(SidebarBuiltin, {
    ref,
    state: props.state,
    actions: { ...EMPTY_ACTIONS, ...props.actions },
    ...(props.dependencies ? { dependencies: props.dependencies } : {}),
    ...(props.slots ? { slots: props.slots } : {}),
  })
})
