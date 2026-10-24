/**
 * @agnes/web-client — author API for Agnes in-page plugins.
 *
 * Plugin usage:
 * ```ts
 * import type { ClientContext } from '@agnes/web-client'
 * export const inject = ['slots', 'agnes']
 * export function apply(ctx: ClientContext) {
 *   ctx.slots.register('workbench.panel', MyPanel)
 * }
 * ```
 * The host wraps modules in `clientModule()` at load time, binding registrations to the plugin fiber.
 * Plugins creating their own React root with antd must read the current document's `agnes-csp-nonce`
 * meta value and pass it to `ConfigProvider`; the host handles components rendered through host slots.
 */

export type {
  DefineStoreSpec,
  StoreDecl,
  StoreHandle,
  StoreInstance,
} from '@agnes/web-slots'
export {
  defineStore,
  isWebRowId,
  packageIdFromWebRowId,
  SlotCore,
  WEB_ROW_PREFIX,
  webRowId,
} from '@agnes/web-slots'
export {
  applicationAgents,
  applicationBrand,
  applicationIdentity,
  effectiveApplication,
  presentationDefault,
  resolveApplicationBrand,
} from './application-identity.js'
export {
  type ApplicationWorkRequest,
  applicationTimelineWork,
  applicationWorkDraft,
  applicationWorkRequest,
  applicationWorkText,
  encodeApplicationWork,
  openApplicationWork,
  rememberApplicationWork,
  rememberSessionAgent,
  resolveApplicationWork,
  sessionAgentAttribution,
  sessionApplicationWork,
} from './application-work.js'
export type { ClientContext, ClientModule } from './client-module.js'
export { clientModule } from './client-module.js'
export type { ContributionAvailability } from './contribution-scope.js'
export { revokeContributionOwner, updateContributionAvailability } from './contribution-scope.js'
export { reserveHomeEntry, resolveHomeEntry } from './declared-home-entries.js'
export type { DeliverableRecord, DeliverablesSnapshot } from './deliverables.js'
export {
  DeliverablesStore,
  deliveredFiles,
  groupDeliveredFiles,
  surfaceDeliverables,
} from './deliverables.js'
export type { DshSlotDefinition, DshSlotName } from './dsh-slot-catalog.js'
export {
  DSH_PUBLIC_SLOT_NAMES,
  DSH_RUNTIME_SUPPORTED_SLOT_NAMES,
  DSH_SLOT_CATALOG,
  DSH_SLOT_CATALOG_VERSION,
  DSH_SLOT_COUNTS,
  DSH_SLOT_NAMES,
  dshSlotSpec,
  getDshSlotDefinition,
  isKnownDshSlot,
  isPublicDshSlot,
  isRuntimeSupportedDshSlot,
} from './dsh-slot-catalog.js'
export type { ExamplePageContribution } from './example-pages.js'
export type { ExternalSpecifier } from './externals.js'
export { BUILDER_VERSION, externals } from './externals.js'
export { factChainLinks, RegistrableLink, workbenchNavigation } from './fact-chain-links.js'
export { type GoalCommand, type GoalView, goalCommand, readGoal } from './goals.js'
export type { IntelligentUiRenderer, IntelligentUiRendererApi } from './intelligent-ui-renderer.js'
export { slotLocaleCatalog } from './locales.js'
export type { SlotOutletProps } from './outlet.js'
export { SlotOutlet, SlotsProvider } from './outlet.js'
export type {
  ComposerPresentationControls,
  ComposerPresentationPort,
  ConversationPresentationPort,
  NavigationHistory,
  NavigationPresentationPort,
  SessionListMode,
} from './presentation-ports.js'
export type { PresentationProvider } from './presentation-roles.js'
export {
  PresentationRoleRegistry,
  presentationRoles,
  STANDARD_PRESENTATION_ROLES,
  selectPresentationRoles,
} from './presentation-roles.js'
export type { RegisterOptions } from './registry.js'
export { SlotRegistry } from './registry.js'
export type {
  AgnesClient,
  ClientCommand,
  ClientDocumentArtifact,
  ClientDocumentKind,
  ClientDocumentLoader,
  ClientDocumentResource,
  ClientEffectCaller,
  ClientEffectCommand,
  ClientImageArtifact,
  ClientImageLoader,
  ClientImageResource,
  ClientProfileCaller,
  ClientProfileServices,
  ClientServiceApi,
  ClientServiceCaller,
  CommandAuthorizer,
  HostAgnesClient,
  LocaleCatalog,
  LocaleDictionary,
  LocaleVars,
  ModuleIdentity,
  ResolvedTheme,
  UiLocale,
} from './services.js'
export {
  AgnesClientService,
  ClientResourceReclaimedError,
  ClientResourceService,
  CommandService,
  LocaleService,
  resolveUiLocale,
  type SessionReadiness,
  SessionService,
  ThemeService,
  UI_LOCALES,
} from './services.js'
export { type PresentationHost, PresentationService } from './services-presentation.js'
export type {
  ChainRenderOpts,
  ChainSelect,
  ClientCardProps,
  DshOwnerMap,
  DshSlotProps,
  DshSlotPropsFor,
  LegacySlotMap,
  LiveSlotNode,
  ModuleRevision,
  SlotChildren,
  SlotDeclaration,
  SlotEntry,
  SlotFillView,
  SlotKind,
  SlotLabel,
  SlotMap,
  SlotName,
  SlotProps,
  SlotScope,
  SlotSpec,
  ToolCardInlineProps,
  WorkbenchPanelProps,
} from './slots.js'
export { SLOT_TABLE } from './slots.js'
export type {
  ConversationCard,
  ConversationCardInput,
  FileViewerAction,
  HomeEntry,
  HomeEntryBadge,
  HomePageSelection,
  SettingsSection,
  UiExtensionContext,
  WorkbenchPanel,
  WorkbenchPanelCount,
} from './ui-registries.js'
export {
  type ComposerInputCommand,
  composerCommands,
  conversationCards,
  fileViewerActions,
  HomeEntryRegistry,
  HomeNavigation,
  homeEntries,
  homeEntryGroups,
  homeNavigation,
  settingsSections,
  UiExtensionRegistry,
  workbenchPanels,
} from './ui-registries.js'
