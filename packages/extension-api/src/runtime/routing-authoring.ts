import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  MAX_AUTHOR_INLINE_BYTES,
  type ModelRouteSnapshot,
  type ProviderDescriptor,
  type RoutingSelectInput,
  type RoutingSelectResult,
  RuntimeAuthorCodecPolicy,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type {
  AlgorithmAdapterDefinition,
  AuthorCall,
  AuthorSchema,
  EmptyAuthorConfig,
  RoutingStrategyDefinition,
} from './authoring.js'
import { createAuthorSchema } from './authoring-schema-core.js'
import { assertAuthorSchema } from './authoring-schemas.js'
import type {
  CallContext,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from './public-api.js'

/** Installed source qualification is provided by the owning deployment, never by wire JSON. */
export type RoutingDeployment<C, B = unknown, M = unknown> = {
  readonly packageDigest: string
  readonly packageVersion: string
  readonly config: AuthorSchema<C>
  readonly budget: AuthorSchema<B>
  readonly inputMeta: AuthorSchema<M>
  current(context: CallContext, factory: FactoryContext): boolean
}

type Selector<C> = (
  input: Readonly<RoutingSelectInput>,
  context: AuthorCall<C>,
) => RoutingSelectResult | Promise<RoutingSelectResult>
const refs = RuntimeMethodSchemaRefs['agh.routing'].select
export const routingInputSchema = createAuthorSchema(refs.input, (value) =>
  validateRuntime('RoutingSelectInput', value),
)
export const routingResultSchema = createAuthorSchema(refs.output, (value) =>
  validateRuntime('RoutingSelectResult', value),
)
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)
const refused = (detailCode: string, code: RuntimeError['code'] = 'invalid_input'): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Routing request refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'routing-provider',
  },
})

function decode<T>(ref: DataRef, codec: AuthorSchema<T>): Outcome<T> {
  const safe = boundedCanonicalJson(ref, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES + 4096,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!safe.ok || !validateRuntime('DataRef', safe.value.json).ok) return refused('routing_data_ref')
  const data = safe.value.json as DataRef
  if (data.kind !== 'inline' || !same(data.schema, codec.ref)) return refused('routing_schema')
  const body = boundedCanonicalJson(data.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!body.ok || data.bytes !== body.value.bytes || data.digest !== canonicalJsonDigest(body.value.json))
    return refused('routing_content')
  return codec.parse(body.value.json)
}

export function routeSupports(route: ModelRouteSnapshot, input: RoutingSelectInput): boolean {
  const required = input.requiredFeatures
  const offered = route.features
  return (
    route.catalogRevision === input.catalogRevision &&
    required.input.every((kind) => offered.input.includes(kind)) &&
    required.output.every((kind) => offered.output.includes(kind)) &&
    (!required.tools || offered.tools) &&
    (!required.streaming || offered.streaming) &&
    (!required.structuredOutput || offered.structuredOutput)
  )
}

/** A policy can narrow candidates; it cannot replace their fixed identity or capabilities. */
export function validateRoutingSelection(
  input: RoutingSelectInput,
  result: RoutingSelectResult,
): Outcome<RoutingSelectResult> {
  const checked = routingResultSchema.parse(result)
  if (!checked.ok) return checked
  if (
    !input.allowedRoutes.some((route) => same(route, checked.value.route)) ||
    !routeSupports(checked.value.route, input)
  )
    return refused('routing_candidate')
  return checked
}

function createFactory<C, B, M>(
  id: string,
  deployment: RoutingDeployment<C, B, M>,
  requires: ProviderDescriptor['requires'],
  capabilities: ProviderDescriptor['capabilities'],
  make: (
    config: Readonly<C>,
    dependencies: ScopedDependencies,
    context: FactoryContext,
  ) => Promise<Selector<C>>,
): ProviderFactory<ServiceProvider> {
  assertAuthorSchema(deployment.config)
  assertAuthorSchema(deployment.budget)
  assertAuthorSchema(deployment.inputMeta)
  const descriptor: ProviderDescriptor = {
    providerId: id,
    contract: 'agh.routing',
    major: 1,
    logicalName: 'default',
    packageVersion: deployment.packageVersion,
    packageDigest: deployment.packageDigest,
    features: [],
    scope: 'workspace',
    configSchema: deployment.config.ref,
    requires,
    capabilities,
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: [
      {
        method: 'select',
        kind: 'compute',
        inputSchema: refs.input,
        outputSchema: refs.output,
        requiredCapabilities: [],
        retrySafety: 'read-only',
      },
    ],
  }
  if (!validateRuntime('ProviderDescriptor', descriptor).ok) throw new TypeError('Invalid routing descriptor')
  const original = { ...deployment }
  return {
    descriptor,
    async create(config, dependencies, factory) {
      const parsed = decode(config, original.config)
      if (!parsed.ok) throw new TypeError('Invalid routing configuration')
      if (factory.scope.kind !== 'workspace') throw new TypeError('Invalid routing scope')
      const factorySnapshot = canonicalJsonDigest({
        instanceId: factory.instanceId,
        scope: factory.scope,
        bindingId: factory.bindingId,
      })
      const factoryCurrent = () =>
        factorySnapshot ===
        canonicalJsonDigest({
          instanceId: factory.instanceId,
          scope: factory.scope,
          bindingId: factory.bindingId,
        })
      const select = await make(parsed.value, dependencies, factory)
      if (!factoryCurrent() || factory.signal.aborted) throw new TypeError('Routing factory retired')
      let phase: 'starting' | 'ready' | 'draining' | 'closed' = 'starting'
      const active = new Map<string, AbortController>()
      const sourceCurrent = (context: CallContext) => {
        if (
          !validateRuntime('ScopeRef', context.scope).ok ||
          !['workspace', 'session', 'run', 'action'].includes(context.scope.kind) ||
          factory.signal.aborted ||
          context.signal.aborted ||
          Date.parse(context.deadline) <= Date.now()
        )
          return false
        if (
          !Number.isFinite(Date.parse(context.deadline)) ||
          !factoryCurrent() ||
          context.bindingId !== factory.bindingId
        )
          return false
        if (
          !Object.entries(original).every(
            ([key, value]) => deployment[key as keyof typeof deployment] === value,
          )
        )
          return false
        if (
          !Object.entries(factory.scope).every(
            ([key, value]) => key === 'kind' || context.scope[key as keyof typeof context.scope] === value,
          )
        )
          return false
        const originalSignal = context.signal
        const relation = () =>
          canonicalJsonDigest({
            scope: context.scope,
            bindingId: context.bindingId,
            principalRef: context.principalRef,
            authorizationRef: context.authorizationRef,
            invocationId: context.invocationId,
            deadline: context.deadline,
            traceRef: context.traceRef,
          })
        const callRelation = relation()
        const current = (() => {
          try {
            return original.current(context, factory)
          } catch {
            return false
          }
        })()
        return (
          current === true &&
          factoryCurrent() &&
          context.signal === originalSignal &&
          relation() === callRelation &&
          Number.isFinite(Date.parse(context.deadline)) &&
          Date.parse(context.deadline) > Date.now() &&
          context.bindingId === factory.bindingId &&
          Object.entries(factory.scope).every(
            ([key, value]) => key === 'kind' || context.scope[key as keyof typeof context.scope] === value,
          ) &&
          !factory.signal.aborted &&
          !context.signal.aborted &&
          Object.entries(original).every(
            ([key, value]) => deployment[key as keyof typeof deployment] === value,
          )
        )
      }
      const usable = (context: CallContext) =>
        phase === 'ready' && sourceCurrent(context) && phase === 'ready'
      return {
        async ready(context) {
          if (phase !== 'starting' || !sourceCurrent(context) || phase !== 'starting')
            return refused('routing_source', 'denied')
          phase = 'ready'
          return { ok: true, value: undefined }
        },
        async health(context) {
          return { ok: true, value: { status: usable(context) ? 'ready' : 'failed', diagnosticIds: [] } }
        },
        async drain(_deadline, _context) {
          if (phase !== 'closed') phase = 'draining'
          for (const controller of active.values()) controller.abort()
          return {
            ok: true,
            value: {
              state: active.size ? 'blocked' : 'drained',
              activeInvocationIds: [...active.keys()],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          phase = 'closed'
          for (const controller of active.values()) controller.abort()
        },
        async compute(request, context) {
          if (!usable(context)) return refused('routing_source', 'denied')
          const originalSignal = context.signal
          const relation = () =>
            canonicalJsonDigest({
              scope: context.scope,
              bindingId: context.bindingId,
              principalRef: context.principalRef,
              authorizationRef: context.authorizationRef,
              invocationId: context.invocationId,
              deadline: context.deadline,
              traceRef: context.traceRef,
            })
          const callSnapshot = relation()
          if (request.method !== 'select') return refused('operation_not_supported', 'incompatible')
          if (
            request.target.bindingId !== factory.bindingId ||
            request.target.providerId !== descriptor.providerId ||
            request.target.contract !== descriptor.contract ||
            request.target.logicalName !== descriptor.logicalName
          )
            return refused('routing_binding', 'denied')
          const input = decode(request.input, routingInputSchema)
          if (!input.ok) return input
          const budget = decode(input.value.budgetSnapshot, original.budget)
          if (!budget.ok) return budget
          const meta = decode(input.value.inputMeta, original.inputMeta)
          if (!meta.ok) return meta
          const routes = input.value.allowedRoutes
          if (
            routes.some((route) => route.catalogRevision !== input.value.catalogRevision) ||
            new Set(routes.map((route) => route.routeId)).size !== routes.length
          )
            return refused('routing_catalog')
          const controller = new AbortController()
          const abort = () => controller.abort()
          const key = context.invocationId
          if (active.has(key)) return refused('routing_in_flight', 'conflict')
          factory.signal.addEventListener('abort', abort, { once: true })
          context.signal.addEventListener('abort', abort, { once: true })
          active.set(key, controller)
          const timeout = setTimeout(
            abort,
            Math.max(0, Math.min(2147483647, Date.parse(context.deadline) - Date.now())),
          )
          let underlyingPending = false
          try {
            if (!usable(context)) return refused('routing_source', 'denied')
            underlyingPending = true
            const pending = Promise.resolve()
              .then(() => {
                if (controller.signal.aborted) throw new Error('cancelled')
                return select(input.value, { signal: controller.signal, config: parsed.value })
              })
              .finally(() => {
                underlyingPending = false
                if (active.get(key) === controller) active.delete(key)
              })
            const cancelled = new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
                once: true,
              })
              if (controller.signal.aborted) reject(new Error('cancelled'))
            })
            const result = await Promise.race([pending, cancelled])
            if (
              controller.signal.aborted ||
              context.signal !== originalSignal ||
              relation() !== callSnapshot ||
              !usable(context) ||
              relation() !== callSnapshot
            )
              return refused('routing_source', 'denied')
            const valid = validateRoutingSelection(input.value, result)
            if (!valid.ok) return valid
            return routingResultSchema.encode(valid.value)
          } catch {
            return refused(
              controller.signal.aborted ? 'routing_cancelled' : 'routing_provider_error',
              controller.signal.aborted ? 'cancelled' : 'internal',
            )
          } finally {
            clearTimeout(timeout)
            if (!underlyingPending && active.get(key) === controller) active.delete(key)
            factory.signal.removeEventListener('abort', abort)
            originalSignal.removeEventListener('abort', abort)
          }
        },
      }
    },
  }
}

export function createRoutingStrategyFactory<C, B, M>(
  definition: RoutingStrategyDefinition<C>,
  deployment: RoutingDeployment<C, B, M>,
): ProviderFactory<ServiceProvider> {
  if (definition.config && definition.config.schema !== deployment.config)
    throw new TypeError('Routing config source mismatch')
  return createFactory(definition.id, deployment, [], [], async () => definition.select.bind(definition))
}

export function createRoutingAlgorithmFactory<C, B, M>(
  definition: AlgorithmAdapterDefinition<'agh.routing', C>,
  deployment: RoutingDeployment<C, B, M>,
): ProviderFactory<ServiceProvider> {
  if (definition.contract !== 'agh.routing' || (definition.stateCodecs?.length ?? 0) !== 0)
    throw new TypeError('Invalid routing algorithm declaration')
  if (definition.config && definition.config.schema !== deployment.config)
    throw new TypeError('Routing config source mismatch')
  return createFactory(
    definition.id,
    deployment,
    [...definition.requires],
    definition.permissions.map((permission) => ({
      capability: permission.capability,
      resourceTypes: [...permission.resourceTypes],
      operations: [...permission.operations],
    })),
    async (config, dependencies, factory) => {
      const methods = await definition.make(config, dependencies, factory)
      const own = Object.getOwnPropertyDescriptors(methods)
      if (Reflect.ownKeys(own).length !== 1 || !own.select || typeof own.select.value !== 'function')
        throw new TypeError('Routing requires exactly select')
      const select = own.select.value as Selector<EmptyAuthorConfig>
      return (input, context) => select(input, { signal: context.signal, config: Object.freeze({}) })
    },
  )
}
