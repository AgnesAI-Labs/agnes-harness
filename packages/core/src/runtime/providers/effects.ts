import type {
  ActionContext,
  ActionHandlerScope,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { PureHookStageFailure } from '../hooks/stages.js'
import { assertAuthorSchema } from './accounting.js'

const refs = RuntimeMethodSchemaRefs['agh.effects']
const methods = RuntimeServiceCatalog['agh.effects'].methods
function safe(value: unknown) {
  const limits = RuntimeAuthorCodecPolicy.payload
  const result = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!result.ok) throw new TypeError('Invalid Effects payload')
  return result.value
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}
const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(safe(a).json) === canonicalJsonDigest(safe(b).json)
function refusal(code: 'incompatible' | 'cancelled', detailCode: string): Outcome<never> {
  return { ok: false, error: new PureHookStageFailure(code, detailCode).error }
}
function noExecution(context: CallContext): EffectResult {
  const refused = refusal(
    context.signal.aborted ? 'cancelled' : 'incompatible',
    context.signal.aborted ? 'effects_cancelled' : 'effects_stage_source_unavailable',
  )
  if (refused.ok) throw new TypeError('Unreachable Effects refusal')
  return {
    outcome: context.signal.aborted ? 'cancelled' : 'failed',
    error: refused.error,
    externalRequests: [],
    usage: [],
    references: [],
  }
}
/** Official ABI scaffold. Genuine installed stage capture is required before any execution is enabled. */
export function createDefaultEffectsFactory(
  descriptor: ProviderDescriptor,
  configCodec: AuthorSchema<EmptyAuthorConfig>,
): ProviderFactory<ServiceProvider> {
  assertAuthorSchema(configCodec)
  const checked = validateRuntime('ProviderDescriptor', safe(descriptor).json)
  if (
    !checked.ok ||
    checked.value.contract !== 'agh.effects' ||
    checked.value.major !== 1 ||
    !same(checked.value.configSchema, configCodec.ref)
  )
    throw new TypeError('Invalid official Effects descriptor')
  const fixed = checked.value
  if (fixed.operations.length !== Object.keys(methods).length)
    throw new TypeError('Effects requires the complete official method table')
  for (const [method, definition] of Object.entries(methods)) {
    const operation = fixed.operations.find((entry) => entry.method === method)
    const schema = refs[method as keyof typeof refs]
    if (
      !operation ||
      !schema ||
      operation.kind !== definition.kind ||
      !same(operation.inputSchema, schema.input) ||
      !same(operation.outputSchema, schema.output)
    )
      throw new TypeError('Effects operation differs from its official ABI')
  }
  freeze(fixed)
  return Object.freeze({
    descriptor: fixed,
    async create(config: DataRef, _dependencies: ScopedDependencies, factory: FactoryContext) {
      const parsed = validateRuntime('ScopeRef', safe(factory.scope).json)
      if (
        !parsed.ok ||
        !validateRuntime('Id', factory.instanceId).ok ||
        !validateRuntime('Id', factory.bindingId).ok ||
        factory.scope.kind !== fixed.scope ||
        factory.signal.aborted
      )
        throw new TypeError('Invalid Effects factory scope')
      const input = validateRuntime('DataRef', safe(config).json)
      if (!input.ok || input.value.kind !== 'inline' || !same(input.value.schema, fixed.configSchema))
        throw new TypeError('Effects requires the official inline empty configuration')
      const body = safe(input.value.value)
      if (
        !validateRuntime('RuntimeEmptyAuthorConfig', body.json).ok ||
        !configCodec.parse(body.json).ok ||
        body.bytes !== input.value.bytes ||
        canonicalJsonDigest(body.json) !== input.value.digest
      )
        throw new TypeError('Invalid Effects configuration proof')
      let closed = false
      const unsupported = (context: CallContext): Outcome<never> =>
        refusal(
          context.signal.aborted || factory.signal.aborted ? 'cancelled' : 'incompatible',
          closed ? 'effects_closed' : 'effects_stage_source_unavailable',
        )
      const lifecycle = () => ({
        ready: async (context: CallContext) => unsupported(context),
        health: async (_context: CallContext) => ({
          ok: true as const,
          value: {
            status: closed ? ('failed' as const) : ('degraded' as const),
            diagnosticIds: ['effects-stage-source-unavailable'],
          },
        }),
        drain: async (_deadline: string, _context: CallContext) => {
          closed = true
          return {
            ok: true as const,
            value: {
              state: 'drained' as const,
              activeInvocationIds: [],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        close: async () => {
          closed = true
        },
      })
      const provider: ServiceProvider = {
        ...lifecycle(),
        actions: Object.freeze({
          runHooks: Object.freeze({
            kind: 'leaf' as const,
            recovery: 'R0' as const,
            stateCodec: null,
            async create(_scope: ActionHandlerScope) {
              return {
                ...lifecycle(),
                kind: 'leaf' as const,
                effectSemantics: 'idempotent' as const,
                execute: async (_frame: ActionFrame, context: ActionContext) => noExecution(context.call),
                reconcile: async () => {
                  throw new PureHookStageFailure('incompatible', 'effects_reconciliation_unavailable')
                },
              }
            },
          }),
        }),
        control: async (_request, context) => unsupported(context),
      }
      return Object.freeze(provider)
    },
  })
}
