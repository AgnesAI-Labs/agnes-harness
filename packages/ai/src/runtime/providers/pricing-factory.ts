import {
  type AuthorSchema,
  assertAuthorSchema,
  type CallContext,
  type FactoryContext,
  type Outcome,
  type ProviderFactory,
  pricingInputSchema,
  pricingQuoteSchema,
  type ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createPricingAlgorithm, type PricingCatalogRule } from './pricing.js'

/** Selected native source checks. This private port is never parsed from configuration or wire JSON. */
export interface PricingCurrentCapture {
  readonly until: number
  dynamicCheck(): void
  staticCheck(): void
}
export interface PricingCatalogCapture extends PricingCurrentCapture {
  readonly catalog: readonly PricingCatalogRule[]
}
export interface PricingProviderOwner<C> {
  catalog(
    configuration: Readonly<C>,
    factory: FactoryContext,
  ): PricingCatalogCapture | Promise<PricingCatalogCapture>
  captureCurrent(context: CallContext, factory: FactoryContext): PricingCurrentCapture
  now(): number
}
export interface PricingFactoryOptions<C> {
  readonly descriptor: ProviderDescriptor
  readonly configurationSchema: AuthorSchema<C>
  readonly owner: PricingProviderOwner<C>
}
const refs = RuntimeMethodSchemaRefs['agh.pricing'].quote
const inputSchema = pricingInputSchema
const outputSchema = pricingQuoteSchema
const limits = RuntimeAuthorCodecPolicy.payload
function safe(value: unknown) {
  return boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
}
function fail(detailCode: string, denied = false): Outcome<never> {
  return {
    ok: false,
    error: {
      code: denied ? 'denied' : 'invalid_input',
      detailCode,
      message: 'Pricing operation refused',
      diagnosticId: 'pricing-factory',
      retryAdvice: { kind: 'never' },
    },
  }
}
function immutable(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const property of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in property)) throw new TypeError('Pricing source contains accessors')
      immutable(property.value)
    }
    Object.freeze(value)
  }
}
function dataFence(value: unknown): () => void {
  if (value === null || typeof value !== 'object') return () => {}
  const prototype = Object.getPrototypeOf(value),
    descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  const children = keys.map((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !('value' in property)) throw new TypeError('Pricing source contains accessors')
    const original = property.value,
      nested = dataFence(original)
    return () => {
      const current = Object.getOwnPropertyDescriptor(value, key)
      if (
        !current ||
        !('value' in current) ||
        current.value !== original ||
        current.writable !== property.writable ||
        current.enumerable !== property.enumerable ||
        current.configurable !== property.configurable
      )
        throw new Error('Pricing source changed')
      nested()
    }
  })
  return () => {
    if (Object.getPrototypeOf(value) !== prototype || Reflect.ownKeys(value).length !== keys.length)
      throw new Error('Pricing source changed')
    for (const check of children) check()
  }
}
function method<T extends (...args: never[]) => unknown>(owner: object, name: string): T {
  const property = Object.getOwnPropertyDescriptor(owner, name)
  if (!property || !('value' in property) || typeof property.value !== 'function')
    throw new TypeError('Pricing owner method is unavailable')
  return property.value
}
function decode<C>(reference: DataRef, codec: AuthorSchema<C>): Outcome<C> {
  const parsed = validateRuntime('DataRef', reference)
  if (
    !parsed.ok ||
    reference.kind !== 'inline' ||
    canonicalJsonDigest(reference.schema) !== canonicalJsonDigest(codec.ref)
  )
    return fail('pricing_data_ref')
  const body = safe(reference.value)
  if (
    !body.ok ||
    body.value.bytes !== reference.bytes ||
    canonicalJsonDigest(body.value.json) !== reference.digest
  )
    return fail('pricing_data_ref')
  return codec.parse(body.value.json)
}
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
function signalFence(signal: AbortSignal): () => void {
  if (!nativeAborted || Reflect.apply(nativeAborted, signal, []))
    throw new Error('Pricing invocation aborted')
  const own = Object.getOwnPropertyDescriptors(signal),
    keys = Reflect.ownKeys(own),
    prototype = Object.getPrototypeOf(signal)
  return () => {
    if (Object.getPrototypeOf(signal) !== prototype || Reflect.ownKeys(signal).length !== keys.length)
      throw new Error('Pricing signal changed')
    for (const key of keys) {
      const before = Object.getOwnPropertyDescriptor(signal, key),
        original = Reflect.get(own, key)
      if (
        !before ||
        !('value' in before) ||
        !original ||
        !('value' in original) ||
        before.value !== original.value
      )
        throw new Error('Pricing signal changed')
    }
    if (Reflect.apply(nativeAborted, signal, [])) throw new Error('Pricing invocation aborted')
  }
}
function captureChecks(capture: PricingCurrentCapture) {
  const dynamic = method<PricingCurrentCapture['dynamicCheck']>(capture, 'dynamicCheck')
  const fixed = method<PricingCurrentCapture['staticCheck']>(capture, 'staticCheck')
  const descriptor = Object.getOwnPropertyDescriptor(capture, 'until')
  if (!descriptor || !('value' in descriptor) || !Number.isFinite(descriptor.value))
    throw new TypeError('Pricing source deadline unavailable')
  const until: number = descriptor.value
  const fence = dataFence(capture)
  return {
    until,
    dynamic() {
      fence()
      if (Reflect.apply(dynamic, capture, []) !== undefined) throw new Error('Asynchronous pricing source')
      fence()
    },
    fixed() {
      fence()
      if (Reflect.apply(fixed, capture, []) !== undefined) throw new Error('Asynchronous pricing source')
      fence()
    },
  }
}

/** Complete compute/lifecycle SPI; actual catalog and current roles remain with the selected native owner. */
export function createPricingProviderFactory<C>(
  options: PricingFactoryOptions<C>,
): ProviderFactory<ServiceProvider> {
  assertAuthorSchema(options.configurationSchema)
  const checked = safe(options.descriptor)
  if (!checked.ok) throw new TypeError('Invalid pricing descriptor')
  const validated = validateRuntime('ProviderDescriptor', checked.value.json)
  if (!validated.ok) throw new TypeError('Invalid pricing descriptor')
  const descriptor = validated.value,
    operation = descriptor.operations[0]
  if (
    descriptor.contract !== 'agh.pricing' ||
    descriptor.major !== 1 ||
    descriptor.scope !== 'workspace' ||
    descriptor.stateCodecs.length ||
    descriptor.operations.length !== 1 ||
    operation?.method !== 'quote' ||
    operation.kind !== 'compute' ||
    operation.retrySafety !== 'read-only' ||
    canonicalJsonDigest(operation.inputSchema) !== canonicalJsonDigest(refs.input) ||
    canonicalJsonDigest(operation.outputSchema) !== canonicalJsonDigest(refs.output) ||
    canonicalJsonDigest(descriptor.configSchema) !== canonicalJsonDigest(options.configurationSchema.ref)
  )
    throw new TypeError('Invalid pricing factory binding')
  immutable(descriptor)
  const owner = options.owner,
    configCodec = options.configurationSchema
  const catalogMethod = method<PricingProviderOwner<C>['catalog']>(owner, 'catalog')
  const captureMethod = method<PricingProviderOwner<C>['captureCurrent']>(owner, 'captureCurrent')
  const clock = method<PricingProviderOwner<C>['now']>(owner, 'now')
  const ownerFence = dataFence(owner)
  const factory: ProviderFactory<ServiceProvider> = {
    descriptor,
    async create(configuration, _dependencies, context) {
      ownerFence()
      const config = decode(configuration, configCodec)
      if (!config.ok || context.scope.kind !== 'workspace' || !validateRuntime('ScopeRef', context.scope).ok)
        throw new TypeError('Invalid pricing configuration or scope')
      immutable(config.value)
      const factoryProperties = Object.getOwnPropertyDescriptors(context)
      for (const property of Object.values(factoryProperties))
        if (!('value' in property)) throw new TypeError('Pricing factory accessors')
      const factoryFence = dataFence(context.scope),
        factorySignal = context.signal,
        factoryAbort = signalFence(factorySignal)
      const bindingId = context.bindingId,
        originalScope = context.scope
      const factoryFixed = () => {
        ownerFence()
        factoryFence()
        factoryAbort()
        if (Reflect.ownKeys(context).length !== Reflect.ownKeys(factoryProperties).length)
          throw new Error('Pricing factory changed')
        for (const key of Reflect.ownKeys(factoryProperties)) {
          const original = Reflect.get(factoryProperties, key),
            property = Object.getOwnPropertyDescriptor(context, key)
          if (
            !property ||
            !('value' in property) ||
            !original ||
            !('value' in original) ||
            property.value !== original.value
          )
            throw new Error('Pricing factory changed')
        }
      }
      const issuedCatalog = await Reflect.apply(catalogMethod, owner, [config.value, context])
      factoryFixed()
      const catalogChecks = captureChecks(issuedCatalog),
        algorithm = createPricingAlgorithm(issuedCatalog.catalog)
      let phase: 'created' | 'ready' | 'draining' | 'closed' = 'created'
      const active = new Set<string>()
      function gate(call: CallContext, admitted = true): () => void {
        factoryFixed()
        if (
          phase === 'closed' ||
          (admitted && phase !== 'ready') ||
          call.bindingId !== bindingId ||
          !validateRuntime('ScopeRef', call.scope).ok ||
          Object.entries(originalScope).some(
            ([key, value]) => key !== 'kind' && Reflect.get(call.scope, key) !== value,
          )
        )
          throw new Error('Pricing invocation is not current')
        const callWire = Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'signal'))
        const checkedWire = validateRuntime('CallContextWire', callWire)
        if (!checkedWire.ok) throw new Error('Invalid pricing context')
        const callSignal = call.signal,
          callAbort = signalFence(callSignal),
          scopeFence = dataFence(call.scope)
        const callProperties = Object.getOwnPropertyDescriptors(call)
        for (const property of Object.values(callProperties))
          if (!('value' in property)) throw new TypeError('Pricing context accessors')
        const originalDeadline = Date.parse(call.deadline),
          expected = phase
        const current = captureChecks(Reflect.apply(captureMethod, owner, [call, context]))
        const final = () => {
          factoryFixed()
          callAbort()
          scopeFence()
          if (phase !== expected || Reflect.ownKeys(call).length !== Reflect.ownKeys(callProperties).length)
            throw new Error('Pricing invocation changed')
          for (const key of Reflect.ownKeys(callProperties)) {
            const original = Reflect.get(callProperties, key),
              property = Object.getOwnPropertyDescriptor(call, key)
            if (
              !property ||
              !('value' in property) ||
              !original ||
              !('value' in original) ||
              property.value !== original.value
            )
              throw new Error('Pricing invocation changed')
          }
        }
        catalogChecks.dynamic()
        current.dynamic()
        final()
        const time = Reflect.apply(clock, owner, [])
        if (
          !Number.isFinite(time) ||
          !Number.isFinite(originalDeadline) ||
          time >= Math.min(originalDeadline, current.until, catalogChecks.until)
        )
          throw new Error('Pricing deadline exceeded')
        catalogChecks.fixed()
        current.fixed()
        final()
        return final
      }
      const provider: ServiceProvider = {
        async ready(call) {
          try {
            if (phase !== 'created') throw new Error('Pricing phase')
            gate(call, false)()
            phase = 'ready'
            return { ok: true, value: undefined }
          } catch {
            return fail('pricing_not_current', true)
          }
        },
        async health(call) {
          try {
            gate(call, false)()
            return {
              ok: true,
              value: {
                status: phase === 'ready' ? 'ready' : 'degraded',
                diagnosticIds: [],
              },
            }
          } catch {
            return fail('pricing_not_current', true)
          }
        },
        async drain(_deadline, call) {
          try {
            gate(call, false)()
            phase = 'draining'
            return {
              ok: true,
              value: {
                state: active.size ? 'blocked' : 'drained',
                activeInvocationIds: [...active],
                durableOwnerRefs: [],
                diagnosticIds: [],
              },
            }
          } catch {
            return fail('pricing_not_current', true)
          }
        },
        async close() {
          phase = 'closed'
        },
        async compute(request, call) {
          try {
            const requestFence = dataFence(request),
              parsed = validateRuntime('ServiceOperation', request)
            if (
              !parsed.ok ||
              request.method !== 'quote' ||
              request.target.contract !== descriptor.contract ||
              request.target.providerId !== descriptor.providerId ||
              request.target.logicalName !== descriptor.logicalName ||
              request.target.bindingId !== bindingId
            )
              return fail('pricing_request')
            const input = decode(request.input, inputSchema)
            if (!input.ok) return input
            gate(call)()
            requestFence()
            if (active.has(call.invocationId)) return fail('pricing_invocation_duplicate')
            const id = call.invocationId
            active.add(id)
            try {
              const quote = algorithm.quote(input.value),
                output = outputSchema.encode(quote)
              if (!output.ok) return output
              gate(call, false)()
              requestFence()
              return output
            } finally {
              active.delete(id)
            }
          } catch {
            return fail('pricing_not_current', true)
          }
        },
      }
      return provider
    },
  }
  return Object.freeze(factory)
}
