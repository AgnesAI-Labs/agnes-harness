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

/** The two wire formats this adapter speaks. */
export type ReferenceModelApi = 'openai-completions' | 'anthropic-messages'
const apis: readonly ReferenceModelApi[] = ['openai-completions', 'anthropic-messages']

export interface ReferenceModelSource {
  readonly prepared: PreparedModelRequest
  /** The wire format of `body`; absent means `openai-completions`. */
  readonly api?: ReferenceModelApi
  readonly endpoint: string
  readonly body: JsonValue
  /** Verified media evidence for the locked plans: counts and identities only, never bytes. */
  readonly media?: readonly {
    readonly planKey: string
    readonly planDigest: string
    readonly usageIds: readonly string[]
    readonly imageCount: number
  }[]
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
  /**
   * The host's restricted model egress for this call. Every request goes through the fetch it
   * returns; without one the call is refused before the credential is used. The global fetch is
   * never a fallback.
   */
  egress?(source: ReferenceModelSource, frame: ActionFrame, call: ActionContext): typeof fetch | undefined
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

/** The plans the request is locked to are exactly the media it carries, with no usage counted twice. */
function mediaCovered(source: ReferenceModelSource): boolean {
  const plans = source.prepared.mediaPlans
  const media = source.media ?? []
  const body = source.body as { messages?: { content?: unknown }[] } | null
  const imageType = source.api === 'anthropic-messages' ? 'image' : 'image_url'
  let images = 0
  for (const message of body?.messages ?? [])
    if (Array.isArray(message.content))
      images += message.content.filter(
        (part) => (part as { type?: unknown } | null)?.type === imageType,
      ).length
  if (plans.length !== media.length) return false
  const usage = media.flatMap((entry) => entry.usageIds)
  return (
    new Set(usage).size === usage.length &&
    plans.every(
      (plan, index) =>
        media[index]?.planKey === plan.key &&
        media[index]?.planDigest === canonicalJsonDigest(plan as never) &&
        same(plan.targetFeatures, source.prepared.target.features),
    ) &&
    media.reduce((sum, entry) => sum + entry.imageCount, 0) === images
  )
}
const error = (code: RuntimeError['code'], detailCode = 'reference_model'): RuntimeError => ({
  code,
  detailCode,
  message: 'Reference model operation refused',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'reference-model',
})
const failure = (code: RuntimeError['code'], detailCode?: string): EffectResult => ({
  outcome: code === 'unknown_effect' ? 'unknown_effect' : 'failed',
  error: error(code, detailCode),
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

const anthropicVersion = '2023-06-01'
/** Credential header and version header per wire; the credential is whatever the credential owner hands out. */
function wireHeaders(api: ReferenceModelApi, credential: string): Record<string, string> {
  return api === 'anthropic-messages'
    ? { 'content-type': 'application/json', 'x-api-key': credential, 'anthropic-version': anthropicVersion }
    : { 'content-type': 'application/json', authorization: `Bearer ${credential}` }
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
type StreamResult = {
  text: string
  /** `null` until the stream names a clean end; a tool-call end is not one, as no tools are offered. */
  finish: 'stop' | 'length' | null
  tokens: { input: number; output: number } | null
  model: string | null
}
/** Reads a complete SSE body of either wire; a malformed event throws and the effect stays unknown. */
function parseStream(api: ReferenceModelApi, raw: string): StreamResult {
  const result: StreamResult = { text: '', finish: null, tokens: null, model: null }
  let input: number | undefined, output: number | undefined
  const named = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0 && value.length <= 8192) result.model = value
  }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    if (api === 'anthropic-messages') {
      const item = JSON.parse(line.slice(6)) as {
        type?: string
        message?: { model?: string; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
        delta?: { type?: string; text?: string; stop_reason?: string | null }
        usage?: { input_tokens?: unknown; output_tokens?: unknown }
      }
      if (item.type === 'error') throw new Error('Reference stream error event')
      if (item.type === 'message_start') {
        named(item.message?.model)
        if (count(item.message?.usage?.input_tokens)) input = item.message.usage.input_tokens
        if (count(item.message?.usage?.output_tokens)) output = item.message.usage.output_tokens
      }
      if (item.type === 'content_block_delta' && item.delta?.type === 'text_delta')
        result.text += item.delta.text ?? ''
      if (item.type === 'message_delta') {
        const reason = item.delta?.stop_reason
        if (reason === 'end_turn' || reason === 'stop_sequence') result.finish = 'stop'
        if (reason === 'max_tokens') result.finish = 'length'
        if (count(item.usage?.input_tokens)) input = item.usage.input_tokens
        if (count(item.usage?.output_tokens)) output = item.usage.output_tokens
      }
      continue
    }
    const item = JSON.parse(line.slice(6)) as {
      model?: string
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    named(item.model)
    result.text += item.choices?.[0]?.delta?.content ?? ''
    const reason = item.choices?.[0]?.finish_reason
    if (reason === 'stop') result.finish = 'stop'
    if (reason === 'length') result.finish = 'length'
    if (count(item.usage?.prompt_tokens) && count(item.usage?.completion_tokens)) {
      input = item.usage.prompt_tokens
      output = item.usage.completion_tokens
    }
  }
  if (input !== undefined && output !== undefined) result.tokens = { input, output }
  return result
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
    features: [...apis],
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
              const api = source.api ?? 'openai-completions'
              if (!apis.includes(api)) return failure('invalid_input', 'reference_model_api')
              const tokenLimit = api === 'anthropic-messages' ? 'max_tokens' : 'max_completion_tokens'
              if (
                !body.ok ||
                !validateRuntime('PreparedModelRequest', source.prepared).ok ||
                source.prepared.target.adapter.providerId !== providerId ||
                source.prepared.target.adapter.bindingId !== factory.bindingId ||
                source.prepared.outputSchema !== null ||
                !mediaCovered(source) ||
                source.prepared.toolCatalog !== null ||
                !frame.requestIdentity ||
                request.externalIdempotencyKey !== frame.requestIdentity.idempotencyKey ||
                typeof source.body !== 'object' ||
                source.body === null ||
                Array.isArray(source.body) ||
                source.body.model !== source.prepared.target.model ||
                source.body[tokenLimit] !== source.prepared.generation.maxOutputTokens ||
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
              if (!alive()) return failure('denied')
              // The host's egress for this call, before the credential is touched. There is no
              // fallback: without one, nothing is sent.
              let seam: typeof fetch | undefined
              try {
                seam = original.egress?.(source, frame, call)
              } catch {
                seam = undefined
              }
              if (typeof seam !== 'function') return failure('denied', 'reference_model_egress_missing')
              if (active.has(frame.attemptId)) return failure('denied')
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
                  const response = await seam(source.endpoint, {
                    method: 'POST',
                    redirect: 'error',
                    headers: wireHeaders(api, credential),
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
                    finish: 'stop' | 'length' | null = null,
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
                  const parsed = parseStream(api, raw)
                  text = parsed.text
                  finish = parsed.finish
                  tokens = parsed.tokens
                  if (parsed.model) actualModel = parsed.model
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
                    finishReason: response.ok && finish ? finish : 'error',
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
                  return response.ok && !finish
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
