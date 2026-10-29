import type { JsonValue } from '@agnes/protocol'
import type { Disposer, Seq } from './common.js'
import type { ExtensionContext } from './extension.js'
import type { HookEvent, HookHandler } from './hooks.js'
import type { ProjectionDef } from './projections.js'
import type { ResourceEntry } from './resources.js'
import type { ServiceAuthorPort } from './service-provider.js'
import type { ServiceDef } from './services.js'
import type { SlotFill, SlotName } from './slots.js'
import type { ToolDef } from './tool.js'

/**
 * Host backend port behind the plugin context facets (`PluginContextFacets`): six controlled
 * registrations, the provider facade, events and ctx. A plugin never receives this object; the Host
 * builds the facets over it for a bundled package and over row services for an installed one.
 * It is exported from `@agnes/extension-api/host` only, for Host adapters.
 */
export interface ExtensionAPI {
  registerService<I extends JsonValue, O extends JsonValue>(def: ServiceDef<I, O>): Disposer
  registerProjection<S extends JsonValue>(def: ProjectionDef<S>): Disposer
  /** The name carries `capabilities.tools.prefix`; a duplicate is `E_REGISTRY_DUPLICATE` at startup. */
  registerTool(def: ToolDef): Disposer
  /** The event is listed in `capabilities.hooks`. */
  registerHook<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>): Disposer
  /** The slot is listed in `capabilities.slots`. */
  registerSlot<S extends SlotName>(slot: S, fill: NoInfer<SlotFill<S>>): Disposer
  /** The kind is listed in `capabilities.resources`. */
  registerResource(entry: ResourceEntry): Disposer
  /** Appends `x/<extId>/<name>`; needs `capabilities.events`. */
  readonly events: { append(name: string, data: JsonValue): Promise<Seq> }
  /** Capability-checked facade over the host provider registry. Package and owner are host-supplied. */
  readonly providers: ServiceAuthorPort
  readonly ctx: ExtensionContext
}

/** How the Host mounts a bundled extension over its backend port. */
// biome-ignore lint/suspicious/noConfusingVoidType: a factory may return nothing, a Disposer, or a promise of either
export type ExtensionFactory = (agnes: ExtensionAPI) => void | Disposer | Promise<void | Disposer>
