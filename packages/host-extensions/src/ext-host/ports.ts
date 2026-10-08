import type { ProjectionRegistry, RuntimeSlotFill, ToolSource } from '@agnes/core'
import type {
  Disposer,
  HookEvent,
  HookHandler,
  ResourceEntry,
  Seq,
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
  /** Live registration ownership for cleanup verification, not an execution snapshot. */
  registrations(source: string): string[]
}
