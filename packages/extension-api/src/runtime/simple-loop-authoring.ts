import type * as Wire from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type AuthorSchema,
  defineSimpleLoop,
  type EmptyAuthorConfig,
  type SimpleLoopDefinition,
  type SimpleStepView,
} from './authoring.js'
import { runtimeAuthorSchemas } from './authoring-schemas.js'
import type { LoopReadPorts, Outcome } from './public-api.js'

function failure(detailCode: string, code: Wire.RuntimeError['code'] = 'invalid_input'): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Simple loop value was refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'simple-loop-authoring',
    },
  }
}

function json(value: unknown) {
  const limits = RuntimeAuthorCodecPolicy.payload
  return boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
}

function equal(left: unknown, right: unknown): boolean {
  const a = json(left)
  const b = json(right)
  return a.ok && b.ok && canonicalJsonDigest(a.value.json) === canonicalJsonDigest(b.value.json)
}

/** Internal pure evaluation only. The caller owns authorization, preparation and transition commits. */
export function createSimpleLoopEvaluator<C = EmptyAuthorConfig>(
  input: SimpleLoopDefinition<C>,
  configuredValue?: unknown,
) {
  const definition = defineSimpleLoop(input).definition
  const rawConfig = configuredValue === undefined ? (definition.config?.defaults ?? {}) : configuredValue
  const config = definition.config?.schema.parse(rawConfig)
  if (config?.ok === false || (!definition.config && !equal(rawConfig, {})))
    throw new TypeError('Invalid simple loop configuration')
  const selectedConfig = config?.ok ? config.value : {}

  function parseView(value: unknown): Outcome<SimpleStepView<C>> {
    const parsed = runtimeAuthorSchemas.SimpleStepView.parse(value)
    if (!parsed.ok) return parsed
    const actualConfig = definition.config?.schema.parse(parsed.value.config)
    if (actualConfig?.ok === false || !equal(parsed.value.config, selectedConfig))
      return failure('simple_loop_config_mismatch')
    // The generic configuration has just passed its selected author schema.
    return { ok: true, value: parsed.value as unknown as SimpleStepView<C> }
  }

  function invoke<T>(callback: () => unknown, schema: AuthorSchema<T>, signal: AbortSignal): Outcome<T> {
    if (signal.aborted) return failure('simple_loop_cancelled', 'cancelled')
    let value: unknown
    try {
      value = callback()
    } catch {
      return signal.aborted
        ? failure('simple_loop_cancelled', 'cancelled')
        : failure('simple_loop_callback_failed')
    }
    // The intrinsic recognizes cross-realm promises without reading an arbitrary `then` getter.
    let asynchronous = false
    try {
      void Promise.prototype.then.call(value, undefined, () => undefined)
      asynchronous = true
    } catch {
      // Non-promises, including forged Promise prototypes, go through the bounded JSON parser.
    }
    if (asynchronous) {
      return signal.aborted
        ? failure('simple_loop_cancelled', 'cancelled')
        : failure('simple_loop_async_callback')
    }
    if (signal.aborted) return failure('simple_loop_cancelled', 'cancelled')
    return schema.parse(value)
  }

  async function readValue(
    ref: Wire.DataRef,
    ports: Pick<LoopReadPorts, 'resolveData'>,
    signal: AbortSignal,
  ): Promise<Outcome<Wire.JsonValue>> {
    if (signal.aborted) return failure('simple_loop_cancelled', 'cancelled')
    if (!validateRuntime('DataRef', ref).ok) return failure('simple_loop_schema_mismatch')
    if (ref.kind === 'inline') {
      const embedded = json(ref.value)
      if (
        !embedded.ok ||
        embedded.value.bytes !== ref.bytes ||
        canonicalJsonDigest(embedded.value.json) !== ref.digest
      )
        return failure('simple_loop_digest_mismatch')
    }
    let resolved: unknown
    let onAbort = () => {}
    const cancelled = new Promise<Outcome<never>>((resolve) => {
      onAbort = () => resolve(failure('simple_loop_cancelled', 'cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      resolved = await Promise.race([ports.resolveData(ref), cancelled])
    } catch {
      return signal.aborted
        ? failure('simple_loop_cancelled', 'cancelled')
        : failure('simple_loop_read_failed')
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) return failure('simple_loop_cancelled', 'cancelled')
    let value: unknown
    try {
      if (!resolved || typeof resolved !== 'object') return failure('simple_loop_read_invalid')
      const fields = Object.getOwnPropertyDescriptors(resolved)
      const ok = fields.ok
      if (!ok || !('value' in ok) || typeof ok.value !== 'boolean') return failure('simple_loop_read_invalid')
      const payload = fields[ok.value ? 'value' : 'error']
      if (!payload || !('value' in payload) || Reflect.ownKeys(fields).length !== 2)
        return failure('simple_loop_read_invalid')
      value = payload.value
      if (!ok.value) {
        const safe = json(value)
        if (!safe.ok) return failure('simple_loop_read_invalid')
        const error = validateRuntime('RuntimeError', safe.value.json)
        return error.ok ? { ok: false, error: error.value } : failure('simple_loop_read_invalid')
      }
    } catch {
      return failure('simple_loop_read_invalid')
    }
    const bytes = json(value)
    if (!bytes.ok)
      return failure(
        'simple_loop_value_invalid',
        bytes.errors.some((error) => error.code === 'RANGE') ? 'quota' : 'invalid_input',
      )
    const expected = ref.kind === 'inline' ? ref : ref.blob
    if (bytes.value.bytes !== expected.bytes || canonicalJsonDigest(bytes.value.json) !== expected.digest)
      return failure('simple_loop_digest_mismatch')
    return { ok: true, value: bytes.value.json }
  }

  async function read<T>(
    ref: Wire.DataRef,
    schema: Pick<AuthorSchema<T>, 'ref' | 'parse'>,
    ports: Pick<LoopReadPorts, 'resolveData'>,
    signal: AbortSignal,
  ): Promise<Outcome<T>> {
    if (!equal(ref.schema, schema.ref)) return failure('simple_loop_schema_mismatch')
    const resolved = await readValue(ref, ports, signal)
    return resolved.ok ? schema.parse(resolved.value) : resolved
  }

  return Object.freeze({
    ask(value: unknown, signal: AbortSignal): Outcome<Wire.SimpleModelRequest | null> {
      if (signal.aborted) return failure('simple_loop_cancelled', 'cancelled')
      const parsed = parseView(value)
      if (!parsed.ok) return parsed
      if (!definition.ask) return { ok: true, value: null }
      let noRequest = false
      const request = invoke(
        () => {
          const result = definition.ask?.(parsed.value)
          if (result === null) {
            noRequest = true
            return {}
          }
          return result
        },
        runtimeAuthorSchemas.SimpleModelRequest,
        signal,
      )
      if (!request.ok) return request
      if (noRequest) return { ok: true, value: null }
      if ((request.value.toolNames?.length ?? 0) > 0) return failure('simple_loop_decider_tools')
      return request
    },
    next(value: unknown, observation: unknown, signal: AbortSignal): Outcome<Wire.SimpleStepDecision> {
      if (signal.aborted) return failure('simple_loop_cancelled', 'cancelled')
      const parsed = parseView(value)
      if (!parsed.ok) return parsed
      const decision = runtimeAuthorSchemas.SimpleDecisionObservation.parse(observation)
      if (!decision.ok) return decision
      return invoke(
        () => definition.next(parsed.value, decision.value),
        runtimeAuthorSchemas.SimpleStepDecision,
        signal,
      )
    },
    /** Validates the inner SDK codec and its typed values; it does not resume a run or validate pins. */
    async readCheckpoint(
      state: Wire.VersionedState,
      ports: Pick<LoopReadPorts, 'resolveData'>,
      signal: AbortSignal,
    ): Promise<Outcome<Wire.SimpleLoopCheckpoint>> {
      const safe = json(state)
      if (!safe.ok) return failure('simple_loop_checkpoint_invalid')
      const valid = validateRuntime('VersionedState', safe.value.json)
      if (!valid.ok || valid.value.namespace !== 'agh.sdk.simple-loop' || valid.value.codecVersion !== '1')
        return failure('simple_loop_codec_mismatch')
      const checkpoint = await read(
        valid.value.data,
        runtimeAuthorSchemas.SimpleLoopCheckpoint,
        ports,
        signal,
      )
      if (!checkpoint.ok) return checkpoint
      const current = checkpoint.value
      const logicalInput = await readValue(current.logicalInput, ports, signal)
      if (!logicalInput.ok) return logicalInput
      const previous = await read(current.previous, runtimeAuthorSchemas.SimpleObservation, ports, signal)
      if (!previous.ok) return previous
      let fixedView: SimpleStepView<C> | undefined
      for (const ref of [current.view, current.recovery?.view]) {
        if (!ref) continue
        const value = await read(ref, runtimeAuthorSchemas.SimpleStepView, ports, signal)
        if (!value.ok) return value
        const parsed = parseView(value.value)
        if (!parsed.ok) return parsed
        if (
          parsed.value.stepSeq !== current.stepSeq ||
          parsed.value.observedAt !== current.observedAt ||
          parsed.value.signals.some((item) => item.seq > current.signalHighWater) ||
          !equal(parsed.value.input, logicalInput.value) ||
          !equal(parsed.value.previous, previous.value) ||
          (fixedView !== undefined && !equal(parsed.value, fixedView))
        )
          return failure('simple_loop_view_mismatch')
        fixedView = parsed.value
      }
      const references: readonly [
        Wire.DataRef | null | undefined,
        Pick<AuthorSchema<unknown>, 'ref' | 'parse'>,
      ][] = [
        [current.decision, runtimeAuthorSchemas.SimpleDecisionObservation],
        [current.requestedDecision, runtimeAuthorSchemas.SimpleModelRequest],
        [current.committedDecision, runtimeAuthorSchemas.SimpleStepDecision],
        [current.recovery?.decision, runtimeAuthorSchemas.SimpleStepDecision],
      ]
      for (const [ref, schema] of references) {
        if (!ref) continue
        const value = await read(ref, schema, ports, signal)
        if (!value.ok) return value
      }
      return checkpoint
    },
  })
}
