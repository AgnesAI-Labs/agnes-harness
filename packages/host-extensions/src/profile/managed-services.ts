import {
  managedServiceCapabilities,
  type PluginServicesPort,
  type ServiceContext,
  type ServiceDef,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'

/** Generic managed resource administration uses the same native effect journal as plugin effects. */
export function registerManagedServices(
  id: string,
  services: PluginServicesPort,
  handle: {
    configuration(): JsonValue
    status(): JsonValue
    reconcile(context: ServiceContext): Promise<JsonValue>
    retry(): Promise<JsonValue>
    configure(input: JsonValue): Promise<JsonValue>
    check(input: JsonValue, signal: AbortSignal): Promise<JsonValue>
  },
  settled: () => Promise<void>,
  configSchema: ServiceDef['inputSchema'],
  checkSchema?: ServiceDef['inputSchema'],
  recovery?: () => JsonValue,
) {
  for (const capability of managedServiceCapabilities(id, configSchema, checkSchema)) {
    const method = capability.name.slice(id.length + 1)
    services.register({
      ...capability,
      async handler(input, context) {
        await settled()
        if (capability.kind === 'effect' && method !== 'reconcile' && !context.admission?.approval)
          throw new Error('native-admission-required')
        if (method === 'status') return handle.status()
        if (method === 'configuration') return handle.configuration()
        if (method === 'reconcile') return handle.reconcile(context)
        if (method === 'retry') return handle.retry()
        if (method === 'configure') return handle.configure(input)
        try {
          return await handle.check(input, context.signal)
        } catch (error) {
          context.signal.throwIfAborted()
          const status = handle.status() as { state?: string; code?: string }
          if (!recovery || status.state !== 'failed' || status.code === 'shutdown-unconfirmed') throw error
          return recovery()
        }
      },
    })
  }
}
