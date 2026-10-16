import type { JsonValue } from '@agnes/protocol'
import type { BoundWakes, OwnedStore } from './profile-services.js'
import type { PluginStreamsPort, StreamContext } from './streams.js'

/** A trusted backend resource in the current profile worker. It is never session-owned. */
export interface ProfileManagedInit {
  readonly signal: AbortSignal
  readonly store: OwnedStore
  readonly wakes: BoundWakes
  readonly config: JsonValue
  readonly listeners: Readonly<Record<string, { host: '127.0.0.1'; port: number }>>
  assertCurrent(): void
  ready(): void
  onShutdown(
    handler: (reason: 'disable' | 'upgrade' | 'exit') => Promise<{ state: 'settled' | 'unknown' }>,
  ): void
}
export interface ProfileManagedDefinition<T> {
  id: string
  configSchema: import('./services.js').ServiceDef['inputSchema']
  checkSchema?: import('./services.js').ServiceDef['inputSchema']
  defaultConfig: JsonValue
  start(init: ProfileManagedInit): Promise<T>
  check?(value: T, input: JsonValue, signal: AbortSignal): Promise<JsonValue>
}
export interface ProfileManagedHandle<T> {
  /** Resolves only the current, ready resource. Old pinned code cannot revive it. */
  get(): Promise<T>
}
export interface PluginProfileRuntimePort {
  /** The reviewed managedServices declaration owns listeners and deadlines.
   * Registers generic `<id>.status`, `.retry`, `.reconcile`, `.configure` and `.check` profile services.
   * Configuration/retry retain native effect admission; status never returns private credentials. */
  register<T>(definition: ProfileManagedDefinition<T>): ProfileManagedHandle<T>
  /** Forward an own authenticated producer stream to an explicitly reviewed managed `requires` grant.
   * Both activations remain current on every frame; this never grants motion authority. */
  connectProducer(
    target: { extension: string; name: string },
    input: JsonValue,
    context: StreamContext,
  ): Promise<void>
  readonly streams: PluginStreamsPort
}

/** Static declarations for the Host-provided managed facade, for package capability review. */
export function managedServiceCapabilities(
  id: string,
  configSchema: import('./services.js').ServiceDef['inputSchema'],
  checkSchema?: import('./services.js').ServiceDef['inputSchema'],
): import('./services.js').ServiceCapability[] {
  const empty = { type: 'object', properties: {}, additionalProperties: false } as const
  return (['status', 'configuration', 'check', 'retry', 'reconcile', 'configure'] as const).map((method) => {
    const common = {
      name: `${id}.${method}`,
      scope: 'profile' as const,
      inputSchema:
        method === 'configure' ? configSchema : method === 'check' ? (checkSchema ?? empty) : empty,
      outputSchema: {},
      timeoutMs: 30000,
      maxResultBytes: 65536,
    }
    return method === 'retry' || method === 'reconcile' || method === 'configure'
      ? {
          ...common,
          kind: 'effect' as const,
          effectPolicy: {
            isDestructive: true,
            isOpenWorld: true,
            replay: 'never' as const,
            requiresApproval: 'always' as const,
            approvalScopes: [],
          },
        }
      : { ...common, kind: 'query' as const }
  })
}
