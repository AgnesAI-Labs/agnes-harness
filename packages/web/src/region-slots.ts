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
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { createAntdRoot } from '@agnes/web-ui'
import { ConversationUsage, DocumentPreview } from '@agnes/web-ui/assistant-ui'
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
import { createElement, type ReactNode, useLayoutEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ClaimResolver } from './client-modules/boot.js'
import { observeSlotCards } from './client-modules/timeline-slot.js'
import type { DocumentPreviewInput, DocumentPreviewKind } from './document-preview.js'
import { applyLocaleText } from './locale-preference.js'
import { createModelPicker } from './model-picker.js'
import { renderSessionNavigation } from './navigation.js'
import { createPermissionPicker } from './permission-picker.js'
import { isComposerSubmitShortcut, resizeComposer, type Translate } from './presentation.js'
import type { RegionSlots, TranscriptRegionSlots } from './region-slot-port.js'
import { bindSidebar } from './shell.js'
import { createTimelineRenderer } from './timeline.js'
import { TimelineNodeHost } from './timeline-node-host.js'
import { createUsagePanel } from './usage.js'

export type { ConversationChildContainers, ConversationHandle } from '@agnes/web-units'

const TRANSCRIPT_DEPENDENCIES: TranscriptDependencies = {
  createRenderer: createTimelineRenderer,
  observeCards: observeSlotCards,
}
const COMPOSER_DEPENDENCIES: Omit<
  ComposerDependencies,
  'translate' | 'createModelPicker' | 'createPermissionPicker'
> = {
  createUsagePanel,
  UsagePanel: ConversationUsage,
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

function EmptyStateBuiltin({
  t = (key) => key,
}: {
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
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
    createElement('p', { className: 'empty-state-copy' }, t('app.emptyState.tagline')),
  )
}

export interface EmptyStateRegionMount {
  dispose(): void
}

export interface DshShellRegionMount extends EmptyStateRegionMount {}

/**
 * Register the DSH root tree once for the page.  The legacy `ui:*` regions remain the visible
 * compatibility boundaries; their built-ins below forward into this tree so a DSH contribution
 * can replace a top-level surface without making the old app shell disappear.
 */
export function mountDshShellRegion(slots: RegionSlots): DshShellRegionMount {
  if (slots.has('root')) throw new Error('DSH shell root is already mounted')
  slots.declare('root', { kind: 'single', scope: 'root' })
  const removeRoot = slots.register(
    {
      name: 'root',
      id: 'builtin-dsh-root',
      owner: '@agnes/web-shell',
      priority: 0,
      children: DSH_ROOT_CHILDREN,
    },
    () => null,
  )
  const removeMain = slots.register(
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
    overlayRoot.render(slots.outlet({ name: 'shell.overlay', hideWhenEmpty: true }))
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

export interface SettingsRegionOptions {
  computerUse?: ReactNode
  onChange?: (change: SettingsPaneChange) => void
  onClose?: () => void
}
export interface SettingsRegionMount extends EmptyStateRegionMount, SettingsRegionHandle {
  /** Remove exactly one built-in pane without disturbing its siblings or the settings shell. */
  unmountPane(pane: SettingsPane): void
}

/** The settings dialog is component-owned; the dialog shell remains the skin/accessibility boundary. */
export function mountSettingsPaneRegion(
  slots: RegionSlots,
  container: HTMLElement,
  options: SettingsRegionOptions = {},
  locale?: LocaleService,
): SettingsRegionMount {
  // The dialog/rail is a host scaffold. Every page below it is a separate row and separate
  // SlotOutlet, so disabling a single built-in or third-party replacement cannot reset siblings.
  for (const pane of Object.keys(PANE_IDS) as SettingsPane[])
    slots.declare(settingsPaneSlot(pane) as string, { kind: 'single', scope: 'root' })
  for (const name of SETTINGS_DSH_SLOT_NAMES) {
    const spec = dshSlotSpec(name)
    if (!spec) throw new Error(`settings DSH slot is missing from the catalog: ${name}`)
    slots.declare(name, spec)
  }
  const handle = { current: null as SettingsRegionHandle | null }
  const root = createAntdRoot(container)
  const renderSettingsShell = (): void => {
    flushSync(() => {
      root.render(
        createElement(SettingsBuiltin, {
          ref: handle,
          options: locale ? { ...options, translate: (key: string) => locale.t(key) } : options,
        }),
      )
    })
  }
  renderSettingsShell()
  const dshRoots = new Map<string, AntdRoot>()
  const dshPaneSlots = new Map<SettingsPane, string[]>()
  const mountDshOutlet = (name: string, host: HTMLElement, pane?: SettingsPane): void => {
    if (dshRoots.has(name)) throw new Error(`settings DSH slot is mounted twice: ${name}`)
    const dshRoot = createAntdRoot(host)
    dshRoots.set(name, dshRoot)
    if (pane) dshPaneSlots.set(pane, [...(dshPaneSlots.get(pane) ?? []), name])
    flushSync(() => {
      dshRoot.render(slots.outlet({ name: name as never, hideWhenEmpty: true }))
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
    const remove = slots.register(
      {
        name: settingsPaneSlot(pane) as string,
        id: `builtin-settings-${pane}`,
        owner: SETTINGS_UNIT_OWNER[pane],
        priority: 0,
      },
      () =>
        createElement(SettingsPaneBuiltin, {
          pane,
          computerUse: options.computerUse,
          ...(locale ? { translate: (key: string) => locale.t(key) } : {}),
        }),
    )
    removeBuiltin.set(pane, remove)
    flushSync(() => {
      paneRoot.render(slots.outlet({ name: settingsPaneSlot(pane) }))
    })
    for (const name of SETTINGS_DSH_SLOT_NAMES) {
      if (SETTINGS_DSH_GLOBAL_SLOT_NAMES.has(name)) continue
      const dshHost = slotHost.querySelector<HTMLElement>(`#${settingsDshSlotHostId(name as never)}`)
      if (!dshHost) continue
      mountDshOutlet(name, dshHost, pane)
    }
  }
  const translateSettingsMarkup = (): void => {
    if (locale) applyLocaleText(container, (key) => locale.t(key))
  }
  translateSettingsMarkup()
  // 不重渲染外壳。外壳用 dangerouslySetInnerHTML 渲染，字符串随语言变化，重渲染会整段替换
  // innerHTML，把每个面板与各 DSH 出口的宿主元素一起换掉；面板的 React 根绑在旧宿主上，结果右侧
  // 内容区变空白，要刷新页面才恢复。其余面板的文本由 applyLocaleText 就地回填。
  //
  // 模型面板是例外：它由 React 组件 SettingsModelPane 渲染，没有 data-i18n 节点，回填够不着，
  // 只能重渲染它的根换语言。React 这次是就地协调、不替换 DOM，所以面板内的 DSH 宿主仍然存活。
  const stopLocaleUpdates = locale?.subscribe(() => {
    translateSettingsMarkup()
    const modelRoot = paneRoots.get('model')
    if (!modelRoot) return
    flushSync(() => {
      modelRoot.render(slots.outlet({ name: settingsPaneSlot('model') }))
    })
  })
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
      stopLocaleUpdates?.()
      root.unmount()
    },
  }
}

/** Mount the component-owned composer form behind a session-scoped replacement boundary. */
export interface ComposerRegionMount extends EmptyStateRegionMount, ComposerHandle {}

/**
 * Each outlet resolves against the session-aware slots on its own: the frame renders under the
 * root-stable composer region, while its children follow the active session.
 */
function ComposerDshFrame({
  slots,
  setHandle,
  options,
  dependencies,
}: {
  slots: RegionSlots
  setHandle: (value: ComposerHandle | null) => void
  options: ComposerRegionOptions
  dependencies: ComposerDependencies
}): ReturnType<typeof createElement> {
  const outlet = (name: string) => slots.outlet({ name: name as never, hideWhenEmpty: true })
  return createElement(
    'div',
    { 'data-agnes-composer-dsh': true },
    slots.outlet({
      name: 'conversation.composer',
      props: { owner: { composerId: 'composer' } },
      owner: { composerId: 'composer' },
      hideWhenEmpty: true,
    }),
    createElement(Composer, {
      ref: setHandle,
      dependencies,
      ...options,
      slots: {
        attachments: outlet('conversation.input.attachments'),
        dock: createElement(
          'span',
          { style: { display: 'contents' }, 'data-agnes-composer-dock': true },
          slots.outlet({
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
  )
}

export function mountComposerRegion(
  slots: RegionSlots,
  container: HTMLElement,
  options: ComposerRegionOptions,
  locale: LocaleService,
): ComposerRegionMount {
  // Render-time lookup: the injected translate reads whatever locale is current on each render.
  const translate: Translate = (key, vars) => locale.t(key, vars)
  const composerDependencies: ComposerDependencies = {
    ...COMPOSER_DEPENDENCIES,
    translate,
    createModelPicker: (pickerOptions) => createModelPicker({ ...pickerOptions, t: translate }),
    createPermissionPicker: (pickerOptions) => createPermissionPicker({ ...pickerOptions, t: translate }),
    // Wrap the usage panel so the shared React component renders with the current locale.
    UsagePanel: (props) =>
      createElement(ConversationUsage, {
        ...props,
        t: (key, vars) => locale.t(key, vars),
      }),
    createUsagePanel: (parent) => createUsagePanel(parent, (key, vars) => locale.t(key, vars)),
  }
  const ownedShell = slots.has('root') ? undefined : mountDshShellRegion(slots)
  if (!slots.has('conversation.composer'))
    slots.declare('conversation.composer', { kind: 'chain', scope: 'session' }, 'main.conversation')
  if (!slots.has('conversation.composer.bar'))
    slots.declare(
      'conversation.composer.bar',
      { kind: 'single', scope: 'session-maybe' },
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
  slots.declare(COMPOSER_SLOT as string, { kind: 'single', scope: 'session-maybe' })
  const removeDshBarBuiltin = slots.register(
    {
      name: 'conversation.composer.bar',
      id: 'builtin-conversation-composer-bar',
      owner: '@agnes/web-composer',
      priority: 1,
      children: COMPOSER_BAR_DSH_CHILDREN,
    },
    () =>
      ComposerDshFrame({
        slots,
        setHandle,
        options: composerOptions,
        dependencies: composerDependencies,
      }),
  )
  const removeBuiltin = slots.register(
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
    root.render(slots.outlet({ name: COMPOSER_SLOT }, { rootStable: true }))
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

function documentPreviewInput(
  document: RightbarDocument | undefined,
  t: (key: string) => string = (key) => key,
): DocumentPreviewInput {
  return {
    kind: document?.kind ?? 'text',
    title: document?.title ?? t('app.doc.previewTitle'),
    content: document?.content ?? '',
    ...(document?.resourceUrl === undefined ? {} : { resourceUrl: document.resourceUrl }),
  }
}

function DocumentPreviewBuiltin({
  document,
  resources,
  t = (key) => key,
}: {
  document: RightbarDocument | undefined
  resources?: ClientResourceService
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
  const artifact = document?.artifact
  const laneId = document?.laneId
  const kind = document?.kind ?? 'text'
  const request = useMemo(
    () => (artifact && laneId ? { artifact, laneId, kind } : undefined),
    [artifact, laneId, kind],
  )
  const [loaded, setLoaded] = useState<{
    request: NonNullable<typeof request>
    resources: ClientResourceService
    input: DocumentPreviewInput
  }>()
  useLayoutEffect(() => {
    setLoaded(undefined)
    if (!request || !resources) return
    let active = true
    let resource: Awaited<ReturnType<ClientResourceService['documents']['load']>> | undefined
    void resources.documents
      .load(request)
      .then((value) => {
        if (!active) {
          value.release()
          return
        }
        resource = value
        setLoaded({
          request,
          resources,
          input: {
            kind: request.kind,
            ...(value.content === undefined ? {} : { content: value.content }),
            ...(value.url === undefined ? {} : { resourceUrl: value.url }),
          },
        })
      })
      .catch((error: unknown) => {
        if (!active) return
        setLoaded({
          request,
          resources,
          input: {
            kind: 'text',
            content:
              error instanceof ClientResourceReclaimedError
                ? t('app.doc.reclaimed')
                : t('app.doc.unavailable'),
          },
        })
      })
    return () => {
      active = false
      resource?.release()
    }
  }, [request, resources, t])
  // A changed owner must never paint the previous resource while its replacement is loading.
  const input =
    loaded && loaded.request === request && loaded.resources === resources
      ? { ...documentPreviewInput(document, t), ...loaded.input }
      : documentPreviewInput(document, t)
  return createElement(
    'div',
    {
      className: 'rightbar-document-preview',
      'data-rightbar-document-preview': document?.id ?? 'empty',
    },
    createElement(DocumentPreview, input),
  )
}

function RightbarDocumentTab({
  document,
  resources,
  t = (key) => key,
}: {
  document: RightbarDocument | undefined
  resources?: ClientResourceService
  t?: (key: string) => string
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
        t,
      }),
    }),
  )
}

function RightbarGuideTab({
  t = (key) => key,
}: {
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
  return createElement(
    'section',
    { className: 'rightbar-tab-content', 'data-rightbar-tab': 'guide' },
    createElement(SlotOutlet, {
      name: 'sidebar.right.tab.guide',
      owner: { tabId: 'guide' },
      fallback: t('app.guide.empty'),
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
  t = (key) => key,
}: {
  tab: 'document' | 'guide'
  document: RightbarDocument | undefined
  resources?: ClientResourceService
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
  return tab === 'document'
    ? createElement(RightbarDocumentTab, {
        document,
        ...(resources === undefined ? {} : { resources }),
      })
    : createElement(RightbarGuideTab, { t })
}

function RightbarSessionBuiltin({
  document,
  t = (key) => key,
}: {
  document: RightbarDocument | undefined
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
  const activeTab = document === undefined ? 'guide' : 'document'
  const owner = (tabId: 'document' | 'guide') => ({
    tabId,
    title: tabId === 'document' ? (document?.title ?? t('app.doc.fallbackTitle')) : t('app.guide.title'),
    active: activeTab === tabId,
  })
  return createElement(
    'div',
    { id: 'rightbar-session', 'data-agnes-rightbar-session': true },
    createElement(
      'nav',
      { className: 'rightbar-tabs', 'aria-label': t('app.rightbarTabs') },
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
  slots: RegionSlots,
  container: HTMLElement,
  options: RightbarRegionOptions = {},
  locale?: LocaleService,
): RightbarRegionMount {
  const t = locale ? (key: string) => locale.t(key) : undefined
  const rootSpec = dshSlotSpec('rightbar')
  const sessionSpec = dshSlotSpec('rightbar.session')
  if (!rootSpec || !sessionSpec) throw new Error('rightbar DSH slots are missing from the catalog')
  if (!slots.has('rightbar')) slots.declare('rightbar', rootSpec)
  const removeBuiltin = slots.register(
    {
      name: 'rightbar',
      id: 'builtin-rightbar',
      owner: '@agnes/web-rightbar',
      priority: 0,
      children: { 'rightbar.session': sessionSpec },
    },
    () => createElement(RightbarBuiltin),
  )
  const removeSessionBuiltin = slots.register(
    {
      name: 'rightbar.session',
      id: 'builtin-rightbar-session',
      owner: '@agnes/web-rightbar',
      priority: 1,
      children: RIGHTBAR_SESSION_CHILDREN,
    },
    () =>
      createElement(RightbarSessionBuiltin, {
        document: options.document,
        ...(t ? { t } : {}),
      }),
  )
  const removeDocumentTab = slots.register(
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
  const removeGuideTab = slots.register(
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
      slots.register(
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
            ...(t ? { t } : {}),
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
    watchedSlots.some((name) => slots.entries(name).some((entry) => entry.owner !== '@agnes/web-rightbar'))
  const syncVisibility = (): void => {
    container.hidden = !hasCustomRightbarEntry()
  }
  const stops = watchedSlots.map((name) => slots.subscribe(name, syncVisibility))
  flushSync(() => {
    root.render(slots.outlet({ name: 'rightbar' }, { session: options.session }))
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
  slots: RegionSlots,
  container: HTMLElement,
  options: TraceRegionOptions,
): TraceRegionMount {
  slots.declare(TRACE_SLOT as string, { kind: 'single', scope: 'session-maybe' })
  const handle = { current: null as TraceHandle | null }
  const removeBuiltin = slots.register(
    { name: TRACE_SLOT as string, id: 'builtin-trace', owner: '@agnes/web-trace', priority: 0 },
    () => createElement(Trace, { ref: handle, root: container, options }),
  )
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(slots.outlet({ name: TRACE_SLOT }))
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
export function mountTopbarRegion(
  slots: RegionSlots,
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
  slots.declare(TOPBAR_SLOT as string, { kind: 'single', scope: 'root' })
  const removeBuiltin = slots.register(
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
    root.render(slots.outlet({ name: TOPBAR_SLOT }, { rootStable: true }))
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
export function mountApprovalRegion(slots: RegionSlots, container: HTMLElement): ApprovalRegionMount {
  const handle = { current: null as ApprovalHandle | null }
  let view: ApprovalView | undefined
  const setHandle = (value: ApprovalHandle | null): void => {
    handle.current = value
    if (value) value.render(view)
  }
  slots.declare(APPROVAL_SLOT as string, { kind: 'single', scope: 'session-maybe' })
  const removeBuiltin = slots.register(
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
    root.render(slots.outlet({ name: APPROVAL_SLOT }))
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
  locale?: LocaleService
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
  slots: RegionSlots,
  container: HTMLElement,
  options: ConversationRegionOptions = {},
): ConversationRegionMount {
  const ownedShell = slots.has('root') ? undefined : mountDshShellRegion(slots)
  slots.declare(CONVERSATION_SLOT as string, { kind: 'single', scope: 'session-maybe' })
  const handle = { current: null as ConversationHandle | null }
  const removeMainConversationBuiltin = slots.register(
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
        ...(options.onMount ? { onMount: options.onMount } : {}),
        ...(options.onUnmount ? { onUnmount: options.onUnmount } : {}),
        ...(options.locale
          ? {
              translate: (key: string, vars?: Record<string, string | number>) =>
                options.locale?.t(key, vars) ?? key,
            }
          : {}),
        slots: {
          session: createElement(SlotOutlet, { name: 'conversation.session', hideWhenEmpty: true }),
          sessionHeader: createElement(SlotOutlet, {
            name: 'conversation.session.header',
            hideWhenEmpty: true,
          }),
        },
      }),
  )
  const removeSessionBuiltin = slots.register(
    {
      name: 'conversation.session',
      id: 'builtin-conversation-session',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: DSH_CONVERSATION_SESSION_CHILDREN,
    },
    () => createElement(ConversationSessionBuiltin),
  )
  const removeBuiltin = slots.register(
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
  const removeHeaderBuiltin = slots.register(
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
    root.render(slots.outlet({ name: CONVERSATION_SLOT }, { session: options.session }))
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
  slots: RegionSlots,
  container: HTMLElement,
  options: { state?: SidebarState; actions?: Partial<SidebarActions> } = {},
  locale: LocaleService,
): SidebarRegionMount {
  // Render-time lookup: navigation copy resolves on each rebuild against the current locale.
  const translate: Translate = (key, vars) => locale.t(key, vars)
  const sidebarDependencies: SidebarDependencies = {
    translate,
    bindSidebar: (narrow, ownerDocument) => bindSidebar(narrow, ownerDocument, translate),
    renderNavigation: (options) => renderSessionNavigation(options, translate),
  }
  slots.declare(SIDEBAR_SLOT as string, { kind: 'single', scope: 'root' })
  if (!slots.has('sidebar')) slots.declare('sidebar', { kind: 'single', scope: 'root' })
  const handle = { current: null as SidebarHandle | null }
  const removeDshBuiltin = slots.register(
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
        dependencies: sidebarDependencies,
      }),
  )
  const removeBuiltin = slots.register(
    { name: SIDEBAR_SLOT as string, id: 'builtin-sidebar', owner: '@agnes/web-sidebar', priority: 0 },
    () => slots.outlet({ name: 'sidebar' as never }),
  )
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(slots.outlet({ name: SIDEBAR_SLOT }, { rootStable: true }))
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
  slots: TranscriptRegionSlots,
  container: HTMLElement,
  options: {
    /** Select the React host; callers that omit it retain the legacy renderer. */
    nodeHost?: 'react'
    /** XMarkdown is available only with the explicit React host probe. */
    markdownRenderer?: 'legacy' | 'xmarkdown'
    claim?: ClaimResolver
    newContentButton?: HTMLButtonElement
    onFork?: (turn: import('@agnes/protocol').UITurn) => Promise<void>
    session?: SessionService
    locale?: LocaleService
    resources?: ClientResourceService
  } = {},
): TranscriptRegionMount {
  if (!slots.has('conversation.view'))
    slots.declare('conversation.view', { kind: 'list', scope: 'session' }, 'conversation.session')
  if (!slots.has(TRANSCRIPT_SLOT))
    slots.declare(TRANSCRIPT_SLOT as string, { kind: 'single', scope: 'session-maybe' })
  // The timeline projects each node through the registry itself; only the region goes through the port.
  const { registry } = slots
  const handle = { current: null as TranscriptHandle | null }
  const removeBuiltin = slots.register(
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
            ...(options.markdownRenderer ? { markdownRenderer: options.markdownRenderer } : {}),
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
                  ...(options.claim ? { slotCards: { registry, claim: options.claim } } : {}),
                  ...(options.session ? { session: options.session } : {}),
                  ...(options.locale ? { locale: options.locale } : {}),
                  ...(options.resources ? { resources: options.resources } : {}),
                })
              },
            },
            ...options,
          }),
  )
  const removeViewBuiltin = slots.register(
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
  const removeChatChildren = slots.register(
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
  const removeToolChildren = slots.register(
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
      slots.outlet(
        { name: 'conversation.view', fallback: createElement(SlotOutlet, { name: TRANSCRIPT_SLOT }) },
        { session: options.session, locale: options.locale, resources: options.resources },
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
  slots: RegionSlots,
  container: HTMLElement,
  services: { session?: SessionService; locale?: LocaleService } = {},
): EmptyStateRegionMount {
  if (!slots.has(EMPTY_STATE_SLOT))
    slots.declare(EMPTY_STATE_SLOT as string, { kind: 'single', scope: 'root' })
  // Priority 0 is the built-in. Third-party entries can explicitly shadow it with a lower value.
  const translate = services.locale ? (key: string) => services.locale?.t(key) ?? key : undefined
  const removeBuiltin = slots.register(
    {
      name: EMPTY_STATE_SLOT as string,
      id: 'builtin-empty-state',
      owner: '@agnes/web-empty-state',
      priority: 0,
      children: EMPTY_STATE_DSH_CHILDREN,
    },
    () => createElement(EmptyStateBuiltin, translate ? { t: translate } : {}),
  )
  container.replaceChildren()
  const root: AntdRoot = createAntdRoot(container)
  root.render(
    slots.outlet({ name: EMPTY_STATE_SLOT }, { session: services.session, locale: services.locale }),
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
