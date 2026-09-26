/**
 * 页面区域的宿主实现。
 *
 * The first migrated region deliberately keeps its existing outer `<section id="empty-state">`
 * so the legacy layout, CSS selectors and app state machine remain the authority for visibility.
 * Only the section's children move behind a SlotOutlet.  A browser module can shadow the built-in
 * entry by registering the same slot with a lower priority; the surrounding page remains intact.
 */
import {
  type ClientDocumentArtifact,
  ClientResourceReclaimedError,
  type ClientResourceService,
  dshSlotSpec,
  type LocaleService,
  type SessionService,
  type SlotName,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { createAntdRoot } from '@agnes/web-ui'
import {
  Approval,
  type ApprovalHandle,
  type ApprovalView,
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerRegionOptions,
  type ComposerView,
  Conversation,
  type ConversationChildContainers,
  type ConversationHandle,
  EMPTY_SIDEBAR_STATE,
  PANE_IDS,
  SETTINGS_DSH_SLOT_NAMES,
  SettingsBuiltin,
  type SettingsPane,
  SettingsPaneBuiltin,
  type SettingsPaneChange,
  type SettingsRegionHandle,
  Sidebar,
  type SidebarActions,
  type SidebarDependencies,
  type SidebarHandle,
  type SidebarState,
  settingsDshSlotHostId,
  settingsPaneSlotHostId,
  Topbar,
  type TopbarConnectionState,
  type TopbarHandle,
  Trace,
  type TraceHandle,
  type TracePanelOptions,
  Transcript,
  type TranscriptDependencies,
  type TranscriptHandle,
} from '@agnes/web-units'
import { createElement, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { ClaimResolver } from './client-modules/boot.js'
import { observeSlotCards } from './client-modules/timeline-slot.js'
import {
  createDocumentPreview,
  type DocumentPreviewInput,
  type DocumentPreviewKind,
} from './document-preview.js'
import { createModelPicker } from './model-picker.js'
import { renderSessionNavigation } from './navigation.js'
import { createPermissionPicker } from './permission-picker.js'
import { isComposerSubmitShortcut, resizeComposer } from './presentation.js'
import { bindSidebar } from './shell.js'
import { createTimelineRenderer } from './timeline.js'
import { TimelineNodeHost } from './timeline-node-host.js'
import { createUsagePanel } from './usage.js'

export type { ConversationChildContainers, ConversationHandle } from '@agnes/web-units'

const SIDEBAR_DEPENDENCIES: SidebarDependencies = {
  renderNavigation: renderSessionNavigation,
  bindSidebar,
}
const TRANSCRIPT_DEPENDENCIES: TranscriptDependencies = {
  createRenderer: createTimelineRenderer,
  observeCards: observeSlotCards,
}
const COMPOSER_DEPENDENCIES: ComposerDependencies = {
  createModelPicker,
  createPermissionPicker,
  createUsagePanel,
  isSubmitShortcut: isComposerSubmitShortcut,
  resize: resizeComposer,
}
const COMPOSER_DSH_CHILDREN = Object.freeze({
  'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
  'conversation.input.dock': { kind: 'list', scope: 'session' },
  'conversation.input.left': { kind: 'list', scope: 'session' },
  'conversation.input.model': { kind: 'single', scope: 'session' },
  'conversation.input.overlay': { kind: 'list', scope: 'session' },
  'conversation.input.permission': { kind: 'single', scope: 'session' },
  'conversation.input.plan': { kind: 'single', scope: 'session' },
  'conversation.input.right': { kind: 'list', scope: 'session' },
} as const)
const COMPOSER_BAR_DSH_CHILDREN = Object.freeze({
  'conversation.composer.dock': { kind: 'list', scope: 'session' },
  ...COMPOSER_DSH_CHILDREN,
} as const)

const DSH_ROOT_CHILDREN = Object.freeze({
  main: { kind: 'keyed', scope: 'root' },
  rightbar: { kind: 'single', scope: 'root' },
  sidebar: { kind: 'single', scope: 'root' },
  'shell.overlay': { kind: 'list', scope: 'root' },
} as const)

const DSH_MAIN_CONVERSATION_CHILDREN = Object.freeze({
  'conversation.composer': { kind: 'chain', scope: 'session' },
  'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  'conversation.session': { kind: 'single', scope: 'session' },
} as const)

const DSH_CONVERSATION_SESSION_CHILDREN = Object.freeze({
  'conversation.session.header': { kind: 'single', scope: 'session' },
  'conversation.view': { kind: 'list', scope: 'session' },
} as const)

const RIGHTBAR_SESSION_CHILDREN = Object.freeze({
  'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
  'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
  'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' },
} as const)

const RIGHTBAR_DOCUMENT_CHILDREN = Object.freeze({
  'sidebar.right.tab.document': { kind: 'keyed', scope: 'session' },
} as const)

const RIGHTBAR_GUIDE_CHILDREN = Object.freeze({
  'sidebar.right.tab.guide': { kind: 'chain', scope: 'session' },
  'sidebar.right.tab.guide.entry': { kind: 'keyed', scope: 'session' },
} as const)

/** Not part of the three legacy extension slots; this is a host-owned page region. */
export const EMPTY_STATE_SLOT = 'ui:empty-state' as unknown as SlotName
/** The outer `<aside>` remains the skin/accessibility boundary; its contents are replaceable. */
export const SIDEBAR_SLOT = 'ui:sidebar' as unknown as SlotName
export const TRANSCRIPT_SLOT = 'ui:transcript' as unknown as SlotName
export const CONVERSATION_SLOT = 'ui:conversation' as unknown as SlotName
export const CONVERSATION_CHILD_SLOTS = Object.freeze({
  messageActions: 'conversation.message.actions',
  attachments: 'conversation.attachments',
  toolCard: 'conversation.tool-card',
  feedback: 'conversation.feedback',
})
const CONVERSATION_DSH_CHILDREN = Object.freeze({
  ...DSH_MAIN_CONVERSATION_CHILDREN,
} as const)
const CONVERSATION_HEADER_DSH_CHILDREN = Object.freeze({
  'conversation.session.header.actions': { kind: 'list', scope: 'session' },
  'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
  'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
} as const)
const EMPTY_STATE_DSH_CHILDREN = Object.freeze({
  'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
  'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
  'conversation.hero.workspace': { kind: 'single', scope: 'root' },
  'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
} as const)
export const TOPBAR_SLOT = 'ui:topbar' as unknown as SlotName
export const APPROVAL_SLOT = 'ui:approval' as unknown as SlotName
export const COMPOSER_SLOT = 'ui:composer' as unknown as SlotName
export const TRACE_SLOT = 'ui:trace' as unknown as SlotName
export const SETTINGS_PANE_SLOT = 'ui:settings-pane' as unknown as SlotName
export const settingsPaneSlot = (pane: SettingsPane) => `ui:settings-pane.${pane}` as unknown as SlotName

const SETTINGS_UNIT_OWNER: Readonly<Record<SettingsPane, string>> = {
  model: '@agnes/web-settings-model',
  plugin: '@agnes/web-settings-plugins',
  resources: '@agnes/web-settings-resources',
  archived: '@agnes/web-settings-archived',
  'computer-use': '@agnes/web-settings-computer-use',
  appearance: '@agnes/web-settings-appearance',
}

const SETTINGS_DSH_GLOBAL_SLOT_NAMES = new Set([
  'settings.trigger',
  'settings.header',
  'settings.action',
  'settings.close',
  'settings.onboarding',
  'settings.section',
])

function EmptyStateBuiltin(): ReturnType<typeof createElement> {
  return createElement(
    'div',
    { 'data-agnes-region-owner': 'builtin', 'data-agnes-region-unit': 'empty-state' },
    createElement(
      'div',
      { className: 'conversation-hero-dsh', 'data-agnes-conversation-hero': true },
      createElement(SlotOutlet, {
        name: 'conversation.hero.brand.mark',
        props: { owner: { surface: 'conversation.hero' } },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'conversation.hero.workspace',
        props: { owner: { surface: 'conversation.hero' } },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'conversation.hero.workspace.directoryFlow',
        props: { owner: { surface: 'conversation.hero.workspace' } },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'conversation.hero.agentPreset',
        props: { owner: { surface: 'conversation.hero' } },
        hideWhenEmpty: true,
      }),
    ),
    createElement('span', { className: 'agnes-mark empty-brand-mark', 'aria-hidden': 'true' }),
    createElement('h2', { id: 'empty-state-title', className: 'empty-state-heading' }, 'Agnes Harness'),
    createElement('p', { className: 'empty-state-copy' }, '让每一个模型，都能成为会做事的智能体。'),
  )
}

export interface EmptyStateRegionMount {
  dispose(): void
}

/** Root-scoped regions must not remount when a session-scoped sibling changes session. */
function rootStableRegistry(registry: SlotRegistry): SlotRegistry {
  const stable = Object.create(registry) as SlotRegistry
  Object.defineProperty(stable, 'sessionId', { configurable: true, get: () => undefined })
  Object.defineProperty(stable, 'subscribeSession', { configurable: true, value: () => () => undefined })
  return stable
}

export interface DshShellRegionMount extends EmptyStateRegionMount {}

/**
 * Register the DSH root tree once for the page.  The legacy `ui:*` regions remain the visible
 * compatibility boundaries; their built-ins below forward into this tree so a DSH contribution
 * can replace a top-level surface without making the old app shell disappear.
 */
export function mountDshShellRegion(registry: SlotRegistry): DshShellRegionMount {
  if (registry.spec('root')) throw new Error('DSH shell root is already mounted')
  registry.declare('root', { kind: 'single', scope: 'root' }, 'web-shell')
  const removeRoot = registry.register(
    {
      name: 'root',
      id: 'builtin-dsh-root',
      owner: '@agnes/web-shell',
      priority: 0,
      children: DSH_ROOT_CHILDREN,
    },
    () => null,
  )
  const removeMain = registry.register(
    {
      name: 'main',
      key: 'default',
      id: 'builtin-dsh-main',
      owner: '@agnes/web-shell',
      priority: 1,
      children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } },
    },
    () =>
      createElement(SlotOutlet, {
        name: 'main.conversation',
        hideWhenEmpty: true,
      }),
  )

  const overlayHost = document.createElement('div')
  overlayHost.dataset.agnesDshShellOverlay = 'true'
  document.body.append(overlayHost)
  const overlayRoot = createAntdRoot(overlayHost)
  flushSync(() => {
    overlayRoot.render(
      createElement(
        SlotsProvider,
        { registry },
        createElement(SlotOutlet, { name: 'shell.overlay', hideWhenEmpty: true }),
      ),
    )
  })
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      overlayRoot.unmount()
      overlayHost.remove()
      removeMain()
      removeRoot()
    },
  }
}

const DSH_SIDEBAR_CHILDREN = Object.freeze({
  'sidebar.brand.mark': { kind: 'single', scope: 'root' },
  'sidebar.brand.name': { kind: 'single', scope: 'root' },
  'sidebar.footer.action': { kind: 'list', scope: 'root' },
  'sidebar.panellist': { kind: 'list', scope: 'root' },
  'sidebar.settings': { kind: 'single', scope: 'root' },
  'sidebar.workspaces': { kind: 'single', scope: 'root' },
  'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
} as const)

function SidebarDshFrame({
  handle,
  state,
  actions,
}: {
  handle: { current: SidebarHandle | null }
  state: SidebarState
  actions?: Partial<SidebarActions>
}): ReturnType<typeof createElement> {
  const outlet = (name: string) => createElement(SlotOutlet, { name: name as never, hideWhenEmpty: true })
  return createElement(Sidebar, {
    ref: handle,
    state,
    actions,
    dependencies: SIDEBAR_DEPENDENCIES,
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

export interface SettingsRegionOptions {
  onChange?: (change: SettingsPaneChange) => void
  onClose?: () => void
}
export interface SettingsRegionMount extends EmptyStateRegionMount, SettingsRegionHandle {
  /** Remove exactly one built-in pane without disturbing its siblings or the settings shell. */
  unmountPane(pane: SettingsPane): void
}

/** The settings dialog is component-owned; the dialog shell remains the skin/accessibility boundary. */
export function mountSettingsPaneRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: SettingsRegionOptions = {},
): SettingsRegionMount {
  // The dialog/rail is a host scaffold. Every page below it is a separate row and separate
  // SlotOutlet, so disabling a single built-in or third-party replacement cannot reset siblings.
  for (const pane of Object.keys(PANE_IDS) as SettingsPane[])
    registry.declare(settingsPaneSlot(pane) as string, { kind: 'single', scope: 'root' }, 'web-shell')
  for (const name of SETTINGS_DSH_SLOT_NAMES) {
    const spec = dshSlotSpec(name)
    if (!spec) throw new Error(`settings DSH slot is missing from the catalog: ${name}`)
    registry.declare(name, spec, 'web-shell')
  }
  const handle = { current: null as SettingsRegionHandle | null }
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(createElement(SettingsBuiltin, { ref: handle, options }))
  })
  const dshRoots = new Map<string, AntdRoot>()
  const dshPaneSlots = new Map<SettingsPane, string[]>()
  const mountDshOutlet = (name: string, host: HTMLElement, pane?: SettingsPane): void => {
    if (dshRoots.has(name)) throw new Error(`settings DSH slot is mounted twice: ${name}`)
    const dshRoot = createAntdRoot(host)
    dshRoots.set(name, dshRoot)
    if (pane) dshPaneSlots.set(pane, [...(dshPaneSlots.get(pane) ?? []), name])
    flushSync(() => {
      dshRoot.render(
        createElement(
          SlotsProvider,
          { registry },
          createElement(SlotOutlet, { name: name as never, hideWhenEmpty: true }),
        ),
      )
    })
  }
  for (const name of SETTINGS_DSH_GLOBAL_SLOT_NAMES) {
    const host = container.querySelector<HTMLElement>(`#${settingsDshSlotHostId(name as never)}`)
    if (!host) throw new Error(`settings shell is missing ${name}`)
    mountDshOutlet(name, host)
  }
  const paneRoots = new Map<SettingsPane, AntdRoot>()
  const removeBuiltin = new Map<SettingsPane, () => void>()
  for (const pane of Object.keys(PANE_IDS) as SettingsPane[]) {
    const slotHost = container.querySelector<HTMLElement>(`#${settingsPaneSlotHostId(pane)}`)
    if (!slotHost) throw new Error(`settings shell is missing ${settingsPaneSlotHostId(pane)}`)
    const paneRoot = createAntdRoot(slotHost)
    paneRoots.set(pane, paneRoot)
    const remove = registry.register(
      {
        name: settingsPaneSlot(pane) as string,
        id: `builtin-settings-${pane}`,
        owner: SETTINGS_UNIT_OWNER[pane],
        priority: 0,
      },
      () => createElement(SettingsPaneBuiltin, { pane }),
    )
    removeBuiltin.set(pane, remove)
    flushSync(() => {
      paneRoot.render(
        createElement(
          SlotsProvider,
          { registry },
          createElement(SlotOutlet, { name: settingsPaneSlot(pane) }),
        ),
      )
    })
    for (const name of SETTINGS_DSH_SLOT_NAMES) {
      if (SETTINGS_DSH_GLOBAL_SLOT_NAMES.has(name)) continue
      const dshHost = slotHost.querySelector<HTMLElement>(`#${settingsDshSlotHostId(name as never)}`)
      if (!dshHost) continue
      mountDshOutlet(name, dshHost, pane)
    }
  }
  let disposed = false
  return {
    open(pane: SettingsPane) {
      handle.current?.open(pane)
    },
    pane(pane: SettingsPane) {
      return handle.current?.pane(pane) ?? null
    },
    form() {
      return handle.current?.form() ?? null
    },
    unmountPane(pane) {
      for (const name of dshPaneSlots.get(pane) ?? []) {
        dshRoots.get(name)?.unmount()
        dshRoots.delete(name)
      }
      dshPaneSlots.delete(pane)
      removeBuiltin.get(pane)?.()
      removeBuiltin.delete(pane)
      paneRoots.get(pane)?.unmount()
      paneRoots.delete(pane)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const pane of Object.keys(PANE_IDS) as SettingsPane[]) this.unmountPane(pane)
      for (const [name, dshRoot] of dshRoots) {
        dshRoot.unmount()
        dshRoots.delete(name)
      }
      root.unmount()
    },
  }
}

/** Mount the component-owned composer form behind a session-scoped replacement boundary. */
export interface ComposerRegionMount extends EmptyStateRegionMount, ComposerHandle {}

function ComposerDshFrame({
  registry,
  setHandle,
  options,
}: {
  registry: SlotRegistry
  setHandle: (value: ComposerHandle | null) => void
  options: ComposerRegionOptions
}): ReturnType<typeof createElement> {
  const outlet = (name: string) => createElement(SlotOutlet, { name: name as never, hideWhenEmpty: true })
  return createElement(
    SlotsProvider,
    { registry },
    createElement(
      'div',
      { 'data-agnes-composer-dsh': true },
      createElement(SlotOutlet, {
        name: 'conversation.composer',
        props: { owner: { composerId: 'composer' } },
        owner: { composerId: 'composer' },
        hideWhenEmpty: true,
      }),
      createElement(Composer, {
        ref: setHandle,
        dependencies: COMPOSER_DEPENDENCIES,
        ...options,
        slots: {
          attachments: outlet('conversation.input.attachments'),
          dock: createElement(
            'span',
            { style: { display: 'contents' }, 'data-agnes-composer-dock': true },
            createElement(SlotOutlet, {
              name: 'conversation.composer.dock',
              props: { owner: { composerId: 'composer' } },
              hideWhenEmpty: true,
            }),
            outlet('conversation.input.dock'),
          ),
          left: outlet('conversation.input.left'),
          model: outlet('conversation.input.model'),
          overlay: outlet('conversation.input.overlay'),
          permission: outlet('conversation.input.permission'),
          plan: outlet('conversation.input.plan'),
          right: outlet('conversation.input.right'),
        },
      }),
    ),
  )
}

export function mountComposerRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: ComposerRegionOptions,
): ComposerRegionMount {
  const ownedShell = registry.spec('root') ? undefined : mountDshShellRegion(registry)
  if (!registry.spec('conversation.composer'))
    registry.declare(
      'conversation.composer',
      { kind: 'chain', scope: 'session' },
      'web-shell',
      'main.conversation',
    )
  if (!registry.spec('conversation.composer.bar'))
    registry.declare(
      'conversation.composer.bar',
      { kind: 'single', scope: 'session-maybe' },
      'web-shell',
      'main.conversation',
    )
  const handle = { current: null as ComposerHandle | null }
  let view: ComposerView | undefined
  let draft = options.initialDraft ?? ''
  const setHandle = (value: ComposerHandle | null): void => {
    handle.current = value
    if (!value) return
    value.setDraft(draft)
    const next = view
    if (next)
      queueMicrotask(() => {
        if (handle.current === value) value.render(next)
      })
  }
  const composerOptions: ComposerRegionOptions = {
    ...options,
    onDraftChange: (value) => {
      draft = value
      options.onDraftChange(value)
    },
  }
  registry.declare(COMPOSER_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const removeDshBarBuiltin = registry.register(
    {
      name: 'conversation.composer.bar',
      id: 'builtin-conversation-composer-bar',
      owner: '@agnes/web-composer',
      priority: 1,
      children: COMPOSER_BAR_DSH_CHILDREN,
    },
    () =>
      ComposerDshFrame({
        registry,
        setHandle,
        options: composerOptions,
      }),
  )
  const removeBuiltin = registry.register(
    {
      name: COMPOSER_SLOT as string,
      id: 'builtin-composer',
      owner: '@agnes/web-composer',
      priority: 0,
    },
    () => createElement(SlotOutlet, { name: 'conversation.composer.bar' }),
  )
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry: rootStableRegistry(registry) },
        createElement(SlotOutlet, { name: COMPOSER_SLOT }),
      ),
    )
  })
  let disposed = false
  return {
    focus() {
      handle.current?.focus()
    },
    getDraft() {
      return handle.current?.getDraft() ?? draft
    },
    render(next) {
      view = next
      handle.current?.render(next)
    },
    resize() {
      handle.current?.resize()
    },
    setDraft(value) {
      draft = value
      handle.current?.setDraft(value)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
      removeDshBarBuiltin()
      ownedShell?.dispose()
    },
  }
}

export type TraceRegionOptions = Omit<TracePanelOptions, 'root'>

export interface TraceRegionMount extends EmptyStateRegionMount, TraceHandle {}

export interface RightbarRegionOptions {
  session?: SessionService
  resources?: ClientResourceService
  document?: RightbarDocument
}

export interface RightbarRegionMount extends EmptyStateRegionMount {}

export interface RightbarDocument {
  readonly id: string
  readonly title?: string
  readonly kind: DocumentPreviewKind
  readonly content?: string
  readonly resourceUrl?: string
  readonly laneId?: string
  readonly artifact?: ClientDocumentArtifact
}

function documentPreviewInput(document: RightbarDocument | undefined): DocumentPreviewInput {
  return {
    kind: document?.kind ?? 'text',
    title: document?.title ?? '文档预览',
    content: document?.content ?? '',
    ...(document?.resourceUrl === undefined ? {} : { resourceUrl: document.resourceUrl }),
  }
}

function DocumentPreviewBuiltin({
  document,
  resources,
}: {
  document: RightbarDocument | undefined
  resources?: ClientResourceService
}): ReturnType<typeof createElement> {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!host.current) return
    const preview = createDocumentPreview(host.current, documentPreviewInput(document))
    let active = true
    let resource: Awaited<ReturnType<ClientResourceService['documents']['load']>> | undefined
    if (document?.artifact && document.laneId && resources) {
      void resources.documents
        .load({ laneId: document.laneId, kind: document.kind, artifact: document.artifact })
        .then((loaded) => {
          if (!active) {
            loaded.release()
            return
          }
          resource = loaded
          preview.update({
            ...documentPreviewInput(document),
            ...(loaded.content === undefined ? {} : { content: loaded.content }),
            ...(loaded.url === undefined ? {} : { resourceUrl: loaded.url }),
          })
        })
        .catch((error: unknown) => {
          if (!active) return
          // A reclaimed screenshot says so in text; an image preview would only show its URL failure.
          const reclaimed = error instanceof ClientResourceReclaimedError
          preview.update({
            kind: reclaimed ? 'text' : (document?.kind ?? 'text'),
            title: document?.title ?? '文档预览',
            content: reclaimed ? '截图已按保留策略清理' : '文档资源暂不可用',
          })
        })
    }
    return () => {
      active = false
      resource?.release()
      preview.dispose()
    }
  }, [document, resources])
  return createElement('div', {
    ref: host,
    className: 'rightbar-document-preview',
    'data-rightbar-document-preview': document?.id ?? 'empty',
  })
}

function RightbarDocumentTab({
  document,
  resources,
}: {
  document: RightbarDocument | undefined
  resources?: ClientResourceService
}): ReturnType<typeof createElement> {
  const kind = document?.kind ?? 'text'
  return createElement(
    'section',
    { className: 'rightbar-tab-content', 'data-rightbar-tab': 'document' },
    createElement(SlotOutlet, {
      name: 'sidebar.right.tab.document',
      entryKey: kind,
      props: { owner: document },
      fallback: createElement(DocumentPreviewBuiltin, {
        document,
        ...(resources === undefined ? {} : { resources }),
      }),
    }),
  )
}

function RightbarGuideTab(): ReturnType<typeof createElement> {
  return createElement(
    'section',
    { className: 'rightbar-tab-content', 'data-rightbar-tab': 'guide' },
    createElement(SlotOutlet, {
      name: 'sidebar.right.tab.guide',
      owner: { tabId: 'guide' },
      fallback: '暂无指南',
    }),
    createElement(SlotOutlet, {
      name: 'sidebar.right.tab.guide.entry',
      entryKey: 'default',
      props: { owner: { entryId: 'default', tabId: 'guide' } },
      hideWhenEmpty: true,
    }),
  )
}

function RightbarTabBuiltin({
  tab,
  document,
  resources,
}: {
  tab: 'document' | 'guide'
  document: RightbarDocument | undefined
  resources?: ClientResourceService
}): ReturnType<typeof createElement> {
  return tab === 'document'
    ? createElement(RightbarDocumentTab, {
        document,
        ...(resources === undefined ? {} : { resources }),
      })
    : createElement(RightbarGuideTab)
}

function RightbarSessionBuiltin({
  document,
}: {
  document: RightbarDocument | undefined
}): ReturnType<typeof createElement> {
  const activeTab = document === undefined ? 'guide' : 'document'
  const owner = (tabId: 'document' | 'guide') => ({
    tabId,
    title: tabId === 'document' ? (document?.title ?? '文档') : '指南',
    active: activeTab === tabId,
  })
  return createElement(
    'div',
    { id: 'rightbar-session', 'data-agnes-rightbar-session': true },
    createElement(
      'nav',
      { className: 'rightbar-tabs', 'aria-label': '扩展面板' },
      createElement(SlotOutlet, {
        name: 'sidebar.right.pane.tab',
        entryKey: 'document',
        props: { owner: owner('document') },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'sidebar.right.pane.tab',
        entryKey: 'guide',
        props: { owner: owner('guide') },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'sidebar.right.pane.tab.title',
        entryKey: activeTab,
        props: { owner: owner(activeTab) },
        fallback: owner(activeTab).title,
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'sidebar.right.tab.menu.item',
        props: { owner: { activeTab } },
        hideWhenEmpty: true,
      }),
    ),
  )
}

function RightbarBuiltin(): ReturnType<typeof createElement> {
  return createElement(
    'div',
    { id: 'rightbar-content', 'data-agnes-region-unit': 'rightbar' },
    createElement(SlotOutlet, { name: 'rightbar.session', hideWhenEmpty: true }),
  )
}

/** Mount the independent DSH rightbar surface; trace and approval keep their legacy owners. */
export function mountRightbarRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: RightbarRegionOptions = {},
): RightbarRegionMount {
  const rootSpec = dshSlotSpec('rightbar')
  const sessionSpec = dshSlotSpec('rightbar.session')
  if (!rootSpec || !sessionSpec) throw new Error('rightbar DSH slots are missing from the catalog')
  if (!registry.spec('rightbar')) registry.declare('rightbar', rootSpec, 'web-shell')
  const removeBuiltin = registry.register(
    {
      name: 'rightbar',
      id: 'builtin-rightbar',
      owner: '@agnes/web-rightbar',
      priority: 0,
      children: { 'rightbar.session': sessionSpec },
    },
    () => createElement(RightbarBuiltin),
  )
  const removeSessionBuiltin = registry.register(
    {
      name: 'rightbar.session',
      id: 'builtin-rightbar-session',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_SESSION_CHILDREN,
    },
    () => createElement(RightbarSessionBuiltin, { document: options.document }),
  )
  const removeDocumentTab = registry.register(
    {
      name: 'sidebar.right.pane.tab',
      key: 'document',
      id: 'builtin-rightbar-document-tab',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_DOCUMENT_CHILDREN,
    },
    () =>
      createElement(RightbarTabBuiltin, {
        tab: 'document',
        document: options.document,
        ...(options.resources === undefined ? {} : { resources: options.resources }),
      }),
  )
  const removeGuideTab = registry.register(
    {
      name: 'sidebar.right.pane.tab',
      key: 'guide',
      id: 'builtin-rightbar-guide-tab',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_GUIDE_CHILDREN,
    },
    () =>
      createElement(RightbarTabBuiltin, {
        tab: 'guide',
        document: options.document,
        ...(options.resources === undefined ? {} : { resources: options.resources }),
      }),
  )
  const documentRenderers: Array<() => void> = []
  for (const kind of ['text', 'markdown', 'html', 'image', 'pdf', 'code'] as const) {
    documentRenderers.push(
      registry.register(
        {
          name: 'sidebar.right.tab.document',
          key: kind,
          id: `builtin-rightbar-document-${kind}`,
          owner: '@agnes/web-rightbar',
          priority: 1,
        },
        ({ owner }: { owner?: RightbarDocument }) =>
          createElement(DocumentPreviewBuiltin, {
            document: owner ?? options.document,
            ...(options.resources === undefined ? {} : { resources: options.resources }),
          }),
      ),
    )
  }
  const root = createAntdRoot(container)
  const watchedSlots = [
    'rightbar',
    'rightbar.session',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'sidebar.right.tab.document',
    'sidebar.right.tab.guide',
    'sidebar.right.tab.guide.entry',
    'sidebar.right.tab.menu.item',
  ]
  const hasCustomRightbarEntry = (): boolean =>
    options.document !== undefined ||
    watchedSlots.some((name) => registry.entries(name).some((entry) => entry.owner !== '@agnes/web-rightbar'))
  const syncVisibility = (): void => {
    container.hidden = !hasCustomRightbarEntry()
  }
  const stops = watchedSlots.map((name) => registry.subscribeBatched(name, syncVisibility))
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry, ...(options.session ? { session: options.session } : {}) },
        createElement(SlotOutlet, { name: 'rightbar' }),
      ),
    )
  })
  syncVisibility()
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stops) stop()
      root.unmount()
      for (const remove of documentRenderers) remove()
      removeGuideTab()
      removeDocumentTab()
      removeSessionBuiltin()
      removeBuiltin()
      container.hidden = true
    },
  }
}

/** The trace pane retains outer visibility semantics while its renderer owns a slot leaf. */
export function mountTraceRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: TraceRegionOptions,
): TraceRegionMount {
  registry.declare(TRACE_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const handle = { current: null as TraceHandle | null }
  const removeBuiltin = registry.register(
    { name: TRACE_SLOT as string, id: 'builtin-trace', owner: '@agnes/web-trace', priority: 0 },
    () => createElement(Trace, { ref: handle, root: container, options }),
  )
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(createElement(SlotsProvider, { registry }, createElement(SlotOutlet, { name: TRACE_SLOT })))
  })
  let disposed = false
  return {
    render(nodes, turns, meta) {
      handle.current?.render(nodes, turns, meta)
    },
    setOpen(open) {
      handle.current?.setOpen(open)
    },
    isOpen() {
      return handle.current?.isOpen() ?? false
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}

export interface TopbarRegionMount extends EmptyStateRegionMount, TopbarHandle {
  ready: Promise<void>
}

/** Mount the component-owned topbar behind a replaceable SlotOutlet. */
export function mountTopbarRegion(registry: SlotRegistry, container: HTMLElement): TopbarRegionMount {
  const handle = { current: null as TopbarHandle | null }
  const disconnectListeners = new Set<() => void>()
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
        disconnectListeners,
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
    onDisconnect(listener) {
      disconnectListeners.add(listener)
      return () => disconnectListeners.delete(listener)
    },
    dispose() {
      if (disposed) return
      disposed = true
      disconnectListeners.clear()
      root.unmount()
      removeBuiltin()
    },
  }
}

export interface ApprovalRegionMount extends EmptyStateRegionMount, ApprovalHandle {}

const APPROVAL_DSH_CHILDREN = Object.freeze({
  'conversation.approval.detail': { kind: 'single', scope: 'session' },
} as const)

function ApprovalDshFrame({
  setHandle,
}: {
  setHandle: (value: ApprovalHandle | null) => void
}): ReturnType<typeof createElement> {
  return createElement(Approval, {
    ref: setHandle,
    detail: createElement(SlotOutlet, { name: 'conversation.approval.detail', hideWhenEmpty: true }),
  })
}

/** Mount the component-owned approval card behind the live-region section and slot boundary. */
export function mountApprovalRegion(registry: SlotRegistry, container: HTMLElement): ApprovalRegionMount {
  const handle = { current: null as ApprovalHandle | null }
  let view: ApprovalView | undefined
  const setHandle = (value: ApprovalHandle | null): void => {
    handle.current = value
    if (value) value.render(view)
  }
  registry.declare(APPROVAL_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const removeBuiltin = registry.register(
    {
      name: APPROVAL_SLOT as string,
      id: 'builtin-approval',
      owner: '@agnes/web-approval',
      priority: 0,
      children: APPROVAL_DSH_CHILDREN,
    },
    () => ApprovalDshFrame({ setHandle }),
  )
  container.replaceChildren()
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(SlotsProvider, { registry }, createElement(SlotOutlet, { name: APPROVAL_SLOT })),
    )
  })
  let disposed = false
  return {
    render(next) {
      view = next
      container.hidden = next === undefined
      if (next) container.dataset.key = next.key
      else container.removeAttribute('data-key')
      handle.current?.render(next)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}

/** Make the conversation shell a session-scoped replacement boundary before mounting its children. */
export interface ConversationRegionOptions {
  session?: SessionService
  onMount?(children: ConversationChildContainers): void
  onUnmount?(): void
}

export interface ConversationRegionMount extends EmptyStateRegionMount, ConversationHandle {}

function ConversationSessionHeaderBuiltin({
  sessionId,
}: {
  sessionId?: string
}): ReturnType<typeof createElement> {
  const owner = { sessionId: sessionId ?? '' }
  return createElement(
    'header',
    { className: 'conversation-session-header', 'data-agnes-conversation-header': true },
    createElement(SlotOutlet, {
      name: 'conversation.session.header.lineage',
      props: { owner },
      hideWhenEmpty: true,
    }),
    createElement(SlotOutlet, {
      name: 'conversation.session.header.actions',
      props: { owner },
      hideWhenEmpty: true,
    }),
    createElement(SlotOutlet, {
      name: 'conversation.session.header.utilities',
      props: { owner },
      hideWhenEmpty: true,
    }),
    createElement(SlotOutlet, {
      name: 'conversation.session.header.corner',
      props: { owner },
      hideWhenEmpty: true,
    }),
  )
}

function ConversationSessionBuiltin(): ReturnType<typeof createElement> {
  return createElement('span', {
    hidden: true,
    'data-agnes-conversation-session': true,
  })
}

export function mountConversationRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: ConversationRegionOptions = {},
): ConversationRegionMount {
  const ownedShell = registry.spec('root') ? undefined : mountDshShellRegion(registry)
  registry.declare(CONVERSATION_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const handle = { current: null as ConversationHandle | null }
  const removeMainConversationBuiltin = registry.register(
    {
      name: 'main.conversation',
      id: 'builtin-dsh-main-conversation',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: CONVERSATION_DSH_CHILDREN,
    },
    () =>
      createElement(Conversation, {
        ref: handle,
        ...options,
        slots: {
          session: createElement(SlotOutlet, { name: 'conversation.session', hideWhenEmpty: true }),
          sessionHeader: createElement(SlotOutlet, {
            name: 'conversation.session.header',
            hideWhenEmpty: true,
          }),
        },
      }),
  )
  const removeSessionBuiltin = registry.register(
    {
      name: 'conversation.session',
      id: 'builtin-conversation-session',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: DSH_CONVERSATION_SESSION_CHILDREN,
    },
    () => createElement(ConversationSessionBuiltin),
  )
  const removeBuiltin = registry.register(
    {
      name: CONVERSATION_SLOT as string,
      id: 'builtin-conversation',
      owner: '@agnes/web-conversation',
      priority: 0,
      children: {
        [CONVERSATION_CHILD_SLOTS.messageActions]: { kind: 'list', scope: 'session-maybe' },
        [CONVERSATION_CHILD_SLOTS.attachments]: { kind: 'list', scope: 'session-maybe' },
        [CONVERSATION_CHILD_SLOTS.toolCard]: { kind: 'list', scope: 'session-maybe' },
        [CONVERSATION_CHILD_SLOTS.feedback]: { kind: 'list', scope: 'session-maybe' },
      },
    },
    () => createElement(SlotOutlet, { name: 'main', entryKey: 'default', hideWhenEmpty: true }),
  )
  const removeHeaderBuiltin = registry.register(
    {
      name: 'conversation.session.header',
      id: 'builtin-conversation-session-header',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: CONVERSATION_HEADER_DSH_CHILDREN,
    },
    ({ sessionId }: { sessionId?: string }) =>
      createElement(ConversationSessionHeaderBuiltin, {
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
  )
  container.replaceChildren()
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry, ...(options.session ? { session: options.session } : {}) },
        createElement(SlotOutlet, { name: CONVERSATION_SLOT }),
      ),
    )
  })
  let disposed = false
  return {
    setEmptyStateVisible(visible) {
      handle.current?.setEmptyStateVisible(visible)
    },
    isTranscriptNearBottom() {
      return handle.current?.isTranscriptNearBottom() ?? false
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeHeaderBuiltin()
      removeSessionBuiltin()
      removeMainConversationBuiltin()
      removeBuiltin()
      ownedShell?.dispose()
    },
  }
}

/** Render the built-in sidebar behind the root-scoped slot ledger without replacing its outer landmark. */
export interface SidebarRegionMount extends EmptyStateRegionMount, SidebarHandle {}

export function mountSidebarRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: { state?: SidebarState; actions?: Partial<SidebarActions> } = {},
): SidebarRegionMount {
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
        state: options.state ?? EMPTY_SIDEBAR_STATE,
        ...(options.actions === undefined ? {} : { actions: options.actions }),
      }),
  )
  const removeBuiltin = registry.register(
    { name: SIDEBAR_SLOT as string, id: 'builtin-sidebar', owner: '@agnes/web-sidebar', priority: 0 },
    () => createElement(SlotsProvider, { registry }, createElement(SlotOutlet, { name: 'sidebar' as never })),
  )
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry: rootStableRegistry(registry) },
        createElement(SlotOutlet, { name: SIDEBAR_SLOT }),
      ),
    )
  })
  let disposed = false
  return {
    update(state) {
      flushSync(() => handle.current?.update(state))
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

/** Render the transcript component behind a session-scoped, replaceable SlotOutlet. */
export interface TranscriptRegionMount extends EmptyStateRegionMount, TranscriptHandle {}

export function mountTranscriptRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: {
    /** Explicit W4a node-host probe; the default production path stays on the legacy renderer. */
    nodeHost?: 'react'
    claim?: ClaimResolver
    newContentButton?: HTMLButtonElement
    onFork?: (turn: import('@agnes/protocol').UITurn) => Promise<void>
    session?: SessionService
    locale?: LocaleService
    resources?: ClientResourceService
  } = {},
): TranscriptRegionMount {
  if (!registry.spec('conversation.view'))
    registry.declare(
      'conversation.view',
      { kind: 'list', scope: 'session' },
      'web-shell',
      'conversation.session',
    )
  if (!registry.spec(TRANSCRIPT_SLOT))
    registry.declare(TRANSCRIPT_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const handle = { current: null as TranscriptHandle | null }
  const removeBuiltin = registry.register(
    {
      name: TRANSCRIPT_SLOT as string,
      id: 'builtin-transcript',
      owner: '@agnes/web-transcript',
      priority: 0,
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      },
    },
    () =>
      options.nodeHost === 'react'
        ? createElement(TimelineNodeHost, {
            ref: handle,
            registry,
            ...(options.claim ? { claim: options.claim } : {}),
            ...(options.newContentButton ? { newContentButton: options.newContentButton } : {}),
            ...(options.onFork ? { onFork: options.onFork } : {}),
            ...(options.session ? { session: options.session } : {}),
            ...(options.locale ? { locale: options.locale } : {}),
            ...(options.resources ? { resources: options.resources } : {}),
          })
        : createElement(Transcript, {
            ref: handle,
            dependencies: {
              ...TRANSCRIPT_DEPENDENCIES,
              createRenderer(rendererOptions) {
                return createTimelineRenderer({
                  ...rendererOptions,
                  registry,
                  ...(options.session ? { session: options.session } : {}),
                  ...(options.locale ? { locale: options.locale } : {}),
                  ...(options.resources ? { resources: options.resources } : {}),
                })
              },
            },
            ...options,
          }),
  )
  const removeViewBuiltin = registry.register(
    {
      name: 'conversation.view',
      id: 'builtin-conversation-view',
      owner: '@agnes/web-transcript',
      priority: 0,
    },
    () => createElement(SlotOutlet, { name: TRANSCRIPT_SLOT }),
  )
  // These are child declarations of the two keyed transcript parents. The
  // declaration-only entries keep the parent/child lifecycle tied to this
  // transcript mount while their keys stay outside real node/tool keys.
  const removeChatChildren = registry.register(
    {
      name: 'conversation.chat.node',
      key: '__agnes-native-child-declarations__',
      id: 'builtin-conversation-chat-children',
      owner: '@agnes/web-transcript',
      priority: -1,
      children: {
        'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
        'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
        'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
        'conversation.message.images': { kind: 'single', scope: 'session' },
        'conversation.trajectory.images': { kind: 'single', scope: 'session' },
      },
    },
    () => null,
  )
  const removeToolChildren = registry.register(
    {
      name: 'tool.call.toolview',
      key: '__agnes-native-child-declarations__',
      id: 'builtin-tool-view-children',
      owner: '@agnes/web-transcript',
      priority: -1,
      children: {
        'tool.call.images': { kind: 'single', scope: 'session' },
        'tool.view.cordis': { kind: 'keyed', scope: 'session' },
      },
    },
    () => null,
  )
  container.replaceChildren()
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        {
          registry,
          ...(options.session ? { session: options.session } : {}),
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.resources ? { resources: options.resources } : {}),
        },
        createElement(SlotOutlet, {
          name: 'conversation.view',
          fallback: createElement(SlotOutlet, { name: TRANSCRIPT_SLOT }),
        }),
      ),
    )
  })
  let disposed = false
  return {
    render(nodes, turns, meta) {
      handle.current?.render(nodes, turns, meta)
    },
    reset() {
      handle.current?.reset()
    },
    pinToBottom() {
      handle.current?.pinToBottom()
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeToolChildren()
      removeChatChildren()
      removeViewBuiltin()
      removeBuiltin()
    },
  }
}

/**
 * Move the empty-state children behind the browser slot ledger.
 *
 * This operation is intentionally idempotent at the caller boundary: one root is created per
 * container and its registration is removed together with the root.  It is safe to call while the
 * section is hidden; the app keeps ownership of `hidden` and the region only owns its contents.
 */
export function mountEmptyStateRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  services: { session?: SessionService; locale?: LocaleService } = {},
): EmptyStateRegionMount {
  if (!registry.spec(EMPTY_STATE_SLOT))
    registry.declare(EMPTY_STATE_SLOT as string, { kind: 'single', scope: 'root' }, 'web-shell')
  // Priority 0 is the built-in. Third-party entries can explicitly shadow it with a lower value.
  const removeBuiltin = registry.register(
    {
      name: EMPTY_STATE_SLOT as string,
      id: 'builtin-empty-state',
      owner: '@agnes/web-empty-state',
      priority: 0,
      children: EMPTY_STATE_DSH_CHILDREN,
    },
    EmptyStateBuiltin,
  )
  container.replaceChildren()
  const root: AntdRoot = createAntdRoot(container)
  const providerProps = {
    registry,
    ...(services.session ? { session: services.session } : {}),
    ...(services.locale ? { locale: services.locale } : {}),
  }
  root.render(
    createElement(SlotsProvider, providerProps, createElement(SlotOutlet, { name: EMPTY_STATE_SLOT })),
  )
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}
