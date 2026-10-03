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
  type Money,
  type PriceQuote,
  type PricingQuoteInput,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'

export interface ReferencePriceRule {
  readonly priceVersion: string
  readonly model: string
  readonly region: string | null
  readonly unit: string
  readonly ruleId: string
  readonly unitPrice: Money
}
interface SourceChecks {
  readonly until: number
  dynamicCheck(): void
  staticCheck(): void
}
export interface ReferencePricingOwner<C> {
  catalog(
    config: Readonly<C>,
    factory: FactoryContext,
  ):
    | (SourceChecks & { readonly catalog: readonly ReferencePriceRule[] })
    | Promise<SourceChecks & { readonly catalog: readonly ReferencePriceRule[] }>
  captureCurrent(context: CallContext, factory: FactoryContext): SourceChecks
  now(): number
}
export interface ReferencePricingOptions<C> {
  readonly descriptor: ProviderDescriptor
  readonly configurationSchema: AuthorSchema<C>
  readonly owner: ReferencePricingOwner<C>
}
const refs = RuntimeMethodSchemaRefs['agh.pricing'].quote,
  budget = RuntimeAuthorCodecPolicy.payload
function snapshot(value: unknown) {
  const result = boundedCanonicalJson(value, {
    maxBytes: budget.maxCanonicalJsonBytes,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!result.ok) throw new TypeError('Reference price data invalid')
  return result.value
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new TypeError('Reference price accessor refused')
    freeze(descriptor.value)
  }
  Object.freeze(value)
}
function refused(detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'denied',
      detailCode,
      message: 'Reference pricing operation refused',
      diagnosticId: 'reference-pricing',
      retryAdvice: { kind: 'never' },
    },
  }
}
function tree(value: unknown, frame = false): () => void {
  if (value === null || typeof value !== 'object') return () => {}
  const proto = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value)
  const fields = keys.map((key) => {
    const original = Object.getOwnPropertyDescriptor(value, key)
    if (!original || !('value' in original)) throw new TypeError('Reference price accessor refused')
    const nested = frame && key === 'signal' ? () => {} : tree(original.value)
    return () => {
      const actual = Object.getOwnPropertyDescriptor(value, key)
      if (
        !actual ||
        !('value' in actual) ||
        actual.value !== original.value ||
        actual.configurable !== original.configurable ||
        actual.writable !== original.writable ||
        actual.enumerable !== original.enumerable
      )
        throw new Error('Reference price source changed')
      nested()
    }
  })
  return () => {
    if (Object.getPrototypeOf(value) !== proto || Reflect.ownKeys(value).length !== keys.length)
      throw new Error('Reference price source changed')
    for (const check of fields) check()
  }
}
function sourceChecks(value: SourceChecks) {
  const check = tree(value),
    until = Object.getOwnPropertyDescriptor(value, 'until')
  const dynamic = Object.getOwnPropertyDescriptor(value, 'dynamicCheck'),
    fixed = Object.getOwnPropertyDescriptor(value, 'staticCheck')
  if (
    !until ||
    !('value' in until) ||
    typeof until.value !== 'number' ||
    !Number.isFinite(until.value) ||
    !dynamic ||
    !('value' in dynamic) ||
    typeof dynamic.value !== 'function' ||
    !fixed ||
    !('value' in fixed) ||
    typeof fixed.value !== 'function'
  )
    throw new Error('Reference source unavailable')
  return {
    until: until.value,
    dynamic() {
      check()
      if (Reflect.apply(dynamic.value, value, []) !== undefined)
        throw new Error('Reference asynchronous source')
      check()
    },
    fixed() {
      check()
      if (Reflect.apply(fixed.value, value, []) !== undefined)
        throw new Error('Reference asynchronous source')
      check()
    },
  }
}
function decode<T>(reference: DataRef, codec: AuthorSchema<T>): T {
  if (
    !validateRuntime('DataRef', reference).ok ||
    reference.kind !== 'inline' ||
    canonicalJsonDigest(reference.schema) !== canonicalJsonDigest(codec.ref)
  )
    throw new Error('Reference schema mismatch')
  const body = snapshot(reference.value)
  if (body.bytes !== reference.bytes || canonicalJsonDigest(body.json) !== reference.digest)
    throw new Error('Reference content mismatch')
  const parsed = codec.parse(body.json)
  if (!parsed.ok) throw new Error('Reference codec refused')
  return parsed.value
}
function round(quantity: string, price: string): string {
  if (
    quantity.length > 256 ||
    price.length > 256 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(quantity) ||
    !/^(0|[1-9][0-9]*)$/.test(price)
  )
    throw new Error('Reference quantity invalid')
  const point = quantity.indexOf('.'),
    places = point < 0 ? 0 : quantity.length - point - 1
  const rational = BigInt(quantity.replace('.', '')) * BigInt(price),
    denominator = 10n ** BigInt(places)
  let micros = rational / denominator
  const twice = (rational % denominator) * 2n
  if (twice > denominator || (twice === denominator && (micros & 1n) === 1n)) micros += 1n
  return micros.toString()
}
function directory(catalog: readonly ReferencePriceRule[]) {
  const copied = snapshot(catalog).json
  if (!Array.isArray(copied) || copied.length === 0) throw new Error('Reference directory unavailable')
  const rows: ReferencePriceRule[] = []
  for (const item of copied) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'model,priceVersion,region,ruleId,unit,unitPrice' ||
      typeof item.model !== 'string' ||
      !item.model ||
      typeof item.priceVersion !== 'string' ||
      !item.priceVersion ||
      typeof item.unit !== 'string' ||
      !item.unit ||
      typeof item.ruleId !== 'string' ||
      !item.ruleId ||
      (item.region !== null && typeof item.region !== 'string')
    )
      throw new Error('Reference directory invalid')
    const money = validateRuntime('Money', item.unitPrice)
    if (!money.ok || !money.value.currency) throw new Error('Reference currency invalid')
    round('0', money.value.units)
    const row = {
      priceVersion: item.priceVersion,
      model: item.model,
      region: item.region,
      unit: item.unit,
      ruleId: item.ruleId,
      unitPrice: money.value,
    }
    if (
      rows.some(
        (old) =>
          old.priceVersion === row.priceVersion &&
          old.model === row.model &&
          old.region === row.region &&
          old.unit === row.unit &&
          old.unitPrice.currency === row.unitPrice.currency,
      )
    )
      throw new Error('Reference duplicate rule')
    rows.push(row)
  }
  return (input: PricingQuoteInput): PriceQuote => {
    const selection = rows.filter(
      (row) =>
        row.priceVersion === input.priceVersion &&
        row.model === input.model &&
        row.region === input.region &&
        row.unitPrice.currency === input.currency,
    )
    if (!selection.length) throw new Error('Reference fixed version unavailable')
    const lineItems = input.usageUnits.map((item) => {
      const row = selection.find((rule) => rule.unit === item.unit)
      if (!row) throw new Error('Reference unit unavailable')
      return {
        unit: item.unit,
        quantity: item.value,
        unitPrice: { ...row.unitPrice },
        ruleId: row.ruleId,
        amount: {
          currency: input.currency,
          scale: 6 as const,
          units: round(item.value, row.unitPrice.units),
        },
      }
    })
    let total = 0n
    for (const line of lineItems) total += BigInt(line.amount.units)
    const body = {
      priceVersion: input.priceVersion,
      inputDigest: canonicalJsonDigest(input),
      lineItems,
      amount: { currency: input.currency, scale: 6 as const, units: total.toString() },
      rounding: 'half-even' as const,
    }
    return { quoteId: `reference-quote:${canonicalJsonDigest(body)}`, ...body }
  }
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
function live(signal: AbortSignal) {
  if (!aborted || Reflect.apply(aborted, signal, [])) throw new Error('Reference cancelled')
}

/** Independent catalog/rational arithmetic and lifecycle; no default pricing implementation is imported. */
export function createReferencePricingFactory<C>(
  options: ReferencePricingOptions<C>,
): ProviderFactory<ServiceProvider> {
  assertAuthorSchema(options.configurationSchema)
  const descriptorResult = validateRuntime('ProviderDescriptor', snapshot(options.descriptor).json)
  if (!descriptorResult.ok) throw new Error('Reference descriptor invalid')
  freeze(descriptorResult.value)
  const descriptor = descriptorResult.value,
    op = descriptor.operations[0]
  if (
    descriptor.contract !== 'agh.pricing' ||
    descriptor.major !== 1 ||
    descriptor.scope !== 'workspace' ||
    descriptor.operations.length !== 1 ||
    descriptor.stateCodecs.length ||
    op?.method !== 'quote' ||
    op.kind !== 'compute' ||
    op.retrySafety !== 'read-only' ||
    canonicalJsonDigest(op.inputSchema) !== canonicalJsonDigest(refs.input) ||
    canonicalJsonDigest(op.outputSchema) !== canonicalJsonDigest(refs.output) ||
    canonicalJsonDigest(descriptor.configSchema) !== canonicalJsonDigest(options.configurationSchema.ref)
  )
    throw new Error('Reference binding invalid')
  const owner = options.owner,
    fixedOwner = tree(owner),
    codec = options.configurationSchema
  const read = Object.getOwnPropertyDescriptor(owner, 'catalog'),
    capture = Object.getOwnPropertyDescriptor(owner, 'captureCurrent'),
    clock = Object.getOwnPropertyDescriptor(owner, 'now')
  if (
    !read ||
    !('value' in read) ||
    typeof read.value !== 'function' ||
    !capture ||
    !('value' in capture) ||
    typeof capture.value !== 'function' ||
    !clock ||
    !('value' in clock) ||
    typeof clock.value !== 'function'
  )
    throw new Error('Reference owner unavailable')
  const readCatalog: ReferencePricingOwner<C>['catalog'] = read.value
  const captureCurrent: ReferencePricingOwner<C>['captureCurrent'] = capture.value
  const now: ReferencePricingOwner<C>['now'] = clock.value
  const factory: ProviderFactory<ServiceProvider> = {
    descriptor,
    async create(config, _deps, frame) {
      const frameFence = tree(frame, true),
        nativeSignal = frame.signal,
        originalScope = frame.scope,
        bindingId = frame.bindingId
      if (originalScope.kind !== 'workspace' || !validateRuntime('ScopeRef', originalScope).ok)
        throw new Error('Reference factory scope')
      const configuration = decode(config, codec)
      const original = await Reflect.apply(readCatalog, owner, [configuration, frame]),
        catalog = sourceChecks(original)
      fixedOwner()
      frameFence()
      live(nativeSignal)
      const quote = directory(original.catalog)
      let phase: 'created' | 'ready' | 'draining' | 'closed' = 'created'
      function gate(call: CallContext, accepting = true) {
        const check = tree(call, true),
          expected = phase,
          signal = call.signal,
          until = Date.parse(call.deadline)
        if (
          expected === 'closed' ||
          (accepting && expected !== 'ready') ||
          call.bindingId !== bindingId ||
          !validateRuntime('ScopeRef', call.scope).ok ||
          Object.entries(originalScope).some(
            ([key, val]) => key !== 'kind' && Reflect.get(call.scope, key) !== val,
          )
        )
          throw new Error('Reference not current')
        const wire = Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'signal'))
        if (!validateRuntime('CallContextWire', wire).ok) throw new Error('Reference call invalid')
        const current = sourceChecks(Reflect.apply(captureCurrent, owner, [call, frame]))
        catalog.dynamic()
        current.dynamic()
        check()
        frameFence()
        fixedOwner()
        live(signal)
        live(nativeSignal)
        const time = Reflect.apply(now, owner, [])
        if (
          typeof time !== 'number' ||
          !Number.isFinite(time) ||
          !Number.isFinite(until) ||
          time >= Math.min(until, current.until, catalog.until)
        )
          throw new Error('Reference deadline exceeded')
        catalog.fixed()
        current.fixed()
        check()
        frameFence()
        fixedOwner()
        live(signal)
        live(nativeSignal)
        if (phase !== expected) throw new Error('Reference phase changed')
      }
      return {
        async ready(call) {
          try {
            if (phase !== 'created') throw new Error('Reference phase')
            gate(call, false)
            phase = 'ready'
            return { ok: true, value: undefined }
          } catch {
            return refused('reference_pricing_current')
          }
        },
        async health(call) {
          try {
            gate(call, false)
            return {
              ok: true,
              value: { status: phase === 'ready' ? 'ready' : 'degraded', diagnosticIds: [] },
            }
          } catch {
            return refused('reference_pricing_current')
          }
        },
        async drain(_deadline, call) {
          try {
            gate(call, false)
            phase = 'draining'
            return {
              ok: true,
              value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
            }
          } catch {
            return refused('reference_pricing_current')
          }
        },
        async close() {
          phase = 'closed'
        },
        async compute(request, call) {
          try {
            const requestFence = tree(request)
            if (
              !validateRuntime('ServiceOperation', request).ok ||
              request.method !== 'quote' ||
              request.target.bindingId !== bindingId ||
              request.target.contract !== descriptor.contract ||
              request.target.providerId !== descriptor.providerId ||
              request.target.logicalName !== descriptor.logicalName
            )
              throw new Error('Reference operation invalid')
            const input = decode(request.input, pricingInputSchema)
            gate(call)
            requestFence()
            const output = pricingQuoteSchema.encode(quote(input))
            if (!output.ok) return output
            gate(call, false)
            requestFence()
            return output
          } catch {
            return refused('reference_pricing_current')
          }
        },
      }
    },
  }
  return Object.freeze(factory)
}
