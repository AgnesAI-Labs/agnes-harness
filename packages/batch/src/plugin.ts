import { createHash } from 'node:crypto'
import type { PluginContextFacets, ServiceCapability, ServiceContext, ServiceDef } from '@agnes/extension-api'
import { type JsonValue, jcs } from '@agnes/protocol'
import { BatchError } from './contracts.js'
import { BATCH_CONFIG_SCHEMA, startProfileBatch } from './runtime.js'
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
          workspaceRoot: { type: 'string', minLength: 1, maxLength: 4096 },
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
  const common = {
    name: `batch.${verb}`,
    scope: 'profile' as const,
    inputSchema: {
      type: 'object' as const,
      properties,
      required:
        verb === 'start'
          ? ['id', 'dir', 'spec']
          : verb === 'list'
            ? []
            : verb === 'export'
              ? ['id', 'out']
              : ['id'],
      additionalProperties: false as const,
    },
    outputSchema: {},
    timeoutMs: 30_000,
    maxResultBytes: 128 * 1024,
  }
  if (queries.has(verb)) return { ...common, kind: 'query' }
  return {
    ...common,
    kind: 'effect',
    ...(verb === 'cancel' ? { priority: 'urgent' as const } : {}),
    effectPolicy: {
      isDestructive: verb !== 'cancel',
      isOpenWorld: true,
      replay: 'never',
      requiresApproval: verb === 'cancel' ? 'never' : 'always',
      approvalScopes: [],
    },
  }
}
export const BATCH_SERVICES = verbs.map(capability)
function definition(verb: (typeof verbs)[number], connector: BatchConnector): ServiceDef {
  return {
    ...capability(verb),
    ...(!queries.has(verb)
      ? {
          async prepare(input: JsonValue, context: ServiceContext) {
            context.signal.throwIfAborted()
            if (context.scope?.kind !== 'profile') throw new BatchError('E_BATCH_PROFILE_REQUIRED')
            if (!input || typeof input !== 'object' || Array.isArray(input))
              throw new BatchError('E_BATCH_REQUEST')
            const binding = (await connector(context)).reviewBinding()
            const spec = verb === 'start' ? validateSpec(input.spec) : undefined
            const prepared = spec ? { ...input, spec } : input
            return {
              input: JSON.parse(JSON.stringify(prepared)) as JsonValue,
              presentation: {
                action: `batch.${verb}`,
                workspaceRoot: binding.workspaceRoot,
                id: String(input.id),
                ...(spec
                  ? {
                      dir: String(input.dir),
                      budget: spec.budget,
                      concurrency: spec.concurrency,
                      promptPreview: spec.prompt.slice(0, 512).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '),
                      inputDigest: createHash('sha256')
                        .update(jcs(prepared as unknown as JsonValue))
                        .digest('hex'),
                    }
                  : {}),
                ...(verb === 'export' ? { out: String(input.out) } : {}),
              },
            }
          },
        }
      : {}),
    async handler(input, context) {
      context.signal.throwIfAborted()
      if (context.scope?.kind !== 'profile') throw new BatchError('E_BATCH_PROFILE_REQUIRED')
      if (
        !queries.has(verb) &&
        (!context.admission ||
          (verb !== 'cancel' && !context.admission.approval) ||
          jcs(context.admission.prepared.input) !== jcs(input))
      )
        throw new BatchError('E_BATCH_NATIVE_ADMISSION_REQUIRED')
      const service = (await connector(context)).withSignal(context.signal)
      if (
        verb === 'start' &&
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        input.workspaceRoot !== undefined &&
        input.workspaceRoot !== service.reviewBinding().workspaceRoot
      )
        throw new BatchError('E_BATCH_BINDING_CHANGED')
      if (!queries.has(verb)) {
        const presentation = context.admission!.prepared.presentation
        if (
          !presentation ||
          typeof presentation !== 'object' ||
          Array.isArray(presentation) ||
          presentation.workspaceRoot !== service.reviewBinding().workspaceRoot
        )
          throw new BatchError('E_BATCH_BINDING_CHANGED')
      }
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
/** Installed profile singleton, using the public SDK rather than a child dispatch seam. */
export const batchPlugin = {
  inject: ['services', 'profileRuntime'],
  apply(context: Pick<PluginContextFacets, 'services' | 'profileRuntime'>) {
    const resource = context.profileRuntime.register({
      id: 'batchWorker',
      configSchema: BATCH_CONFIG_SCHEMA,
      defaultConfig: {},
      start: startProfileBatch,
    })
    return createBatchPlugin(async () => resource.get()).apply(context)
  },
}
