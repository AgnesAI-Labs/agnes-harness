import type {
  ActionProviderFactory,
  CallContext,
  FactoryContext,
  LeafActionProvider,
  Outcome,
  ProviderFactory,
  PureToolDefinition,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { defineTool, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
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
  type StandardToolOutput,
  type ToolCall,
  type ToolDefinition,
  type ToolPolicySnapshot,
  validateRuntime,
} from '@agnes/protocol/runtime'

/** Installed source and current admission belong to the native dispatcher. */
export interface ReferenceToolsDeployment {
  readonly descriptor: ProviderDescriptor
  readonly configuration: DataRef
  readonly definition: ToolDefinition
  readonly snapshot: string
  readonly catalogRevision: number
  checkCurrent(context: CallContext): Promise<Outcome<void>>
  verifyCall(call: ToolCall, frame: ActionFrame, context: CallContext): Promise<Outcome<void>>
  createExecutor(call: ToolCall): ActionProviderFactory
}

/** Independent array/regular-expression implementation of the fixed pure tool. */
export function createReferenceTextStatisticsTool(): PureToolDefinition<StandardToolOutput> {
  return defineTool({
    id: 'text-statistics',
    description: 'Count Unicode code points, whitespace-delimited words and lines in one text block',
    execution: 'pure',
    input: runtimeAuthorSchemas.StandardToolOutput,
    execute(input, context) {
      if (context.signal.aborted) throw new Error('Text statistics cancelled')
      const block = input.content[0]
      if (input.content.length !== 1 || !block || input.structured !== undefined)
        throw new TypeError('Text statistics requires exactly one text block')
      const text = block.text
      const characters = Array.from(text).length
      const words = text.match(/\S+/gu)?.length ?? 0
      const lines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length
      return {
        content: [{ type: 'text', text: `characters=${characters}; words=${words}; lines=${lines}` }],
        structured: { characters, words, lines },
      }
    },
  }) as PureToolDefinition<StandardToolOutput>
}

const methods = RuntimeMethodSchemaRefs['agh.tools']
const budget = RuntimeAuthorCodecPolicy.payload
const problem = (code: RuntimeError['code'], detailCode: string): RuntimeError => ({
  code,
  detailCode,
  message: 'Reference Tools request refused',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'reference-tools',
})
function denied(code: RuntimeError['code'], detailCode: string): Outcome<never> {
  return { ok: false, error: problem(code, detailCode) }
}
function digest(value: unknown): string {
  return canonicalJsonDigest(value as JsonValue)
}
function equivalent(left: unknown, right: unknown): boolean {
  return digest(left) === digest(right)
}
function snapshot<T>(value: T): T {
  const encoded = boundedCanonicalJson(value, {
    maxBytes: budget.maxCanonicalJsonBytes,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!encoded.ok) throw new TypeError('Reference Tools payload exceeds codec limits')
  const detached = JSON.parse(encoded.value.canonical) as T
  function freeze(node: unknown): void {
    if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(freeze)
      Object.freeze(node)
    }
  }
  freeze(detached)
  return detached
}
function data<K extends keyof RuntimeWireTypes>(
  input: DataRef,
  expected: SchemaRef,
  name: K,
): Outcome<RuntimeWireTypes[K]> {
  if (!validateRuntime('DataRef', input).ok || input.kind !== 'inline' || !equivalent(input.schema, expected))
    return denied('invalid_input', 'tools_data_schema')
  const encoded = boundedCanonicalJson(input.value, {
    maxBytes: budget.maxCanonicalJsonBytes,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!encoded.ok || encoded.value.bytes !== input.bytes || digest(encoded.value.json) !== input.digest)
    return denied('invalid_input', 'tools_data_integrity')
  const validated = validateRuntime(name, encoded.value.json)
  return validated.ok
    ? { ok: true, value: snapshot(validated.value) }
    : denied('invalid_input', 'tools_input_schema')
}
function output(schema: SchemaRef, value: unknown): Outcome<DataRef> {
  const encoded = boundedCanonicalJson(value, {
    maxBytes: budget.maxCanonicalJsonBytes,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!encoded.ok) return denied('quota', 'tools_output_budget')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema,
      value: encoded.value.json,
      digest: digest(encoded.value.json),
      bytes: encoded.value.bytes,
    },
  }
}
function contains(parent: FactoryContext['scope'], child: CallContext['scope']): boolean {
  return Object.keys(parent)
    .filter((key) => key !== 'kind')
    .every((key) => parent[key as keyof typeof parent] === child[key as keyof typeof child])
}
function copyCall(context: CallContext): CallContext {
  const { signal, ...wire } = context
  if (!validateRuntime('CallContextWire', wire).ok) throw new TypeError('Invalid reference Tools context')
  return { ...snapshot(wire), signal }
}
function failed(error: RuntimeError): EffectResult {
  return {
    outcome: error.code === 'cancelled' ? 'cancelled' : 'failed',
    error,
    externalRequests: [],
    usage: [],
    references: [],
  }
}

/** Independent fixed-snapshot service; it neither owns authorization nor invents receipts. */
export function createReferenceToolsFactory(
  source: ReferenceToolsDeployment,
): ProviderFactory<ServiceProvider> {
  const descriptor = snapshot(source.descriptor)
  const definition = snapshot(source.definition)
  const configuration = snapshot(source.configuration)
  const sourceSnapshot = source.snapshot
  const catalogRevision = source.catalogRevision
  if (configuration.kind !== 'inline')
    throw new TypeError('Reference Tools configuration must be fixed inline data')
  const configurationProof = boundedCanonicalJson(configuration.value, {
    maxBytes: budget.maxCanonicalJsonBytes,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (
    !configurationProof.ok ||
    configurationProof.value.bytes !== configuration.bytes ||
    digest(configurationProof.value.json) !== configuration.digest
  )
    throw new TypeError('Reference Tools configuration proof differs')
  if (
    !validateRuntime('ProviderDescriptor', descriptor).ok ||
    !validateRuntime('ToolDefinition', definition).ok ||
    !validateRuntime('DataRef', configuration).ok ||
    !validateRuntime('Id', sourceSnapshot).ok ||
    !validateRuntime('Revision', catalogRevision).ok ||
    descriptor.contract !== 'agh.tools' ||
    descriptor.major !== 1 ||
    descriptor.recovery !== 'R1' ||
    descriptor.features.length !== 0 ||
    descriptor.stateCodecs.length !== 0 ||
    !equivalent(configuration.schema, descriptor.configSchema)
  )
    throw new TypeError('Reference Tools requires the fixed pure deployment')
  const expected = [
    ['describe', 'query'],
    ['classify', 'compute'],
    ['catalog', 'compute'],
    ['invoke', 'action'],
  ] as const
  if (
    descriptor.operations.length !== expected.length ||
    expected.some(
      ([method, kind]) =>
        !descriptor.operations.some(
          (operation) =>
            operation.method === method &&
            operation.kind === kind &&
            equivalent(operation.inputSchema, methods[method].input) &&
            equivalent(operation.outputSchema, methods[method].output),
        ),
    )
  )
    throw new TypeError('Reference Tools methods differ from the official slice')
  if (
    definition.name !== 'text-statistics' ||
    definition.executor.providerId !== descriptor.providerId ||
    definition.executor.logicalName !== descriptor.logicalName ||
    definition.executor.contract !== descriptor.contract ||
    !equivalent(definition.inputSchema, runtimeAuthorSchemas.StandardToolOutput.ref) ||
    !equivalent(definition.outputSchema, runtimeAuthorSchemas.StandardToolOutput.ref) ||
    definition.retrySafety !== 'idempotent' ||
    definition.policy.classifierRef !== null ||
    !definition.policy.defaults.isReadOnly ||
    definition.policy.defaults.isDestructive ||
    definition.policy.defaults.requiresApproval !== 'never' ||
    definition.policy.defaults.replay !== 'idempotent' ||
    definition.policy.defaults.approvalScopes.length !== 0 ||
    definition.execution.isOpenWorld ||
    definition.execution.concurrency !== 'parallel' ||
    definition.execution.deferLoading ||
    definition.execution.requiredModelInput.length !== 0
  )
    throw new TypeError('Reference Tools definition is not the closed text-statistics tool')
  function policy(input: DataRef): Outcome<ToolPolicySnapshot> {
    const parsed = data(input, definition.inputSchema, 'StandardToolOutput')
    if (!parsed.ok) return parsed
    if (parsed.value.content.length !== 1 || parsed.value.structured !== undefined)
      return denied('invalid_input', 'tools_one_text_required')
    const fields = {
      ...definition.policy.defaults,
      policyVersion: definition.policy.version,
      classifierDigest: digest(definition.policy),
      inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
      definitionDigest: digest(definition),
    }
    return { ok: true, value: { ...fields, fingerprint: digest(fields) } }
  }
  return {
    descriptor,
    async create(config, _dependencies, factoryContext) {
      if (
        !equivalent(config, configuration) ||
        !validateRuntime('ScopeRef', factoryContext.scope).ok ||
        factoryContext.scope.kind !== descriptor.scope ||
        factoryContext.bindingId !== definition.executor.bindingId
      )
        throw new TypeError('Reference Tools binding or configuration differs')
      const factory = { ...factoryContext, scope: snapshot(factoryContext.scope) }
      const serviceStop = new AbortController()
      const active = new Map<symbol, string>()
      const sourceReads = new Map<symbol, { invocationId: string; scope: CallContext['scope'] }>()
      const executors = new Set<LeafActionProvider>()
      let serviceState: 'ready' | 'draining' | 'closed' = 'ready'
      function readIds(scope?: CallContext['scope']): string[] {
        return [...sourceReads.values()]
          .filter((read) => !scope || equivalent(read.scope, scope))
          .map((read) => read.invocationId)
      }
      async function awaitSource(
        call: CallContext,
        read: () => Promise<Outcome<void>>,
        lifecycle = false,
        deadline = call.deadline,
      ): Promise<Outcome<void>> {
        const token = Symbol('reference-tools-source')
        const signal = lifecycle
          ? call.signal
          : AbortSignal.any([call.signal, factory.signal, serviceStop.signal])
        if (signal.aborted) return denied('cancelled', 'tools_cancelled')
        sourceReads.set(token, { invocationId: call.invocationId, scope: call.scope })
        const original = Promise.resolve()
          .then(read)
          .then(
            (result) => {
              sourceReads.delete(token)
              return result
            },
            () => {
              sourceReads.delete(token)
              return denied('denied', 'tools_source_unavailable')
            },
          )
        return new Promise((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          let finished = false
          const finish = (result: Outcome<void>) => {
            if (finished) return
            finished = true
            if (timer !== undefined) clearTimeout(timer)
            signal.removeEventListener('abort', aborted)
            resolve(result)
          }
          const aborted = () => finish(denied('cancelled', 'tools_cancelled'))
          const expires = Math.min(Date.parse(call.deadline), Date.parse(deadline))
          const arm = () => {
            const remaining = expires - Date.now()
            timer = setTimeout(
              () => {
                if (expires <= Date.now()) finish(denied('timeout', 'tools_deadline'))
                else arm()
              },
              Math.max(0, Math.min(remaining, 2_147_483_647)),
            )
          }
          signal.addEventListener('abort', aborted, { once: true })
          original.then(finish)
          arm()
          if (signal.aborted) aborted()
        })
      }
      function available(call: CallContext): Outcome<void> {
        if (call.bindingId !== factory.bindingId || !contains(factory.scope, call.scope))
          return denied('denied', 'tools_context_binding')
        if (serviceState !== 'ready') return denied('retryable', 'tools_closed')
        if (call.signal.aborted || factory.signal.aborted || serviceStop.signal.aborted)
          return denied('cancelled', 'tools_cancelled')
        if (Date.parse(call.deadline) <= Date.now()) return denied('timeout', 'tools_deadline')
        return { ok: true, value: undefined }
      }
      async function authorize(call: CallContext, deadline = call.deadline): Promise<Outcome<void>> {
        const first = available(call)
        if (!first.ok) return first
        if (Date.parse(deadline) <= Date.now()) return denied('timeout', 'tools_deadline')
        try {
          const authorized = await awaitSource(call, () => source.checkCurrent(call), false, deadline)
          if (authorized.ok && Date.parse(deadline) <= Date.now()) return denied('timeout', 'tools_deadline')
          return authorized.ok ? available(call) : authorized
        } catch {
          return denied('denied', 'tools_source_unavailable')
        }
      }
      async function drainAdmission(
        deadline: string,
        context: CallContext,
        actionScope?: CallContext['scope'],
      ): Promise<Outcome<void>> {
        try {
          const call = copyCall(context)
          const validate = (): Outcome<void> => {
            if (!validateRuntime('Timestamp', deadline).ok)
              return denied('invalid_input', 'tools_drain_deadline')
            if (
              call.bindingId !== factory.bindingId ||
              !contains(factory.scope, call.scope) ||
              (actionScope && !equivalent(call.scope, actionScope))
            )
              return denied('denied', 'tools_context_binding')
            if (call.signal.aborted) return denied('cancelled', 'tools_drain_cancelled')
            if (Date.parse(call.deadline) <= Date.now()) return denied('timeout', 'tools_drain_deadline')
            return { ok: true, value: undefined }
          }
          const before = validate()
          if (!before.ok) return before
          const authorized = await awaitSource(call, () => source.checkCurrent(call), true, deadline)
          return authorized.ok ? validate() : authorized
        } catch {
          return denied('denied', 'tools_source_unavailable')
        }
      }
      const invoke: ActionProviderFactory = {
        kind: 'leaf',
        recovery: 'R1',
        stateCodec: null,
        async create(actionContext) {
          if (serviceState !== 'ready') throw problem('retryable', 'tools_closed')
          const action = { ...actionContext, scope: snapshot(actionContext.scope) }
          if (
            !validateRuntime('ScopeRef', action.scope).ok ||
            action.bindingId !== factory.bindingId ||
            action.scope.kind !== 'action' ||
            action.scope.actionId !== action.actionId ||
            action.scope.runId !== action.runId ||
            !contains(factory.scope, action.scope)
          )
            throw new TypeError('Reference Tools action scope differs')
          const actionStop = new AbortController()
          const owned = new Set<LeafActionProvider>()
          const pending = new Map<symbol, string>()
          let closed = false
          async function check(call: CallContext, deadline = call.deadline): Promise<Outcome<void>> {
            if (closed || actionStop.signal.aborted || action.signal.aborted)
              return denied('cancelled', 'tools_action_closed')
            if (!equivalent(call.scope, action.scope)) return denied('denied', 'tools_action_scope')
            return authorize(
              {
                ...call,
                signal: AbortSignal.any([call.signal, action.signal, actionStop.signal]),
              },
              deadline,
            )
          }
          return {
            kind: 'leaf',
            effectSemantics: 'idempotent',
            executionUnit: 'single-effect',
            async ready(context) {
              try {
                return await check(copyCall(context))
              } catch {
                return denied('invalid_input', 'tools_call_context')
              }
            },
            async health(context) {
              try {
                const admission = await check(copyCall(context))
                return admission.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : admission
              } catch {
                return denied('invalid_input', 'tools_call_context')
              }
            },
            async drain(deadline, call) {
              try {
                call = copyCall(call)
              } catch {
                return denied('invalid_input', 'tools_call_context')
              }
              const admission = await drainAdmission(deadline, call, action.scope)
              if (!admission.ok) return admission
              closed = true
              actionStop.abort()
              const results = await Promise.all([...owned].map((child) => child.drain(deadline, call)))
              const ids = [
                ...pending.values(),
                ...readIds(action.scope),
                ...results.flatMap((result) =>
                  result.ok ? result.value.activeInvocationIds : [call.invocationId],
                ),
              ]
              return {
                ok: true,
                value: {
                  state: ids.length === 0 ? 'drained' : 'blocked',
                  activeInvocationIds: [...new Set(ids)],
                  durableOwnerRefs: [],
                  diagnosticIds: [],
                },
              }
            },
            async close(reason) {
              closed = true
              actionStop.abort()
              await Promise.all([...owned].map((child) => child.close(reason)))
            },
            async execute(inputFrame, inputContext) {
              const token = Symbol('reference-tools-execution')
              let executor: LeafActionProvider | undefined
              let cleanupCall: CallContext | undefined
              try {
                const frame = snapshot(inputFrame)
                const originalCall = copyCall(inputContext.call)
                cleanupCall = originalCall
                const call = {
                  ...originalCall,
                  signal: AbortSignal.any([
                    originalCall.signal,
                    factory.signal,
                    action.signal,
                    actionStop.signal,
                    serviceStop.signal,
                  ]),
                }
                pending.set(token, call.invocationId)
                active.set(token, call.invocationId)
                const { signal: _signal, ...wire } = originalCall
                if (
                  !validateRuntime('ActionFrame', frame).ok ||
                  frame.actionId !== action.actionId ||
                  frame.runId !== action.runId ||
                  frame.bindingId !== action.bindingId ||
                  frame.method !== 'invoke' ||
                  frame.invocationId !== call.invocationId ||
                  !equivalent(frame.context, wire) ||
                  frame.input.kind !== 'inline' ||
                  frame.input.digest !== frame.inputDigest ||
                  frame.continuation !== null ||
                  frame.attemptNumber < 1 ||
                  Date.parse(frame.actionTimebox.maxDeadline) <= Date.now()
                )
                  return failed(problem('invalid_input', 'tools_action_frame'))
                const admitted = await check(call, frame.actionTimebox.maxDeadline)
                if (!admitted.ok) return failed(admitted.error)
                const parsed = data(frame.input, methods.invoke.input, 'ToolCall')
                if (!parsed.ok) return failed(parsed.error)
                const invocation = parsed.value
                const classified = policy(invocation.input)
                if (!classified.ok) return failed(classified.error)
                if (
                  !equivalent(invocation.definition, definition) ||
                  !equivalent(invocation.policy, classified.value) ||
                  invocation.expectedDefinitionDigest !== classified.value.definitionDigest
                )
                  return failed(problem('denied', 'tools_call_identity'))
                if (invocation.modelContextRef !== null)
                  return failed(problem('incompatible', 'tools_model_context_source_unavailable'))
                if (invocation.batchRef !== null)
                  return failed(problem('incompatible', 'tools_batch_source_unavailable'))
                let sourceVerified: Outcome<void>
                if (typeof source.verifyCall !== 'function')
                  return failed(problem('incompatible', 'tools_action_source_unavailable'))
                try {
                  sourceVerified = await awaitSource(
                    call,
                    () => source.verifyCall(invocation, frame, call),
                    false,
                    frame.actionTimebox.maxDeadline,
                  )
                } catch {
                  return failed(problem('denied', 'tools_source_unavailable'))
                }
                if (!sourceVerified.ok) return failed(sourceVerified.error)
                const latest = await check(call, frame.actionTimebox.maxDeadline)
                if (!latest.ok) return failed(latest.error)
                if (typeof source.createExecutor !== 'function')
                  return failed(problem('incompatible', 'tools_author_dispatcher_unavailable'))
                const adapter = source.createExecutor(invocation)
                if (adapter.kind !== 'leaf' || adapter.recovery !== 'R1' || adapter.stateCodec !== null)
                  return failed(problem('incompatible', 'tools_pure_executor_required'))
                const candidate = await adapter.create(action)
                if (candidate.kind !== 'leaf') {
                  await candidate.close('shutdown')
                  return failed(problem('incompatible', 'tools_pure_executor_required'))
                }
                executor = candidate
                executors.add(executor)
                owned.add(executor)
                if (executor.effectSemantics !== 'idempotent')
                  return failed(problem('incompatible', 'tools_pure_executor_required'))
                const ready = await executor.ready(call)
                if (!ready.ok) return failed(ready.error)
                const beforeExecution = await check(call, frame.actionTimebox.maxDeadline)
                if (!beforeExecution.ok) return failed(beforeExecution.error)
                const result = snapshot(await executor.execute(frame, { ...inputContext, call }))
                const afterExecution = await check(call, frame.actionTimebox.maxDeadline)
                if (!afterExecution.ok) return failed(afterExecution.error)
                if (
                  !validateRuntime('EffectResult', result).ok ||
                  result.externalRequests.length ||
                  result.usage.length ||
                  result.references.length
                )
                  return failed(problem('internal', 'tools_executor_result'))
                if (result.outcome === 'succeeded') {
                  if (!result.result) return failed(problem('internal', 'tools_executor_result'))
                  const raw = data(result.result, RuntimeSchemaRefs.ToolResult, 'ToolResult')
                  if (
                    !raw.ok ||
                    raw.value.details !== undefined ||
                    raw.value.artifacts.length ||
                    !equivalent(raw.value.provenance.producer, definition.executor) ||
                    raw.value.provenance.sourceRefs.length === 0 ||
                    !equivalent(raw.value.provenance.trustLabels, ['derived'])
                  )
                    return failed(problem('internal', 'tools_result_provenance'))
                  const visible = data(raw.value.output, definition.outputSchema, 'StandardToolOutput')
                  if (!visible.ok) return failed(visible.error)
                }
                return result
              } catch {
                return failed(problem('internal', 'tools_dispatch_failed'))
              } finally {
                if (executor) {
                  try {
                    const drained =
                      cleanupCall && (await executor.drain(new Date().toISOString(), cleanupCall))
                    if (drained?.ok && drained.value.state === 'drained') {
                      await executor.close('shutdown')
                      executors.delete(executor)
                      owned.delete(executor)
                    }
                  } catch {
                    /* Keep the handler reachable when cleanup cannot prove it drained. */
                  }
                }
                active.delete(token)
                pending.delete(token)
              }
            },
            async reconcile(_frame, _evidence, context) {
              const admission = await check(copyCall(context.call))
              if (!admission.ok) throw admission.error
              throw problem('incompatible', 'tools_receipt_source_unavailable')
            },
          }
        },
      }
      return {
        async ready(context) {
          try {
            return await authorize(copyCall(context))
          } catch {
            return denied('invalid_input', 'tools_call_context')
          }
        },
        async health(context) {
          try {
            const admission = await authorize(copyCall(context))
            return admission.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : admission
          } catch {
            return denied('invalid_input', 'tools_call_context')
          }
        },
        async drain(deadline, context) {
          try {
            context = copyCall(context)
          } catch {
            return denied('invalid_input', 'tools_call_context')
          }
          const admission = await drainAdmission(deadline, context)
          if (!admission.ok) return admission
          serviceState = 'draining'
          serviceStop.abort()
          const results = await Promise.all(
            [...executors].map((executor) => executor.drain(deadline, context)),
          )
          const ids = [
            ...active.values(),
            ...readIds(),
            ...results.flatMap((result) =>
              result.ok ? result.value.activeInvocationIds : [context.invocationId],
            ),
          ]
          return {
            ok: true,
            value: {
              state: ids.length === 0 ? 'drained' : 'blocked',
              activeInvocationIds: [...new Set(ids)],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close(reason) {
          serviceState = 'closed'
          serviceStop.abort()
          await Promise.all([...executors].map((executor) => executor.close(reason)))
        },
        async query(inputRequest, inputCall) {
          try {
            const request = snapshot(inputRequest),
              call = copyCall(inputCall)
            if (!validateRuntime('ServiceQuery', request).ok)
              return denied('invalid_input', 'tools_query_schema')
            const admitted = await authorize(call)
            if (!admitted.ok) return admitted
            if (!equivalent(request.target, definition.executor)) return denied('denied', 'tools_target')
            if (request.method !== 'describe') return denied('incompatible', 'tools_query_unsupported')
            if (
              request.page !== undefined ||
              (request.snapshot !== undefined && request.snapshot !== sourceSnapshot)
            )
              return denied('conflict', 'tools_snapshot')
            const parsed = data(request.input, methods.describe.input, 'ToolsDescribeRequest')
            if (!parsed.ok) return parsed
            if (!equivalent(parsed.value.resource, definition.resource))
              return denied('denied', 'tools_definition_source')
            const encoded = output(methods.describe.output, definition)
            if (!encoded.ok) return encoded
            const rechecked = await authorize(call)
            return rechecked.ok
              ? { ok: true, value: { kind: 'value', snapshot: sourceSnapshot, output: encoded.value } }
              : rechecked
          } catch {
            return denied('invalid_input', 'tools_query_schema')
          }
        },
        async compute(inputRequest, inputCall) {
          try {
            const request = snapshot(inputRequest),
              call = copyCall(inputCall)
            if (!validateRuntime('ServiceOperation', request).ok)
              return denied('invalid_input', 'tools_operation_schema')
            const admitted = await authorize(call)
            if (!admitted.ok) return admitted
            if (!equivalent(request.target, definition.executor)) return denied('denied', 'tools_target')
            let encoded: Outcome<DataRef>
            if (request.method === 'classify') {
              const parsed = data(request.input, methods.classify.input, 'ToolsClassifyRequest')
              if (!parsed.ok) return parsed
              if (!equivalent(parsed.value.definition, definition))
                return denied('denied', 'tools_definition_source')
              const classified = policy(parsed.value.input)
              encoded = classified.ok ? output(methods.classify.output, classified.value) : classified
            } else if (request.method === 'catalog') {
              const parsed = data(request.input, methods.catalog.input, 'ToolsCatalogRequest')
              if (!parsed.ok) return parsed
              if (parsed.value.tools.length !== 1 || !equivalent(parsed.value.tools[0], definition))
                return denied('denied', 'tools_catalog_source')
              if (parsed.value.policy.policyRevision !== catalogRevision)
                return denied('conflict', 'tools_catalog_revision')
              if (
                parsed.value.policy.disclosure !== 'standard' ||
                !parsed.value.policy.compactionAgentCallable
              )
                return denied('incompatible', 'tools_catalog_policy_unsupported')
              const catalog = { revision: catalogRevision, tools: [definition] }
              encoded = output(methods.catalog.output, { ...catalog, digest: digest(catalog) })
            } else return denied('incompatible', 'tools_compute_unsupported')
            const rechecked = await authorize(call)
            return rechecked.ok ? encoded : rechecked
          } catch {
            return denied('invalid_input', 'tools_operation_schema')
          }
        },
        actions: { invoke },
      }
    },
  }
}
