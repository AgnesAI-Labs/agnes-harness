import type { ProjectionRegistry, RuntimeSlotFill, ToolSource } from '@agnes/core'
import type {
  Disposer,
  HookEvent,
  HookHandler,
  ProjectionReader,
  ResourceEntry,
  Seq,
  ServiceInstance,
  ServiceKind,
  ServiceKindToken,
  ServicePorts,
  ServiceProvider,
  SlotName,
  ToolDef,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import type { ServiceRegistry } from './services.js'

export type RegMeta = ToolSource

/** Internal assembly ports, never exposed directly to an extension factory. */
export interface KernelPorts {
  services: Pick<ServiceRegistry, 'register' | 'registerRow'>
  projections: {
    register: ProjectionRegistry['register']
    read(
      key: string,
      meta: RegMeta,
      beforeFold: () => void,
    ): Promise<{ asOfSeq: number; unit: ReturnType<ProjectionRegistry['snapshotOne']> }>
  }
  tools: { add(def: ToolDef, meta: RegMeta): Disposer }
  hooks: { on<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>, meta: RegMeta): Disposer }
  slots: { register<S extends SlotName>(slot: S, fill: NoInfer<RuntimeSlotFill<S>>, meta: RegMeta): Disposer }
  resources: { register(entry: ResourceEntry, meta: RegMeta): Disposer }
  extEvents: { append(type: string, data: JsonValue, meta: RegMeta): Promise<Seq> }
  /** Host grant for the shared service facade. Absent on hosts that do not install it. */
  serviceProviders?: {
    register<S extends ServiceInstance, P extends ServicePorts>(
      kind: ServiceKind<S, P>,
      provider: ServiceProvider<S, P>,
      identity: { readonly owner: string; readonly packageId: string },
    ): () => Promise<void>
    bindOwn<S extends ServiceInstance, P extends ServicePorts>(
      kind: ServiceKind<S, P>,
      identity: {
        readonly owner: string
        readonly packageId: string
        readonly trust: 'builtin' | 'trusted'
        readonly recheck: () => void
        readonly projections: ProjectionReader
      },
    ): Promise<S>
    /** Present after the kind is installed. Missing means the events check waits until bind. */
    grants?(
      kind: ServiceKindToken,
    ): { readonly events: boolean; readonly projections: readonly string[] } | undefined
  }
  /** Live registration ownership for cleanup verification, not an execution snapshot. */
  registrations(source: string): string[]
}
