/**
 * @agnes/web-client — Agnes 页面内插件的作者 API（web 客户端模块设计 WC6）。
 *
 * 插件写法：
 * ```ts
 * import type { ClientContext } from '@agnes/web-client'
 * export const inject = ['slots', 'agnes']
 * export function apply(ctx: ClientContext) {
 *   ctx.slots.register('workbench.panel', MyPanel)
 * }
 * ```
 * 宿主装载时经 `clientModule()` 包装，注册自动绑定插件 fiber。
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
export type { ClientContext, ClientModule } from './client-module.js'
export { clientModule } from './client-module.js'
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
export type { ExternalSpecifier } from './externals.js'
export { BUILDER_VERSION, externals } from './externals.js'
export type { SlotOutletProps } from './outlet.js'
export { SlotOutlet, SlotsProvider } from './outlet.js'
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
  ClientServiceApi,
  ClientServiceCaller,
  CommandAuthorizer,
  HostAgnesClient,
  LocaleDictionary,
  ModuleIdentity,
  ResolvedTheme,
} from './services.js'
export {
  AgnesClientService,
  ClientResourceReclaimedError,
  ClientResourceService,
  CommandService,
  LocaleService,
  SessionService,
  ThemeService,
} from './services.js'
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
