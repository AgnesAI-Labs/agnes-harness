import type { JsonValue } from '@agnes/protocol'
import type { Disposer, Seq } from './common.js'
import type { ExtensionContext } from './extension.js'
import type { HookEvent, HookHandler } from './hooks.js'
import type { ProjectionCapability, ProjectionDef } from './projections.js'
import type { ProviderRegistrationPort } from './provider-kind.js'
import type { ResourceEntry } from './resources.js'
import type { ServiceDef } from './services.js'
import type { SlotFill, SlotName } from './slots.js'
import type { ToolRegistrationPort } from './tool.js'

/**
 * An installed package states the event types and state ceiling inline; a bundled package states
 * them once in its manifest `capabilities.projections`, which the Host matches by name.
 */
export type PluginProjectionDef<S extends JsonValue = JsonValue> = ProjectionDef<S> &
  Partial<Omit<ProjectionCapability, 'name'>>

export interface PluginHooksPort {
  /** Any of the 16 hook events. Observe-only events ignore the handler result. */
  register<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>): Disposer
}
export interface PluginProjectionsPort {
  register<S extends JsonValue>(def: PluginProjectionDef<S>): Disposer
}
export interface PluginServicesPort {
  register(def: ServiceDef): Disposer
}
export interface PluginSlotsPort {
  register<S extends SlotName>(slot: S, fill: NoInfer<SlotFill<S>>): Disposer
}
export interface PluginResourcesPort {
  register(entry: ResourceEntry): Disposer
}
/** Appends to the plugin's own namespace of the session ledger (`x/<id>/<name>`). */
export interface PluginEventLogPort {
  append(name: string, data: JsonValue): Promise<Seq>
}

/**
 * Everything a plugin may register or read through its context, for official and third-party
 * packages alike. A plugin lists the facets it uses in `inject`; the Host refuses a facet its
 * trust tier or declared capabilities do not grant, as data, not as a different API.
 */
export interface PluginContextFacets {
  readonly tools: ToolRegistrationPort
  readonly hooks: PluginHooksPort
  readonly projections: PluginProjectionsPort
  readonly services: PluginServicesPort
  readonly slots: PluginSlotsPort
  readonly resources: PluginResourcesPort
  readonly eventLog: PluginEventLogPort
  readonly providers: ProviderRegistrationPort
  /** Current-profile managed resources and streams for reviewed installed plugin rows. */
  readonly profileRuntime: import('./profile-runtime.js').PluginProfileRuntimePort
  /** Identity, trust tier, logger, abort signal and platform facts of this plugin. */
  readonly self: ExtensionContext
}

export type PluginFacetName = keyof PluginContextFacets
export const PLUGIN_FACET_NAMES: readonly PluginFacetName[] = Object.freeze([
  'tools',
  'hooks',
  'projections',
  'services',
  'slots',
  'resources',
  'eventLog',
  'providers',
  'self',
  'profileRuntime',
])
