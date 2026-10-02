import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type BindingRef,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type IntegrityVerifyPackageRequest,
  type IntegrityVerifyPackageResult,
  type JsonValue,
  MAX_AUTHOR_INLINE_BYTES,
  type OwnerRef,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  type RuntimeWireTypes,
  type SchemaRef,
  type ScopeRef,
  type ServiceOperation,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import {
  IntegrityRefusal,
  referenceCanonicalize,
  referenceVerify,
  rejectIntegrity,
} from './integrity-algorithms.js'

/** Private deployment owner, not a public grant or a serialized recovery handle. */
export interface ReferenceIntegrityTransferPort {
  readonly descriptor: Readonly<{
    binding: BindingRef
    scope: ScopeRef
    feature: 'authority-transfer.v1'
    methods: readonly string[]
  }>
  /** Persists the full subject/binding/method/request identity and fingerprint before effects. */
  prepare(operation: ServiceOperation, context: CallContext): Promise<Outcome<OwnerRef>>
  /** Entry means effects may have happened; failure alone does not prove rollback. */
  execute(operation: ServiceOperation, ownerRef: OwnerRef, context: CallContext): Promise<Outcome<DataRef>>
  /** Current authorization plus exact persisted owner/request verification; never reexecutes. */
  reconcile(operation: ServiceOperation, ownerRef: OwnerRef, context: CallContext): Promise<Outcome<DataRef>>
}

/** Host-owned trust, package loading, signature verification and current permission checks. */
export interface ReferenceIntegrityMaintenance {
  verifyPackage(
    request: IntegrityVerifyPackageRequest,
    context: CallContext,
  ): Promise<Outcome<IntegrityVerifyPackageResult>>
  authorityTransfer?: ReferenceIntegrityTransferPort
}
export interface ReferenceIntegrityOptions {
  readonly binding: BindingRef
  readonly scope: ScopeRef
  /** Checks this selected instance and the caller's current permission; a reference is not a grant. */
  readonly authorize: (operation: ServiceOperation, context: CallContext) => Promise<Outcome<void>>
  readonly methods?: readonly string[]
  readonly signal?: AbortSignal
  readonly maintenance?: ReferenceIntegrityMaintenance
}

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}
const contract = 'agh.integrity'
const methods = RuntimeServiceCatalog[contract].methods
const refs = RuntimeMethodSchemaRefs[contract]
const same = (left: unknown, right: unknown): boolean => jcs(left) === jcs(right)

function transferDescriptor(
  port: ReferenceIntegrityTransferPort,
): ReferenceIntegrityTransferPort['descriptor'] {
  if (
    !port ||
    typeof port.prepare !== 'function' ||
    typeof port.execute !== 'function' ||
    typeof port.reconcile !== 'function'
  )
    throw new Error('Integrity transfer requires a durable recovery owner')
  const binding = validateRuntime('BindingRef', port.descriptor.binding)
  const scope = validateRuntime('ScopeRef', port.descriptor.scope)
  const enabled = port.descriptor.methods
  if (
    !binding.ok ||
    !scope.ok ||
    binding.value.contract !== contract ||
    port.descriptor.feature !== 'authority-transfer.v1' ||
    !Array.isArray(enabled) ||
    !enabled.length ||
    new Set(enabled).size !== enabled.length ||
    enabled.some(
      (name) =>
        !Object.hasOwn(methods, name) ||
        !('requiredFeature' in methods[name as keyof typeof methods]) ||
        (methods[name as keyof typeof methods] as { requiredFeature?: string }).requiredFeature !==
          'authority-transfer.v1',
    )
  )
    throw new Error('Invalid Integrity transfer owner descriptor')
  return Object.freeze({
    binding: Object.freeze(binding.value),
    scope: Object.freeze(scope.value),
    feature: 'authority-transfer.v1',
    methods: Object.freeze([...enabled]),
  })
}
function unknownTransfer(ownerRef: OwnerRef): Outcome<DataRef> {
  return {
    ok: false,
    error: {
      code: 'unknown_effect',
      detailCode: 'effect_unknown',
      message: 'Integrity maintenance result requires reconciliation',
      diagnosticId: 'reference-integrity',
      retryAdvice: { kind: 'reconcile', ownerRef },
    },
  }
}

function encode<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  value: RuntimeWireTypes[K],
): DataRef {
  if (!validateRuntime(name, value).ok) rejectIntegrity('invalid_input', 'integrity_output_invalid')
  const safe = boundedCanonicalJson(value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!safe.ok) rejectIntegrity('quota', 'inline_data_bytes')
  return {
    kind: 'inline',
    schema,
    value: safe.value.json,
    bytes: safe.value.bytes,
    digest: canonicalJsonDigest(safe.value.json),
  }
}
function unwrap(schema: SchemaRef, data: DataRef): JsonValue {
  if (data.kind !== 'inline' || !same(data.schema, schema))
    rejectIntegrity('invalid_input', 'schema_mismatch')
  const safe = boundedCanonicalJson(data.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!safe.ok) rejectIntegrity('quota', 'inline_data_bytes')
  if (data.bytes !== safe.value.bytes || data.digest !== canonicalJsonDigest(safe.value.json))
    rejectIntegrity('invalid_input', 'integrity_mismatch')
  return safe.value.json
}
function decode<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  data: DataRef,
): RuntimeWireTypes[K] {
  const checked = validateRuntime(name, unwrap(schema, data))
  if (!checked.ok) rejectIntegrity('invalid_input', 'integrity_input_invalid')
  return checked.value
}

/** Independent, stateless reference computation. It owns no ledger or permission database. */
export function createReferenceIntegrityProvider(options: ReferenceIntegrityOptions): ServiceProvider {
  const binding = validateRuntime('BindingRef', options.binding)
  const scope = validateRuntime('ScopeRef', options.scope)
  if (!binding.ok || !scope.ok || binding.value.contract !== contract)
    throw new Error('Invalid Integrity deployment binding')
  const selectedBinding = Object.freeze(binding.value)
  const selectedScope = Object.freeze(scope.value)
  const authorize = options.authorize
  const maintenancePort = options.maintenance
  const transferPort = maintenancePort?.authorityTransfer
  const transfer = transferPort ? transferDescriptor(transferPort) : undefined
  if (transfer && (!same(transfer.binding, selectedBinding) || !same(transfer.scope, selectedScope)))
    throw new Error('Integrity transfer owner does not match the selected deployment')
  const enabled = options.methods ? new Set(options.methods) : undefined
  let phase: 'ready' | 'draining' | 'closed' = 'ready'
  const active = new Map<string, AbortController>()
  const stop = () => {
    for (const controller of active.values()) controller.abort()
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  function live(context: CallContext): void {
    if (phase !== 'ready') rejectIntegrity('incompatible', 'provider_closed')
    if (options.signal?.aborted || context.signal.aborted) rejectIntegrity('cancelled', 'cancelled')
    if (!Number.isFinite(Date.parse(context.deadline)) || Date.now() >= Date.parse(context.deadline))
      rejectIntegrity('timeout', 'deadline_exceeded')
    if (context.bindingId !== selectedBinding.bindingId || !same(context.scope, selectedScope))
      rejectIntegrity('denied', 'permission_denied')
  }
  type TransferRecovery = {
    operation: ServiceOperation
    ownerRef: OwnerRef
    context: CallContext
    port: ReferenceIntegrityTransferPort
  }
  async function recoverTransfer(recovery: TransferRecovery): Promise<Outcome<DataRef>> {
    const { operation, ownerRef, context, port } = recovery
    try {
      live(context)
      const authorized = await authorize(operation, context)
      if (!authorized.ok) return unknownTransfer(ownerRef)
      live(context)
      const original = await port.reconcile(operation, ownerRef, context)
      if (!original.ok) return unknownTransfer(ownerRef)
      const method = operation.method as keyof typeof refs
      decode(methods[method].output, refs[method].output, original.value)
      live(context)
      if (!(await authorize(operation, context)).ok) return unknownTransfer(ownerRef)
      live(context)
      return original
    } catch {
      return unknownTransfer(ownerRef)
    }
  }
  async function call(
    request: unknown,
    supplied: CallContext,
    maintenance: boolean,
  ): Promise<Outcome<DataRef>> {
    let controller: AbortController | undefined
    let unsubscribe: (() => void) | undefined
    let invocation: string | undefined
    let recovery: TransferRecovery | undefined
    try {
      const prototype = Object.getPrototypeOf(supplied)
      if (prototype !== Object.prototype && prototype !== null)
        rejectIntegrity('invalid_input', 'invalid_call_context')
      const descriptors = Object.getOwnPropertyDescriptors(supplied)
      if (
        Reflect.ownKeys(supplied).some((key) => typeof key !== 'string') ||
        Object.values(descriptors).some((property) => !('value' in property))
      )
        rejectIntegrity('invalid_input', 'invalid_call_context')
      const signal: unknown = descriptors.signal?.value
      const wire = Object.fromEntries(
        Object.entries(descriptors)
          .filter(([key]) => key !== 'signal')
          .map(([key, property]) => [key, property.value]),
      )
      const checkedContext = validateRuntime('CallContextWire', wire)
      if (!checkedContext.ok || !(signal instanceof AbortSignal))
        rejectIntegrity('invalid_input', 'invalid_call_context')
      controller = new AbortController()
      const abort = () => controller?.abort()
      signal.addEventListener('abort', abort, { once: true })
      unsubscribe = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) controller.abort()
      Object.freeze(checkedContext.value.scope)
      const context: CallContext = Object.freeze({ ...checkedContext.value, signal: controller.signal })
      live(context)
      if (active.has(context.invocationId)) rejectIntegrity('conflict', 'invocation_conflict')
      invocation = context.invocationId
      active.set(invocation, controller)
      const checkedRequest = validateRuntime('ServiceOperation', request)
      if (!checkedRequest.ok || !same(checkedRequest.value.target, selectedBinding))
        rejectIntegrity('invalid_input', 'invalid_request')
      const operation = checkedRequest.value
      freeze(operation)
      if (enabled && !enabled.has(operation.method))
        rejectIntegrity('incompatible', 'operation_not_supported')
      const allowed = await authorize(operation, context)
      if (!allowed.ok) return allowed
      live(context)
      let result: DataRef
      if (!maintenance && operation.method === 'canonicalize') {
        const input = unwrap(refs.canonicalize.input, operation.input)
        result = encode(methods.canonicalize.output, refs.canonicalize.output, referenceCanonicalize(input))
      } else if (!maintenance && operation.method === 'verify') {
        const input = unwrap(refs.verify.input, operation.input)
        result = encode(methods.verify.output, refs.verify.output, referenceVerify(input))
      } else if (maintenance && operation.method === 'verifyPackage' && maintenancePort) {
        const input = decode(methods.verifyPackage.input, refs.verifyPackage.input, operation.input)
        const checked = await maintenancePort.verifyPackage(input, context)
        if (!checked.ok) return checked
        if (checked.value.accepted && checked.value.verifiedDigest !== input.expectedDigest)
          rejectIntegrity('invalid_input', 'integrity_mismatch')
        result = encode(methods.verifyPackage.output, refs.verifyPackage.output, checked.value)
      } else if (
        maintenance &&
        Object.hasOwn(refs, operation.method) &&
        Object.hasOwn(methods, operation.method) &&
        maintenancePort?.authorityTransfer
      ) {
        const method = operation.method as keyof typeof refs
        const metadata = methods[method]
        if (metadata.kind !== 'maintenance' || operation.method === 'verifyPackage')
          rejectIntegrity('incompatible', 'operation_not_supported')
        decode(metadata.input, refs[method].input, operation.input)
        if (!transfer?.methods.includes(operation.method))
          rejectIntegrity('incompatible', 'operation_not_supported')
        const port = maintenancePort.authorityTransfer
        const prepared = await port.prepare(operation, context)
        if (!prepared.ok) {
          if (!validateRuntimeErrorDetail(prepared.error).ok)
            rejectIntegrity('internal', 'integrity_recovery_owner_invalid')
          return prepared
        }
        const owner = validateRuntime('OwnerRef', prepared.value)
        if (!owner.ok || owner.value.kind !== 'reconciliation')
          rejectIntegrity('internal', 'integrity_recovery_owner_invalid')
        live(context)
        if (!(await authorize(operation, context)).ok) rejectIntegrity('denied', 'permission_denied')
        live(context)
        recovery = { operation, ownerRef: Object.freeze(owner.value), context, port }
        const checked = await port.execute(operation, recovery.ownerRef, context)
        if (!checked.ok) return await recoverTransfer(recovery)
        result = checked.value
        decode(metadata.output, refs[method].output, result)
      } else rejectIntegrity('incompatible', 'operation_not_supported')
      live(context)
      const latest = await authorize(operation, context)
      if (!latest.ok) return recovery ? unknownTransfer(recovery.ownerRef) : latest
      live(context)
      return { ok: true, value: result }
    } catch (caught) {
      if (recovery) return await recoverTransfer(recovery)
      return {
        ok: false,
        error:
          caught instanceof IntegrityRefusal
            ? caught.error
            : new IntegrityRefusal('internal', 'integrity_provider_failed').error,
      }
    } finally {
      unsubscribe?.()
      if (invocation !== undefined) active.delete(invocation)
    }
  }
  return {
    compute: (request, context) => call(request, context, false),
    ...(maintenancePort ? { maintenance: (request, context) => call(request, context, true) } : {}),
    ready: async (context) =>
      phase === 'ready' && !context.signal.aborted
        ? { ok: true, value: undefined }
        : { ok: false, error: new IntegrityRefusal('incompatible', 'provider_closed').error },
    health: async () => ({
      ok: true,
      value: { status: phase === 'ready' ? 'ready' : 'degraded', diagnosticIds: [] },
    }),
    drain: async () => {
      if (phase !== 'closed') phase = 'draining'
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
      phase = 'closed'
      stop()
      options.signal?.removeEventListener('abort', stop)
    },
  }
}

/** Configuration source identity is supplied by the deployment's generated empty-config codec. */
export interface ReferenceIntegrityFactoryOptions {
  readonly descriptor: ProviderDescriptor
  readonly configSchema: AuthorSchema<EmptyAuthorConfig>
  readonly authorize: ReferenceIntegrityOptions['authorize']
  readonly maintenance?: ReferenceIntegrityMaintenance
}

export function createReferenceIntegrityFactory(
  options: ReferenceIntegrityFactoryOptions,
): ProviderFactory<ServiceProvider> {
  const checked = validateRuntime('ProviderDescriptor', options.descriptor)
  if (
    !checked.ok ||
    checked.value.contract !== contract ||
    checked.value.major !== 1 ||
    !same(checked.value.configSchema, options.configSchema.ref)
  )
    throw new Error('Invalid Integrity descriptor or configuration source')
  const descriptor = checked.value
  freeze(descriptor)
  const transfer = options.maintenance?.authorityTransfer
    ? transferDescriptor(options.maintenance.authorityTransfer)
    : undefined
  if (
    transfer &&
    (transfer.binding.providerId !== descriptor.providerId ||
      transfer.binding.logicalName !== descriptor.logicalName)
  )
    throw new Error('Integrity transfer owner provider does not match descriptor')
  const advertised = new Set<string>()
  for (const operation of descriptor.operations) {
    if (advertised.has(operation.method) || !Object.hasOwn(methods, operation.method))
      throw new Error('Unknown or duplicate Integrity operation')
    advertised.add(operation.method)
    const method = operation.method as keyof typeof methods
    const metadata = methods[method]
    if ('requiredFeature' in metadata && !descriptor.features.includes(metadata.requiredFeature))
      throw new Error('Integrity maintenance feature is not advertised')
    if (
      operation.kind !== metadata.kind ||
      !same(operation.inputSchema, refs[method].input) ||
      !same(operation.outputSchema, refs[method].output)
    )
      throw new Error('Integrity operation codec mismatch')
    if (
      operation.kind === 'maintenance' &&
      (!options.maintenance || (method !== 'verifyPackage' && !options.maintenance.authorityTransfer))
    )
      throw new Error('Advertised Integrity maintenance needs a trusted deployment port')
    if (
      'requiredFeature' in metadata &&
      metadata.requiredFeature === 'authority-transfer.v1' &&
      !transfer?.methods.includes(operation.method)
    )
      throw new Error('Advertised Integrity transfer needs its actual recovery owner')
  }
  if (!advertised.has('canonicalize') || !advertised.has('verify'))
    throw new Error('Integrity computes must be advertised')
  return {
    descriptor,
    create: async (config, _dependencies, context) => {
      const checkedData = validateRuntime('DataRef', config)
      if (
        !checkedData.ok ||
        checkedData.value.kind !== 'inline' ||
        !same(checkedData.value.schema, options.configSchema.ref)
      )
        rejectIntegrity('invalid_input', 'schema_mismatch')
      const value = checkedData.value
      const safe = boundedCanonicalJson(value.value, {
        maxBytes: MAX_AUTHOR_INLINE_BYTES,
        maxDepth: 64,
        maxMembers: 10000,
      })
      if (
        !safe.ok ||
        safe.value.bytes !== value.bytes ||
        canonicalJsonDigest(safe.value.json) !== value.digest
      )
        rejectIntegrity('invalid_input', 'integrity_mismatch')
      const parsed = options.configSchema.parse(safe.value.json)
      if (!parsed.ok || Object.keys(parsed.value).length !== 0)
        rejectIntegrity('invalid_input', 'integrity_configuration_invalid')
      if (context.signal.aborted) rejectIntegrity('cancelled', 'cancelled')
      return createReferenceIntegrityProvider({
        binding: {
          bindingId: context.bindingId,
          contract,
          logicalName: descriptor.logicalName,
          providerId: descriptor.providerId,
        },
        scope: context.scope,
        methods: [...advertised],
        signal: context.signal,
        authorize: options.authorize,
        ...(options.maintenance ? { maintenance: options.maintenance } : {}),
      })
    },
  }
}
