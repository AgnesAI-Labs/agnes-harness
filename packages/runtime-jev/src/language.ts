import type {
  ArtifactPort,
  DecisionInputPolicy,
  LanguageBackend,
  LanguageInput,
  ModelSettlement,
  PreparedModelCall,
} from '@agnes/jev-runtime'
import type {
  InferenceEvent,
  ModelPriceQuote,
  PreparedInference,
  Provider,
  RequestBody,
} from '@agnes/protocol'
import { createLanguageContext } from './language-context.js'
import { assertImageModel, DEFAULT_IMAGE_REQUEST_BYTES, materializeToolImages } from './language-media.js'
import { decodeLanguageResponse, type LanguageToolCall } from './language-response.js'
import { durableJson, freezeJson } from './model-json.js'

export interface LanguageHost {
  readonly provider: Provider
  readonly selection: Pick<RequestBody, 'slot' | 'route' | 'model' | 'contractId'>
  /** Host-resolved exact request pricing, captured before the durable model.requested admission. */
  readonly pricing?: (request: RequestBody) => ModelPriceQuote | null
  readonly sessionKey: string
  readonly system: string
  readonly artifacts?: Pick<ArtifactPort, 'read'>
  /** Combined decoded image bytes per actual provider request; checked before artifact I/O. */
  readonly maxImageRequestBytes?: number
  /** Exact Host-owned input sources; only declared replaceable context snapshots are elevated. */
  readonly inputPolicies?: Readonly<Record<string, DecisionInputPolicy>>
  readonly sampling?: RequestBody['sampling']
  readonly maxFormatRetries: number
  readonly maxResponseBytes: number
  readonly hashRequest: (body: Omit<RequestBody, 'derivedHash'>) => string
  /** Preview only; durable settlement remains the source of accepted answers and usage. */
  readonly onEvent?: (event: InferenceEvent, purpose: LanguageInput['purpose']) => void | Promise<void>
}

/** Each prepared snapshot binds one provider call, with provider-internal retries disabled. */
export function createLanguageBackend(host: LanguageHost): LanguageBackend {
  if (
    !Number.isSafeInteger(host.maxFormatRetries) ||
    host.maxFormatRetries < 0 ||
    !Number.isSafeInteger(host.maxResponseBytes) ||
    host.maxResponseBytes < 1
  )
    throw new TypeError('Language limits must be explicitly configured')
  const pending = new WeakMap<PreparedModelCall, { request: RequestBody; prepared?: PreparedInference }>()
  return {
    maxFormatRetries: host.maxFormatRetries,
    async prepare(input, signal) {
      signal.throwIfAborted()
      const selection = structuredClone(host.selection)
      const context = createLanguageContext(input, host.inputPolicies)
      if (context.toolImages.length) assertImageModel(host.provider, selection)
      await materializeToolImages(
        context.messages,
        context.toolImages,
        host.artifacts,
        host.maxImageRequestBytes ?? DEFAULT_IMAGE_REQUEST_BYTES,
        signal,
      )
      const body: Omit<RequestBody, 'derivedHash'> = {
        kind: 'inference',
        sessionKey: host.sessionKey,
        ...selection,
        system: [host.system, context.system].filter(Boolean).join('\n\n'),
        messages: context.messages,
        tools: context.tools,
        ...(host.sampling === undefined ? {} : { sampling: structuredClone(host.sampling) }),
      }
      const derivedHash = host.hashRequest(structuredClone(body))
      if (!/^[0-9a-f]{64}$/.test(derivedHash)) throw new TypeError('Request hash must be SHA-256 hex')
      const request = freezeJson({ ...body, derivedHash })
      const prepared = await host.provider.prepare?.(request, { signal })
      signal.throwIfAborted()
      const call: PreparedModelCall = freezeJson({
        purpose: input.purpose,
        backend: 'agnes-provider',
        endpoint: prepared?.snapshot.endpoint ?? request.route,
        requestedModel: request.model,
        codec: prepared ? 'agnes-language-v2' : 'agnes-language-v1',
        inputCursor: input.inputCursor,
        input: durableJson({
          request,
          ...(prepared ? { providerRequest: durableJson(prepared.snapshot) } : {}),
          pricing: host.pricing?.(request) ?? null,
          requestNote: context.requestNote,
          ...(context.toolImages.length
            ? { mediaRefs: durableJson(context.toolImages), mediaCodec: 'agnes-verified-tool-images-v1' }
            : {}),
          ...(input.repair === undefined ? {} : { repair: input.repair }),
        }),
      })
      pending.set(call, { request, ...(prepared ? { prepared } : {}) })
      return call
    },
    async invoke(call, signal) {
      const bound = pending.get(call)
      if (bound === undefined || call.purpose === 'decision')
        throw new Error('Language call was not prepared here or was already invoked')
      pending.delete(call)
      const { request, prepared } = bound
      signal.throwIfAborted()
      if (
        !prepared &&
        request.messages.some((message) => message.content.some((block) => block.type === 'image'))
      )
        assertImageModel(host.provider, request)
      const events: InferenceEvent[] = []
      const calls: LanguageToolCall[] = []
      let text = ''
      let size = 0
      let terminal: Extract<InferenceEvent, { type: 'done' | 'error' }> | undefined
      let observedModel: string | undefined
      let usage: Extract<InferenceEvent, { type: 'usage' }> | undefined
      let failure: ModelSettlement['error']
      try {
        const options = {
          signal,
          toolNames: request.tools.map((tool) => tool.name),
          retry: false as const,
        }
        for await (const event of prepared
          ? prepared.infer(options)
          : host.provider.infer(request, options)) {
          signal.throwIfAborted()
          size += new TextEncoder().encode(JSON.stringify(event)).byteLength
          if (size > host.maxResponseBytes) {
            failure = {
              code: 'LANGUAGE_RESPONSE_LIMIT',
              message: 'Language response exceeded its byte limit',
              retryable: false,
            }
            break
          }
          events.push(structuredClone(event))
          await host.onEvent?.(freezeJson(structuredClone(event)), call.purpose)
          const model =
            event.type === 'sent'
              ? event.stamp.model.responseModel
              : event.type === 'usage' || event.type === 'error'
                ? event.response?.model
                : undefined
          // Persist the first real mismatch rather than allowing later requested-model
          // frames to revive a quote for a call whose observed identity is ambiguous.
          if (
            typeof model === 'string' &&
            model.length > 0 &&
            model.length <= 256 &&
            !/[\p{Cc}]/u.test(model) &&
            (observedModel === undefined || observedModel === request.model)
          )
            observedModel = model
          if (event.type === 'text_delta') text += event.delta
          if (event.type === 'toolcall_end')
            calls.push({ name: event.call.name, arguments: JSON.stringify(event.call.args) })
          if (event.type === 'usage') {
            usage = event
          }
          if (event.type === 'media')
            failure = {
              code: 'LANGUAGE_UNSUPPORTED_MEDIA',
              message: 'Media output requires a host artifact adapter',
              retryable: false,
            }
          if (event.type === 'error' || event.type === 'done') {
            terminal = event
            break
          }
        }
      } catch (_error) {
        failure = {
          code: signal.aborted ? 'ABORTED' : 'LANGUAGE_TRANSPORT',
          message: signal.aborted ? 'Language request cancelled' : 'Language transport failed',
          retryable: false,
        }
      }
      const common: ModelSettlement = {
        snapshot: { codec: 'agnes-inference-v1', response: durableJson({ events }) },
        ...(observedModel === undefined ? {} : { observedModel }),
        ...(usage === undefined
          ? {}
          : {
              usage: durableJson(usage),
              ...(usage.timing?.durationMs === undefined ? {} : { latencyMs: usage.timing.durationMs }),
            }),
      }
      if (failure !== undefined) return { ...common, error: failure }
      if (terminal === undefined)
        return {
          ...common,
          error: {
            code: 'LANGUAGE_INCOMPLETE',
            message: 'Language stream ended without a terminal receipt',
            retryable: false,
          },
        }
      if (terminal.type === 'error')
        return {
          ...common,
          error: { code: terminal.code, message: terminal.message, retryable: terminal.retryable },
        }
      if (terminal.reason === 'length')
        return {
          ...common,
          error: { code: 'LANGUAGE_INCOMPLETE', message: 'Language output was truncated', retryable: false },
        }
      if (call.purpose !== 'answer')
        return { ...common, ...decodeLanguageResponse(call.purpose, text, calls) }
      if (calls.length > 0 || text.trim() === '')
        return {
          ...common,
          error: {
            code: 'LANGUAGE_ANSWER',
            message: 'Expected a nonempty final answer without tool calls',
            retryable: false,
          },
        }
      return { ...common, output: { kind: 'answer', content: [{ kind: 'text', text }] } }
    },
  }
}
