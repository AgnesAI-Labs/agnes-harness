import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type BindingRef,
  type DataRef,
  type IntegrityVerifyPackageRequest,
  type IntegrityVerifyPackageResult,
  type OwnerRef,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  type ScopeRef,
  type ServiceOperation,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { LedgerIntegrityFailure } from '../../log/integrity.js'
import { canonicalizeIntegrity } from '../integrity/canonicalize.js'
import {
  decodeIntegrityData,
  encodeIntegrityData,
  freezeIntegrityValue,
  sameIntegrityValue,
  unwrapIntegrityData,
} from '../integrity/data.js'
import { checkedIntegrityRefusal, failIntegrity, IntegrityFailure } from '../integrity/validation.js'
import { verifyIntegrity } from '../integrity/verify.js'

const contract = 'agh.integrity'
const methods = RuntimeServiceCatalog[contract].methods
const schemas = RuntimeMethodSchemaRefs[contract]

/** Real deployment owners check package provenance and maintenance authorization. */
export interface IntegrityTransferPort {
  readonly descriptor: Readonly<{
    binding: BindingRef
    scope: ScopeRef
    feature: 'authority-transfer.v1'
    methods: readonly string[]
  }>
  prepare(operation: ServiceOperation, context: CallContext): Promise<Outcome<OwnerRef>>
  execute(operation: ServiceOperation, owner: OwnerRef, context: CallContext): Promise<Outcome<DataRef>>
  reconcile(operation: ServiceOperation, owner: OwnerRef, context: CallContext): Promise<Outcome<DataRef>>
}
export interface IntegrityMaintenancePorts {
  verifyPackage(
    request: IntegrityVerifyPackageRequest,
    context: CallContext,
  ): Promise<Outcome<IntegrityVerifyPackageResult>>
  authorityTransfer?: IntegrityTransferPort
}
export interface IntegrityProviderOptions {
  readonly binding: BindingRef
  readonly scope: ScopeRef
  readonly authorize: (operation: ServiceOperation, context: CallContext) => Promise<Outcome<void>>
  readonly maintenance?: IntegrityMaintenancePorts
  readonly methods?: readonly string[]
  readonly signal?: AbortSignal
}
function errorOf(error: unknown) {
  if (error instanceof IntegrityFailure) return error.error
  if (error instanceof LedgerIntegrityFailure)
    return new IntegrityFailure('invalid_input', 'integrity_mismatch').error
  return new IntegrityFailure('internal', 'integrity_provider_failed').error
}

/** Stateless compute; supplied checkpoints and manifests never become grants or storage facts. */
export function createIntegrityProvider(options: IntegrityProviderOptions): ServiceProvider {
  const selectedBinding = validateRuntime('BindingRef', options.binding)
  const selectedScope = validateRuntime('ScopeRef', options.scope)
  if (!selectedBinding.ok || !selectedScope.ok || selectedBinding.value.contract !== contract)
    throw new TypeError('Invalid Integrity binding')
  const binding = Object.freeze(selectedBinding.value)
  const scope = Object.freeze(selectedScope.value)
  const authorize = options.authorize
  const maintenance = options.maintenance
  const transfer = maintenance?.authorityTransfer
  const transferMethods = new Set<string>()
  if (transfer) {
    const ownerBinding = validateRuntime('BindingRef', transfer.descriptor?.binding)
    const ownerScope = validateRuntime('ScopeRef', transfer.descriptor?.scope)
    const names = transfer.descriptor?.methods
    if (
      !ownerBinding.ok ||
      !ownerScope.ok ||
      !sameIntegrityValue(ownerBinding.value, binding) ||
      !sameIntegrityValue(ownerScope.value, scope) ||
      transfer.descriptor.feature !== 'authority-transfer.v1' ||
      !Array.isArray(names) ||
      names.length === 0 ||
      names.some((name) => typeof name !== 'string') ||
      typeof transfer.prepare !== 'function' ||
      typeof transfer.execute !== 'function' ||
      typeof transfer.reconcile !== 'function'
    )
      throw new TypeError('Unqualified Integrity transfer owner')
    for (const name of names) {
      if (transferMethods.has(name) || !Object.hasOwn(methods, name))
        throw new TypeError('Invalid Integrity transfer methods')
      const metadata = methods[name as keyof typeof methods]
      if (
        metadata.kind !== 'maintenance' ||
        !('requiredFeature' in metadata) ||
        metadata.requiredFeature !== 'authority-transfer.v1'
      )
        throw new TypeError('Invalid Integrity transfer qualification')
      transferMethods.add(name)
    }
  }
  const permitted = options.methods === undefined ? null : new Set(options.methods)
  const shutdown = options.signal
  const active = new Map<string, AbortController>()
  let admitting = true
  let closed = false
  const abortCalls = () => {
    for (const controller of active.values()) controller.abort()
  }
  shutdown?.addEventListener('abort', abortCalls, { once: true })

  function recheck(context: CallContext): void {
    if (closed || !admitting) failIntegrity('incompatible', 'provider_closed')
    if (shutdown?.aborted || context.signal.aborted) failIntegrity('cancelled', 'cancelled')
    const deadline = Date.parse(context.deadline)
    if (!Number.isFinite(deadline) || Date.now() > deadline) failIntegrity('timeout', 'deadline_exceeded')
    if (context.bindingId !== binding.bindingId || !sameIntegrityValue(context.scope, scope))
      failIntegrity('denied', 'permission_denied')
  }
  function captureContext(supplied: CallContext, signal: AbortSignal): CallContext {
    if (supplied === null || typeof supplied !== 'object')
      failIntegrity('invalid_input', 'invalid_call_context')
    const prototype = Object.getPrototypeOf(supplied)
    if (prototype !== Object.prototype && prototype !== null)
      failIntegrity('invalid_input', 'invalid_call_context')
    const properties = Object.getOwnPropertyDescriptors(supplied)
    if (
      Reflect.ownKeys(supplied).some((key) => typeof key !== 'string') ||
      Object.values(properties).some((property) => !('value' in property))
    )
      failIntegrity('invalid_input', 'invalid_call_context')
    const wire = Object.fromEntries(
      Object.entries(properties)
        .filter(([key]) => key !== 'signal')
        .map(([key, property]) => [key, property.value]),
    )
    const checked = validateRuntime('CallContextWire', wire)
    if (!checked.ok) failIntegrity('invalid_input', 'invalid_call_context')
    freezeIntegrityValue(checked.value)
    return Object.freeze({ ...checked.value, signal })
  }
  async function run(
    operation: ServiceOperation,
    context: CallContext,
    isMaintenance: boolean,
    startEffect: (owner: OwnerRef) => void,
  ) {
    if (!isMaintenance) {
      if (operation.method === 'canonicalize')
        return encodeIntegrityData(
          methods.canonicalize.output,
          schemas.canonicalize.output,
          canonicalizeIntegrity(unwrapIntegrityData(operation.input, schemas.canonicalize.input)),
        )
      if (operation.method === 'verify')
        return encodeIntegrityData(
          methods.verify.output,
          schemas.verify.output,
          verifyIntegrity(unwrapIntegrityData(operation.input, schemas.verify.input)),
        )
    } else if (maintenance && operation.method === 'verifyPackage') {
      const input = decodeIntegrityData(
        operation.input,
        schemas.verifyPackage.input,
        methods.verifyPackage.input,
      )
      const output = await maintenance.verifyPackage(input, context)
      if (!output.ok) return { ok: false as const, error: checkedIntegrityRefusal(output.error) }
      if (output.value.accepted && output.value.verifiedDigest !== input.expectedDigest)
        failIntegrity('invalid_input', 'integrity_mismatch')
      return encodeIntegrityData(methods.verifyPackage.output, schemas.verifyPackage.output, output.value)
    } else if (isMaintenance && transfer && transferMethods.has(operation.method)) {
      const key = operation.method as keyof typeof methods
      if (methods[key].kind !== 'maintenance') failIntegrity('incompatible', 'operation_not_supported')
      decodeIntegrityData(operation.input, schemas[key].input, methods[key].input)
      const prepared = await transfer.prepare(operation, context)
      if (!prepared.ok) return { ok: false as const, error: checkedIntegrityRefusal(prepared.error) }
      const reserved = validateRuntime('OwnerRef', prepared.value)
      if (!reserved.ok || reserved.value.kind !== 'reconciliation')
        failIntegrity('incompatible', 'maintenance_owner_unavailable')
      freezeIntegrityValue(reserved.value)
      recheck(context)
      const permission = await authorize(operation, context)
      if (!permission.ok) return { ok: false as const, error: checkedIntegrityRefusal(permission.error) }
      recheck(context)
      startEffect(reserved.value)
      const output = await transfer.execute(operation, reserved.value, context)
      if (!output.ok) return { ok: false as const, error: checkedIntegrityRefusal(output.error) }
      decodeIntegrityData(output.value, schemas[key].output, methods[key].output)
      return output.value
    }
    failIntegrity('incompatible', 'operation_not_supported')
  }
  async function call(request: ServiceOperation, supplied: CallContext, maintenanceCall: boolean) {
    const controller = new AbortController()
    let unlink: () => void = () => undefined
    let invocation: string | null = null
    let effectOwner: OwnerRef | null = null
    let effectContext: CallContext | null = null
    let effectRequest: ServiceOperation | null = null
    const unknownEffect = (): Outcome<DataRef> => {
      if (!effectOwner) throw new Error('No reserved maintenance owner')
      return {
        ok: false,
        error: {
          code: 'unknown_effect',
          detailCode: 'effect_unknown',
          message: 'Maintenance outcome must be reconciled with its persistent owner',
          diagnosticId: 'integrity-maintenance',
          retryAdvice: { kind: 'reconcile', ownerRef: effectOwner },
        },
      }
    }
    async function recover(): Promise<Outcome<DataRef>> {
      if (!effectOwner || !effectContext || !effectRequest || !transfer) return unknownEffect()
      try {
        recheck(effectContext)
        const current = await authorize(effectRequest, effectContext)
        if (!current.ok) return unknownEffect()
        recheck(effectContext)
        const remembered = await transfer.reconcile(effectRequest, effectOwner, effectContext)
        if (!remembered.ok) return unknownEffect()
        const method = effectRequest.method as keyof typeof methods
        const data = validateRuntime('DataRef', remembered.value)
        if (!data.ok) return unknownEffect()
        decodeIntegrityData(data.value, schemas[method].output, methods[method].output)
        recheck(effectContext)
        const latest = await authorize(effectRequest, effectContext)
        if (!latest.ok) return unknownEffect()
        recheck(effectContext)
        return { ok: true, value: data.value }
      } catch {
        return unknownEffect()
      }
    }
    try {
      const properties = Object.getOwnPropertyDescriptors(supplied)
      const sourceSignal: unknown = properties.signal?.value
      if (!(sourceSignal instanceof AbortSignal)) failIntegrity('invalid_input', 'invalid_call_context')
      const onAbort = () => controller.abort()
      sourceSignal.addEventListener('abort', onAbort, { once: true })
      unlink = () => sourceSignal.removeEventListener('abort', onAbort)
      if (sourceSignal.aborted) controller.abort()
      const context = captureContext(supplied, controller.signal)
      recheck(context)
      const parsed = validateRuntime('ServiceOperation', request)
      if (!parsed.ok || !sameIntegrityValue(parsed.value.target, binding))
        failIntegrity('invalid_input', 'invalid_request')
      freezeIntegrityValue(parsed.value)
      if (permitted && !permitted.has(parsed.value.method))
        failIntegrity('incompatible', 'operation_not_supported')
      if (active.has(context.invocationId)) failIntegrity('conflict', 'invocation_conflict')
      invocation = context.invocationId
      active.set(invocation, controller)
      const first = await authorize(parsed.value, context)
      if (!first.ok) return { ok: false as const, error: checkedIntegrityRefusal(first.error) }
      recheck(context)
      effectContext = context
      effectRequest = parsed.value
      const result = await run(parsed.value, context, maintenanceCall, (owner) => {
        effectOwner = owner
      })
      if ('ok' in result) return effectOwner ? await recover() : result
      recheck(context)
      const latest = await authorize(parsed.value, context)
      if (!latest.ok)
        return effectOwner
          ? unknownEffect()
          : { ok: false as const, error: checkedIntegrityRefusal(latest.error) }
      recheck(context)
      return { ok: true as const, value: result }
    } catch (error) {
      return effectOwner ? await recover() : { ok: false as const, error: errorOf(error) }
    } finally {
      unlink()
      if (invocation !== null) active.delete(invocation)
    }
  }
  return {
    compute: (request, context) => call(request, context, false),
    ...(maintenance
      ? { maintenance: (request: ServiceOperation, context: CallContext) => call(request, context, true) }
      : {}),
    ready: async (context) =>
      closed || !admitting || shutdown?.aborted || context.signal.aborted
        ? { ok: false, error: new IntegrityFailure('incompatible', 'provider_closed').error }
        : { ok: true, value: undefined },
    health: async () => ({
      ok: true,
      value: { status: closed || !admitting || shutdown?.aborted ? 'degraded' : 'ready', diagnosticIds: [] },
    }),
    drain: async () => {
      admitting = false
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
    close: async () => {
      closed = true
      admitting = false
      abortCalls()
      shutdown?.removeEventListener('abort', abortCalls)
    },
  }
}

export interface IntegrityFactoryOptions {
  readonly descriptor: ProviderDescriptor
  readonly configSchema: AuthorSchema<EmptyAuthorConfig>
  readonly authorize: IntegrityProviderOptions['authorize']
  readonly maintenance?: IntegrityMaintenancePorts
}
export function createIntegrityFactory(options: IntegrityFactoryOptions): ProviderFactory<ServiceProvider> {
  const parsed = validateRuntime('ProviderDescriptor', options.descriptor)
  if (
    !parsed.ok ||
    parsed.value.contract !== contract ||
    parsed.value.major !== 1 ||
    !sameIntegrityValue(parsed.value.configSchema, options.configSchema.ref)
  )
    throw new TypeError('Invalid Integrity descriptor or configuration schema')
  const descriptor = parsed.value
  freezeIntegrityValue(descriptor)
  const transfer = options.maintenance?.authorityTransfer
  if (transfer) {
    const transferBinding = validateRuntime('BindingRef', transfer.descriptor?.binding)
    const transferScope = validateRuntime('ScopeRef', transfer.descriptor?.scope)
    const names = transfer.descriptor?.methods
    if (
      !transferBinding.ok ||
      !transferScope.ok ||
      transferBinding.value.contract !== contract ||
      transferBinding.value.providerId !== descriptor.providerId ||
      transferBinding.value.logicalName !== descriptor.logicalName ||
      transfer.descriptor.feature !== 'authority-transfer.v1' ||
      !Array.isArray(names) ||
      names.length === 0 ||
      new Set(names).size !== names.length ||
      typeof transfer.prepare !== 'function' ||
      typeof transfer.execute !== 'function' ||
      typeof transfer.reconcile !== 'function'
    )
      throw new TypeError('Unqualified Integrity transfer owner')
    for (const method of names) {
      if (!Object.hasOwn(methods, method)) throw new TypeError('Unknown Integrity transfer method')
      const item = methods[method as keyof typeof methods]
      if (
        item.kind !== 'maintenance' ||
        !('requiredFeature' in item) ||
        item.requiredFeature !== 'authority-transfer.v1'
      )
        throw new TypeError('Invalid Integrity transfer method')
    }
  }
  const enabled = new Set<string>()
  for (const operation of descriptor.operations) {
    if (enabled.has(operation.method) || !Object.hasOwn(methods, operation.method))
      throw new TypeError('Invalid Integrity operation')
    enabled.add(operation.method)
    const key = operation.method as keyof typeof methods
    const metadata = methods[key]
    if (
      metadata.kind !== operation.kind ||
      !sameIntegrityValue(operation.inputSchema, schemas[key].input) ||
      !sameIntegrityValue(operation.outputSchema, schemas[key].output)
    )
      throw new TypeError('Integrity operation schemas do not match')
    if ('requiredFeature' in metadata && !descriptor.features.includes(metadata.requiredFeature))
      throw new TypeError('Missing Integrity maintenance feature')
    if (
      metadata.kind === 'maintenance' &&
      (!options.maintenance || (key !== 'verifyPackage' && !transfer?.descriptor.methods.includes(key)))
    )
      throw new TypeError('Missing trusted Integrity maintenance port')
  }
  if (!enabled.has('canonicalize') || !enabled.has('verify'))
    throw new TypeError('Missing Integrity computes')
  return {
    descriptor,
    create: async (config, _dependencies, context) => {
      const checked = validateRuntime('DataRef', config)
      if (!checked.ok) failIntegrity('invalid_input', 'integrity_configuration_invalid')
      const parsedConfig = options.configSchema.parse(
        unwrapIntegrityData(checked.value, descriptor.configSchema),
      )
      if (!parsedConfig.ok || Object.keys(parsedConfig.value).length !== 0)
        failIntegrity('invalid_input', 'integrity_configuration_invalid')
      if (context.signal.aborted) failIntegrity('cancelled', 'cancelled')
      return createIntegrityProvider({
        binding: {
          bindingId: context.bindingId,
          contract,
          logicalName: descriptor.logicalName,
          providerId: descriptor.providerId,
        },
        scope: context.scope,
        methods: [...enabled],
        signal: context.signal,
        authorize: options.authorize,
        ...(options.maintenance ? { maintenance: options.maintenance } : {}),
      })
    },
  }
}
