import type { PluginContextFacets, ServiceCapability, ServiceContext, ServiceDef } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { BatchError } from './contracts.js'
import { validateSpec } from './schema.js'
import type { BatchService } from './service.js'

/** Resolves only Host-admitted owner/workspace identity. Request data cannot select another owner. */
export type BatchConnector = (context: ServiceContext) => Promise<BatchService>
const verbs = ['start', 'status', 'results', 'cancel', 'resume', 'list', 'export'] as const
const queries = new Set<string>(['status', 'results', 'list'])
const id = { type: 'string', pattern: '^b[0-9a-f]{12}$' }
function capability(verb: (typeof verbs)[number]): ServiceCapability {
  const properties: Record<string, JsonValue> =
    verb === 'start'
      ? {
          id,
          dir: { type: 'string', minLength: 1, maxLength: 4096 },
          spec: { type: 'object' },
          extensions: { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^[a-z0-9]{1,10}$' } },
        }
      : verb === 'list'
        ? { cursor: { type: 'string', maxLength: 2048 } }
        : verb === 'results'
          ? {
              id,
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 3 },
            }
          : verb === 'export'
            ? { id, out: { type: 'string', minLength: 1, maxLength: 4096 } }
            : { id }
  return {
    name: `batch.${verb}`,
    kind: queries.has(verb) ? 'query' : 'effect',
    inputSchema: {
      type: 'object',
      properties,
      required:
        verb === 'start'
          ? ['id', 'dir', 'spec']
          : verb === 'list'
            ? []
            : verb === 'export'
              ? ['id', 'out']
              : ['id'],
      additionalProperties: false,
    },
    outputSchema: {},
    timeoutMs: 30_000,
    maxResultBytes: 128 * 1024,
  }
}
export const BATCH_SERVICES = verbs.map(capability)
function definition(verb: (typeof verbs)[number], connector: BatchConnector): ServiceDef {
  return {
    ...capability(verb),
    async handler(input, context) {
      const service = await connector(context)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BatchError('E_BATCH_REQUEST')
      // The Host validates the strict input schema before calling this handler.
      let output: unknown
      switch (verb) {
        case 'start':
          output = await service.start({
            id: String(input.id),
            dir: String(input.dir),
            spec: validateSpec(input.spec),
            ...(Array.isArray(input.extensions) && input.extensions.every((v) => typeof v === 'string')
              ? { extensions: input.extensions }
              : {}),
          })
          break
        case 'list':
          output = await service.list(typeof input.cursor === 'string' ? input.cursor : undefined)
          break
        case 'results':
          output = await service.results(
            String(input.id),
            typeof input.offset === 'number' ? input.offset : undefined,
            typeof input.limit === 'number' ? input.limit : undefined,
          )
          break
        case 'export':
          output = await service.export(String(input.id), String(input.out))
          break
        default:
          output = await service[verb](String(input.id))
      }
      return JSON.parse(JSON.stringify(output)) as JsonValue
    },
  }
}
/** Factory for the runtime's reviewed owner-bound connector; it never constructs authority itself. */
export function createBatchPlugin(connector: BatchConnector) {
  return {
    inject: ['services'],
    apply(context: Pick<PluginContextFacets, 'services'>) {
      const disposers: (() => void)[] = []
      try {
        for (const verb of verbs) disposers.push(context.services.register(definition(verb, connector)))
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
  }
}
/** Older Hosts must refuse installation instead of starting unconstrained child sessions. */
export const batchPlugin = {
  inject: ['services'],
  apply(): never {
    throw new BatchError('E_BATCH_MANAGED_CONNECTOR_REQUIRED')
  },
}
