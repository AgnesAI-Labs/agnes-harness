/**
 * 客户端模块子系统启动（WC8）：浏览器里新建一棵 Cordis Context 树，挂五个宿主服务，
 * 在具名挂载点开 React root。宿主现有命令式 DOM 不重写（N6）——服务只是包装宿主既有状态。
 *
 * 第一段前端轨没有真实名册源（P1a），reconciler 处于 idle：不加载任何模块（fail-closed）。
 */
import { Context } from '@agnes/cordis'
import {
  type AgnesClient,
  AgnesClientService,
  type ClientEffectCaller,
  ClientResourceService,
  type ClientServiceCaller,
  type CommandAuthorizer,
  CommandService,
  type HostAgnesClient,
  LocaleService,
  SessionService,
  type SlotEntry,
  SlotOutlet,
  SlotRegistry,
  SlotsProvider,
  ThemeService,
} from '@agnes/web-client'
import { BuiltinWebUnitRegistry } from '@agnes/web-units'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ApprovalRegionMount,
  ComposerRegionMount,
  ConversationChildContainers,
  ConversationRegionMount,
  DshShellRegionMount,
  RightbarRegionMount,
  SettingsRegionMount,
  TopbarRegionMount,
  TraceRegionMount,
  TranscriptRegionMount,
} from '../region-slots.js'
import {
  CONVERSATION_CHILD_SLOTS,
  mountApprovalRegion,
  mountComposerRegion,
  mountConversationRegion,
  mountDshShellRegion,
  mountEmptyStateRegion,
  mountRightbarRegion,
  mountSettingsPaneRegion,
  mountSidebarRegion,
  mountTopbarRegion,
  mountTraceRegion,
  mountTranscriptRegion,
} from '../region-slots.js'
import type { SidebarActions, SidebarState } from '../sidebar.js'
import { readThemePreference, resolveTheme, safeThemeStorage, THEME_STORAGE_KEY } from '../theme.js'
import { type ClientReconciler, createReconciler, type RosterSource } from './reconcile.js'

export interface ClientModulesRuntime {
  ctx: Context
  registry: SlotRegistry
  session: SessionService
  theme: ThemeService
  locale: LocaleService
  resources: ClientResourceService
  commands: CommandService
  reconciler: ClientReconciler
  /** Active built-in `web:` rows; each row owns one independent disposer. */
  builtinUnits: BuiltinWebUnitRegistry
  /** Runtime truth, not a manifest claim: slots actually registered by this package. */
  actualSlots(packageId: string): readonly string[]
  sidebar?: {
    update(state: SidebarState): void
    close(): void
    dismiss(): void
    focusNew(): void
    dispose(): void
  }
  conversation?: ConversationRegionMount
  approval?: ApprovalRegionMount
  composer?: ComposerRegionMount
  topbar?: TopbarRegionMount
  transcript?: TranscriptRegionMount
  trace?: TraceRegionMount
  rightbar?: RightbarRegionMount
  settings?: SettingsRegionMount
  /** 挂载点容器卸载（页面卸载时浏览器回收；提供显式路径便于测试）。 */
  dispose(): Promise<void>
}

/** 认领解析器：fill.extId 是否命中某注册项归属包（WC9 按包认领）。真源 = 名册 extIds（P1a）。 */
export type ClaimResolver = (entry: SlotEntry, extId: string) => boolean

export async function startClientModules(options: {
  /** Raw, host-owned SDK client. `clientModule()` exposes a narrower facade to each module. */
  agnes: HostAgnesClient
  /** Same-origin BFF only; absent keeps browser service calls fail-closed. */
  clientServiceCaller?: ClientServiceCaller | undefined
  /** Separate authorized effect relay; absent keeps effect commands fail-closed. */
  clientEffectCaller?: ClientEffectCaller | undefined
  /** 名册源；缺省 = idle（fail-closed，不加载任何模块）。 */
  rosterSource?: RosterSource | undefined
  /** 宿主容器：workbench.panel 挂载点的父节点（B4：具体位置随布局定，这里由调用方给）。 */
  panelContainer?: HTMLElement | undefined
  /** 迁移中的宿主区域；容器本身仍由 app.ts 管理 hidden/ARIA。 */
  emptyStateContainer?: HTMLElement | undefined
  /** 迁移中的侧栏地标；外壳仍由静态 layout/CSS 所有。 */
  sidebarContainer?: HTMLElement | undefined
  sidebar?: { state?: SidebarState; actions?: Partial<SidebarActions> } | undefined
  transcriptContainer?: HTMLElement | undefined
  transcript?: {
    newContentButton?: HTMLButtonElement
    onFork?: (turn: import('@agnes/protocol').UITurn) => Promise<void>
  }
  conversationContainer?: HTMLElement | undefined
  topbarContainer?: HTMLElement | undefined
  approvalContainer?: HTMLElement | undefined
  composerContainer?: HTMLElement | undefined
  composer?: import('../composer.js').ComposerRegionOptions | undefined
  traceContainer?: HTMLElement | undefined
  trace?: import('../region-slots.js').TraceRegionOptions | undefined
  rightbarContainer?: HTMLElement | undefined
  settingsPaneContainer?: HTMLElement | undefined
  settings?: import('../region-slots.js').SettingsRegionOptions | undefined
  /** Host permission bridge for plugin-contributed browser commands. Defaults to deny. */
  authorizeCommand?: CommandAuthorizer | undefined
  /** 时间线 slot 节点的认领解析器；缺省一律未认领（无名册时显示占位）。 */
  claim?: ClaimResolver | undefined
}): Promise<ClientModulesRuntime> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const builtinUnits = new BuiltinWebUnitRegistry()

  const pref = readThemePreference(safeThemeStorage())
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
  new AgnesClientService(ctx, options.agnes, options.clientServiceCaller, options.clientEffectCaller)
  const theme = new ThemeService(ctx, resolveTheme(pref, prefersDark.matches))
  const session = new SessionService(ctx, undefined, options.agnes)
  const resources = new ClientResourceService(ctx, options.agnes, session)
  const locale = new LocaleService(ctx, document.documentElement.lang || 'zh-CN')
  const commands = new CommandService(ctx, options.authorizeCommand)

  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  const dshShell: DshShellRegionMount = mountDshShellRegion(registry)

  // 主题：监听既有外观系统的三个变化入口（不改宿主内部：storage/system + 显式事件）。
  prefersDark.addEventListener('change', () => {
    theme.setTheme(resolveTheme(readThemePreference(safeThemeStorage()), prefersDark.matches))
  })
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      theme.setTheme(resolveTheme(readThemePreference(safeThemeStorage()), prefersDark.matches))
    }
  })
  window.addEventListener('agnes:theme-changed', () => {
    theme.setTheme(resolveTheme(readThemePreference(safeThemeStorage()), prefersDark.matches))
  })

  // workbench.panel 挂载点：宿主划定的容器 + React root（WC8）。
  const panelRoots: Root[] = []
  const panelContainer = options.panelContainer
  if (panelContainer) {
    const host = document.createElement('div')
    host.setAttribute('data-agnes-slot-mount', 'workbench.panel')
    panelContainer.appendChild(host)
    const root = createRoot(host)
    panelRoots.push(root)
    root.render(
      createElement(
        SlotsProvider,
        { registry, session, locale, resources },
        createElement(SlotOutlet, { name: 'workbench.panel', hideWhenEmpty: true }),
      ),
    )
  }

  // Parent first: the conversation component owns child mount skeletons, then child regions claim
  // those containers only while the built-in parent is mounted.
  const transcriptDelegate = { current: null as TranscriptRegionMount | null }
  let conversationChildrenGeneration = 0
  const unmountConversationChildUnits = (): void => {
    for (const packageId of [
      '@agnes/web-conversation-message-actions',
      '@agnes/web-conversation-attachments',
      '@agnes/web-conversation-tool-card',
      '@agnes/web-conversation-feedback',
    ])
      builtinUnits.unmount(packageId)
  }
  const mountConversationChildren = (children: ConversationChildContainers): void => {
    const generation = ++conversationChildrenGeneration
    queueMicrotask(() => {
      if (generation !== conversationChildrenGeneration) return
      unmountConversationChildUnits()
      builtinUnits.unmount('@agnes/web-transcript')
      builtinUnits.unmount('@agnes/web-empty-state')
      transcriptDelegate.current = null
      const emptyState = mountEmptyStateRegion(registry, children.emptyState, { session, locale })
      const transcript = mountTranscriptRegion(registry, children.transcript, {
        ...options.transcript,
        newContentButton: children.newContentButton,
        session,
        resources,
      })
      builtinUnits.mount('@agnes/web-empty-state', () => emptyState.dispose())
      builtinUnits.mount('@agnes/web-transcript', () => transcript.dispose())
      const childUnits = [
        [
          '@agnes/web-conversation-message-actions',
          CONVERSATION_CHILD_SLOTS.messageActions,
          children.messageActions,
        ],
        ['@agnes/web-conversation-attachments', CONVERSATION_CHILD_SLOTS.attachments, children.attachments],
        ['@agnes/web-conversation-tool-card', CONVERSATION_CHILD_SLOTS.toolCard, children.toolCard],
        ['@agnes/web-conversation-feedback', CONVERSATION_CHILD_SLOTS.feedback, children.feedback],
      ] as const
      for (const [packageId, slot, container] of childUnits) {
        const root = createRoot(container)
        root.render(
          createElement(
            SlotsProvider,
            { registry, session, locale, resources },
            createElement(SlotOutlet, { name: slot as never, hideWhenEmpty: true }),
          ),
        )
        builtinUnits.mount(packageId, () => root.unmount())
      }
      transcriptDelegate.current = transcript
    })
  }
  const unmountConversationChildren = (): void => {
    conversationChildrenGeneration++
    transcriptDelegate.current = null
    queueMicrotask(() => {
      builtinUnits.unmount('@agnes/web-transcript')
      builtinUnits.unmount('@agnes/web-empty-state')
      unmountConversationChildUnits()
    })
  }
  const conversation = options.conversationContainer
    ? mountConversationRegion(registry, options.conversationContainer, {
        session,
        onMount: mountConversationChildren,
        onUnmount: unmountConversationChildren,
      })
    : undefined
  if (conversation) builtinUnits.mount('@agnes/web-conversation', () => conversation.dispose())
  const topbar = options.topbarContainer ? mountTopbarRegion(registry, options.topbarContainer) : undefined
  if (topbar) builtinUnits.mount('@agnes/web-topbar', () => topbar.dispose())
  const approval = options.approvalContainer
    ? mountApprovalRegion(registry, options.approvalContainer)
    : undefined
  if (approval) builtinUnits.mount('@agnes/web-approval', () => approval.dispose())
  const composer = options.composerContainer
    ? mountComposerRegion(
        registry,
        options.composerContainer,
        options.composer ?? {
          onCancel: () => undefined,
          onDraftChange: () => undefined,
          onError: () => undefined,
          onModelSelect: async () => false,
          onPermissionSelect: async () => false,
          onSubmit: () => undefined,
          onWorkspace: () => undefined,
        },
      )
    : undefined
  if (composer) builtinUnits.mount('@agnes/web-composer', () => composer.dispose())
  const trace =
    options.traceContainer && options.trace
      ? mountTraceRegion(registry, options.traceContainer, options.trace)
      : undefined
  if (trace) builtinUnits.mount('@agnes/web-trace', () => trace.dispose())
  const rightbar = options.rightbarContainer
    ? mountRightbarRegion(registry, options.rightbarContainer, { session, resources })
    : undefined
  if (rightbar) builtinUnits.mount('@agnes/web-rightbar', () => rightbar.dispose())
  const settingsPane = options.settingsPaneContainer
    ? mountSettingsPaneRegion(registry, options.settingsPaneContainer, options.settings)
    : undefined
  if (settingsPane) {
    const settingsUnits = [
      ['model', '@agnes/web-settings-model'],
      ['plugin', '@agnes/web-settings-plugins'],
      ['resources', '@agnes/web-settings-resources'],
      ['archived', '@agnes/web-settings-archived'],
      ['computer-use', '@agnes/web-settings-computer-use'],
      ['appearance', '@agnes/web-settings-appearance'],
    ] as const
    for (const [pane, packageId] of settingsUnits)
      builtinUnits.mount(packageId, () => settingsPane.unmountPane(pane))
  }
  const emptyState =
    !conversation && options.emptyStateContainer
      ? mountEmptyStateRegion(registry, options.emptyStateContainer, { session, locale })
      : undefined
  if (emptyState) builtinUnits.mount('@agnes/web-empty-state', () => emptyState.dispose())
  // The sidebar keeps its existing document-level navigation binding; let the component-owned
  // topbar commit its toggle button before that root discovers the shared control.
  if (topbar) await topbar.ready

  const sidebar = options.sidebarContainer
    ? mountSidebarRegion(registry, options.sidebarContainer, options.sidebar)
    : undefined
  if (sidebar) builtinUnits.mount('@agnes/web-sidebar', () => sidebar.dispose())
  const transcript =
    !conversation && options.transcriptContainer
      ? mountTranscriptRegion(registry, options.transcriptContainer, {
          ...options.transcript,
          session,
          resources,
        })
      : undefined
  if (transcript) builtinUnits.mount('@agnes/web-transcript', () => transcript.dispose())
  const transcriptRuntime = conversation
    ? ({
        render(nodes, turns, meta) {
          transcriptDelegate.current?.render(nodes, turns, meta)
        },
        reset() {
          transcriptDelegate.current?.reset()
        },
        pinToBottom() {
          transcriptDelegate.current?.pinToBottom()
        },
        dispose() {
          transcriptDelegate.current?.dispose()
          transcriptDelegate.current = null
        },
      } satisfies TranscriptRegionMount)
    : transcript

  const reconciler = createReconciler({
    ctx,
    source: options.rosterSource ?? { list: async () => ({ revision: '', modules: [], statuses: [] }) },
    removeOwner: (packageId) => registry.removeOwner(packageId),
  })

  return {
    ctx,
    registry,
    session,
    resources,
    theme,
    locale,
    commands,
    reconciler,
    builtinUnits,
    actualSlots(packageId) {
      return [...new Set(registry.entriesByOwner(packageId).map((entry) => entry.name))]
    },
    ...(sidebar ? { sidebar } : {}),
    ...(conversation ? { conversation } : {}),
    ...(approval ? { approval } : {}),
    ...(composer ? { composer } : {}),
    ...(topbar ? { topbar } : {}),
    ...(transcriptRuntime ? { transcript: transcriptRuntime } : {}),
    ...(trace ? { trace } : {}),
    ...(rightbar ? { rightbar } : {}),
    ...(settingsPane ? { settings: settingsPane } : {}),
    dispose: async () => {
      for (const root of panelRoots) root.unmount()
      builtinUnits.dispose()
      dshShell.dispose()
      // The built-in unit registry owns individual pane rows. The shell root has no row of its
      // own and therefore must still be released after all pane roots have been withdrawn.
      settingsPane?.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** 默认认领：无名册 = 一律未认领（占位）。 */
export const unclaimed: ClaimResolver = () => false
export type { AgnesClient }
export { createReconciler }
