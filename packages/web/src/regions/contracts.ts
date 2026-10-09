import { createPermissionPicker } from '@agnes/web-admin/permission-picker'
import { type SlotName, type SlotRegistry } from '@agnes/web-client'
import { isComposerSubmitShortcut, resizeComposer } from '@agnes/web-conversation/presentation'
import { createUsagePanel } from '@agnes/web-conversation/usage'
import { ConversationUsage } from '@agnes/web-ui/assistant-ui'
import {
  type ComposerDependencies,
  type ConversationChildContainers,
  type ConversationHandle,
  downscaleImageFile,
  type SettingsPane,
  type TranscriptDependencies,
} from '@agnes/web-units'
import { observeSlotCards } from '../client-modules/timeline-slot.js'
import { createModelPicker } from '../model-picker.js'
import { bindSidebar } from '../shell.js'
import { createTimelineRenderer } from '../timeline.js'

export type { ConversationChildContainers, ConversationHandle } from '@agnes/web-units'

export const SIDEBAR_DEPENDENCIES_BASE = {
  bindSidebar,
}

export const TRANSCRIPT_DEPENDENCIES: TranscriptDependencies = {
  createRenderer: createTimelineRenderer,
  observeCards: observeSlotCards,
}

export const COMPOSER_DEPENDENCIES: Omit<ComposerDependencies, 'translate'> = {
  createModelPicker,
  createPermissionPicker,
  createUsagePanel,
  downscaleImage: downscaleImageFile,
  UsagePanel: ConversationUsage,
  isSubmitShortcut: isComposerSubmitShortcut,
  resize: resizeComposer,
}

export const COMPOSER_DSH_CHILDREN = Object.freeze({
  'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
  'conversation.input.dock': { kind: 'list', scope: 'session' },
  'conversation.input.left': { kind: 'list', scope: 'session' },
  'conversation.input.model': { kind: 'single', scope: 'session' },
  'conversation.input.overlay': { kind: 'list', scope: 'session' },
  'conversation.input.permission': { kind: 'single', scope: 'session' },
  'conversation.input.plan': { kind: 'single', scope: 'session' },
  'conversation.input.right': { kind: 'list', scope: 'session' },
} as const)

export const COMPOSER_BAR_DSH_CHILDREN = Object.freeze({
  'conversation.composer.dock': { kind: 'list', scope: 'session' },
  ...COMPOSER_DSH_CHILDREN,
} as const)

export const DSH_ROOT_CHILDREN = Object.freeze({
  main: { kind: 'keyed', scope: 'root' },
  rightbar: { kind: 'single', scope: 'root' },
  sidebar: { kind: 'single', scope: 'root' },
  'shell.overlay': { kind: 'list', scope: 'root' },
} as const)

export const DSH_MAIN_CONVERSATION_CHILDREN = Object.freeze({
  'conversation.composer': { kind: 'chain', scope: 'session' },
  'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  'conversation.session': { kind: 'single', scope: 'session' },
} as const)

export const DSH_CONVERSATION_SESSION_CHILDREN = Object.freeze({
  'conversation.session.header': { kind: 'single', scope: 'session' },
  'conversation.view': { kind: 'list', scope: 'session' },
} as const)

export const RIGHTBAR_SESSION_CHILDREN = Object.freeze({
  'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
  'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
  'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' },
} as const)

export const RIGHTBAR_DOCUMENT_CHILDREN = Object.freeze({
  'sidebar.right.tab.document': { kind: 'keyed', scope: 'session' },
} as const)

export const RIGHTBAR_GUIDE_CHILDREN = Object.freeze({
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

export const CONVERSATION_DSH_CHILDREN = Object.freeze({
  ...DSH_MAIN_CONVERSATION_CHILDREN,
} as const)

export const CONVERSATION_HEADER_DSH_CHILDREN = Object.freeze({
  'conversation.session.header.actions': { kind: 'list', scope: 'session' },
  'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
  'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
} as const)

export const EMPTY_STATE_DSH_CHILDREN = Object.freeze({
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

export const SETTINGS_UNIT_OWNER: Readonly<Record<SettingsPane, string>> = {
  model: '@agnes/web-settings-model',
  plugin: '@agnes/web-settings-plugins',
  resources: '@agnes/web-settings-resources',
  archived: '@agnes/web-settings-archived',
  'computer-use': '@agnes/web-settings-computer-use',
  appearance: '@agnes/web-settings-appearance',
}

export const SETTINGS_DSH_GLOBAL_SLOT_NAMES = new Set([
  'settings.trigger',
  'settings.header',
  'settings.action',
  'settings.close',
  'settings.onboarding',
  'settings.section',
])

export interface EmptyStateRegionMount {
  dispose(): void
}

/** Root-scoped regions must not remount when a session-scoped sibling changes session. */
export function rootStableRegistry(registry: SlotRegistry): SlotRegistry {
  const stable = Object.create(registry) as SlotRegistry
  Object.defineProperty(stable, 'sessionId', { configurable: true, get: () => undefined })
  Object.defineProperty(stable, 'subscribeSession', { configurable: true, value: () => () => undefined })
  return stable
}
