/**
 * Start client modules: create a browser Cordis Context tree, attach five host services and register
 * in-app portals at named mount points. Services and controllers retain their existing state ownership.
 *
 * Without a real roster source, the reconciler stays idle and loads no modules (fail-closed).
 */
import { Context } from '@agnes/cordis'
import {
  type AgnesClient,
  AgnesClientService,
  type ClientEffectCaller,
  type ClientProfileCaller,
  ClientResourceService,
  type ClientServiceCaller,
  type CommandAuthorizer,
  CommandService,
  type HostAgnesClient,
  homeNavigation,
  LocaleService,
  type PresentationHost,
  PresentationService,
  SessionService,
  type SlotEntry,
  SlotOutlet,
  SlotRegistry,
  SlotsProvider,
  ThemeService,
} from '@agnes/web-client'
import { WEB_LOCALE_NAMESPACE, webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import {
  applyDocumentLocale,
  isUiLocale,
  LOCALE_STORAGE_KEY,
  readLocalePreference,
  type UiLocale,
} from '@agnes/web-foundation/locale-preference'
import { COMPUTER_USE_LOCALE_NAMESPACE, computerUseCatalog } from '@agnes/web-foundation/locales/computer-use'
import {
  SERVER_ERROR_LOCALE_NAMESPACE,
  serverErrorCatalog,
} from '@agnes/web-foundation/locales/server-errors'
import {
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
  THEME_STORAGE_KEY,
} from '@agnes/web-foundation/theme'
import type { AntdRoot } from '@agnes/web-ui'
import {
  createRegionHost,
  createRegionRenderer,
  WEB_UI_LOCALE_NAMESPACE,
  webUiLocaleCatalog,
} from '@agnes/web-ui'
import { diagnosticsCatalog } from '@agnes/web-units/diagnostics-locale'
import {
  BuiltinWebUnitRegistry,
  type SessionListMark,
  WEB_UNITS_LOCALE_NAMESPACE,
  webUnitsLocaleCatalog,
} from '@agnes/web-units/shell'
import { traceCatalog } from '@agnes/web-units/trace-locale'
import { LoopPicker } from '../loop-picker.js'
import { businessAgentSuggestions } from '../pages/business-agents.js'
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
  mountDshShellRegion,
  mountEmptyStateRegion,
  mountRightbarRegion,
  mountSettingsPaneRegion,
  mountTopbarRegion,
  mountTraceRegion,
  mountTranscriptRegion,
} from '../region-slots.js'
import { ProfileApprovals, ProfileAttentionEntry } from '../regions/profile-approvals.js'
import { profileAttentionCaller } from '../regions/profile-attention-caller.js'
import { createProfileAttention } from '../regions/profile-attention-state.js'
import { sessionInventory } from '../session-inventory.js'
import type { SidebarActions, SidebarState } from '../sidebar.js'
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
    setRunning(ids: readonly string[]): void
    setMarks(marks: Readonly<Record<string, SessionListMark>>): void
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
  /** Unmount mount-point containers (the browser handles page unload; the explicit path supports tests). */
  dispose(): Promise<void>
}
/** Resolve claims by matching fill.extId against roster extIds of the package owning a registration. */
export type ClaimResolver = (entry: SlotEntry, extId: string) => boolean
export async function startClientModules(options: {
  /** Raw, host-owned SDK client. `clientModule()` exposes a narrower facade to each module. */
  agnes: HostAgnesClient
  presentation?: PresentationHost
  /** Same-origin BFF only; absent keeps browser service calls fail-closed. */
  clientProfileCaller?: ClientProfileCaller | undefined
  clientServiceCaller?: ClientServiceCaller | undefined
  /** Separate authorized effect relay; absent keeps effect commands fail-closed. */
  clientEffectCaller?: ClientEffectCaller | undefined
  /** Roster source; omission leaves reconciliation idle, loading no modules (fail-closed). */
  rosterSource?: RosterSource | undefined
  /** Host container: parent of the workbench.panel mount point; the caller supplies its layout-dependent location. */
  panelContainer?: HTMLElement | undefined
  /** Host region being migrated; app.ts still manages hidden/ARIA on the container itself. */
  emptyStateContainer?: HTMLElement | undefined
  /** Sidebar landmark being migrated; static layout/CSS still owns the shell. */
  sidebarContainer?: HTMLElement | undefined
  sidebar?:
    | {
        state?: SidebarState
        actions?: Partial<SidebarActions>
      }
    | undefined
  transcriptContainer?: HTMLElement | undefined
  transcript?: {
    newContentButton?: HTMLButtonElement
    onFork?: (turn: import('@agnes/protocol').UITurn) => Promise<void>
    turnErrorActions?: import('@agnes/web-ui/conversation').TurnErrorActions
  }
  conversationContainer?: HTMLElement | undefined
  topbarContainer?: HTMLElement | undefined
  approvalContainer?: HTMLElement | undefined
  composerContainer?: HTMLElement | undefined
  composer?: import('@agnes/web-conversation/composer').ComposerRegionOptions | undefined
  traceContainer?: HTMLElement | undefined
  trace?: import('../region-slots.js').TraceRegionOptions | undefined
  rightbarContainer?: HTMLElement | undefined
  settingsPaneContainer?: HTMLElement | undefined
  settings?: import('../region-slots.js').SettingsRegionOptions | undefined
  /** Host permission bridge for plugin-contributed browser commands. Defaults to deny. */
  authorizeCommand?: CommandAuthorizer | undefined
  /** Claim resolver for timeline slot nodes; defaults to unclaimed, showing placeholders without a roster. */
  claim?: ClaimResolver | undefined
}): Promise<ClientModulesRuntime> {
  const ctx = new Context()
  const presentation: PresentationHost = { ...options.presentation }
  new PresentationService(ctx, presentation)
  await ctx.plugin(SlotRegistry)
  const builtinUnits = new BuiltinWebUnitRegistry()
  const pref = readThemePreference(safeThemeStorage())
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
  const attention = createProfileAttention()
  const theme = new ThemeService(ctx, resolveTheme(pref, prefersDark.matches))
  const session = new SessionService(ctx, undefined, options.agnes)
  new AgnesClientService(
    ctx,
    options.agnes,
    options.clientServiceCaller,
    options.clientEffectCaller,
    options.clientProfileCaller
      ? profileAttentionCaller(options.clientProfileCaller, attention, session)
      : undefined,
  )
  const stopAttentionPage = homeNavigation.subscribe(attention.reconcile)
  const stopAttentionSession = session.readiness.subscribe(attention.reconcile)
  const resources = new ClientResourceService(ctx, options.agnes, session)
  const storedLocale = readLocalePreference(safeThemeStorage())
  applyDocumentLocale(document.documentElement, storedLocale)
  const locale = new LocaleService(ctx, storedLocale)
  locale.register(WEB_LOCALE_NAMESPACE, webLocaleCatalog)
  locale.register(WEB_UNITS_LOCALE_NAMESPACE, webUnitsLocaleCatalog)
  locale.register(WEB_UI_LOCALE_NAMESPACE, webUiLocaleCatalog)
  locale.register(COMPUTER_USE_LOCALE_NAMESPACE, computerUseCatalog)
  locale.register('@agnes/web-diagnostics', diagnosticsCatalog)
  locale.register('@agnes/web-trace', traceCatalog)
  locale.register(SERVER_ERROR_LOCALE_NAMESPACE, serverErrorCatalog)
  const commands = new CommandService(ctx, options.authorizeCommand)
  const registry = (
    ctx as unknown as {
      slots: SlotRegistry
    }
  ).slots
  const dshShell: DshShellRegionMount = mountDshShellRegion(
    registry,
    <ProfileApprovals client={options.agnes} locale={locale} attention={attention} entry={false} />,
  )
  // Seats belong to the host; default occupants arrive through the release roster.
  for (const name of ['ui:sidebar', 'ui:conversation', 'ui:transcript', 'ui:composer'])
    registry.declare(
      name,
      { kind: 'single', scope: name === 'ui:sidebar' ? 'root' : 'session-maybe' },
      'web-shell',
    )
  // Theme and locale listeners belong to this runtime, including same-page restarts.
  ctx.effect(() => {
    const syncTheme = () =>
      theme.setTheme(resolveTheme(readThemePreference(safeThemeStorage()), prefersDark.matches))
    const onThemeStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) syncTheme()
    }
    const applyLocale = (next: UiLocale): void => {
      applyDocumentLocale(document.documentElement, next)
      locale.setLocale(next)
    }
    const onLocaleStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY) applyLocale(readLocalePreference(safeThemeStorage()))
    }
    const onLocaleChanged = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail
      if (isUiLocale(next)) applyLocale(next)
    }
    prefersDark.addEventListener('change', syncTheme)
    window.addEventListener('storage', onThemeStorage)
    window.addEventListener('agnes:theme-changed', syncTheme)
    window.addEventListener('storage', onLocaleStorage)
    window.addEventListener('agnes:locale-changed', onLocaleChanged)
    return () => {
      prefersDark.removeEventListener('change', syncTheme)
      window.removeEventListener('storage', onThemeStorage)
      window.removeEventListener('agnes:theme-changed', syncTheme)
      window.removeEventListener('storage', onLocaleStorage)
      window.removeEventListener('agnes:locale-changed', onLocaleChanged)
    }
  })
  // workbench.panel mount point: host-defined container plus React root.
  const panelRoots: AntdRoot[] = []
  const panelContainer = options.panelContainer
  if (panelContainer) {
    const host = createRegionHost(panelContainer, 'div')
    host.setAttribute('data-agnes-slot-mount', 'workbench.panel')

    const root = createRegionRenderer(host)
    panelRoots.push(root)
    root.render(
      <SlotsProvider registry={registry} session={session} locale={locale} resources={resources}>
        <SlotOutlet name={'workbench.panel'} hideWhenEmpty={true} />
      </SlotsProvider>,
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
      builtinUnits.mount('@agnes/web-empty-state', () => emptyState.dispose())
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
        const root = createRegionRenderer(container)
        root.render(
          <SlotsProvider registry={registry} session={session} locale={locale} resources={resources}>
            <SlotOutlet name={slot as never} hideWhenEmpty={true} />
          </SlotsProvider>,
        )
        builtinUnits.mount(packageId, () => root.unmount())
      }
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
  let conversationView: ConversationRegionMount | undefined
  let emptyVisible = true
  if (options.conversationContainer)
    presentation.conversation = {
      container: options.conversationContainer,
      onMount: mountConversationChildren,
      onUnmount: unmountConversationChildren,
      attach(handle) {
        const attached = { ...handle, dispose() {} }
        conversationView = attached
        handle.setEmptyStateVisible(emptyVisible)
        return () => {
          if (conversationView === attached) conversationView = undefined
        }
      },
      transcript: {
        ...options.transcript,
        ...(options.claim ? { claim: options.claim } : {}),
        attach(handle) {
          const attached = { ...handle, dispose() {} }
          transcriptDelegate.current = attached
          // A region remounted for another selection starts empty: repainting the previous session's
          // whole transcript there only delays the switch, and its own content replaces it anyway.
          if (lastTranscript && lastTranscript.sessionId === session.sessionId)
            handle.render(...lastTranscript.args)
          return () => {
            if (transcriptDelegate.current === attached) transcriptDelegate.current = null
          }
        },
      },
    }
  const conversation: ConversationRegionMount | undefined = options.conversationContainer
    ? {
        setEmptyStateVisible(visible) {
          emptyVisible = visible
          conversationView?.setEmptyStateVisible(visible)
        },
        isTranscriptNearBottom: () => conversationView?.isTranscriptNearBottom() ?? false,
        dispose() {},
      }
    : undefined
  const topbar = options.topbarContainer
    ? mountTopbarRegion(registry, options.topbarContainer, locale)
    : undefined
  if (topbar) builtinUnits.mount('@agnes/web-topbar', () => topbar.dispose())
  const approval = options.approvalContainer
    ? mountApprovalRegion(registry, options.approvalContainer)
    : undefined
  if (approval) builtinUnits.mount('@agnes/web-approval', () => approval.dispose())
  let composerView: ComposerRegionMount | undefined
  let composerState: Parameters<ComposerRegionMount['render']>[0] | undefined
  let composerDraft = options.composer?.initialDraft ?? ''
  let composerImages: ReturnType<ComposerRegionMount['getImageBlocks']> = []
  let composerAttachments: ReturnType<ComposerRegionMount['getAttachmentBlocks']> = []
  let composerSessionId = session.getSnapshot()
  ctx.effect(() =>
    session.subscribe(() => {
      const next = session.getSnapshot()
      if (next === composerSessionId) return
      composerSessionId = next
      composerImages = []
      composerAttachments = []
    }),
  )
  if (options.composerContainer)
    presentation.composer = {
      container: options.composerContainer,
      controls: { LoopPicker, suggestions: businessAgentSuggestions },
      options: options.composer ?? {
        onCancel() {},
        onDraftChange() {},
        onError() {},
        onModelSelect: async () => false,
        onPermissionSelect: async () => false,
        onSubmit() {},
        onWorkspace() {},
      },
      attach(handle) {
        const attached = { ...handle, dispose() {} }
        composerView = attached
        handle.setDraft(composerDraft)
        handle.restoreImageBlocks(composerImages)
        handle.restoreAttachmentBlocks(composerAttachments)
        if (composerState) handle.render(composerState)
        return () => {
          if (composerView !== attached) return
          composerDraft = handle.getDraft()
          composerImages = handle.getImageBlocks()
          composerAttachments = handle.getAttachmentBlocks()
          composerView = undefined
        }
      },
    }
  const composer: ComposerRegionMount | undefined = options.composerContainer
    ? {
        focus: () => composerView?.focus(),
        getDraft: () => composerView?.getDraft() ?? composerDraft,
        getImageBlocks: () => composerView?.getImageBlocks() ?? composerImages,
        getAttachmentBlocks: () => composerView?.getAttachmentBlocks() ?? composerAttachments,
        hasPendingImages: () => composerView?.hasPendingImages() ?? false,
        render(value) {
          composerState = value
          composerView?.render(value)
        },
        setDraft(value) {
          composerDraft = value
          composerView?.setDraft(value)
        },
        clearImageBlocks() {
          composerImages = []
          composerAttachments = []
          composerView?.clearImageBlocks()
        },
        restoreImageBlocks(value) {
          composerImages = value
          composerView?.restoreImageBlocks(value)
        },
        restoreAttachmentBlocks(value) {
          composerAttachments = value
          composerView?.restoreAttachmentBlocks(value)
        },
        mention: (value) => composerView?.mention(value),
        dispose() {},
      }
    : undefined
  const trace =
    options.traceContainer && options.trace
      ? mountTraceRegion(registry, options.traceContainer, options.trace)
      : undefined
  if (trace) builtinUnits.mount('@agnes/web-trace', () => trace.dispose())
  const rightbar = options.rightbarContainer
    ? mountRightbarRegion(registry, options.rightbarContainer, { session, resources }, locale)
    : undefined
  if (rightbar) builtinUnits.mount('@agnes/web-rightbar', () => rightbar.dispose())
  const settingsPane = options.settingsPaneContainer
    ? mountSettingsPaneRegion(registry, options.settingsPaneContainer, options.settings, locale)
    : undefined
  if (settingsPane) {
    const settingsUnits = [
      ['model', '@agnes/web-settings-model'],
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
  let sidebarView: import('../regions/sidebar.js').SidebarRegionMount | undefined
  let sidebarState = options.sidebar?.state
  let running: readonly string[] = []
  let marks: Readonly<Record<string, SessionListMark>> = {}
  if (options.sidebarContainer)
    presentation.navigation = {
      container: options.sidebarContainer,
      history: sessionInventory,
      initial: {
        ...options.sidebar,
        profileApprovals: <ProfileAttentionEntry attention={attention} locale={locale} />,
      },
      attach(handle) {
        const attached = { ...handle, dispose() {} }
        sidebarView = attached
        if (sidebarState) handle.update(sidebarState)
        handle.setRunning(running)
        handle.setMarks?.(marks)
        return () => {
          if (sidebarView === attached) sidebarView = undefined
        }
      },
    }
  const sidebar = options.sidebarContainer
    ? {
        update(value: SidebarState) {
          sidebarState = value
          sidebarView?.update(value)
        },
        setRunning(value: readonly string[]) {
          running = value
          sidebarView?.setRunning(value)
        },
        setMarks(value: Readonly<Record<string, SessionListMark>>) {
          marks = value
          sidebarView?.setMarks?.(value)
        },
        close: () => sidebarView?.close(),
        dismiss: () => sidebarView?.dismiss(),
        focusNew: () => sidebarView?.focusNew(),
        dispose() {},
      }
    : undefined
  const transcript =
    !conversation && options.transcriptContainer
      ? mountTranscriptRegion(registry, options.transcriptContainer, {
          ...options.transcript,
          ...(options.claim ? { claim: options.claim } : {}),
          session,
          locale,
          resources,
        })
      : undefined
  if (transcript) builtinUnits.mount('@agnes/web-transcript', () => transcript.dispose())
  let lastTranscript:
    | { sessionId: string | undefined; args: Parameters<TranscriptRegionMount['render']> }
    | undefined
  const transcriptRuntime = conversation
    ? ({
        render(nodes, turns, meta) {
          lastTranscript = { sessionId: session.sessionId, args: [nodes, turns, meta] }
          transcriptDelegate.current?.render(nodes, turns, meta)
        },
        reset() {
          lastTranscript = undefined
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
    locale,
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
      stopAttentionPage()
      stopAttentionSession()
      attention.dispose()
      conversationChildrenGeneration++
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
/** Default claim: no roster means every slot is unclaimed (placeholder). */
export const unclaimed: ClaimResolver = () => false
export type { AgnesClient }
export { createReconciler }
