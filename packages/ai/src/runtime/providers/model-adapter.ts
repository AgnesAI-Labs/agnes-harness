import {
  type ActionContext,
  type CallContext,
  type FactoryContext,
  type Outcome,
  type ProviderFactory,
  runtimeAuthorSchemas,
  type ServiceProvider,
} from '@agnes/extension-api/runtime'
import type { ResponseMeta, ToolCall } from '@agnes/protocol'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type ExternalRequestRef,
  MAX_AUTHOR_INLINE_BYTES,
  type ModelOutput,
  type ProviderDescriptor,
  type ReconcileResult,
  RuntimeAuthorCapabilities,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  type UsageFact,
  type UsageMeasurement,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { PiAdapter } from '../../adapters/pi/index.js'
import { mediaConsumed } from '../model-adapter/media.js'
import type { ModelAdapterDeployment, ModelWireFetch, ModelWireSource } from '../model-adapter/ports.js'
import { type ModelUsageEvidence, modelUsageEvidence } from '../model-adapter/usage-evidence.js'

const methods = RuntimeMethodSchemaRefs['agh.model-adapter']
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)
const error = (code: RuntimeError['code'], detailCode: string): RuntimeError => ({
  code,
  detailCode,
  message: 'Model adapter request refused',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'model-adapter',
})
const failure = (code: RuntimeError['code'], detailCode: string): EffectResult => ({
  outcome: code === 'unknown_effect' ? 'unknown_effect' : code === 'cancelled' ? 'cancelled' : 'failed',
  error: error(code, detailCode),
  externalRequests: [],
  usage: [],
  references: [],
})
function decode(ref: DataRef, method: 'invoke' | 'reconcile'): Outcome<unknown> {
  const safe = boundedCanonicalJson(ref, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES + 4096,
    maxDepth: 128,
    maxMembers: 10000,
  })
  if (
    !safe.ok ||
    !validateRuntime('DataRef', safe.value.json).ok ||
    ref.kind !== 'inline' ||
    !same(ref.schema, methods[method].input) ||
    ref.digest !== canonicalJsonDigest(ref.value)
  )
    return { ok: false, error: error('invalid_input', 'model_input') }
  const body = boundedCanonicalJson(ref.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: 128,
    maxMembers: 10000,
  })
  if (
    !body.ok ||
    body.value.bytes !== ref.bytes ||
    !validateRuntime(
      method === 'invoke' ? 'ModelAdapterInvokeRequest' : 'ModelAdapterReconcileRequest',
      body.value.json,
    ).ok
  )
    return { ok: false, error: error('invalid_input', 'model_input') }
  return { ok: true, value: body.value.json }
}
function validSource(source: ModelWireSource, frame: ActionFrame, factory: FactoryContext): boolean {
  const p = source.prepared
  return (
    validateRuntime('PreparedModelRequest', p).ok &&
    p.target.adapter.bindingId === factory.bindingId &&
    p.target.adapter.contract === 'agh.model-adapter' &&
    p.target.adapter.providerId === 'agh.default/model-adapter' &&
    frame.bindingId === factory.bindingId &&
    frame.requestIdentity !== null &&
    p.target.model === source.model.id &&
    source.model.route === source.route.route &&
    source.request.derivedHash === p.inputDigest &&
    source.request.route === source.route.route &&
    source.request.model === p.target.model &&
    source.route.models.some((model) => same(model, source.model)) &&
    ['openai-completions', 'anthropic-messages'].includes(source.route.api) &&
    source.request.sampling?.maxTokens === p.generation.maxOutputTokens &&
    (source.request.sampling?.thinking ?? null) === p.generation.thinking &&
    mediaConsumed(source) &&
    p.outputSchema === null
  )
}
function external(frame: ActionFrame): ExternalRequestRef {
  if (!frame.requestIdentity) throw new Error('Missing request identity')
  return {
    system: frame.requestIdentity.system,
    requestId: frame.requestIdentity.aghRequestId,
    requestDigest: frame.requestIdentity.requestDigest,
    ...(frame.requestIdentity.idempotencyKey === null
      ? {}
      : { idempotencyKey: frame.requestIdentity.idempotencyKey }),
  }
}
const encodeMethod = (name: 'ModelOutput' | 'ReconcileResult', value: unknown): Outcome<DataRef> => {
  const schema = name === 'ModelOutput' ? methods.invoke.output : methods.reconcile.output
  const parsed = validateRuntime(name, value)
  const canonical = boundedCanonicalJson(value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: 128,
    maxMembers: 10000,
  })
  return parsed.ok && canonical.ok
    ? {
        ok: true,
        value: {
          kind: 'inline',
          schema,
          value: canonical.value.json,
          digest: canonicalJsonDigest(canonical.value.json),
          bytes: canonical.value.bytes,
        },
      }
    : { ok: false, error: error('invalid_input', 'model_result') }
}
const checked = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw new Error('Invalid model encoding')
  return outcome.value
}

const inferenceCapability = {
  ...RuntimeAuthorCapabilities.modelInference,
  resourceTypes: [...RuntimeAuthorCapabilities.modelInference.resourceTypes],
  operations: [...RuntimeAuthorCapabilities.modelInference.operations],
}

export function createModelAdapterFactory(
  deployment: ModelAdapterDeployment,
): ProviderFactory<ServiceProvider> {
  if (
    !deployment.config ||
    !deployment.usage ||
    !deployment.usageAuthorityId ||
    !(Number.isFinite(deployment.creditsPerUsd ?? 1) && (deployment.creditsPerUsd ?? 1) > 0) ||
    !deployment.units ||
    Object.values(deployment.units).some((unit) => !unit) ||
    ['installed', 'load', 'current', 'withCredential', 'beforeSend', 'save', 'lookup'].some(
      (key) => typeof deployment[key as keyof ModelAdapterDeployment] !== 'function',
    )
  )
    throw new TypeError('Missing model source owner')
  const original = { ...deployment }
  const unitsDigest = canonicalJsonDigest(deployment.units as never)
  const descriptor: ProviderDescriptor = {
    providerId: 'agh.default/model-adapter',
    contract: 'agh.model-adapter',
    major: 1,
    logicalName: 'default',
    packageVersion: '0.0.0',
    packageDigest: deployment.packageDigest,
    features: ['openai-completions', 'anthropic-messages'],
    scope: 'runtime',
    configSchema: deployment.config.ref,
    requires: [],
    capabilities: [inferenceCapability],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: [
      {
        method: 'invoke',
        kind: 'action',
        inputSchema: methods.invoke.input,
        outputSchema: methods.invoke.output,
        requiredCapabilities: [inferenceCapability],
        retrySafety: 'never',
      },
      {
        method: 'reconcile',
        kind: 'action',
        inputSchema: methods.reconcile.input,
        outputSchema: methods.reconcile.output,
        requiredCapabilities: [],
        retrySafety: 'never',
      },
    ],
  }
  if (!validateRuntime('ProviderDescriptor', descriptor).ok) throw new TypeError('Invalid model descriptor')
  const sourcesUnchanged = () =>
    Object.entries(original).every(([key, value]) => deployment[key as keyof typeof deployment] === value) &&
    canonicalJsonDigest(deployment.units as never) === unitsDigest
  return {
    descriptor,
    async create(config, _dependencies, factory) {
      const configBody =
        config.kind === 'inline'
          ? boundedCanonicalJson(config.value, {
              maxBytes: MAX_AUTHOR_INLINE_BYTES,
              maxDepth: 128,
              maxMembers: 10000,
            })
          : null
      if (
        !validateRuntime('DataRef', config).ok ||
        !configBody?.ok ||
        (config.kind === 'inline' && config.bytes !== configBody.value.bytes) ||
        factory.scope.kind !== 'runtime' ||
        config.kind !== 'inline' ||
        !same(config.schema, original.config.ref) ||
        config.digest !== canonicalJsonDigest(config.value) ||
        !original.config.parse(config.value).ok
      )
        throw new TypeError('Invalid model configuration')
      const factoryDigest = canonicalJsonDigest({
        instanceId: factory.instanceId,
        scope: factory.scope,
        bindingId: factory.bindingId,
      } as never)
      const factoryCurrent = () =>
        factoryDigest ===
        canonicalJsonDigest({
          instanceId: factory.instanceId,
          scope: factory.scope,
          bindingId: factory.bindingId,
        } as never)
      let phase: 'starting' | 'ready' | 'draining' | 'closed' = 'starting'
      const active = new Map<string, AbortController>()
      const callRelation = (context: CallContext) =>
        canonicalJsonDigest({
          scope: context.scope,
          bindingId: context.bindingId,
          principalRef: context.principalRef,
          authorizationRef: context.authorizationRef,
          invocationId: context.invocationId,
          deadline: context.deadline,
          traceRef: context.traceRef,
        })
      const staticCurrent = (context: CallContext) =>
        phase === 'ready' &&
        validateRuntime('ScopeRef', context.scope).ok &&
        factoryCurrent() &&
        Object.entries(factory.scope).every(
          ([key, value]) => key === 'kind' || context.scope[key as keyof typeof context.scope] === value,
        ) &&
        sourcesUnchanged() &&
        !factory.signal.aborted &&
        !context.signal.aborted &&
        context.bindingId === factory.bindingId &&
        Date.parse(context.deadline) > Date.now()
      const current = (context: CallContext) => {
        const relation = callRelation(context),
          signal = context.signal
        try {
          return (
            staticCurrent(context) &&
            original.installed(context) === true &&
            staticCurrent(context) &&
            signal === context.signal &&
            relation === callRelation(context)
          )
        } catch {
          return false
        }
      }
      const lifecycle = {
        async ready(context: CallContext): Promise<Outcome<void>> {
          const relation = callRelation(context),
            signal = context.signal
          if (
            phase !== 'starting' ||
            !sourcesUnchanged() ||
            !factoryCurrent() ||
            factory.signal.aborted ||
            context.signal.aborted ||
            original.installed(context) !== true ||
            !sourcesUnchanged() ||
            !validateRuntime('ScopeRef', context.scope).ok ||
            Date.parse(context.deadline) <= Date.now() ||
            !Number.isFinite(Date.parse(context.deadline)) ||
            context.bindingId !== factory.bindingId ||
            signal !== context.signal ||
            relation !== callRelation(context) ||
            !factoryCurrent() ||
            phase !== 'starting'
          )
            return { ok: false, error: error('denied', 'model_source') }
          phase = 'ready'
          return { ok: true, value: undefined }
        },
        async health(context: CallContext) {
          return {
            ok: true as const,
            value: { status: current(context) ? ('ready' as const) : ('failed' as const), diagnosticIds: [] },
          }
        },
        async drain(_deadline: string, _context: CallContext) {
          if (phase !== 'closed') phase = 'draining'
          for (const call of active.values()) call.abort()
          return {
            ok: true as const,
            value: {
              state: active.size ? ('blocked' as const) : ('drained' as const),
              activeInvocationIds: [...active.keys()],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          phase = 'closed'
          for (const call of active.values()) call.abort()
        },
      }
      const createAction = (method: 'invoke' | 'reconcile') => ({
        kind: 'leaf' as const,
        recovery: 'R1' as const,
        stateCodec: null,
        async create(scope: import('@agnes/extension-api/runtime').ActionHandlerScope) {
          let closed = false
          let draining = false
          const own = new Set<AbortController>()
          return {
            ...lifecycle,
            kind: 'leaf' as const,
            effectSemantics: 'non-idempotent' as const,
            executionUnit: 'single-effect' as const,
            async ready(context: CallContext): Promise<Outcome<void>> {
              return !closed && !draining && current(context) && scope.bindingId === factory.bindingId
                ? { ok: true, value: undefined }
                : { ok: false, error: error('denied', 'model_source') }
            },
            async drain() {
              draining = true
              for (const call of own) call.abort()
              return {
                ok: true as const,
                value: {
                  state: own.size ? ('blocked' as const) : ('drained' as const),
                  activeInvocationIds: [...active.entries()]
                    .filter(([, call]) => own.has(call))
                    .map(([id]) => id),
                  durableOwnerRefs: [],
                  diagnosticIds: [],
                },
              }
            },
            async close() {
              closed = true
              for (const call of own) call.abort()
            },
            async reconcile(
              frame: ActionFrame,
              evidence: readonly DataRef[],
              context: ActionContext,
            ): Promise<ReconcileResult> {
              return original.lookup(frame, evidence, context, null)
            },
            async execute(frame: ActionFrame, context: ActionContext): Promise<EffectResult> {
              if (
                closed ||
                draining ||
                scope.signal.aborted ||
                !(method === 'invoke' ? current(context.call) : staticCurrent(context.call)) ||
                frame.actionId !== scope.actionId ||
                frame.runId !== scope.runId ||
                frame.method !== method
              )
                return failure('denied', 'model_source')
              const originalCall = context.call,
                originalSignal = context.call.signal
              const relation = () =>
                canonicalJsonDigest({
                  frame,
                  call: {
                    principalRef: context.call.principalRef,
                    scope: context.call.scope,
                    bindingId: context.call.bindingId,
                    invocationId: context.call.invocationId,
                    deadline: context.call.deadline,
                    traceRef: context.call.traceRef,
                    authorizationRef: context.call.authorizationRef,
                  },
                } as never)
              const relationSnapshot = relation()
              const parsed = decode(frame.input, method)
              if (!parsed.ok) return failure(parsed.error.code, parsed.error.detailCode)
              if (method === 'reconcile') {
                const request = parsed.value as import('@agnes/protocol/runtime').ModelAdapterReconcileRequest
                const result = await original.lookup(
                  frame,
                  request.externalReceipt ? [request.externalReceipt] : [],
                  context,
                  request.attemptRef,
                )
                const data = encodeMethod('ReconcileResult', result)
                return data.ok
                  ? {
                      outcome: 'succeeded',
                      result: data.value,
                      externalRequests: [],
                      usage: [],
                      references: [],
                    }
                  : failure('invalid_input', 'model_reconcile_result')
              }
              const request = parsed.value as import('@agnes/protocol/runtime').ModelAdapterInvokeRequest
              let loaded: Outcome<ModelWireSource>
              try {
                loaded = await original.load(request.preparedCallRef, frame, context)
              } catch {
                return failure('denied', 'model_source_unavailable')
              }
              if (!loaded.ok) {
                if (loaded.error.detailCode !== 'model_prepared_lost')
                  return failure(loaded.error.code, loaded.error.detailCode)
                // The prepared call is gone from this process: never prepare or send again. The store says
                // whether a send was fenced for this attempt and what it saved.
                const found = await original.lookup(frame, [], context, null).catch(() => null)
                if (found?.kind === 'resolved') return found.result
                return found?.kind === 'not_found'
                  ? failure('incompatible', 'model_prepared_lost')
                  : failure('unknown_effect', 'model_prepared_unknown')
              }
              const source = loaded.value
              if (
                !validSource(source, frame, factory) ||
                request.externalIdempotencyKey !== frame.requestIdentity?.idempotencyKey ||
                !current(context.call) ||
                context.call !== originalCall ||
                context.call.signal !== originalSignal ||
                relation() !== relationSnapshot
              )
                return failure('invalid_input', 'model_prepared_source')
              const snapshot = canonicalJsonDigest(source as never)
              const staticAlive = () =>
                !closed &&
                !draining &&
                context.call === originalCall &&
                context.call.signal === originalSignal &&
                relation() === relationSnapshot &&
                !scope.signal.aborted &&
                staticCurrent(context.call) &&
                snapshot === canonicalJsonDigest(source as never)
              const alive = () => {
                try {
                  return (
                    staticAlive() &&
                    original.installed(context.call) === true &&
                    staticAlive() &&
                    original.current(source, frame, context.call) === true &&
                    staticAlive()
                  )
                } catch {
                  return false
                }
              }
              if (!alive()) return failure('denied', 'model_current')
              // The host's egress for this call, before the credential is touched. There is no
              // fallback: without one, nothing is sent.
              let fetch: ModelWireFetch | undefined
              try {
                fetch = original.egress?.(source, frame, context)
              } catch {
                fetch = undefined
              }
              if (typeof fetch !== 'function') return failure('denied', 'model_egress_missing')
              // An egress that owns the send fence says so by providing `fenced`; only then is its
              // evidence used. Anything else keeps the adapter's own fence and its classification.
              const wire = fetch,
                owned = typeof wire.fenced === 'function'
              const controller = new AbortController(),
                abort = () => controller.abort()
              if (active.has(frame.attemptId)) return failure('conflict', 'model_in_flight')
              active.set(frame.attemptId, controller)
              own.add(controller)
              for (const signal of [factory.signal, scope.signal, context.call.signal])
                signal.addEventListener('abort', abort, { once: true })
              let bodyDigest: string | null = null,
                sent = false,
                text = '',
                thinking = '',
                response: ResponseMeta | undefined
              const tools: ToolCall[] = []
              const usageState: {
                tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
                evidence: ModelUsageEvidence
                reportedFees: boolean
              } = { tokens: null, evidence: {}, reportedFees: false }
              const requestRef = external(frame)
              const unknownMeasurement: UsageMeasurement = {
                kind: 'unknown',
                quantities: [],
                actualModel: source.prepared.target.model,
                source: 'reported-target',
                sourceReceipt: null,
                replacesFactIds: [],
              }
              const unknownDimensions = original.usage.encode(unknownMeasurement)
              if (!unknownDimensions.ok) {
                active.delete(frame.attemptId)
                own.delete(controller)
                for (const signal of [factory.signal, scope.signal, context.call.signal])
                  signal.removeEventListener('abort', abort)
                return failure('invalid_input', 'model_usage_schema')
              }
              const unknownFact: UsageFact = {
                usageId: `${frame.attemptId}:model`,
                originKey: `${requestRef.system}:${requestRef.requestId}`,
                actionId: frame.actionId,
                attemptId: frame.attemptId,
                source: { ...source.prepared.target.adapter },
                dimensions: unknownDimensions.value,
                externalRequest: requestRef,
                observedAt: new Date().toISOString(),
                certainty: 'unknown',
              }
              let usage: UsageFact[] = [unknownFact],
                finish: ModelOutput['finishReason'] | null = null
              let result: EffectResult
              // The egress's own answer, missing or throwing read as possibly sent.
              const settle = () => {
                if (!owned) return
                try {
                  sent = wire.fenced?.() !== false
                } catch {
                  sent = true
                }
                if (finish !== null) sent = true
              }
              // Proven not sent: the egress owns the fence, did not commit it, and said why.
              const notSent = (): EffectResult | undefined => {
                if (!owned || sent) return undefined
                let refusal: ReturnType<NonNullable<ModelWireFetch['refusal']>>
                try {
                  refusal = wire.refusal?.()
                } catch {
                  return undefined
                }
                if (!refusal || !/^[a-z0-9_]{1,64}$/.test(String(refusal.detailCode))) return undefined
                const known = ['denied', 'retryable', 'cancelled', 'timeout'].includes(refusal.code)
                const code = known ? (refusal.code as RuntimeError['code']) : 'internal'
                const proven = failure(code, refusal.detailCode)
                return code === 'retryable' && proven.error
                  ? { ...proven, error: { ...proven.error, retryAdvice: { kind: 'retry_same_action' } } }
                  : proven
              }
              try {
                const output = await original.withCredential(source, frame, context, async (credential) => {
                  if (
                    !alive() ||
                    !credential?.trim() ||
                    source.prepared.credentialRef === null ||
                    source.prepared.target.credentialBinding === null
                  )
                    throw new Error('Retired source or missing bound credential')
                  const adapter = new PiAdapter({ manualRoutes: [source.route], maxRetries: 0, fetch })
                  adapter.bindCredential(source.route.route, credential)
                  for await (const event of adapter.stream(source.route.route, source.request, {
                    signal: controller.signal,
                    toolNames: source.request.tools.map((tool) => tool.name),
                    retry: false,
                    redirect: 'error',
                    sessionKey: source.request.sessionKey,
                    timeoutMs: {
                      firstToken: 120000,
                      total: Math.max(1, Math.min(600000, Date.parse(context.call.deadline) - Date.now())),
                    },
                    reportSent(report) {
                      if (owned) {
                        // The egress commits the fence at the connector; only record the digest.
                        if (!alive() || controller.signal.aborted || !staticAlive())
                          throw new Error('Model send refused')
                        bodyDigest = report.sentHash
                        return
                      }
                      if (
                        !alive() ||
                        controller.signal.aborted ||
                        original.beforeSend(source, frame, context, report.sentHash) !== true ||
                        !staticAlive()
                      )
                        throw new Error('Model send refused')
                      bodyDigest = report.sentHash
                      sent = true
                    },
                  })) {
                    if (event.type === 'text_delta') text += event.delta
                    if (event.type === 'thinking_delta') thinking += event.delta
                    if (event.type === 'toolcall_end') tools.push(event.call)
                    if (event.type === 'usage') {
                      usageState.tokens = event.tokens
                      usageState.evidence = modelUsageEvidence(source.model, event, original.creditsPerUsd)
                      usageState.reportedFees = event.billing !== undefined || event.credits !== undefined
                      response = event.response ?? response
                    }
                    if (event.type === 'done')
                      finish =
                        event.reason === 'toolUse'
                          ? 'tool-calls'
                          : event.reason === 'length'
                            ? 'length'
                            : 'stop'
                    if (event.type === 'error') {
                      response = event.response ?? response
                      finish = response?.status ? 'error' : null
                    }
                    if (text.length + thinking.length > MAX_AUTHOR_INLINE_BYTES) {
                      controller.abort()
                      throw new Error('Model output quota')
                    }
                  }
                })
                settle()
                if (!output.ok) throw new Error('Credential owner refused')
                const receipt = response
                  ? checked(runtimeAuthorSchemas.ProviderResponseEvidence.encode(response))
                  : null
                const measured =
                  usageState.tokens !== null &&
                  Object.values(usageState.tokens).some((quantity) => quantity > 0)
                const measurement: UsageMeasurement = {
                  kind: measured ? 'reported' : 'unknown',
                  ...usageState.evidence,
                  quantities:
                    measured && usageState.tokens
                      ? Object.entries(usageState.tokens).map(([unit, quantity]) => ({
                          unit: original.units[unit as keyof typeof original.units],
                          value: String(quantity),
                        }))
                      : [],
                  actualModel: response?.model ?? source.prepared.target.model,
                  source: response ? 'provider-receipt' : 'reported-target',
                  sourceReceipt: receipt,
                  replacesFactIds: [],
                }
                let dimensions = original.usage.encode(measurement)
                if (!dimensions.ok && !usageState.reportedFees) {
                  const {
                    billing: _billing,
                    credits: _credits,
                    creditSource: _creditSource,
                    ...legacy
                  } = measurement
                  dimensions = original.usage.encode(legacy)
                }
                usage = [
                  {
                    usageId: `${frame.attemptId}:model`,
                    originKey: `${requestRef.system}:${requestRef.requestId}`,
                    actionId: frame.actionId,
                    attemptId: frame.attemptId,
                    source: source.prepared.target.adapter,
                    dimensions: checked(dimensions),
                    externalRequest: requestRef,
                    observedAt: new Date().toISOString(),
                    certainty: measured ? 'measured' : 'unknown',
                  },
                ]
                const content = checked(
                  runtimeAuthorSchemas.StandardToolOutput.encode({
                    content: [{ type: 'text', text }],
                    structured: { thinking, toolCalls: tools as never },
                  }),
                )
                const model: ModelOutput = {
                  outputRef: content,
                  finishReason: finish ?? 'error',
                  usageFactRefs: [
                    {
                      authorityId: original.usageAuthorityId,
                      usageId: `${frame.attemptId}:model`,
                      digest: canonicalJsonDigest(usage[0] as never),
                    },
                  ],
                  providerReceipt: receipt,
                  actualModel: response?.model ?? source.prepared.target.model,
                }
                result = finish
                  ? {
                      outcome: 'succeeded',
                      result: checked(encodeMethod('ModelOutput', model)),
                      externalRequests: [requestRef],
                      usage,
                      references: [],
                    }
                  : (notSent() ?? {
                      ...failure(
                        sent ? 'unknown_effect' : controller.signal.aborted ? 'cancelled' : 'internal',
                        sent ? 'model_stream_unknown' : 'model_not_sent',
                      ),
                      externalRequests: sent ? [requestRef] : [],
                      usage: sent ? usage : [],
                    })
              } catch {
                settle()
                if (sent && usageState.tokens !== null) {
                  usage = [unknownFact]
                  try {
                    const dimensions = original.usage.encode({
                      ...unknownMeasurement,
                      ...usageState.evidence,
                    })
                    if (dimensions.ok) usage = [{ ...unknownFact, dimensions: dimensions.value }]
                  } catch {
                    // Preserve the already encoded unknown fact when the selected codec cannot retain fees.
                  }
                }
                result = notSent() ?? {
                  ...failure(
                    sent ? 'unknown_effect' : controller.signal.aborted ? 'cancelled' : 'denied',
                    sent ? 'model_stream_unknown' : 'model_send_refused',
                  ),
                  externalRequests: sent && frame.requestIdentity ? [external(frame)] : [],
                  usage: sent ? usage : [],
                }
              }
              try {
                if (sent) await original.save(frame, result, bodyDigest)
              } catch {
                return {
                  ...result,
                  outcome: 'unknown_effect',
                  error: error('unknown_effect', 'model_receipt_unconfirmed'),
                }
              } finally {
                active.delete(frame.attemptId)
                own.delete(controller)
                for (const signal of [factory.signal, scope.signal, context.call.signal])
                  signal.removeEventListener('abort', abort)
              }
              return result
            },
          }
        },
      })
      return {
        ...lifecycle,
        actions: { invoke: createAction('invoke'), reconcile: createAction('reconcile') },
      }
    },
  }
}
