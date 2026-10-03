import type {
  AuthorSchema,
  CallContext,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { assertAuthorSchema } from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  type CloseReason,
  canonicalJsonDigest,
  type DataRef,
  type DrainResult,
  type Health,
  type JsonValue,
  type OwnerRef,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  type ServiceOperation,
  type ServiceQuery,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { BudgetAuthorityFault } from '../budget/reservations.js'
import { UsageOriginFault } from '../usage/origins.js'

/** Installed concrete authority owns durable replay, current source qualification and resource lifetime. */
export interface AccountingProviderAuthority {
  now(): string
  open(config: DataRef, context: FactoryContext): Promise<Outcome<void>>
  readConfig(config: DataRef, context: FactoryContext): Promise<Outcome<unknown>>
  read(reference: DataRef, context: CallContext): Promise<Outcome<unknown>>
  borrowContext?(original: CallContext, signal: AbortSignal): Outcome<CallContext>
  checkCurrent(context: CallContext): Promise<Outcome<void>>
  operationOwner(method: string, input: JsonValue, context: CallContext): Promise<Outcome<OwnerRef>>
  publish(schema: SchemaRef, value: JsonValue, context: CallContext): Promise<Outcome<DataRef>>
  health(context: CallContext): Promise<Outcome<Health>>
  drain(deadline: string, context: CallContext): Promise<Outcome<DrainResult>>
  close(reason: CloseReason): Promise<void>
}
export type AccountingMethod = Readonly<{
  kind: 'control' | 'query'
  input: keyof RuntimeWireTypes
  output: keyof RuntimeWireTypes
}>
export type AccountingDispatch = (
  method: string,
  input: JsonValue,
  context: CallContext,
  snapshot?: string,
) => Promise<{ value: unknown; snapshot?: string }>
const sameRef = (a: SchemaRef, b: SchemaRef) =>
  a.typeId === b.typeId && a.revision === b.revision && a.digest === b.digest
const failure = (
  code: import('@agnes/protocol/runtime').RuntimeError['code'],
  detailCode: string,
): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Accounting operation refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'accounting-provider',
  },
})
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}
function parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): Outcome<RuntimeWireTypes[K]> {
  const limits = RuntimeAuthorCodecPolicy.payload
  const safe = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!safe.ok) return failure('invalid_input', 'accounting_payload_budget')
  const parsed = validateRuntime(name, safe.value.json)
  if (!parsed.ok) return failure('invalid_input', 'accounting_schema')
  freeze(parsed.value)
  return { ok: true, value: parsed.value }
}
function bound(
  request: ServiceOperation | ServiceQuery,
  context: CallContext,
  factory: FactoryContext,
  descriptor: ProviderDescriptor,
): boolean {
  return (
    request.target.contract === descriptor.contract &&
    request.target.providerId === descriptor.providerId &&
    request.target.logicalName === descriptor.logicalName &&
    request.target.bindingId === factory.bindingId &&
    context.bindingId === factory.bindingId &&
    Object.entries(factory.scope).every(
      ([key, value]) => key === 'kind' || context.scope[key as keyof typeof context.scope] === value,
    )
  )
}
function uncertain(owner: OwnerRef): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'unknown_effect',
      detailCode: 'unknown_result',
      message: 'Durable accounting result requires reconciliation',
      retryAdvice: { kind: 'reconcile', ownerRef: owner },
      diagnosticId: 'accounting-provider',
    },
  }
}
/** Repeated wire/lifecycle implementation only; all accounting decisions remain in actual authority/rules. */
export function createAccountingFactory<C>(
  contract: 'agh.budget' | 'agh.usage',
  descriptor: ProviderDescriptor,
  configCodec: AuthorSchema<C>,
  authority: AccountingProviderAuthority,
  methods: Readonly<Record<string, AccountingMethod>>,
  dispatch: AccountingDispatch,
): ProviderFactory<ServiceProvider> {
  assertAuthorSchema(configCodec)
  const schemas = RuntimeMethodSchemaRefs[contract]
  const declared = parse('ProviderDescriptor', descriptor)
  if (
    !declared.ok ||
    descriptor.contract !== contract ||
    descriptor.major !== 1 ||
    !sameRef(descriptor.configSchema, configCodec.ref) ||
    descriptor.operations.length !== Object.keys(methods).length
  )
    throw new TypeError('Accounting descriptor must declare its complete official contract')
  for (const [method, definition] of Object.entries(methods)) {
    const official = schemas[method as keyof typeof schemas]
    const actual = descriptor.operations.find((entry) => entry.method === method)
    if (
      !official ||
      !actual ||
      actual.kind !== definition.kind ||
      !sameRef(actual.inputSchema, official.input) ||
      !sameRef(actual.outputSchema, official.output)
    )
      throw new TypeError('Accounting operation differs from the official contract')
  }
  const fixed = declared.value
  return {
    descriptor: fixed,
    async create(config, _dependencies, factory) {
      if (!sameRef(config.schema, fixed.configSchema)) throw new TypeError('Accounting config schema differs')
      const loaded = await authority.readConfig(config, factory)
      if (!loaded.ok) throw new Error(loaded.error.detailCode)
      const decoded = configCodec.parse(loaded.value)
      if (!decoded.ok) throw new TypeError('Accounting configuration is invalid')
      const encoded = configCodec.encode(decoded.value),
        proof = config.kind === 'inline' ? config : config.blob
      if (
        !encoded.ok ||
        encoded.value.kind !== 'inline' ||
        encoded.value.digest !== proof.digest ||
        encoded.value.bytes !== proof.bytes
      )
        throw new TypeError('Accounting configuration proof differs')
      const opened = await authority.open(config, factory)
      if (!opened.ok) throw new Error(opened.error.detailCode)
      let state: 'ready' | 'draining' | 'closed' = 'ready'
      const lifetime = new AbortController(),
        active = new Map<symbol, { invocationId: string; owner?: OwnerRef }>()
      const preflight = (context: CallContext): Outcome<void> => {
        if (state !== 'ready') return failure('retryable', 'accounting_closed')
        if (context.signal.aborted || factory.signal.aborted)
          return failure('cancelled', 'accounting_cancelled')
        const now = Date.parse(authority.now()),
          deadline = Date.parse(context.deadline)
        if (!Number.isFinite(now) || !Number.isFinite(deadline))
          return failure('invalid_input', 'accounting_clock')
        return now >= deadline ? failure('timeout', 'accounting_deadline') : { ok: true, value: undefined }
      }
      async function call(
        kind: 'control' | 'query',
        request: ServiceOperation | ServiceQuery,
        context: CallContext,
      ): Promise<Outcome<{ output: DataRef; snapshot?: string }>> {
        const token = Symbol(),
          entry: { invocationId: string; owner?: OwnerRef } = { invocationId: context.invocationId }
        active.set(token, entry)
        const original = context,
          combinedSignal = AbortSignal.any([context.signal, factory.signal, lifetime.signal])
        let started = false,
          dispatched = false
        try {
          if (authority.borrowContext) {
            const borrowed = authority.borrowContext(original, combinedSignal)
            if ('then' in borrowed && typeof borrowed.then === 'function')
              return failure('internal', 'accounting_async_borrow')
            if (!borrowed.ok) return borrowed
            context = borrowed.value
            if (context.signal !== combinedSignal) return failure('denied', 'accounting_borrow_signal')
          } else context = { ...original, signal: combinedSignal }
          const checked = preflight(context)
          if (!checked.ok) return checked
          const definition = methods[request.method],
            official = schemas[request.method as keyof typeof schemas]
          if (
            !definition ||
            !official ||
            definition.kind !== kind ||
            !bound(request, context, factory, fixed)
          )
            return failure('denied', 'accounting_binding')
          if (!sameRef(request.input.schema, official.input))
            return failure('invalid_input', 'accounting_input_schema')
          const current = await authority.checkCurrent(context)
          if (!current.ok) return current
          const read = await authority.read(request.input, context)
          if (!read.ok) return read
          const parsed = parse(definition.input, read.value)
          if (!parsed.ok) return parsed
          const limits = RuntimeAuthorCodecPolicy.payload
          const input = boundedCanonicalJson(parsed.value, {
            maxBytes: limits.maxCanonicalJsonBytes,
            maxDepth: limits.maxDepth,
            maxMembers: limits.maxMembers,
          })
          const proof = request.input.kind === 'inline' ? request.input : request.input.blob
          if (
            !input.ok ||
            input.value.bytes !== proof.bytes ||
            canonicalJsonDigest(input.value.json) !== proof.digest
          )
            return failure('invalid_input', 'accounting_input_proof')
          const live = preflight(context)
          if (!live.ok) return live
          if (kind === 'control') {
            const owner = await authority.operationOwner(request.method, input.value.json, context)
            if (!owner.ok) return owner
            const actual = parse('OwnerRef', owner.value)
            if (!actual.ok || actual.value.kind !== 'reconciliation')
              return failure('internal', 'accounting_original_owner')
            entry.owner = actual.value
          }
          const final = preflight(context)
          if (!final.ok) return final
          started = kind === 'control'
          const result = await dispatch(
            request.method,
            input.value.json,
            context,
            'snapshot' in request ? request.snapshot : undefined,
          )
          dispatched = kind === 'control'
          const output = parse(definition.output, result.value)
          if (!output.ok)
            return entry.owner ? uncertain(entry.owner) : failure('internal', 'accounting_output_schema')
          const value = boundedCanonicalJson(output.value, {
            maxBytes: limits.maxCanonicalJsonBytes,
            maxDepth: limits.maxDepth,
            maxMembers: limits.maxMembers,
          })
          if (!value.ok)
            return entry.owner ? uncertain(entry.owner) : failure('internal', 'accounting_output_budget')
          if (kind === 'query') {
            const current = await authority.checkCurrent(context)
            if (!current.ok) return current
            const live = preflight(context)
            if (!live.ok) return live
            if (!result.snapshot || !validateRuntime('Id', result.snapshot).ok)
              return failure('internal', 'accounting_query_snapshot')
          }
          const emitted = await authority.publish(official.output, value.value.json, context)
          if (!emitted.ok) return entry.owner ? uncertain(entry.owner) : emitted
          const published = parse('DataRef', emitted.value)
          if (!published.ok)
            return entry.owner ? uncertain(entry.owner) : failure('internal', 'accounting_output_reference')
          const source = published.value.kind === 'inline' ? published.value : published.value.blob
          if (
            !sameRef(published.value.schema, official.output) ||
            source.digest !== canonicalJsonDigest(value.value.json) ||
            source.bytes !== value.value.bytes ||
            (published.value.kind === 'inline' &&
              canonicalJsonDigest(published.value.value) !== source.digest)
          )
            return entry.owner ? uncertain(entry.owner) : failure('internal', 'accounting_output_proof')
          if (kind === 'query') {
            const finalCurrent = await authority.checkCurrent(context)
            if (!finalCurrent.ok) return finalCurrent
            const finalLive = preflight(context)
            if (!finalLive.ok) return finalLive
          }
          return {
            ok: true,
            value: {
              output: published.value,
              ...(result.snapshot === undefined ? {} : { snapshot: result.snapshot }),
            },
          }
        } catch (error) {
          if (dispatched && entry.owner) return uncertain(entry.owner)
          const explicit = parse('RuntimeError', error)
          if (explicit.ok && !started) return { ok: false, error: explicit.value }
          if (error instanceof BudgetAuthorityFault || error instanceof UsageOriginFault) {
            const code =
              error.detail === 'invalid'
                ? 'invalid_input'
                : error.detail === 'conflict'
                  ? 'conflict'
                  : error.detail === 'denied'
                    ? 'denied'
                    : error.detail === 'integrity'
                      ? 'internal'
                      : 'quota'
            return failure(code, `accounting_${error.detail}`)
          }
          return started && entry.owner
            ? uncertain(entry.owner)
            : failure('retryable', 'accounting_authority_unavailable')
        } finally {
          active.delete(token)
        }
      }
      return {
        async ready(context) {
          const result = preflight(context)
          return result.ok ? authority.checkCurrent(context) : result
        },
        async health(context) {
          return authority.health(context)
        },
        async drain(deadline, context) {
          if (state !== 'closed') state = 'draining'
          const result = await authority.drain(deadline, context)
          if (!result.ok) return result
          return {
            ok: true,
            value: {
              ...result.value,
              state: active.size ? 'blocked' : result.value.state,
              activeInvocationIds: [
                ...new Set([
                  ...result.value.activeInvocationIds,
                  ...[...active.values()].map((value) => value.invocationId),
                ]),
              ],
              durableOwnerRefs: [
                ...result.value.durableOwnerRefs,
                ...[...active.values()].flatMap((value) => (value.owner ? [value.owner] : [])),
              ],
            },
          }
        },
        async close(reason) {
          if (state === 'closed') return
          state = 'closed'
          lifetime.abort()
          await authority.close(reason)
        },
        async control(request, context) {
          const result = await call('control', request, context)
          return result.ok ? { ok: true, value: result.value.output } : result
        },
        async query(request, context) {
          const result = await call('query', request, context)
          if (!result.ok) return result
          if (result.value.snapshot === undefined) return failure('internal', 'accounting_query_snapshot')
          return {
            ok: true,
            value: { kind: 'value', output: result.value.output, snapshot: result.value.snapshot },
          }
        },
      }
    },
  }
}
