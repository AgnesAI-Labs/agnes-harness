import type { DecisionBackend, JsonValue, ModelSettlement, PreparedModelCall } from '@agnes/jev-runtime'
import { durableJson, freezeJson } from './model-json.js'

export interface DecisionRequest {
  readonly model: string
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, JsonValue>>
}

/** Host transport owns credentials, HTTP limits and cancellation; it must make one attempt. */
export interface DecisionTransport {
  invoke(request: DecisionRequest, signal: AbortSignal): Promise<ModelSettlement>
}

export interface DecisionConnection {
  readonly backend: 'jev' | 'laya'
  readonly endpoint: string
  readonly model: string
  /** Optional Host price evidence; evaluated and frozen before the durable request barrier. */
  readonly pricing?: () => JsonValue
  readonly transport: DecisionTransport
}

/** Preserve System One score output for the core's purpose/operation/binding validator. */
export function decodeDecisionResponse(value: unknown): ModelSettlement {
  const output = durableJson(value)
  if (output === null || typeof output !== 'object' || Array.isArray(output))
    return {
      error: {
        code: 'DECISION_INVALID_RESPONSE',
        message: 'Expected a decision response object',
        retryable: false,
      },
    }
  return {
    output,
    snapshot: { codec: 'systemone-json-v1', response: output },
    ...(typeof output.model === 'string' ? { observedModel: output.model } : {}),
    ...(output.routing === undefined ? {} : { routing: output.routing }),
    ...(output.usage === undefined ? {} : { usage: output.usage }),
  }
}

/** No language-provider fallback: callers must mark Jev unavailable without this transport. */
export function createDecisionBackend(connection: DecisionConnection): DecisionBackend {
  const endpoint = new URL(connection.endpoint)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new TypeError('Decision endpoint must not contain credentials, query or fragment')
  if (!connection.model.trim()) throw new TypeError('Decision model is required')
  const pending = new WeakMap<PreparedModelCall, DecisionRequest>()
  return {
    async prepare(input, signal) {
      signal.throwIfAborted()
      const request = freezeJson(
        structuredClone({ model: connection.model, state: input.state, questions: input.questions }),
      )
      const call: PreparedModelCall = freezeJson({
        purpose: 'decision',
        backend: connection.backend,
        endpoint: connection.endpoint,
        requestedModel: connection.model,
        codec: 'systemone-json-v1',
        input: durableJson(request),
        ...(connection.pricing ? { pricing: durableJson(connection.pricing()) } : {}),
        inputCursor: input.inputCursor,
      })
      pending.set(call, request)
      return call
    },
    async invoke(call, signal) {
      const request = pending.get(call)
      if (request === undefined) throw new Error('Decision call was not prepared here or was already invoked')
      pending.delete(call)
      signal.throwIfAborted()
      return connection.transport.invoke(request, signal)
    },
  }
}
