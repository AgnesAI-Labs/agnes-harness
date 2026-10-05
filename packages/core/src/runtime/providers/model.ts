import type {
  ActionHandlerScope,
  ActionProviderFactory,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  LoopReadPorts,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  MAX_AUTHOR_INLINE_BYTES,
  type ProviderDescriptor,
  RuntimeAuthorCapabilities,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  assemblePrepared,
  type CatalogPick,
  checkCredential,
  modelCaptureOf,
  refusal,
  selectionDigest,
} from '../model/prepared-call.js'
import type { ModelCapture, WireIdentity } from '../model/wire-request.js'

export type ModelCatalogView = Readonly<{
  digest: string
  select(route: string, model: string): CatalogPick | undefined
}>
export type IssuanceEntry = Readonly<{
  /** Digest of the whole inline prepared body, which is the digest of the prepared reference. */
  preparedDigest: W.Digest
  inputDigest: W.Digest
  /** The retained whole-catalog digest the source reader reads the capture back by. */
  captureDigest: string
  wire: WireIdentity
  scope: Readonly<{ sessionId: string; runId: string }>
  ownerBindingId: string
}>
export type RevisionBinding = Readonly<{
  routeId: string
  routeRevision: number
  catalogRevision: number
  selectionDigest: W.Digest
}>
export interface ModelDeployment {
  readonly packageDigest: string
  readonly config: AuthorSchema<EmptyAuthorConfig>
  /** Secrets service binding for the credential resolve query; null when none is selected. */
  readonly secrets: W.BindingRef | null
  /** State service binding for reading published child results. */
  readonly state: W.BindingRef
  current(context: CallContext): boolean
  catalog: { capture(context: CallContext): Outcome<ModelCatalogView> }
  prices: { version(target: W.ModelRouteSnapshot, capture: ModelCapture): string | null }
  /** The trusted source of the wire identity; the provider never infers a slot or reads it from the caller. */
  wire: {
    resolve(request: {
      context: CallContext
      sessionParameterRef: W.DomainReference
      route: W.ModelRouteSnapshot
    }): Promise<Outcome<WireIdentity>>
  }
  adapters: {
    select(
      target: W.BindingRef,
      context: CallContext,
    ): { binding: W.BindingRef; packageDigest: string } | null
  }
  issuance: {
    record(entry: IssuanceEntry): Outcome<void>
    read(preparedDigest: string): IssuanceEntry | undefined
    bindRevision(binding: RevisionBinding): Outcome<void>
  }
  credentials?: {
    verifyIssued(handle: W.SecretHandle, binding: W.SecretConsumerBinding, context: CallContext): boolean
  }
  estimate?(prepared: W.PreparedModelRequest): readonly W.ExactQuantity[]
  bridge: { ready(context: CallContext): Outcome<void> }
  now?(): number
}

const methods = RuntimeMethodSchemaRefs['agh.model']
const LIMITS = { maxBytes: MAX_AUTHOR_INLINE_BYTES, maxDepth: 128, maxMembers: 10000 }
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)

class ModelFault extends Error {
  constructor(
    readonly code: W.RuntimeError['code'],
    readonly detail: string,
  ) {
    super(detail)
  }
}
const fault = (code: W.RuntimeError['code'], detail: string) => new ModelFault(code, detail)
const failed = (error: unknown): Outcome<never> =>
  error instanceof ModelFault
    ? refusal(error.code, error.detail)
    : refusal('retryable', 'model_dependency_unavailable')
const errorOf = (error: unknown): W.RuntimeError => {
  const refused = failed(error)
  if (refused.ok) throw new TypeError('refusal is never ok')
  return refused.error
}

function encode(schema: W.SchemaRef, value: unknown): W.DataRef {
  const body = boundedCanonicalJson(value, LIMITS)
  if (!body.ok) throw fault('quota', 'model_output_budget')
  return {
    kind: 'inline',
    schema,
    value: body.value.json,
    digest: canonicalJsonDigest(body.value.json),
    bytes: body.value.bytes,
  }
}
function decode<K extends keyof W.RuntimeWireTypes>(
  ref: W.DataRef,
  schema: W.SchemaRef,
  name: K,
): W.RuntimeWireTypes[K] {
  if (ref.kind !== 'inline' || !same(ref.schema, schema) || ref.digest !== canonicalJsonDigest(ref.value))
    throw fault('invalid_input', 'model_input_schema')
  const parsed = validateRuntime(name, ref.value)
  if (!parsed.ok) throw fault('invalid_input', 'model_input_schema')
  return parsed.value as W.RuntimeWireTypes[K]
}
async function raced<T>(work: Promise<T>, call: CallContext): Promise<T> {
  if (call.signal.aborted) throw fault('cancelled', 'model_cancelled')
  let off = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(fault('cancelled', 'model_cancelled'))
    call.signal.addEventListener('abort', stop, { once: true })
    off = () => call.signal.removeEventListener('abort', stop)
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    off()
  }
}
const runOf = (scope: W.ScopeRef): { sessionId: string; runId: string } => {
  if (scope.kind !== 'run' && scope.kind !== 'action') throw fault('denied', 'model_scope')
  return { sessionId: scope.sessionId, runId: scope.runId }
}

/** The one preparation path shared by compute `prepare` and the managed `prepareRequest`. */
async function prepareOnce(
  d: ModelDeployment,
  owner: W.BindingRef,
  input: W.ModelPrepareRequest,
  call: CallContext,
  resolved: boolean,
): Promise<W.ModelPrepareResult> {
  if (call.signal.aborted) throw fault('cancelled', 'model_cancelled')
  if (!d.current(call)) throw fault('denied', 'model_binding_denied')
  const scope = runOf(call.scope)
  if (input.hookResults !== null) throw fault('incompatible', 'model_hooks_unsupported')
  const route = input.route
  const relation = checkCredential(route, input.credentialRef, (d.now ?? Date.now)())
  if (!relation.ok) throw fault(relation.error.code, relation.error.detailCode)
  if (!resolved && route.credentialBinding !== null) {
    const verified =
      d.credentials?.verifyIssued(input.credentialRef as W.SecretHandle, route.credentialBinding, call) ===
      true
    if (!verified) throw fault('incompatible', 'model_credential_unverified')
  }
  const adapter = d.adapters.select(route.adapter, call)
  if (!adapter || !same(adapter.binding, route.adapter)) throw fault('denied', 'model_adapter_unavailable')
  const features = route.features
  if (
    (input.toolCatalog !== null && !features.tools) ||
    (input.outputSchema !== null && !features.structuredOutput)
  )
    throw fault('incompatible', 'model_feature_mismatch')
  const catalog = d.catalog.capture(call)
  if (!catalog.ok) throw fault(catalog.error.code, catalog.error.detailCode)
  const picked = catalog.value.select(route.routeId, route.model)
  if (!picked) throw fault('denied', 'model_catalog_missing')
  const capture: ModelCapture = modelCaptureOf(adapter.packageDigest, picked)
  const price = d.prices.version(route, capture)
  if (price === null) throw fault('backend_unavailable', 'model_not_ready')
  if (price !== route.priceVersion) throw fault('denied', 'model_price_mismatch')
  const wire = await raced(
    d.wire.resolve({ context: call, sessionParameterRef: input.sessionParameterRef, route }),
    call,
  )
  if (!wire.ok) throw fault(wire.error.code, wire.error.detailCode)
  const first = assemblePrepared({ owner, request: input, capture, wire: wire.value, estimatedUnits: [] })
  if (!first.ok) throw fault(first.error.code, first.error.detailCode)
  const units = d.estimate ? [...d.estimate(first.value.prepared)] : []
  const assembled =
    units.length === 0
      ? first
      : assemblePrepared({ owner, request: input, capture, wire: wire.value, estimatedUnits: units })
  if (!assembled.ok) throw fault(assembled.error.code, assembled.error.detailCode)
  const final = assembled.value
  if (call.signal.aborted) throw fault('cancelled', 'model_cancelled')
  // Everything is validated; only now is anything written. The route revision is pinned together with the issuance.
  const bound = d.issuance.bindRevision({
    routeId: route.routeId,
    routeRevision: route.routeRevision,
    catalogRevision: route.catalogRevision,
    selectionDigest: selectionDigest(picked),
  })
  if (!bound.ok) throw fault(bound.error.code, bound.error.detailCode)
  const recorded = d.issuance.record({
    preparedDigest: final.ref.digest,
    inputDigest: final.prepared.inputDigest,
    captureDigest: catalog.value.digest,
    wire: wire.value,
    scope,
    ownerBindingId: owner.bindingId,
  })
  if (!recorded.ok) throw fault(recorded.error.code, recorded.error.detailCode)
  return {
    preparedRef: final.ref,
    targetSnapshot: route,
    inputDigest: final.prepared.inputDigest,
    estimatedUnits: final.prepared.estimatedUnits,
    mediaPlanRefs: [],
  }
}

const prepareRequestCodec: W.StateCodecRef = {
  namespace: 'agh.default/model-prepare-request',
  codecVersion: '1',
  schema: {
    typeId: 'agh.model/prepare-request-continuation@1',
    revision: 1,
    digest: canonicalJsonDigest({
      type: 'object',
      additionalProperties: false,
      required: ['request'],
      properties: { request: { type: 'string' } },
    }),
  },
}

export function createDefaultModelFactory(d: ModelDeployment): ProviderFactory<ServiceProvider> {
  const inferenceCapability = {
    ...RuntimeAuthorCapabilities.modelInference,
    resourceTypes: [...RuntimeAuthorCapabilities.modelInference.resourceTypes],
    operations: [...RuntimeAuthorCapabilities.modelInference.operations],
  }
  const op = (
    method: 'prepare' | 'prepareRequest' | 'infer',
    kind: 'compute' | 'action',
    retrySafety: 'read-only' | 'never',
  ) => ({
    method,
    kind,
    inputSchema: methods[method].input,
    outputSchema: methods[method].output,
    requiredCapabilities: method === 'infer' ? [inferenceCapability] : [],
    retrySafety,
  })
  const descriptor: ProviderDescriptor = {
    providerId: 'agh.default/model',
    contract: 'agh.model',
    major: 1,
    logicalName: 'default',
    packageVersion: '0.0.0',
    packageDigest: d.packageDigest,
    features: [],
    scope: 'runtime',
    configSchema: d.config.ref,
    requires: [],
    capabilities: [inferenceCapability],
    recovery: 'R2',
    isolation: ['trusted-in-process'],
    stateCodecs: [prepareRequestCodec],
    activationMode: 'eager',
    operations: [
      op('prepare', 'compute', 'read-only'),
      op('prepareRequest', 'action', 'never'),
      op('infer', 'action', 'never'),
    ],
  }
  if (!validateRuntime('ProviderDescriptor', descriptor).ok) throw new TypeError('Invalid model descriptor')
  return {
    descriptor,
    async create(_config, _dependencies, factory: FactoryContext) {
      const owner: W.BindingRef = {
        bindingId: factory.bindingId,
        contract: 'agh.model',
        logicalName: 'default',
        providerId: 'agh.default/model',
      }
      let phase: 'starting' | 'ready' | 'draining' | 'closed' = 'starting'
      const active = new Set<string>()
      const live = (call: CallContext) =>
        phase === 'ready' && !factory.signal.aborted && !call.signal.aborted && d.current(call)
      const service: ServiceProvider = {
        async ready(call) {
          const bridge = d.bridge.ready(call)
          if (!bridge.ok) return bridge
          if (phase !== 'starting' || !d.current(call)) return refusal('denied', 'model_binding_denied')
          phase = 'ready'
          return { ok: true, value: undefined }
        },
        async health(call) {
          return { ok: true, value: { status: live(call) ? 'ready' : 'failed', diagnosticIds: [] } }
        },
        async drain(_deadline, _call) {
          if (phase !== 'closed') phase = 'draining'
          return {
            ok: true,
            value: {
              state: active.size ? 'blocked' : 'drained',
              activeInvocationIds: [...active],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          phase = 'closed'
        },
        compute: async (request, call) => {
          if (request.target.bindingId !== factory.bindingId || request.method !== 'prepare')
            return refusal('denied', 'model_binding_denied')
          if (phase !== 'ready') return refusal('denied', 'provider_closed')
          active.add(call.invocationId)
          try {
            const input = decode(request.input, methods.prepare.input, 'ModelPrepareRequest')
            const result = await prepareOnce(d, owner, input, call, false)
            return { ok: true, value: encode(methods.prepare.output, result) }
          } catch (error) {
            return failed(error)
          } finally {
            active.delete(call.invocationId)
          }
        },
      }
      service.actions = {
        prepareRequest: prepareRequestAction(d, owner, factory, () => phase, active),
      }
      return service
    },
  }
}

function prepareRequestAction(
  d: ModelDeployment,
  owner: W.BindingRef,
  factory: FactoryContext,
  phase: () => string,
  active: Set<string>,
): ActionProviderFactory {
  return {
    kind: 'composite',
    recovery: 'R2',
    stateCodec: prepareRequestCodec,
    async create(scope: ActionHandlerScope) {
      const stop = new AbortController()
      const state = (frame: W.ActionFrame): W.VersionedState => ({
        namespace: prepareRequestCodec.namespace,
        codecVersion: '1',
        data: encode(prepareRequestCodec.schema, { request: frame.inputDigest }),
        provenance: { sourceRefs: [], producer: owner, trustLabels: [] },
        createdAt: frame.observedAt,
        references: [],
      })
      async function step(frame: W.ActionFrame, ports: LoopReadPorts): Promise<W.ProviderTransition> {
        const call: CallContext = {
          ...frame.context,
          signal: AbortSignal.any([scope.signal, stop.signal, factory.signal]),
        }
        const transition = (next: W.NextStep): W.ProviderTransition => ({
          expectedProviderRevision: frame.providerRevision,
          continuation: state(frame),
          consumeSignals: [],
          children: [],
          next,
        })
        try {
          if (stop.signal.aborted || phase() !== 'ready') throw fault('denied', 'provider_closed')
          if (
            scope.bindingId !== factory.bindingId ||
            frame.bindingId !== factory.bindingId ||
            frame.runId !== scope.runId ||
            frame.actionId !== scope.actionId ||
            frame.method !== 'prepareRequest' ||
            frame.inputDigest !==
              (frame.input.kind === 'inline' ? frame.input.digest : frame.input.blob.digest)
          )
            throw fault('denied', 'model_binding_denied')
          const input = decode(frame.input, methods.prepareRequest.input, 'ModelPrepareRequestRequest')
          if (input.credentialRefresh !== null) throw fault('incompatible', 'model_refresh_unsupported')
          let handle: W.SecretHandle | null = null
          const binding = input.route.credentialBinding
          if (binding !== null) {
            if (!d.secrets) throw fault('incompatible', 'model_credential_unverified')
            const resolve = RuntimeMethodSchemaRefs['agh.secrets'].resolve
            const reply = await raced(
              ports.query({
                target: d.secrets,
                method: 'resolve',
                input: encode(resolve.input, {
                  secretId: binding.secretId,
                  audience: binding.audience,
                  purpose: binding.purpose,
                }),
              }),
              call,
            )
            if (!reply.ok || reply.value.kind !== 'value')
              throw fault('backend_unavailable', 'model_credential_unavailable')
            handle = decode(reply.value.output, resolve.output, 'SecretHandle')
          }
          if (input.credentialRef !== null && !same(input.credentialRef, handle))
            throw fault('denied', 'model_credential_binding')
          const { credentialRefresh: _refresh, ...rest } = input
          const result = await prepareOnce(
            d,
            owner,
            { ...rest, hookResults: null, credentialRef: handle },
            call,
            true,
          )
          return transition({
            kind: 'complete',
            output: encode(methods.prepareRequest.output, result),
            references: [],
          })
        } catch (error) {
          return transition({ kind: 'fail', error: errorOf(error) })
        }
      }
      return {
        kind: 'composite',
        async ready() {
          return stop.signal.aborted ? refusal('denied', 'provider_closed') : { ok: true, value: undefined }
        },
        async health() {
          return { ok: true, value: { status: stop.signal.aborted ? 'failed' : 'ready', diagnosticIds: [] } }
        },
        async drain() {
          stop.abort()
          return {
            ok: true,
            value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
          }
        },
        async close() {
          stop.abort()
        },
        async start(frame, ports) {
          active.add(frame.invocationId)
          try {
            return await step(frame, ports)
          } finally {
            active.delete(frame.invocationId)
          }
        },
        async resume(frame, ports) {
          active.add(frame.invocationId)
          try {
            return await step(frame, ports)
          } finally {
            active.delete(frame.invocationId)
          }
        },
      }
    },
  }
}
