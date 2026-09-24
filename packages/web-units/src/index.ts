import { webRowId } from '@agnes/web-slots'

export {
  Approval,
  type ApprovalAction,
  type ApprovalHandle,
  type ApprovalProps,
  type ApprovalView,
} from './approval.js'
export {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerRegionOptions,
  type ComposerSlots,
  type ComposerView,
  type ModelPickerOption,
  type ModelPickerState,
  type PermissionMode,
  type PermissionPickerState,
} from './composer.js'
export {
  type ConversationAttachmentsRenderer,
  createConversationAttachmentsRenderer,
} from './conversation/attachments.js'
export { type ConversationFeedback, createConversationFeedback } from './conversation/feedback.js'
export {
  type ConversationMessageActionOptions,
  type ConversationMessageActionState,
  type ConversationMessageActions,
  createConversationMessageActions,
} from './conversation/message-actions.js'
export {
  type ConversationToolCard,
  type ConversationToolCardOptions,
  createConversationToolCard,
} from './conversation/tool-card.js'
export {
  Conversation,
  type ConversationChildContainers,
  type ConversationHandle,
  type ConversationProps,
} from './conversation.js'
export type {
  BrowserLog,
  BrowserLogEntry,
  DiagnosticsArtifact,
  DiagnosticsBundle,
  DiagnosticsInclude,
  DiagnosticsWarning,
  LogTail,
} from './diagnostics-types.js'
export { escapeBundleJson, renderDiagnosticsViewer } from './diagnostics-viewer.js'
export { buildZip, type ZipEntry } from './diagnostics-zip.js'
export type {
  SettingsDshSlotName,
  SettingsPane,
  SettingsPaneChange,
  SettingsRegionHandle,
  SettingsRegionOptions,
  SettingsResourceTab,
} from './settings.js'
export {
  PANE_IDS,
  renderSettingsMarkup,
  SETTINGS_DSH_SLOT_NAMES,
  SettingsBuiltin,
  SettingsPaneBuiltin,
  settingsDshSlotHostId,
  settingsPaneSlotHostId,
} from './settings.js'
export {
  EMPTY_SIDEBAR_STATE,
  type SessionAction,
  Sidebar,
  type SidebarActions,
  type SidebarDependencies,
  type SidebarHandle,
  type SidebarNavigationOptions,
  type SidebarShell,
  type SidebarSlots,
  type SidebarState,
} from './sidebar.js'
export { Topbar, type TopbarConnectionState, type TopbarHandle } from './topbar.js'
export {
  buildTraceRows,
  durationLabel,
  TRACE_PANEL_STORAGE_KEY,
  Trace,
  type TraceHandle,
  type TraceMeta,
  type TracePanel,
  type TracePanelOptions,
  type TraceProps,
  type TraceRow,
  traceRowBuilder,
} from './trace.js'
export {
  Transcript,
  type TranscriptDependencies,
  type TranscriptHandle,
  type TranscriptMeta,
  type TranscriptProps,
  type TranscriptRenderer,
} from './transcript.js'

/** The contribution half of one built-in `web:` row. */
export interface WebUnitContribution {
  readonly entry: string
  readonly styles: readonly string[]
  readonly slots: readonly string[]
  readonly services: readonly string[]
  readonly projections: readonly string[]
}

/**
 * Stable identity and lifecycle contract for a built-in web unit.
 *
 * Built-ins use the same row shape as installed client modules. Their rows are
 * always available from the Web bundle and therefore do not depend on a daemon
 * roster fetch. `owner` is the registry ownership key used for atomic removal.
 */
export interface WebUnitDefinition {
  readonly packageId: string
  readonly rowId: string
  readonly moduleName: string
  readonly entry: string
  readonly contributes: WebUnitContribution
  readonly scope: 'root' | 'session-maybe' | 'session'
  readonly kind: 'single' | 'list' | 'keyed' | 'chain'
  readonly priority: number
  readonly dependencies: readonly string[]
}

const unit = (
  packageId: string,
  entry: string,
  slots: readonly string[],
  scope: WebUnitDefinition['scope'],
  dependencies: readonly string[] = [],
): WebUnitDefinition => ({
  packageId,
  rowId: webRowId(packageId),
  moduleName: packageId,
  entry,
  contributes: {
    entry,
    styles: [],
    slots,
    services: [],
    projections: [],
  },
  scope,
  kind: 'single',
  priority: 0,
  dependencies,
})

/**
 * The first built-in unit cut. The six settings panes and conversation child
 * fills are intentionally separate rows: unregistering one row must not remove
 * its siblings or the conversation shell.
 */
export const BUILTIN_WEB_UNITS: readonly WebUnitDefinition[] = Object.freeze([
  unit('@agnes/web-sidebar', './sidebar.js', ['ui:sidebar'], 'root'),
  unit('@agnes/web-transcript', './transcript.js', ['ui:transcript'], 'session-maybe'),
  unit('@agnes/web-conversation', './conversation.js', ['ui:conversation'], 'session-maybe'),
  unit('@agnes/web-topbar', './topbar.js', ['ui:topbar'], 'root'),
  unit('@agnes/web-approval', './approval.js', ['ui:approval'], 'session-maybe'),
  unit('@agnes/web-composer', './composer.js', ['ui:composer'], 'session-maybe'),
  unit('@agnes/web-trace', './trace.js', ['ui:trace'], 'session-maybe'),
  unit('@agnes/web-rightbar', './rightbar.js', ['rightbar'], 'root'),
  unit('@agnes/web-empty-state', './empty-state.js', ['ui:empty-state'], 'root'),
  unit('@agnes/web-settings-model', './settings/model.js', ['ui:settings-pane.model'], 'root'),
  unit('@agnes/web-settings-plugins', './settings/plugins.js', ['ui:settings-pane.plugins'], 'root'),
  unit('@agnes/web-settings-resources', './settings/resources.js', ['ui:settings-pane.resources'], 'root'),
  unit(
    '@agnes/web-settings-computer-use',
    './settings/computer-use.js',
    ['ui:settings-pane.computer-use'],
    'root',
  ),
  unit('@agnes/web-settings-archived', './settings/archived.js', ['ui:settings-pane.archived'], 'root'),
  unit('@agnes/web-settings-appearance', './settings/appearance.js', ['ui:settings-pane.appearance'], 'root'),
  unit(
    '@agnes/web-conversation-message-actions',
    './conversation/message-actions.js',
    ['conversation.message.actions'],
    'session-maybe',
    ['@agnes/web-conversation'],
  ),
  unit(
    '@agnes/web-conversation-attachments',
    './conversation/attachments.js',
    ['conversation.attachments'],
    'session-maybe',
    ['@agnes/web-conversation'],
  ),
  unit(
    '@agnes/web-conversation-tool-card',
    './conversation/tool-card.js',
    ['conversation.tool-card'],
    'session-maybe',
    ['@agnes/web-conversation'],
  ),
  unit(
    '@agnes/web-conversation-feedback',
    './conversation/feedback.js',
    ['conversation.feedback'],
    'session-maybe',
    ['@agnes/web-conversation'],
  ),
])

const byPackageId = new Map(BUILTIN_WEB_UNITS.map((definition) => [definition.packageId, definition]))

export function getBuiltinWebUnit(packageId: string): WebUnitDefinition | undefined {
  return byPackageId.get(packageId)
}

export function builtinWebUnitRoster(): readonly WebUnitDefinition[] {
  return BUILTIN_WEB_UNITS
}

export interface MountedWebUnit {
  readonly definition: WebUnitDefinition
  readonly dispose: () => void
}

/**
 * Small lifecycle ledger for host-owned units. It intentionally knows nothing
 * about React: a mount can be a region handle, a child outlet, or a future
 * independent bundle. Removing one key only invokes that key's disposer.
 */
export class BuiltinWebUnitRegistry {
  private readonly mounted = new Map<string, MountedWebUnit>()

  mount(packageId: string, dispose: () => void): () => void {
    const definition = getBuiltinWebUnit(packageId)
    if (!definition) throw new Error(`unknown built-in web unit: ${packageId}`)
    if (this.mounted.has(packageId)) throw new Error(`web unit already mounted: ${packageId}`)
    for (const dependency of definition.dependencies) {
      if (!this.mounted.has(dependency)) {
        throw new Error(`web unit ${packageId} requires mounted dependency ${dependency}`)
      }
    }
    let live = true
    const mounted: MountedWebUnit = {
      definition,
      dispose: () => {
        if (!live) return
        live = false
        dispose()
      },
    }
    this.mounted.set(packageId, mounted)
    return () => this.unmount(packageId)
  }

  unmount(packageId: string): void {
    // A parent row owns its child declarations. Remove dependents first so a
    // child can never remain live against a collapsed parent slot.
    for (const [candidateId, candidate] of [...this.mounted]) {
      if (candidate.definition.dependencies.includes(packageId)) this.unmount(candidateId)
    }
    const mounted = this.mounted.get(packageId)
    if (!mounted) return
    this.mounted.delete(packageId)
    mounted.dispose()
  }

  get(packageId: string): MountedWebUnit | undefined {
    return this.mounted.get(packageId)
  }

  snapshot(): readonly Readonly<{
    rowId: string
    moduleName: string
    enabled: true
    phase: 'ready'
    entryUrl: string
    styleUrls: readonly string[]
    slots: readonly string[]
    extIds: readonly string[]
  }>[] {
    return [...this.mounted.values()].map(({ definition }) => ({
      rowId: definition.rowId,
      moduleName: definition.moduleName,
      enabled: true as const,
      phase: 'ready' as const,
      entryUrl: definition.entry,
      styleUrls: [...definition.contributes.styles],
      slots: [...definition.contributes.slots],
      extIds: [],
    }))
  }

  dispose(): void {
    for (const mounted of [...this.mounted.values()].reverse()) mounted.dispose()
  }
}

/** Stable row projection consumed by diagnostics and the browser roster view. */
export function builtinWebUnitRows(): readonly Readonly<{
  rowId: string
  moduleName: string
  enabled: true
  phase: 'ready'
  entryUrl: string
  styleUrls: readonly string[]
  slots: readonly string[]
  extIds: readonly string[]
}>[] {
  return BUILTIN_WEB_UNITS.map((definition) => ({
    rowId: definition.rowId,
    moduleName: definition.moduleName,
    enabled: true as const,
    phase: 'ready' as const,
    entryUrl: definition.entry,
    styleUrls: [...definition.contributes.styles],
    slots: [...definition.contributes.slots],
    extIds: [],
  }))
}

export function assertBuiltinWebUnitContract(definition: WebUnitDefinition): void {
  if (definition.rowId !== webRowId(definition.packageId)) {
    throw new Error(`web unit ${definition.packageId} has an unstable row id`)
  }
  if (definition.contributes.entry !== definition.entry) {
    throw new Error(`web unit ${definition.packageId} has mismatched entry metadata`)
  }
  if (definition.contributes.slots.length === 0) {
    throw new Error(`web unit ${definition.packageId} must declare at least one slot`)
  }
  const dependencies = new Set(definition.dependencies)
  if (dependencies.has(definition.packageId)) {
    throw new Error(`web unit ${definition.packageId} cannot depend on itself`)
  }
}

for (const definition of BUILTIN_WEB_UNITS) assertBuiltinWebUnitContract(definition)
