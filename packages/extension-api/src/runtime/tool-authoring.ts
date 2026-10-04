import type * as Wire from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type AuthorSchema,
  defineTool,
  type EmptyAuthorConfig,
  type OpaqueToolDefinition,
  type PureToolDefinition,
  type StandardToolOutput,
} from './authoring.js'
import { createAuthorSchema } from './authoring-schema-core.js'
import { runtimeAuthorSchemas } from './authoring-schemas.js'
import { copyJson, declarationError } from './authoring-validation.js'
import type {
  ActionHandlerScope,
  ActionProviderFactory,
  CallContext,
  LeafActionProvider,
  Outcome,
} from './public-api.js'
import {
  createToolAuthorEffects,
  type ToolAuthorEffectRoute,
  type ToolAuthorEffectsWindow,
  validateToolAuthorEffectRoutes,
} from './tool-author-effects.js'

const toolCallSchema = createAuthorSchema(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, (value) =>
  validateRuntime('ToolCall', value),
)

/** Supplied by the trusted Tools dispatcher for one fixed input, after source and permission checks. */
export type PureToolAuthorBinding = {
  readonly definition: Wire.ToolDefinition
  readonly inputDigest: Wire.Digest
  readonly provenance: Wire.Provenance
  readonly config?: Wire.DataRef
}

/** Exact broker routes supplied by trusted assembly; this is not an authorization grant. */
export type OpaqueToolAuthorBinding = PureToolAuthorBinding & {
  readonly effectRoutes: readonly ToolAuthorEffectRoute[]
}

function error(code: Wire.RuntimeErrorCode, detailCode: string): Wire.RuntimeError {
  return {
    code,
    detailCode,
    message: 'Tool author adapter refused the operation',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'tool-author-adapter',
  }
}

function equal(a: unknown, b: unknown): boolean {
  return canonicalJsonDigest(a as Wire.JsonValue) === canonicalJsonDigest(b as Wire.JsonValue)
}

function decode<T>(schema: AuthorSchema<T>, ref: Wire.DataRef): Outcome<T> {
  if (!validateRuntime('DataRef', ref).ok || ref.kind !== 'inline' || !equal(ref.schema, schema.ref))
    return { ok: false, error: error('invalid_input', 'tool_data_schema') }
  const parsed = schema.parse(ref.value)
  if (!parsed.ok) return parsed
  const encoded = schema.encode(parsed.value)
  if (!encoded.ok) return encoded
  if (!equal(encoded.value, ref)) return { ok: false, error: error('invalid_input', 'tool_data_digest') }
  return parsed
}

function failed(failure: Wire.RuntimeError): Wire.EffectResult {
  return {
    outcome:
      failure.code === 'unknown_effect'
        ? 'unknown_effect'
        : failure.code === 'cancelled'
          ? 'cancelled'
          : 'failed',
    error: failure,
    externalRequests: [],
    usage: [],
    references: [],
  }
}

/**
 * Wraps a pure tool in the public leaf lifecycle. Authorization, source verification,
 * receipt persistence and result visibility remain with the dispatcher and Runtime.
 * Blob-backed author values require an authorized resolver and are refused here.
 */
export function createPureToolAuthorAdapter<I, C = EmptyAuthorConfig>(
  input: PureToolDefinition<I, C>,
  binding: PureToolAuthorBinding,
): ActionProviderFactory {
  if (input.execution !== 'pure') declarationError('this adapter requires a pure tool')
  return createToolAuthorAdapter(input, binding)
}

/**
 * Typed opaque execution only. Host owns broker authorization, receipts and reconciliation.
 * R0 is deliberate until the durable opaque boundary is installed and verified by Runtime.
 */
export function createOpaqueToolAuthorAdapter<I, C = EmptyAuthorConfig>(
  input: OpaqueToolDefinition<I, C>,
  binding: OpaqueToolAuthorBinding,
): ActionProviderFactory {
  if (input.execution !== 'opaque') declarationError('this adapter requires an opaque tool')
  return createToolAuthorAdapter(input, binding, binding.effectRoutes)
}

function createToolAuthorAdapter<I, C>(
  input: PureToolDefinition<I, C> | OpaqueToolDefinition<I, C>,
  binding: PureToolAuthorBinding,
  effectRoutes: readonly ToolAuthorEffectRoute[] = [],
): ActionProviderFactory {
  const author = input.execution === 'pure' ? defineTool(input) : defineTool(input)
  const opaque = author.execution === 'opaque'
  const routes = opaque ? validateToolAuthorEffectRoutes(author.effects, effectRoutes) : []
  const locked = copyJson(binding)
  const tool = locked.definition
  if (
    !validateRuntime('ToolDefinition', tool).ok ||
    !validateRuntime('Provenance', locked.provenance).ok ||
    !validateRuntime('Digest', locked.inputDigest).ok
  )
    declarationError('invalid locked tool binding')
  if (
    !equal(tool.inputSchema, author.input.ref) ||
    !equal(tool.outputSchema, runtimeAuthorSchemas.StandardToolOutput.ref)
  )
    declarationError('tool schemas do not match the author definition')
  if (
    !opaque &&
    (tool.retrySafety !== 'idempotent' ||
      tool.execution.isOpenWorld ||
      !tool.policy.defaults.isReadOnly ||
      tool.policy.defaults.isDestructive)
  )
    declarationError('pure tool metadata must preserve pure execution semantics')
  if (
    author.execution === 'opaque' &&
    (tool.retrySafety !== 'never' ||
      tool.policy.defaults.replay !== 'never' ||
      !tool.execution.isOpenWorld ||
      !equal(tool.requiredCapabilities, author.permissions))
  )
    declarationError('opaque tool metadata must preserve declared permissions and non-idempotent semantics')
  if (locked.provenance.sourceRefs.length === 0 || !equal(locked.provenance.producer, tool.executor))
    declarationError('verified tool sources and producer are required')
  let config: Readonly<C>
  if (author.config) {
    const parsed =
      locked.config === undefined
        ? author.config.schema.parse(author.config.defaults)
        : decode(author.config.schema, locked.config)
    if (!parsed.ok) declarationError('invalid tool configuration')
    config = parsed.value
  } else {
    if (locked.config !== undefined) declarationError('tool has no configurable values')
    config = Object.freeze({}) as Readonly<C>
  }
  const definitionDigest = canonicalJsonDigest(tool)
  function toolInput(ref: Wire.DataRef): Outcome<I> {
    const call = decode(toolCallSchema, ref)
    if (!call.ok) return call
    if (
      !equal(call.value.definition, tool) ||
      call.value.expectedDefinitionDigest !== definitionDigest ||
      call.value.input.kind !== 'inline' ||
      call.value.input.digest !== locked.inputDigest ||
      call.value.policy.inputDigest !== locked.inputDigest ||
      call.value.policy.definitionDigest !== definitionDigest ||
      call.value.policy.policyVersion !== tool.policy.version
    )
      return { ok: false, error: error('conflict', 'tool_definition_or_input_drift') }
    const { fingerprint, ...policy } = call.value.policy
    if (canonicalJsonDigest(policy) !== fingerprint)
      return { ok: false, error: error('invalid_input', 'tool_policy_digest') }
    if (opaque && call.value.policy.replay !== 'never')
      return { ok: false, error: error('denied', 'opaque_tool_replay_forbidden') }
    return decode(author.input, call.value.input)
  }
  return Object.freeze({
    kind: 'leaf',
    recovery: opaque ? 'R0' : 'R1',
    stateCodec: null,
    async create(scope: ActionHandlerScope): Promise<LeafActionProvider> {
      if (
        scope.bindingId !== tool.executor.bindingId ||
        !validateRuntime('ScopeRef', scope.scope).ok ||
        !('runId' in scope.scope) ||
        scope.scope.runId !== scope.runId ||
        (scope.scope.kind === 'action' && scope.scope.actionId !== scope.actionId)
      )
        declarationError('tool action binding mismatch')
      const scopeSignal = scope.signal
      const identity = copyJson({
        instanceId: scope.instanceId,
        actionId: scope.actionId,
        runId: scope.runId,
        bindingId: scope.bindingId,
        scope: scope.scope,
      })
      const stopped = new AbortController()
      const active = new Map<string, Promise<void>>()
      let draining = false
      let closed = false
      let opaqueExecuted = false
      function check(context: CallContext): Wire.RuntimeError | undefined {
        const { signal, ...wire } = context
        if (
          !validateRuntime('CallContextWire', wire).ok ||
          context.bindingId !== identity.bindingId ||
          !equal(context.scope, identity.scope)
        )
          return error('denied', 'tool_context_mismatch')
        if (closed || draining || scopeSignal.aborted || stopped.signal.aborted || signal.aborted)
          return error('cancelled', 'tool_call_cancelled')
        if (Date.parse(context.deadline) <= Date.now()) return error('timeout', 'tool_deadline')
        return undefined
      }
      function frameError(frame: Wire.ActionFrame, context: CallContext): Wire.RuntimeError | undefined {
        const failure = check(context)
        if (failure) return failure
        const { signal: _signal, ...wire } = context
        if (
          !validateRuntime('ActionFrame', frame).ok ||
          frame.actionId !== identity.actionId ||
          frame.runId !== identity.runId ||
          frame.bindingId !== identity.bindingId ||
          frame.invocationId !== context.invocationId ||
          !equal(frame.context, wire) ||
          frame.method !== 'invoke' ||
          frame.attemptNumber === 0 ||
          frame.continuation !== null ||
          frame.input.kind !== 'inline' ||
          frame.inputDigest !== frame.input.digest
        )
          return error('invalid_input', 'tool_frame_mismatch')
        return undefined
      }
      return {
        kind: 'leaf',
        effectSemantics: opaque ? 'non-idempotent' : 'idempotent',
        ...(opaque ? { executionUnit: 'opaque-call' as const } : {}),
        async ready(context) {
          const failure = check(context)
          return failure ? { ok: false, error: failure } : { ok: true, value: undefined }
        },
        async health(context) {
          const failure = check(context)
          return failure
            ? { ok: false, error: failure }
            : { ok: true, value: { status: 'ready', diagnosticIds: [] } }
        },
        async drain(deadline, context) {
          const { signal, ...wire } = context
          if (
            !validateRuntime('CallContextWire', wire).ok ||
            context.bindingId !== identity.bindingId ||
            !equal(context.scope, identity.scope)
          )
            return { ok: false, error: error('denied', 'tool_context_mismatch') }
          if (!validateRuntime('Timestamp', deadline).ok)
            return { ok: false, error: error('invalid_input', 'tool_drain_deadline') }
          const callerFailure = (): Wire.RuntimeError | undefined => {
            if (signal.aborted) return error('cancelled', 'tool_drain_cancelled')
            if (Date.parse(context.deadline) <= Date.now()) return error('timeout', 'tool_drain_deadline')
            return undefined
          }
          const before = callerFailure()
          if (before) return { ok: false, error: before }
          const expiresAt = Math.min(Date.parse(deadline), Date.parse(context.deadline))
          draining = true
          stopped.abort()
          if (active.size && expiresAt > Date.now()) {
            let timer: ReturnType<typeof setTimeout> | undefined
            let onAbort: () => void = () => {}
            try {
              await Promise.race([
                Promise.allSettled([...active.values()]),
                new Promise<void>((resolve) => {
                  const arm = () => {
                    const remaining = expiresAt - Date.now()
                    if (remaining <= 0) resolve()
                    else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647))
                  }
                  arm()
                }),
                new Promise<void>((resolve) => {
                  onAbort = resolve
                  signal.addEventListener('abort', onAbort, { once: true })
                  if (signal.aborted) onAbort()
                }),
              ])
            } finally {
              if (timer !== undefined) clearTimeout(timer)
              signal.removeEventListener('abort', onAbort)
            }
          }
          const after = callerFailure()
          if (after) return { ok: false, error: after }
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
        async close() {
          closed = true
          stopped.abort()
        },
        async execute(frame, context) {
          const failure = frameError(frame, context.call)
          if (failure) return failed(failure)
          if (Date.parse(frame.actionTimebox.maxDeadline) <= Date.now())
            return failed(error('timeout', 'tool_deadline'))
          if (active.size) return failed(error('conflict', 'tool_invocation_active'))
          if (opaque && (opaqueExecuted || frame.attemptNumber !== 1))
            return failed(error('conflict', 'opaque_tool_already_dispatched'))
          const value = toolInput(frame.input)
          if (!value.ok) return failed(value.error)
          if (opaque) opaqueExecuted = true
          const invocationId = frame.invocationId
          const expiresAt = Math.min(
            Date.parse(context.call.deadline),
            Date.parse(frame.actionTimebox.maxDeadline),
          )
          let settled: () => void = () => {}
          active.set(
            invocationId,
            new Promise<void>((resolve) => {
              settled = resolve
            }),
          )
          const deadline = new AbortController()
          const signal = AbortSignal.any([context.call.signal, scopeSignal, stopped.signal, deadline.signal])
          let effects: ToolAuthorEffectsWindow | undefined
          function brokerFailure(): Wire.RuntimeError | undefined {
            if (!effects?.failure) return undefined
            const failure = effects.failure
            if (failure.code !== 'unknown_effect' && (effects.confirmedSuccess || effects.pending > 0))
              return { ...failure, code: 'unknown_effect', retryAdvice: { kind: 'never' } }
            return failure
          }
          function interruption(): Wire.RuntimeError | undefined {
            if (deadline.signal.aborted || Date.now() >= expiresAt)
              return error('timeout', 'tool_call_stopped')
            if (signal.aborted) return error('cancelled', 'tool_call_stopped')
            return undefined
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          function armDeadline(): void {
            const remaining = expiresAt - Date.now()
            if (remaining <= 0) deadline.abort()
            else timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647))
          }
          armDeadline()
          let onAbort: () => void = () => {}
          const aborted = new Promise<Wire.EffectResult>((resolve) => {
            onAbort = () =>
              resolve(
                failed(
                  effects?.dispatched
                    ? error('unknown_effect', 'opaque_tool_interrupted_after_dispatch')
                    : (interruption() ?? error('cancelled', 'tool_call_stopped')),
                ),
              )
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
          })
          const execution = (async (): Promise<Wire.EffectResult> => {
            try {
              const before = interruption()
              if (before) return failed(before)
              let output: StandardToolOutput
              if (author.execution === 'opaque') {
                effects = createToolAuthorEffects(
                  author.effects,
                  routes,
                  context.effects,
                  context.call,
                  signal,
                )
                output = await author.execute(
                  value.value,
                  Object.freeze({ signal, config, effects: effects.effects }),
                )
              } else output = await author.execute(value.value, Object.freeze({ signal, config }))
              effects?.close()
              if (effects?.pending) return failed(error('unknown_effect', 'opaque_tool_effects_pending'))
              const failure = brokerFailure()
              if (failure) return failed(failure)
              const after = interruption()
              if (after)
                return failed(
                  effects?.dispatched
                    ? error('unknown_effect', 'opaque_tool_interrupted_after_dispatch')
                    : after,
                )
              const encoded = runtimeAuthorSchemas.StandardToolOutput.encode(
                output as Wire.StandardToolOutput,
              )
              if (!encoded.ok)
                return failed(
                  effects?.dispatched
                    ? error('unknown_effect', 'opaque_tool_output_invalid_after_dispatch')
                    : encoded.error,
                )
              const result = runtimeAuthorSchemas.ToolResult.encode({
                output: encoded.value,
                artifacts: [],
                provenance: { ...locked.provenance, trustLabels: [opaque ? 'external' : 'derived'] },
              })
              if (!result.ok)
                return failed(
                  effects?.dispatched
                    ? error('unknown_effect', 'opaque_tool_output_invalid_after_dispatch')
                    : result.error,
                )
              const encodedInterruption = interruption()
              if (encodedInterruption)
                return failed(
                  effects?.dispatched
                    ? error('unknown_effect', 'opaque_tool_interrupted_after_dispatch')
                    : encodedInterruption,
                )
              return {
                outcome: 'succeeded',
                result: result.value,
                externalRequests: [],
                usage: [],
                references: [],
              }
            } catch {
              const brokerError = brokerFailure()
              if (brokerError) return failed(brokerError)
              if (effects?.dispatched)
                return failed(error('unknown_effect', 'opaque_tool_author_failed_after_dispatch'))
              const failure = interruption()
              if (failure) return failed(failure)
              return failed(error('internal', 'tool_author_failed'))
            } finally {
              effects?.close()
              const release = () => {
                active.delete(invocationId)
                settled()
                if (timer !== undefined) clearTimeout(timer)
                signal.removeEventListener('abort', onAbort)
              }
              if (effects?.pending) void effects.waitForPending().then(release, release)
              else release()
            }
          })()
          return Promise.race([execution, aborted])
        },
        async reconcile(frame, evidence, context) {
          const failure = frameError(frame, context.call)
          if (failure) throw failure
          const value = toolInput(frame.input)
          if (!value.ok) throw value.error
          const source = evidence[0]
          if (!source || !validateRuntime('DataRef', source).ok)
            throw error('invalid_input', 'tool_reconciliation_evidence_required')
          if (source.kind === 'inline') {
            const limits = RuntimeAuthorCodecPolicy.payload
            const canonical = boundedCanonicalJson(source.value, {
              maxBytes: limits.maxCanonicalJsonBytes,
              maxDepth: limits.maxDepth,
              maxMembers: limits.maxMembers,
            })
            if (
              !canonical.ok ||
              canonical.value.bytes !== source.bytes ||
              canonicalJsonDigest(canonical.value.json) !== source.digest
            )
              throw error('invalid_input', 'tool_reconciliation_evidence_integrity')
          }
          return {
            kind: 'unknown',
            evidence: copyJson(source),
            reason: opaque
              ? 'Opaque execution cannot be replayed; the original Host owner must reconcile its evidence'
              : 'No external lookup exists for a pure tool; Runtime may schedule pure recomputation under its retry policy',
          }
        },
      }
    },
  })
}
