import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
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
export type SessionAction = 'rename' | 'fork' | 'archive'

export interface SidebarNavigationOptions {
  nav: HTMLElement
  sessions: PageSessionMeta['items']
  workspaces: readonly WorkspaceEntry[]
  currentId?: string
  activeId?: string
  labels: ReadonlyMap<string, string>
  disabled?: boolean
  next?: string
  loadMore?(cursor: string): void
  action?(action: SessionAction, id: string, title: string, trigger: HTMLElement): void
  open(id: string): void
}

export interface SidebarShell {
  close(): void
  dismiss(): void
  dispose(): void
}

export interface SidebarDependencies {
  renderNavigation(options: SidebarNavigationOptions): void
  bindSidebar(narrow: MediaQueryList): SidebarShell
}

export interface SidebarState {
  sessions: PageSessionMeta['items']
  workspaces: readonly WorkspaceEntry[]
  labels: ReadonlyMap<string, string>
  currentId?: string
  next?: string
  sessionPending: boolean
  newDisabled: boolean
}

export interface SidebarActions {
  newSession(): void
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
    state.currentId ?? null,
    state.next ?? null,
    state.sessionPending,
    state.newDisabled,
  ])
}

const CLOSE_ICON = [
  'M16.4516 4.58065C16.4516 4.45594 16.3361 4.35484 16.1935 4.35484H3.80645C3.66393 4.35484 3.54839 4.45594 3.54839 4.58065V15.4194C3.54839 15.5441 3.66393 15.6452 3.80645 15.6452H16.1935C16.3361 15.6452 16.4516 15.5441 16.4516 15.4194V4.58065ZM18 15.4194C18 16.2923 17.1912 17 16.1935 17H3.80645C2.80878 17 2 16.2923 2 15.4194V4.58065C2 3.70768 2.80878 3 3.80645 3H16.1935C17.1912 3 18 3.70768 18 4.58065V15.4194Z',
  'M8.45161 16.3226H6.90322L6.90323 3.67742H8.45161L8.45161 16.3226Z',
]
const NEW_ICON = [
  'M12.3028 8.66267C12.3541 8.66267 12.4032 8.68528 12.4394 8.72554C12.4757 8.7658 12.496 8.8204 12.496 8.87733V11.1892H14.5766C14.6222 11.1894 14.6663 11.2075 14.701 11.2403C14.7358 11.2731 14.759 11.3184 14.7665 11.3684L14.769 11.4039V12.2597C14.7688 12.3163 14.7484 12.3706 14.7124 12.4106C14.6764 12.4506 14.6276 12.4732 14.5766 12.4735H12.4952V14.7863C12.495 14.8368 12.4789 14.8856 12.4495 14.9242C12.4202 14.9628 12.3795 14.9886 12.3347 14.9972L12.3028 15H11.5325C11.4813 15 11.4322 14.9774 11.3959 14.9371C11.3597 14.8969 11.3394 14.8423 11.3394 14.7853V12.4735H9.25871C9.21313 12.4733 9.16907 12.4552 9.13433 12.4224C9.09959 12.3896 9.07641 12.3442 9.06888 12.2943L9.06552 12.2597V11.4039C9.06552 11.3469 9.08587 11.2923 9.1221 11.2521C9.15833 11.2118 9.20748 11.1892 9.25871 11.1892H11.3394V8.87733C11.3394 8.82639 11.3557 8.7771 11.3854 8.73829C11.4151 8.69947 11.4562 8.67366 11.5015 8.66547L11.5325 8.66267H12.3028ZM7.99958 1C11.851 1 14.9988 4.06674 15 7.89055C15 7.89171 14.9991 7.89267 14.9979 7.89267C14.9967 7.89267 14.9958 7.89361 14.9958 7.89477V8.02147C14.9958 8.09251 14.9704 8.16064 14.9252 8.21088C14.88 8.26111 14.8187 8.28933 14.7547 8.28933L14.0743 8.28467C14.0108 8.28417 13.9501 8.25586 13.9053 8.20588C13.8604 8.1559 13.8352 8.08829 13.8349 8.01773V7.85673C13.8349 7.85441 13.8368 7.85253 13.8391 7.85253C13.8415 7.85253 13.8433 7.85065 13.8433 7.84833V7.77973C13.7803 4.74267 11.2024 2.26747 7.99958 2.26747C4.75809 2.26747 2.15582 4.80427 2.15582 7.89267C2.15582 8.994 2.48509 10.0459 3.09408 10.9493L3.17892 11.0725C3.48551 11.5019 3.44771 11.794 3.13692 12.6536L2.96976 13.1109L2.91096 13.2827L3.06888 13.2593C3.21504 13.236 3.40487 13.2033 3.63167 13.1567L4.03906 13.0717C4.90256 12.8907 5.20496 12.8617 5.54179 12.998L5.57959 13.0148C6.34481 13.348 7.1596 13.5188 7.98194 13.5188L8.13398 13.516C8.26753 13.516 8.37505 13.6355 8.37505 13.7839V14.5193C8.37505 14.5904 8.34965 14.6585 8.30444 14.7087C8.25923 14.759 8.19791 14.7872 8.13398 14.7872H7.9811L7.80134 14.7825C6.89359 14.76 5.9965 14.5601 5.1512 14.1917C5.10164 14.1693 4.86476 14.1955 4.38681 14.2907L3.67871 14.4381C2.73624 14.6285 2.38429 14.6267 2.01722 14.3215C1.68711 14.0452 1.63923 13.6541 1.73163 13.2033L1.75346 13.1025C1.79378 12.9345 1.84838 12.7712 1.95674 12.4772L2.08778 12.1151C2.12308 12.0193 2.15365 11.9215 2.17934 11.822L2.18774 11.7893C2.19362 11.7613 2.19614 11.7539 2.20958 11.7707L2.26333 11.8453L2.0987 11.6036C1.38639 10.5069 1 9.22827 1 7.89267C1 4.06787 4.14826 1 7.99958 1Z',
]
const ADD_ICON = [
  'M6 1.16797C6.26487 1.16807 6.48024 1.38262 6.48047 1.64746V5.64062H10.4736C10.7383 5.64111 10.9531 5.8563 10.9531 6.12109C10.953 6.38576 10.7382 6.60108 10.4736 6.60156H6.48047V10.5938C6.48046 10.8588 6.265 11.0741 6 11.0742C5.73491 11.0742 5.51954 10.8588 5.51953 10.5938V6.60156H1.52734C1.26235 6.60156 1.04704 6.38605 1.04688 6.12109C1.04688 5.856 1.26225 5.64062 1.52734 5.64062H5.51953V1.64746C5.51976 1.38256 5.73504 1.16797 6 1.16797Z',
]
const SETTINGS_ICON = [
  'M7.25098 2.19971H8.75879C8.8493 2.19971 8.93968 2.25922 8.97363 2.36182V2.36377L9.39844 3.63721L9.39941 3.64014C9.47672 3.86852 9.63853 4.0561 9.85254 4.16553C10.0864 4.28501 10.3441 4.28724 10.5645 4.20947V4.21045L10.5693 4.2085L11.8057 3.75928C11.8691 3.73619 11.9415 3.74412 12.001 3.78467L12.0557 3.83545L12.9902 5.0415V5.04053C13.057 5.127 13.0622 5.24839 13.0049 5.33936L12.3018 6.45557C12.1678 6.66517 12.127 6.91401 12.1797 7.1499C12.2322 7.38516 12.3738 7.59233 12.583 7.7251L13.6865 8.42529C13.7695 8.47777 13.8177 8.58636 13.793 8.69482V8.69678L13.4541 10.1978C13.4422 10.2502 13.4143 10.2959 13.3779 10.3286C13.3417 10.3611 13.2982 10.3797 13.2539 10.3843H13.2529L11.957 10.519H11.9561C11.7135 10.5447 11.4901 10.6666 11.3369 10.8638C11.2079 11.0285 11.1368 11.2337 11.1406 11.4468L11.1475 11.5386L11.3008 12.855C11.3139 12.9682 11.2535 13.0694 11.167 13.1118L9.80762 13.7778H9.80664C9.7756 13.7931 9.74459 13.8002 9.71289 13.8003C9.6568 13.8003 9.59828 13.7774 9.55273 13.73L8.6416 12.7798C8.47198 12.6029 8.23877 12.4995 7.9873 12.4995C7.74164 12.4996 7.50653 12.5995 7.33594 12.7769L6.4248 13.7222C6.35395 13.7951 6.25379 13.8091 6.17285 13.769L6.1709 13.7681L4.81445 13.0981H4.81543C4.72745 13.0543 4.66835 12.9526 4.68164 12.8413L4.83984 11.519V11.5181C4.86443 11.3099 4.81854 11.0981 4.70508 10.9185L4.65137 10.8433C4.49826 10.6463 4.27557 10.5242 4.0332 10.4985H4.03418L2.74316 10.3599C2.65171 10.35 2.56747 10.2803 2.54395 10.1733L2.54297 10.1704L2.20605 8.66748C2.18203 8.55837 2.22971 8.45059 2.31348 8.39697L3.42383 7.69873L3.4248 7.69775C3.63321 7.56572 3.77503 7.3592 3.82812 7.12549L3.8291 7.12354C3.88165 6.8881 3.84057 6.64225 3.71289 6.43604L3.71191 6.43408L3.0127 5.31494L3.01172 5.31396C2.95435 5.22192 2.96131 5.10054 3.02637 5.01709L3.9668 3.81396H3.96777C4.03098 3.73316 4.13022 3.70741 4.21582 3.73877L4.2168 3.73975L5.44336 4.18994V4.18896C5.67325 4.27374 5.92778 4.26269 6.15234 4.15088L6.15332 4.15186C6.15476 4.15115 6.15579 4.14964 6.15723 4.14893C6.15839 4.14834 6.15997 4.14854 6.16113 4.14795L6.16016 4.14697C6.37759 4.03755 6.5399 3.84796 6.61621 3.62256L6.61719 3.61963L7.03613 2.36377C7.07173 2.25797 7.16219 2.19975 7.25098 2.19971Z',
  'M8 6.19971C8.92947 6.19991 9.69745 6.90947 9.79004 7.81592L9.7998 8.00049C9.79801 8.99391 8.99055 9.80008 8 9.80029C7.00837 9.80029 6.19943 8.99315 6.19922 8.00049C6.19922 7.00873 7.00716 6.19971 8 6.19971Z',
]

function icon(paths: readonly string[], viewBox: string, className: string) {
  return createElement(
    'svg',
    { className, viewBox, 'data-agnes-region': 'icon', 'aria-hidden': true },
    ...paths.map((path) => createElement('path', { key: path, d: path })),
  )
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
  /** 上一次真正渲染的导航区数据签名；未渲染过时为 undefined，首次更新不得短路。 */
  const renderedSignature = useRef<string | undefined>(undefined)
  const renderNavigation = useCallback(
    (next: SidebarState): boolean => {
      const navElement = nav.current
      if (!navElement || !dependencies) return false
      const active =
        navElement.contains(document.activeElement) && document.activeElement instanceof HTMLElement
          ? document.activeElement.dataset.session
          : undefined
      dependencies.renderNavigation({
        nav: navElement,
        sessions: next.sessions,
        workspaces: next.workspaces,
        labels: next.labels,
        ...(next.currentId ? { currentId: next.currentId } : {}),
        ...(active ? { activeId: active } : {}),
        disabled: next.sessionPending,
        ...(next.next ? { next: next.next } : {}),
        loadMore: actions.loadMore,
        action: actions.sessionAction,
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
    const controller = dependencies.bindSidebar(window.matchMedia('(max-width: 720px)'))
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
          className: 'icon-button sidebar-close',
          type: 'button',
          'aria-label': '关闭导航',
        },
        icon(CLOSE_ICON, '0 0 20 20', 'icon icon-fill'),
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
          className: 'primary-button',
          type: 'button',
          disabled: state.newDisabled,
        },
        icon(NEW_ICON, '0 0 16 16', 'icon icon-fill'),
        createElement('span', null, '新会话'),
      ),
    ),
    createElement(
      'div',
      { className: 'sidebar-section-heading' },
      createElement('p', { className: 'section-label' }, '工作区与会话'),
      createElement(
        'button',
        {
          id: 'workspace-add',
          ref: workspaceAdd,
          className: 'icon-button subtle',
          type: 'button',
          'aria-label': '添加工作区',
          title: '添加工作区',
        },
        icon(ADD_ICON, '0 0 12 12', 'icon icon-fill'),
      ),
      slots?.workspaces,
    ),
    createElement('nav', { id: 'sessions', 'aria-label': '任务列表', ref: nav }),
    slots?.panellist,
    createElement(
      'div',
      { className: 'sidebar-footer' },
      slots?.footerAction,
      createElement(
        'button',
        { id: 'settings', ref: settingsButton, className: 'secondary-button', type: 'button' },
        icon(SETTINGS_ICON, '0 0 16 16', 'icon icon-settings'),
        createElement('span', null, '设置'),
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
