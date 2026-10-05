import type {
  ActionContext,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  type AttemptRef,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type JsonValue,
  MAX_AUTHOR_INLINE_BYTES,
  type ModelOutput,
  type PreparedModelRequest,
  type ReconcileResult,
  RuntimeAuthorCapabilities,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  type UsageFact,
  type UsageMeasurement,
  validateRuntime,
} from '@agnes/protocol/runtime'

export interface ReferenceModelSource {
  readonly prepared: PreparedModelRequest
  readonly endpoint: string
  readonly body: JsonValue
}
/** Original capabilities installed by the source owner; no browser authentication projection. */
export interface ReferenceModelDeployment {
  readonly packageDigest: string
  readonly config: AuthorSchema<EmptyAuthorConfig>
  readonly usage: AuthorSchema<UsageMeasurement>
  readonly usageAuthorityId: string
  readonly units: Readonly<{ input: string; output: string }>
  installed(call: CallContext): boolean
  load(ref: DataRef, frame: ActionFrame, call: ActionContext): Promise<Outcome<ReferenceModelSource>>
  current(source: ReferenceModelSource, frame: ActionFrame, call: CallContext): boolean
  withCredential<T>(
    source: ReferenceModelSource,
    frame: ActionFrame,
    call: ActionContext,
    consume: (credential: string) => Promise<T>,
  ): Promise<Outcome<T>>
  beforeSend(source: ReferenceModelSource, frame: ActionFrame, call: ActionContext, digest: string): boolean
  save(frame: ActionFrame, result: EffectResult, digest: string, receipt: DataRef | null): Promise<void>
  lookup(
    frame: ActionFrame,
    refs: readonly DataRef[],
    call: ActionContext,
    target: AttemptRef | null,
  ): Promise<ReconcileResult>
}
const providerId = 'agh.reference/model-adapter',
  methods = RuntimeMethodSchemaRefs['agh.model-adapter']
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)
const error = (code: RuntimeError['code']): RuntimeError => ({
  code,
  detailCode: 'reference_model',
  message: 'Reference model operation refused',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'reference-model',
})
const failure = (code: RuntimeError['code']): EffectResult => ({
  outcome: code === 'unknown_effect' ? 'unknown_effect' : 'failed',
  error: error(code),
  externalRequests: [],
  usage: [],
  references: [],
})
function encode(name: 'ModelOutput' | 'ReconcileResult', value: unknown): DataRef {
  const body = boundedCanonicalJson(value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: 128,
    maxMembers: 10000,
  })
  if (!body.ok || !validateRuntime(name, body.value.json).ok) throw new Error('Reference output invalid')
  return {
    kind: 'inline',
    schema: name === 'ModelOutput' ? methods.invoke.output : methods.reconcile.output,
    value: body.value.json,
    bytes: body.value.bytes,
    digest: canonicalJsonDigest(body.value.json),
  }
}
function checked<T>(value: Outcome<T>): T {
  if (!value.ok) throw new Error('Reference codec refused')
  return value.value
}

/** Independent HTTP/SSE implementation; it does not import the default adapter or its wire library. */
const inferenceCapability = {
  ...RuntimeAuthorCapabilities.modelInference,
  resourceTypes: [...RuntimeAuthorCapabilities.modelInference.resourceTypes],
  operations: [...RuntimeAuthorCapabilities.modelInference.operations],
}

export function createReferenceModelAdapterFactory(
  deployment: ReferenceModelDeployment,
): ProviderFactory<ServiceProvider> {
  if (
    !deployment.config ||
    !deployment.usage ||
    !deployment.usageAuthorityId ||
    !deployment.units?.input ||
    !deployment.units.output ||
    ['installed', 'load', 'current', 'withCredential', 'beforeSend', 'save', 'lookup'].some(
      (key) => typeof deployment[key as keyof ReferenceModelDeployment] !== 'function',
    )
  )
    throw new TypeError('Missing reference source owner')
  const original = { ...deployment },
    units = canonicalJsonDigest(deployment.units as never)
  const unchanged = () =>
    Object.entries(original).every(
      ([key, value]) => deployment[key as keyof ReferenceModelDeployment] === value,
    ) && units === canonicalJsonDigest(deployment.units as never)
  const descriptor = {
    providerId,
    contract: 'agh.model-adapter',
    major: 1,
    logicalName: 'default',
    packageVersion: '1.0.0',
    packageDigest: deployment.packageDigest,
    features: ['openai-completions'],
    scope: 'runtime' as const,
    configSchema: deployment.config.ref,
    requires: [],
    capabilities: [inferenceCapability],
    recovery: 'R1' as const,
    isolation: ['trusted-in-process' as const],
    stateCodecs: [],
    activationMode: 'eager' as const,
    operations: (['invoke', 'reconcile'] as const).map((method) => ({
      method,
      kind: 'action' as const,
      inputSchema: methods[method].input,
      outputSchema: methods[method].output,
      requiredCapabilities: method === 'invoke' ? [inferenceCapability] : [],
      retrySafety: 'never' as const,
    })),
  }
  if (!validateRuntime('ProviderDescriptor', descriptor).ok)
    throw new TypeError('Invalid reference descriptor')
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
        throw new TypeError('Invalid reference configuration')
      const factoryRelation = () =>
          canonicalJsonDigest({
            scope: factory.scope,
            bindingId: factory.bindingId,
            instanceId: factory.instanceId,
          }),
        originalFactory = factoryRelation(),
        factorySignal = factory.signal
      let phase: 'starting' | 'ready' | 'draining' | 'closed' = 'starting'
      const active = new Map<string, AbortController>()
      const callRelation = (call: CallContext) =>
        canonicalJsonDigest({
          scope: call.scope,
          bindingId: call.bindingId,
          principalRef: call.principalRef,
          authorizationRef: call.authorizationRef,
          invocationId: call.invocationId,
          deadline: call.deadline,
          traceRef: call.traceRef,
        })
      const staticContext = (call: CallContext) =>
        unchanged() &&
        factory.signal === factorySignal &&
        factoryRelation() === originalFactory &&
        !factory.signal.aborted &&
        !call.signal.aborted &&
        call.bindingId === factory.bindingId &&
        Date.parse(call.deadline) > Date.now() &&
        validateRuntime('ScopeRef', call.scope).ok &&
        Object.entries(factory.scope).every(
          ([key, value]) => key === 'kind' || call.scope[key as keyof typeof call.scope] === value,
        )
      const staticCurrent = (call: CallContext) => phase === 'ready' && staticContext(call)
      const current = (call: CallContext) => {
        const relation = callRelation(call),
          signal = call.signal
        try {
          return (
            staticCurrent(call) &&
            original.installed(call) === true &&
            staticCurrent(call) &&
            signal === call.signal &&
            relation === callRelation(call)
          )
        } catch {
          return false
        }
      }
      const lifecycle = {
        async ready(call: CallContext): Promise<Outcome<void>> {
          const state = phase,
            relation = callRelation(call),
            signal = call.signal
          if (state !== 'starting' || !staticContext(call)) return { ok: false, error: error('denied') }
          let accepted = false
          try {
            accepted = original.installed(call) === true
          } catch {}
          if (
            !accepted ||
            !staticContext(call) ||
            signal !== call.signal ||
            relation !== callRelation(call) ||
            phase !== state ||
            factorySignal.aborted ||
            !unchanged() ||
            factoryRelation() !== originalFactory ||
            call.signal.aborted
          )
            return { ok: false, error: error('denied') }
          phase = 'ready'
          return { ok: true, value: undefined }
        },
        async health(call: CallContext) {
          return {
            ok: true as const,
            value: { status: current(call) ? ('ready' as const) : ('failed' as const), diagnosticIds: [] },
          }
        },
        async drain() {
          if (phase !== 'closed') phase = 'draining'
          for (const signal of active.values()) signal.abort()
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
          for (const signal of active.values()) signal.abort()
        },
      }
      const actionFactory = (method: 'invoke' | 'reconcile') => ({
        kind: 'leaf' as const,
        recovery: 'R1' as const,
        stateCodec: null,
        async create(scope: import('@agnes/extension-api/runtime').ActionHandlerScope) {
          let closed = false,
            draining = false
          const own = new Set<AbortController>()
          return {
            ...lifecycle,
            kind: 'leaf' as const,
            effectSemantics: 'non-idempotent' as const,
            executionUnit: 'single-effect' as const,
            async ready(call: CallContext): Promise<Outcome<void>> {
              return !closed &&
                !draining &&
                !scope.signal.aborted &&
                scope.bindingId === factory.bindingId &&
                current(call)
                ? { ok: true, value: undefined }
                : { ok: false, error: error('denied') }
            },
            async drain() {
              draining = true
              for (const signal of own) signal.abort()
              return {
                ok: true as const,
                value: {
                  state: own.size ? ('blocked' as const) : ('drained' as const),
                  activeInvocationIds: [...active].filter(([, signal]) => own.has(signal)).map(([id]) => id),
                  durableOwnerRefs: [],
                  diagnosticIds: [],
                },
              }
            },
            async close() {
              closed = true
              for (const signal of own) signal.abort()
            },
            async reconcile(frame: ActionFrame, refs: readonly DataRef[], call: ActionContext) {
              return original.lookup(frame, refs, call, null)
            },
            async execute(frame: ActionFrame, call: ActionContext): Promise<EffectResult> {
              if (
                closed ||
                draining ||
                scope.signal.aborted ||
                scope.bindingId !== frame.bindingId ||
                scope.actionId !== frame.actionId ||
                scope.runId !== frame.runId ||
                frame.method !== method ||
                !(method === 'invoke' ? current(call.call) : staticCurrent(call.call))
              )
                return failure('denied')
              const signal = call.call.signal,
                originalCall = call.call
              const relation = () =>
                  canonicalJsonDigest({
                    frame,
                    scope: call.call.scope,
                    principalRef: call.call.principalRef,
                    bindingId: call.call.bindingId,
                    invocationId: call.call.invocationId,
                    authorizationRef: call.call.authorizationRef,
                    deadline: call.call.deadline,
                    traceRef: call.call.traceRef,
                  } as never),
                pinned = relation()
              const ref = frame.input
              if (
                ref.kind !== 'inline' ||
                !same(ref.schema, methods[method].input) ||
                ref.digest !== canonicalJsonDigest(ref.value)
              )
                return failure('invalid_input')
              const input = boundedCanonicalJson(ref.value, {
                maxBytes: MAX_AUTHOR_INLINE_BYTES,
                maxDepth: 128,
                maxMembers: 10000,
              })
              const parsed = validateRuntime(
                method === 'invoke' ? 'ModelAdapterInvokeRequest' : 'ModelAdapterReconcileRequest',
                ref.value,
              )
              if (!input.ok || input.value.bytes !== ref.bytes || !parsed.ok) return failure('invalid_input')
              if (method === 'reconcile') {
                const request = parsed.value as import('@agnes/protocol/runtime').ModelAdapterReconcileRequest
                try {
                  const result = await original.lookup(
                    frame,
                    request.externalReceipt ? [request.externalReceipt] : [],
                    call,
                    request.attemptRef,
                  )
                  if (!staticCurrent(call.call) || relation() !== pinned) return failure('denied')
                  return {
                    outcome: 'succeeded',
                    result: encode('ReconcileResult', result),
                    externalRequests: [],
                    usage: [],
                    references: [],
                  }
                } catch {
                  return failure('internal')
                }
              }
              const request = parsed.value as import('@agnes/protocol/runtime').ModelAdapterInvokeRequest
              let loaded: Outcome<ReferenceModelSource>
              try {
                loaded = await original.load(request.preparedCallRef, frame, call)
              } catch {
                return failure('denied')
              }
              if (!loaded.ok) return failure(loaded.error.code)
              const source = loaded.value,
                sourceDigest = canonicalJsonDigest(source as never)
              const body = boundedCanonicalJson(source.body, {
                maxBytes: MAX_AUTHOR_INLINE_BYTES,
                maxDepth: 128,
                maxMembers: 10000,
              })
              if (
                !body.ok ||
                !validateRuntime('PreparedModelRequest', source.prepared).ok ||
                source.prepared.target.adapter.providerId !== providerId ||
                source.prepared.target.adapter.bindingId !== factory.bindingId ||
                source.prepared.outputSchema !== null ||
                source.prepared.mediaPlans.length ||
                source.prepared.toolCatalog !== null ||
                !frame.requestIdentity ||
                request.externalIdempotencyKey !== frame.requestIdentity.idempotencyKey ||
                typeof source.body !== 'object' ||
                source.body === null ||
                Array.isArray(source.body) ||
                source.body.model !== source.prepared.target.model ||
                source.body.max_completion_tokens !== source.prepared.generation.maxOutputTokens ||
                !source.prepared.credentialRef ||
                !source.prepared.target.credentialBinding
              )
                return failure('invalid_input')
              const staticAlive = () =>
                !closed &&
                !draining &&
                !scope.signal.aborted &&
                call.call === originalCall &&
                call.call.signal === signal &&
                relation() === pinned &&
                sourceDigest === canonicalJsonDigest(source as never) &&
                staticCurrent(call.call)
              const alive = () => {
                try {
                  return (
                    staticAlive() &&
                    original.installed(call.call) === true &&
                    staticAlive() &&
                    original.current(source, frame, call.call) === true &&
                    staticAlive()
                  )
                } catch {
                  return false
                }
              }
              if (!alive() || active.has(frame.attemptId)) return failure('denied')
              const controller = new AbortController(),
                abort = () => controller.abort(),
                timer = setTimeout(
                  abort,
                  Math.max(1, Math.min(2147483647, Date.parse(call.call.deadline) - Date.now())),
                )
              const signals = [factorySignal, scope.signal, signal]
              for (const item of signals) item.addEventListener('abort', abort, { once: true })
              active.set(frame.attemptId, controller)
              own.add(controller)
              const identity = {
                system: frame.requestIdentity.system,
                requestId: frame.requestIdentity.aghRequestId,
                requestDigest: frame.requestIdentity.requestDigest,
                ...(frame.requestIdentity.idempotencyKey === null
                  ? {}
                  : { idempotencyKey: frame.requestIdentity.idempotencyKey }),
              }
              let actualModel = source.prepared.target.model
              let sent = false,
                receipt: DataRef | null = null,
                result: EffectResult
              const measurement = (
                kind: UsageMeasurement['kind'],
                input: number | null,
                output: number | null,
              ): UsageFact => ({
                usageId: `${frame.attemptId}:reference`,
                originKey: `${identity.system}:${identity.requestId}`,
                actionId: frame.actionId,
                attemptId: frame.attemptId,
                source: { ...source.prepared.target.adapter },
                dimensions: checked(
                  original.usage.encode({
                    kind,
                    quantities:
                      input === null || output === null
                        ? []
                        : [
                            { unit: original.units.input, value: String(input) },
                            { unit: original.units.output, value: String(output) },
                          ],
                    actualModel,
                    source: receipt ? 'provider-receipt' : 'reported-target',
                    sourceReceipt: receipt,
                    replacesFactIds: [],
                  }),
                ),
                externalRequest: identity,
                observedAt: new Date().toISOString(),
                certainty: kind === 'unknown' ? 'unknown' : 'measured',
              })
              let usage: UsageFact[] = []
              try {
                usage = [measurement('unknown', null, null)]
                const outcome = await original.withCredential(source, frame, call, async (credential) => {
                  if (!credential?.trim() || !alive()) throw new Error('Reference credential refused')
                  if (
                    !alive() ||
                    original.beforeSend(source, frame, call, canonicalJsonDigest(body.value.json)) !== true ||
                    !staticAlive() ||
                    controller.signal.aborted
                  )
                    throw new Error('Reference send refused')
                  sent = true
                  const response = await fetch(source.endpoint, {
                    method: 'POST',
                    redirect: 'error',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
                    body: body.value.canonical,
                    signal: controller.signal,
                  })
                  const responseId = response.headers.get('x-request-id')
                  receipt = checked(
                    runtimeAuthorSchemas.ProviderResponseEvidence.encode({
                      status: response.status,
                      ...(responseId ? { id: responseId } : {}),
                      headers: responseId ? { 'x-request-id': responseId } : {},
                      headerNames: [...response.headers.keys()],
                    }),
                  )
                  usage = [measurement('unknown', null, null)]
                  let raw = '',
                    text = '',
                    finished = false,
                    tokens: { input: number; output: number } | null = null
                  if (!response.body) throw new Error('Reference stream missing')
                  const reader = response.body.getReader(),
                    decoder = new TextDecoder()
                  try {
                    for (;;) {
                      const next = await reader.read()
                      if (next.done) break
                      raw += decoder.decode(next.value, { stream: true })
                      if (raw.length > MAX_AUTHOR_INLINE_BYTES) {
                        await reader.cancel()
                        throw new Error('Reference output quota')
                      }
                    }
                  } finally {
                    reader.releaseLock()
                  }
                  for (const line of raw.split('\n')) {
                    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
                    const item = JSON.parse(line.slice(6)) as {
                      model?: string
                      choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
                      usage?: { prompt_tokens: number; completion_tokens: number }
                    }
                    if (typeof item.model === 'string' && item.model.length > 0 && item.model.length <= 8192)
                      actualModel = item.model
                    text += item.choices?.[0]?.delta?.content ?? ''
                    if (item.choices?.[0]?.finish_reason === 'stop') finished = true
                    if (
                      item.usage &&
                      Number.isSafeInteger(item.usage.prompt_tokens) &&
                      item.usage.prompt_tokens >= 0 &&
                      Number.isSafeInteger(item.usage.completion_tokens) &&
                      item.usage.completion_tokens >= 0
                    )
                      tokens = { input: item.usage.prompt_tokens, output: item.usage.completion_tokens }
                  }
                  if (receipt?.kind === 'inline')
                    receipt = checked(
                      runtimeAuthorSchemas.ProviderResponseEvidence.encode({
                        ...(receipt.value as Record<string, JsonValue>),
                        model: actualModel,
                      }),
                    )
                  if (tokens) usage = [measurement('reported', tokens.input, tokens.output)]
                  const outputRef = checked(
                    runtimeAuthorSchemas.StandardToolOutput.encode({
                      content: [{ type: 'text', text }],
                      structured: {},
                    }),
                  )
                  const output: ModelOutput = {
                    outputRef,
                    finishReason: response.ok && finished ? 'stop' : 'error',
                    usageFactRefs: [
                      {
                        authorityId: original.usageAuthorityId,
                        usageId: usage[0]?.usageId ?? '',
                        digest: canonicalJsonDigest(usage[0] as never),
                      },
                    ],
                    providerReceipt: receipt,
                    actualModel,
                  }
                  return response.ok && !finished
                    ? {
                        ...failure('unknown_effect'),
                        externalRequests: [identity],
                        usage,
                        references: [],
                      }
                    : {
                        outcome: 'succeeded' as const,
                        result: encode('ModelOutput', output),
                        externalRequests: [identity],
                        usage,
                        references: [],
                      }
                })
                if (!outcome.ok) throw new Error('Reference credential owner refused')
                result = outcome.value
              } catch {
                result = {
                  ...failure(sent ? 'unknown_effect' : 'denied'),
                  externalRequests: sent ? [identity] : [],
                  usage: sent ? usage : [],
                  references: [],
                }
              }
              try {
                if (sent) await original.save(frame, result, canonicalJsonDigest(body.value.json), receipt)
              } catch {
                result = { ...result, outcome: 'unknown_effect', error: error('unknown_effect') }
              } finally {
                clearTimeout(timer)
                for (const item of signals) item.removeEventListener('abort', abort)
                active.delete(frame.attemptId)
                own.delete(controller)
              }
              return result
            },
          }
        },
      })
      return {
        ...lifecycle,
        actions: { invoke: actionFactory('invoke'), reconcile: actionFactory('reconcile') },
      }
    },
  }
}
