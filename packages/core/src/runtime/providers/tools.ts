import type {
  ActionHandlerScope,
  ActionProviderFactory,
  CallContext,
  FactoryContext,
  LeafActionProvider,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type JsonValue,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  type ToolCall,
  type ToolDefinition,
  type ToolPolicySnapshot,
  validateRuntime,
} from '@agnes/protocol/runtime'

/** Native installed-source seam. It grants no authority; the Host dispatcher must supply current checks. */
export interface ToolsDeployment {
  readonly descriptor: ProviderDescriptor
  readonly configuration: DataRef
  readonly definition: ToolDefinition
  readonly snapshot: string
  readonly catalogRevision: number
  checkCurrent(context: CallContext): Promise<Outcome<void>>
  /** Verify original input/policy/action admission and, for model calls, the original
   * prepared model handle, selected model/catalog, same Run/Action and pure-stage eligibility.
   * The installed owner must recheck identity, source and current read permission after awaits;
   * a matching DataRef/schema/digest alone is not proof. Missing source must refuse. */
  verifyCall(call: ToolCall, frame: ActionFrame, context: CallContext): Promise<Outcome<void>>
  /** Trusted dispatcher supplies the existing pure author adapter; no private package import here. */
  createExecutor(call: ToolCall): ActionProviderFactory
}
const refs = RuntimeMethodSchemaRefs['agh.tools']
const refuse = (code: RuntimeError['code'], detailCode: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Tools operation refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'tools-provider',
  },
})
const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as JsonValue) === canonicalJsonDigest(b as JsonValue)
const limits = RuntimeAuthorCodecPolicy.payload
function fixed<T>(value: T): T {
  const encoded = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!encoded.ok) throw new TypeError('Tools payload exceeds the fixed codec budget')
  const copy = JSON.parse(encoded.value.canonical) as T
  const freeze = (child: unknown): void => {
    if (child && typeof child === 'object') {
      for (const value of Object.values(child)) freeze(value)
      Object.freeze(child)
    }
  }
  freeze(copy)
  return copy
}
function decode<K extends keyof RuntimeWireTypes>(
  ref: DataRef,
  schema: SchemaRef,
  type: K,
): Outcome<RuntimeWireTypes[K]> {
  if (!validateRuntime('DataRef', ref).ok || ref.kind !== 'inline' || !same(ref.schema, schema))
    return refuse('invalid_input', 'tools_data_schema')
  const canonical = boundedCanonicalJson(ref.value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (
    !canonical.ok ||
    canonical.value.bytes !== ref.bytes ||
    canonicalJsonDigest(canonical.value.json) !== ref.digest
  )
    return refuse('invalid_input', 'tools_data_integrity')
  const parsed = validateRuntime(type, canonical.value.json)
  if (!parsed.ok) return refuse('invalid_input', 'tools_input_schema')
  return { ok: true, value: fixed(parsed.value) }
}
function encode(schema: SchemaRef, value: unknown): Outcome<DataRef> {
  const canonical = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!canonical.ok) return refuse('quota', 'tools_output_budget')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema,
      value: canonical.value.json,
      bytes: canonical.value.bytes,
      digest: canonicalJsonDigest(canonical.value.json),
    },
  }
}
function scopeContains(parent: FactoryContext['scope'], child: CallContext['scope']): boolean {
  return Object.entries(parent).every(
    ([key, value]) => key === 'kind' || child[key as keyof typeof child] === value,
  )
}
function failure(error: RuntimeError): EffectResult {
  return {
    outcome: error.code === 'cancelled' ? 'cancelled' : 'failed',
    error,
    externalRequests: [],
    usage: [],
    references: [],
  }
}
function lockedCall(call: CallContext): CallContext {
  const { signal, ...wire } = call,
    value = fixed(wire)
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
  if (!validateRuntime('CallContextWire', value).ok || !aborted || typeof aborted.call(signal) !== 'boolean')
    throw new TypeError('Tools call context is invalid')
  return Object.freeze({ ...value, signal })
}

/** Fixed pure text-tools slice. Unsupported durable commands are absent from the descriptor. */
export function createDefaultToolsFactory(deployment: ToolsDeployment): ProviderFactory<ServiceProvider> {
  const descriptor = fixed(deployment.descriptor),
    definition = fixed(deployment.definition),
    configuration = fixed(deployment.configuration)
  const snapshot = deployment.snapshot,
    catalogRevision = deployment.catalogRevision
  if (
    !validateRuntime('Id', snapshot).ok ||
    !validateRuntime('Revision', catalogRevision).ok ||
    configuration.kind !== 'inline'
  )
    throw new TypeError('Tools fixed source identity is invalid')
  const configurationProof = boundedCanonicalJson(configuration.value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (
    !configurationProof.ok ||
    configurationProof.value.bytes !== configuration.bytes ||
    canonicalJsonDigest(configurationProof.value.json) !== configuration.digest ||
    !same(definition.inputSchema, RuntimeSchemaRefs.StandardToolOutput)
  )
    throw new TypeError('Tools source schema or configuration proof differs')
  if (
    !validateRuntime('ProviderDescriptor', descriptor).ok ||
    !validateRuntime('ToolDefinition', definition).ok ||
    !validateRuntime('DataRef', configuration).ok ||
    !same(configuration.schema, descriptor.configSchema) ||
    descriptor.contract !== 'agh.tools' ||
    descriptor.major !== 1 ||
    descriptor.features.length ||
    descriptor.stateCodecs.length ||
    descriptor.recovery !== 'R1'
  )
    throw new TypeError('Tools deployment must declare the fixed pure slice')
  const methods = { describe: 'query', classify: 'compute', catalog: 'compute', invoke: 'action' } as const
  if (
    descriptor.operations.length !== 4 ||
    Object.entries(methods).some(
      ([method, kind]) =>
        !descriptor.operations.some(
          (op) =>
            op.method === method &&
            op.kind === kind &&
            same(op.inputSchema, refs[method as keyof typeof methods].input) &&
            same(op.outputSchema, refs[method as keyof typeof methods].output),
        ),
    )
  )
    throw new TypeError('Tools descriptor differs from the supported official methods')
  if (
    definition.executor.contract !== descriptor.contract ||
    definition.executor.providerId !== descriptor.providerId ||
    definition.executor.logicalName !== descriptor.logicalName ||
    definition.name !== 'textstatistics' ||
    !same(definition.inputSchema, definition.outputSchema) ||
    definition.inputSchema.typeId !== 'agh.tool/standard-output@1' ||
    definition.policy.classifierRef !== null ||
    !definition.policy.defaults.isReadOnly ||
    definition.policy.defaults.isDestructive ||
    definition.policy.defaults.requiresApproval !== 'never' ||
    definition.policy.defaults.approvalScopes.length ||
    definition.policy.defaults.replay !== 'idempotent' ||
    definition.retrySafety !== 'idempotent' ||
    definition.execution.isOpenWorld ||
    definition.execution.concurrency !== 'parallel' ||
    definition.execution.requiredModelInput.length ||
    definition.execution.deferLoading
  )
    throw new TypeError('Tools definition must be the closed textstatistics pure tool')
  const classify = (input: DataRef): Outcome<ToolPolicySnapshot> => {
    const parsed = decode(input, definition.inputSchema, 'StandardToolOutput')
    if (!parsed.ok) return parsed
    if (parsed.value.content.length !== 1 || parsed.value.structured !== undefined)
      return refuse('invalid_input', 'tools_one_text_required')
    const policy = {
      ...definition.policy.defaults,
      policyVersion: definition.policy.version,
      classifierDigest: canonicalJsonDigest(definition.policy as unknown as JsonValue),
      inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
      definitionDigest: canonicalJsonDigest(definition),
    }
    return { ok: true, value: { ...policy, fingerprint: canonicalJsonDigest(policy) } }
  }
  return {
    descriptor,
    async create(config, _dependencies, factoryInput) {
      if (
        !same(config, configuration) ||
        factoryInput.bindingId !== definition.executor.bindingId ||
        !validateRuntime('ScopeRef', factoryInput.scope).ok ||
        factoryInput.scope.kind !== descriptor.scope
      )
        throw new TypeError('Tools configuration or binding differs from the installed source')
      const factory = { ...factoryInput, scope: fixed(factoryInput.scope) }
      let state: 'ready' | 'draining' | 'closed' = 'ready'
      const lifetime = new AbortController(),
        children = new Set<LeafActionProvider>(),
        opening = new Map<symbol, string>()
      const pendingChecks = new Map<Promise<unknown>, { invocationId: string; scope: CallContext['scope'] }>()
      async function authority<T>(
        operation: () => Promise<Outcome<T>>,
        context: CallContext,
        stopAccepting = false,
        extraDeadline = context.deadline,
      ): Promise<Outcome<T>> {
        const signal = AbortSignal.any([
          context.signal,
          factory.signal,
          ...(stopAccepting ? [lifetime.signal] : []),
        ])
        let timer: ReturnType<typeof setTimeout> | undefined,
          abort = () => {}
        try {
          const task = Promise.resolve().then(operation)
          pendingChecks.set(task, { invocationId: context.invocationId, scope: context.scope })
          void task.then(
            () => pendingChecks.delete(task),
            () => pendingChecks.delete(task),
          )
          const interruption = new Promise<Outcome<never>>((resolve) => {
            abort = () => resolve(refuse('cancelled', 'tools_cancelled'))
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
            const arm = () => {
              const remaining = Math.min(Date.parse(context.deadline), Date.parse(extraDeadline)) - Date.now()
              if (remaining <= 0) timer = setTimeout(() => resolve(refuse('timeout', 'tools_deadline')), 0)
              else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647))
            }
            arm()
          })
          return await Promise.race([task, interruption])
        } catch {
          return refuse('denied', 'tools_source_unavailable')
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
      }
      function caller(context: CallContext): Outcome<void> {
        const { signal: _signal, ...wire } = context
        if (
          !validateRuntime('CallContextWire', wire).ok ||
          context.bindingId !== factory.bindingId ||
          !scopeContains(factory.scope, context.scope)
        )
          return refuse('denied', 'tools_context_binding')
        if (context.signal.aborted || factory.signal.aborted) return refuse('cancelled', 'tools_cancelled')
        if (Date.parse(context.deadline) <= Date.now()) return refuse('timeout', 'tools_deadline')
        return { ok: true, value: undefined }
      }
      function before(context: CallContext): Outcome<void> {
        const valid = caller(context)
        if (!valid.ok) return valid
        if (state !== 'ready') return refuse('retryable', 'tools_closed')
        if (lifetime.signal.aborted) return refuse('cancelled', 'tools_cancelled')
        return { ok: true, value: undefined }
      }
      async function current(context: CallContext, extraDeadline = context.deadline): Promise<Outcome<void>> {
        try {
          context = lockedCall(context)
          const check = before(context)
          if (!check.ok) return check
          const allowed = await authority(
            () => deployment.checkCurrent(context),
            context,
            true,
            extraDeadline,
          )
          if (Date.parse(extraDeadline) <= Date.now()) return refuse('timeout', 'tools_deadline')
          return allowed.ok ? before(context) : allowed
        } catch {
          return refuse('denied', 'tools_source_unavailable')
        }
      }
      const invoke: ActionProviderFactory = {
        kind: 'leaf',
        recovery: 'R1',
        stateCodec: null,
        async create(scopeInput: ActionHandlerScope) {
          const scope = { ...scopeInput, scope: fixed(scopeInput.scope) }
          if (
            scope.bindingId !== factory.bindingId ||
            scope.scope.kind !== 'action' ||
            scope.scope.actionId !== scope.actionId ||
            scope.scope.runId !== scope.runId ||
            !scopeContains(factory.scope, scope.scope)
          )
            throw new TypeError('Tools action scope differs')
          let closed = false
          const stop = new AbortController(),
            owned = new Set<LeafActionProvider>(),
            pending = new Map<symbol, string>()
          const check = async (call: CallContext, deadline = call.deadline) => {
            if (closed || stop.signal.aborted || scope.signal.aborted)
              return refuse('cancelled', 'tools_action_closed')
            if (!same(call.scope, scope.scope)) return refuse('denied', 'tools_action_scope')
            return current(call, deadline)
          }
          return {
            kind: 'leaf',
            effectSemantics: 'idempotent',
            executionUnit: 'single-effect',
            ready: check,
            async health(call) {
              try {
                call = lockedCall(call)
              } catch {
                return refuse('invalid_input', 'tools_call_schema')
              }
              const valid = caller(call)
              if (!valid.ok) return valid
              if (!same(call.scope, scope.scope)) return refuse('denied', 'tools_action_scope')
              const current = await authority(() => deployment.checkCurrent(call), call)
              if (!current.ok) return current
              const after = caller(call)
              if (!after.ok) return after
              return {
                ok: true,
                value: { status: closed || state !== 'ready' ? 'degraded' : 'ready', diagnosticIds: [] },
              }
            },
            async drain(deadline, call) {
              try {
                call = lockedCall(call)
              } catch {
                return refuse('invalid_input', 'tools_call_schema')
              }
              const valid = caller(call)
              if (!valid.ok) return valid
              if (!same(call.scope, scope.scope)) return refuse('denied', 'tools_action_scope')
              if (!validateRuntime('Timestamp', deadline).ok)
                return refuse('invalid_input', 'tools_drain_deadline')
              const allowed = await authority(() => deployment.checkCurrent(call), call, false, deadline),
                after = caller(call)
              if (!allowed.ok) return allowed
              if (!after.ok) return after
              closed = true
              stop.abort()
              const results = await Promise.all([...owned].map((child) => child.drain(deadline, call)))
              const activeInvocationIds = results.flatMap((result) =>
                result.ok ? result.value.activeInvocationIds : [call.invocationId],
              )
              return {
                ok: true,
                value: {
                  state:
                    activeInvocationIds.length ||
                    pending.size ||
                    [...pendingChecks.values()].some((check) => same(check.scope, scope.scope))
                      ? 'blocked'
                      : 'drained',
                  activeInvocationIds: [
                    ...new Set([
                      ...activeInvocationIds,
                      ...pending.values(),
                      ...[...pendingChecks.values()]
                        .filter((check) => same(check.scope, scope.scope))
                        .map((check) => check.invocationId),
                    ]),
                  ],
                  durableOwnerRefs: [],
                  diagnosticIds: [],
                },
              }
            },
            async close(reason) {
              closed = true
              stop.abort()
              await Promise.all([...owned].map((child) => child.close(reason)))
            },
            async execute(frameInput, contextInput) {
              const id = Symbol('invoke')
              opening.set(id, contextInput.call.invocationId)
              pending.set(id, contextInput.call.invocationId)
              let executor: LeafActionProvider | undefined, executionCall: CallContext | undefined
              try {
                const { signal, ...wire } = contextInput.call
                const call: CallContext = {
                  ...fixed(wire),
                  signal: AbortSignal.any([
                    signal,
                    factory.signal,
                    scope.signal,
                    stop.signal,
                    lifetime.signal,
                  ]),
                }
                const context = { ...contextInput, call }
                executionCall = call
                const frame = fixed(frameInput)
                if (
                  !validateRuntime('ActionFrame', frame).ok ||
                  frame.bindingId !== scope.bindingId ||
                  frame.actionId !== scope.actionId ||
                  frame.runId !== scope.runId ||
                  frame.method !== 'invoke' ||
                  frame.invocationId !== call.invocationId ||
                  !same(frame.context, wire) ||
                  frame.continuation !== null ||
                  frame.input.kind !== 'inline' ||
                  frame.inputDigest !== frame.input.digest ||
                  frame.attemptNumber < 1 ||
                  Date.parse(frame.actionTimebox.maxDeadline) <= Date.now()
                )
                  return failure(refuse('invalid_input', 'tools_action_frame').error)
                const admission = await check(call, frame.actionTimebox.maxDeadline)
                if (!admission.ok) return failure(admission.error)
                const parsed = decode(frame.input, refs.invoke.input, 'ToolCall')
                if (!parsed.ok) return failure(parsed.error)
                const toolCall = parsed.value,
                  policy = classify(toolCall.input)
                if (!policy.ok) return failure(policy.error)
                if (toolCall.batchRef !== null)
                  return failure(refuse('incompatible', 'tools_batch_source_unavailable').error)
                if (
                  !same(toolCall.definition, definition) ||
                  toolCall.expectedDefinitionDigest !== policy.value.definitionDigest ||
                  !same(toolCall.policy, policy.value)
                )
                  return failure(refuse('denied', 'tools_call_identity').error)
                if (
                  toolCall.modelContextRef !== null &&
                  !same(toolCall.modelContextRef.schema, RuntimeSchemaRefs.PreparedModelHandle)
                )
                  return failure(refuse('denied', 'tools_model_context_schema').error)
                if (typeof deployment.verifyCall !== 'function')
                  return failure(refuse('incompatible', 'tools_action_source_unavailable').error)
                const verified = await authority(
                  () => deployment.verifyCall(toolCall, frame, call),
                  call,
                  true,
                  frame.actionTimebox.maxDeadline,
                )
                if (!verified.ok) return failure(verified.error)
                const active = await check(call, frame.actionTimebox.maxDeadline)
                if (!active.ok) return failure(active.error)
                if (typeof deployment.createExecutor !== 'function')
                  return failure(refuse('incompatible', 'tools_author_dispatcher_unavailable').error)
                const executorFactory = deployment.createExecutor(toolCall)
                if (
                  executorFactory.kind !== 'leaf' ||
                  executorFactory.recovery !== 'R1' ||
                  executorFactory.stateCodec !== null
                )
                  return failure(refuse('incompatible', 'tools_pure_executor_required').error)
                const created = await executorFactory.create(scope)
                if (created.kind !== 'leaf' || created.effectSemantics !== 'idempotent') {
                  await created.close('shutdown')
                  return failure(refuse('incompatible', 'tools_pure_executor_required').error)
                }
                executor = created
                children.add(executor)
                owned.add(executor)
                const ready = await executor.ready(call),
                  finalCheck = await check(call, frame.actionTimebox.maxDeadline)
                if (!ready.ok) return failure(ready.error)
                if (!finalCheck.ok) return failure(finalCheck.error)
                const result = await executor.execute(frame, context)
                const settled = await check(call, frame.actionTimebox.maxDeadline)
                if (!settled.ok) return failure(settled.error)
                if (!validateRuntime('EffectResult', result).ok)
                  return failure(refuse('internal', 'tools_executor_result').error)
                if (result.outcome === 'succeeded') {
                  if (
                    !result.result ||
                    result.externalRequests.length ||
                    result.usage.length ||
                    result.references.length
                  )
                    return failure(refuse('internal', 'tools_impure_result').error)
                  const raw = decode(result.result, RuntimeSchemaRefs.ToolResult, 'ToolResult')
                  if (
                    !raw.ok ||
                    raw.value.details !== undefined ||
                    raw.value.artifacts.length ||
                    !same(raw.value.provenance.producer, definition.executor) ||
                    raw.value.provenance.sourceRefs.length === 0 ||
                    !same(raw.value.provenance.trustLabels, ['derived'])
                  )
                    return failure(refuse('internal', 'tools_result_provenance').error)
                  const output = decode(raw.value.output, definition.outputSchema, 'StandardToolOutput')
                  if (!output.ok) return failure(output.error)
                }
                return fixed(result)
              } catch {
                return failure(refuse('internal', 'tools_dispatch_failed').error)
              } finally {
                opening.delete(id)
                pending.delete(id)
                if (executor && executionCall) {
                  try {
                    const drained = await executor.drain(new Date().toISOString(), executionCall)
                    if (drained.ok && drained.value.state === 'drained') {
                      await executor.close('shutdown')
                      children.delete(executor)
                      owned.delete(executor)
                    }
                  } catch {
                    /* Keep an executor whose work has not been proven drained. */
                  }
                }
              }
            },
            async reconcile(_frame, _evidence, context) {
              const allowed = await check(context.call)
              if (!allowed.ok) throw allowed.error
              throw refuse('incompatible', 'tools_receipt_source_unavailable').error
            },
          }
        },
      }
      return {
        ready: current,
        async health(context) {
          try {
            context = lockedCall(context)
          } catch {
            return refuse('invalid_input', 'tools_call_schema')
          }
          const valid = caller(context)
          if (!valid.ok) return valid
          const source = await authority(() => deployment.checkCurrent(context), context)
          if (!source.ok) return source
          const after = caller(context)
          if (!after.ok) return after
          return { ok: true, value: { status: state === 'ready' ? 'ready' : 'degraded', diagnosticIds: [] } }
        },
        async drain(deadline, context) {
          try {
            context = lockedCall(context)
          } catch {
            return refuse('invalid_input', 'tools_call_schema')
          }
          const valid = caller(context)
          if (!valid.ok) return valid
          if (!validateRuntime('Timestamp', deadline).ok)
            return refuse('invalid_input', 'tools_drain_deadline')
          const source = await authority(() => deployment.checkCurrent(context), context, false, deadline),
            after = caller(context)
          if (!source.ok) return source
          if (!after.ok) return after
          state = 'draining'
          lifetime.abort()
          const results = await Promise.all([...children].map((child) => child.drain(deadline, context)))
          const ids = [
            ...opening.values(),
            ...[...pendingChecks.values()].map((check) => check.invocationId),
            ...results.flatMap((result) =>
              result.ok ? result.value.activeInvocationIds : [context.invocationId],
            ),
          ]
          return {
            ok: true,
            value: {
              state: ids.length ? 'blocked' : 'drained',
              activeInvocationIds: [...new Set(ids)],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close(reason) {
          state = 'closed'
          lifetime.abort()
          await Promise.all([...children].map((child) => child.close(reason)))
        },
        async query(requestInput, context) {
          let request: typeof requestInput
          try {
            request = fixed(requestInput)
            context = lockedCall(context)
          } catch {
            return refuse('invalid_input', 'tools_query_schema')
          }
          if (!validateRuntime('ServiceQuery', request).ok)
            return refuse('invalid_input', 'tools_query_schema')
          const allowed = await current(context)
          if (!allowed.ok) return allowed
          if (!same(request.target, definition.executor)) return refuse('denied', 'tools_target')
          if (request.method !== 'describe') return refuse('incompatible', 'tools_query_unsupported')
          if (request.page !== undefined || (request.snapshot !== undefined && request.snapshot !== snapshot))
            return refuse('conflict', 'tools_stale_snapshot')
          const input = decode(request.input, refs.describe.input, 'ToolsDescribeRequest')
          if (!input.ok) return input
          if (!same(input.value.resource, definition.resource))
            return refuse('denied', 'tools_definition_source')
          const result = encode(refs.describe.output, definition),
            after = await current(context)
          if (!after.ok) return after
          if (!result.ok) return result
          return { ok: true, value: { kind: 'value', output: result.value, snapshot } }
        },
        async compute(requestInput, context) {
          let request: typeof requestInput
          try {
            request = fixed(requestInput)
            context = lockedCall(context)
          } catch {
            return refuse('invalid_input', 'tools_compute_schema')
          }
          if (!validateRuntime('ServiceOperation', request).ok)
            return refuse('invalid_input', 'tools_compute_schema')
          const allowed = await current(context)
          if (!allowed.ok) return allowed
          if (!same(request.target, definition.executor)) return refuse('denied', 'tools_target')
          let output: Outcome<DataRef>
          if (request.method === 'classify') {
            const input = decode(request.input, refs.classify.input, 'ToolsClassifyRequest')
            if (!input.ok) return input
            if (!same(input.value.definition, definition)) return refuse('denied', 'tools_definition_source')
            const policy = classify(input.value.input)
            output = policy.ok ? encode(refs.classify.output, policy.value) : policy
          } else if (request.method === 'catalog') {
            const input = decode(request.input, refs.catalog.input, 'ToolsCatalogRequest')
            if (!input.ok) return input
            if (input.value.tools.length !== 1 || !same(input.value.tools[0], definition))
              return refuse('denied', 'tools_catalog_source')
            if (input.value.policy.disclosure !== 'standard' || !input.value.policy.compactionAgentCallable)
              return refuse('incompatible', 'tools_catalog_policy_unsupported')
            if (input.value.policy.policyRevision !== catalogRevision)
              return refuse('conflict', 'tools_catalog_revision')
            const catalog = { revision: catalogRevision, tools: [definition] }
            output = encode(refs.catalog.output, { ...catalog, digest: canonicalJsonDigest(catalog) })
          } else return refuse('incompatible', 'tools_compute_unsupported')
          const after = await current(context)
          return after.ok ? output : after
        },
        actions: { invoke },
      }
    },
  }
}
