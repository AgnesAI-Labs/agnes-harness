import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type AlgorithmAdapterDefinition,
  type AlgorithmImplementationMap,
  type AuthorSchema,
  adaptProvider,
  runtimeAuthorSchemas,
} from './authoring.js'
import { assertAuthorSchema, createAuthorSchema } from './authoring-schema-core.js'
import { assertFields, copyJson } from './authoring-validation.js'
import type * as Local from './public-api.js'

type Contract = 'agh.context' | 'agh.compaction'
type Definition<K extends Contract, C> = AlgorithmAdapterDefinition<K, C>
type StateDecoder = Pick<AuthorSchema<unknown>, 'ref' | 'parse'>
export type AlgorithmAuthorEnvironment = {
  binding: Wire.BindingRef
  context: Local.FactoryContext
  dependencies: Local.ScopedDependencies
  config: Wire.DataRef | null
  schemas?: readonly StateDecoder[]
  /** Trusted Host assembly supplies a freshly authorized child control context. Never exposed to the author. */
  childDrainContext?: (
    scope: Wire.ScopeRef,
    parent: Local.CallContext,
  ) => Promise<Local.Outcome<Local.CallContext>>
}
export type AlgorithmAuthorMethods<K extends Contract> = Local.ProviderLifecycle & {
  readonly methods: AlgorithmImplementationMap[K]
}

function problem(detailCode: string, code: Wire.RuntimeError['code'] = 'invalid_input'): Wire.RuntimeError {
  return {
    code,
    detailCode,
    message: 'Author algorithm invocation rejected',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'author-algorithm',
  }
}
function requireValue<T>(outcome: Local.Outcome<T>): T {
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
function fail(condition: unknown, detail: string): asserts condition {
  if (!condition) throw problem(detail)
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJsonDigest(left as Wire.JsonValue) === canonicalJsonDigest(right as Wire.JsonValue)
}
function checked<K extends keyof Wire.RuntimeWireTypes>(name: K, value: unknown): Wire.RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  fail(result.ok, `invalid_${name}`)
  return copyJson(result.value)
}
function inline(ref: Wire.DataRef, schema: Wire.SchemaRef): Wire.JsonValue {
  const safe = checked('DataRef', ref)
  fail(equal(safe.schema, schema), 'schema_mismatch')
  // The author method SPI has no data resolver. Blob materialization belongs to the caller.
  fail(safe.kind === 'inline', 'inline_data_required')
  const codec = createAuthorSchema(schema, (value) => ({ ok: true, value }))
  const encoded = requireValue(codec.encode(safe.value))
  fail(
    encoded.kind === 'inline' && encoded.digest === safe.digest && encoded.bytes === safe.bytes,
    'data_integrity',
  )
  return safe.value
}
function payload(
  contract: Contract,
  method: string,
  side: 'input' | 'output',
  ref: Wire.DataRef,
): Wire.JsonValue {
  const catalog = RuntimeServiceCatalog[contract].methods as Readonly<
    Record<string, { input: keyof Wire.RuntimeWireTypes; output: keyof Wire.RuntimeWireTypes }>
  >
  const schemas = RuntimeMethodSchemaRefs[contract] as Readonly<
    Record<string, { input: Wire.SchemaRef; output: Wire.SchemaRef }>
  >
  const operation = catalog[method]
  const references = schemas[method]
  fail(operation && references, 'unknown_method')
  const value = inline(ref, references[side])
  checked(operation[side], value)
  return value
}
function within(parent: Wire.ScopeRef, child: Wire.ScopeRef): boolean {
  const fields = child as unknown as Record<string, unknown>
  return Object.entries(parent).every(([key, value]) => key === 'kind' || fields[key] === value)
}
function viewDigest(view: Wire.ContextView): void {
  const { digest, ...content } = view
  fail(canonicalJsonDigest(content) === digest, 'view_digest_mismatch')
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        problem(
          signal.reason?.name === 'TimeoutError' ? 'deadline_expired' : 'cancelled',
          signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
        ),
      )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Internal author-method slice. The trusted preparation dispatcher must compose this with SDK preparation. */
export async function createAlgorithmAuthorMethods<K extends Contract, C>(
  input: Definition<K, C>,
  environment: AlgorithmAuthorEnvironment,
): Promise<AlgorithmAuthorMethods<K>> {
  const definition = adaptProvider(input).definition
  const codecs: readonly StateDecoder[] = [
    ...Object.values(runtimeAuthorSchemas),
    ...(environment.schemas ?? []),
  ]
  for (const candidate of codecs) assertAuthorSchema(candidate as AuthorSchema<unknown>)
  function decodeState(data: Wire.DataRef): void {
    const decoder = codecs.find((candidate) => equal(candidate.ref, data.schema))
    fail(decoder, 'state_schema_unregistered')
    requireValue(decoder.parse(inline(data, decoder.ref)))
  }
  for (const reference of definition.stateCodecs ?? [])
    fail(
      codecs.some((candidate) => equal(candidate.ref, reference.schema)),
      'state_schema_unregistered',
    )
  const binding = checked('BindingRef', environment.binding)
  const scope = checked('ScopeRef', environment.context.scope)
  const factory = { ...environment.context, scope }
  fail(
    binding.contract === definition.contract && binding.bindingId === factory.bindingId,
    'binding_mismatch',
  )
  fail(scope.kind === (definition.contract === 'agh.context' ? 'run' : 'session'), 'scope_mismatch')
  fail(!factory.signal.aborted, 'cancelled')
  let config: Readonly<C>
  if (definition.config) {
    const value =
      environment.config === null
        ? definition.config.defaults
        : inline(environment.config, definition.config.schema.ref)
    config = requireValue(definition.config.schema.parse(value))
  } else {
    fail(environment.config === null, 'unexpected_config')
    config = Object.freeze({}) as Readonly<C>
  }
  for (const requirement of definition.requires) {
    const result = environment.dependencies.get(requirement)
    if (!result.ok && !requirement.optional) throw result.error
  }
  const implementation = await definition.make(config, environment.dependencies, factory)
  const names =
    definition.contract === 'agh.context' ? ['view', 'refresh'] : ['plan', 'expand', 'execute', 'apply']
  assertFields(implementation, names)
  fail(
    names.every((name) => Object.hasOwn(implementation, name)),
    'method_set_mismatch',
  )
  const methods = implementation as unknown as Record<
    string,
    Local.QueryHandler | Local.MethodHandler | Local.ActionProviderFactory
  >
  let state: 'created' | 'ready' | 'draining' | 'closed' = 'created'
  const controller = new AbortController()
  const signal = AbortSignal.any([factory.signal, controller.signal])
  const active = new Set<string>()
  const activeActions = new Set<string>()
  const pendingCreations = new Set<string>()
  const jobs = new Set<Promise<unknown>>()
  function trackJob<T>(pending: Promise<T>): Promise<T> {
    jobs.add(pending)
    void pending.then(
      () => jobs.delete(pending),
      () => jobs.delete(pending),
    )
    return pending
  }
  let pendingCalls = 0
  async function trackEffect<T>(run: () => Promise<T>): Promise<T> {
    pendingCalls++
    try {
      return await trackJob(run())
    } finally {
      pendingCalls--
    }
  }
  const children = new Set<Local.ActionProvider>()
  const childDrains = new Map<
    Local.ActionProvider,
    { scope: Wire.ScopeRef; drain: Local.ProviderLifecycle['drain'] }
  >()
  const childDrainContext = environment.childDrainContext

  function context(
    call: Local.CallContext,
    childScope: Wire.ScopeRef = scope,
    allowInactive = false,
    control = false,
  ): Local.CallContext {
    const { signal: callSignal, ...wire } = call
    const safe = checked('CallContextWire', wire)
    fail(equal(safe.scope, childScope) && safe.bindingId === binding.bindingId, 'context_mismatch')
    if ((!control && (state === 'closed' || signal.aborted)) || callSignal.aborted)
      throw problem('cancelled', 'cancelled')
    fail(allowInactive || state === 'ready', 'provider_not_ready')
    if (Date.parse(safe.deadline) <= Date.now()) throw problem('deadline_expired', 'timeout')
    return {
      ...safe,
      signal: AbortSignal.any([
        ...(control ? [] : [signal]),
        callSignal,
        AbortSignal.timeout(Math.max(0, Math.min(Date.parse(safe.deadline) - Date.now(), 2_147_483_647))),
      ]),
    }
  }
  async function pure<T>(
    call: Local.CallContext,
    run: (safe: Local.CallContext) => Promise<Local.Outcome<T>>,
  ): Promise<Local.Outcome<T>> {
    try {
      const safe = context(call)
      fail(!active.has(safe.invocationId), 'invocation_active')
      active.add(safe.invocationId)
      const pending = trackJob((async () => run(safe))())
      void pending.then(
        () => active.delete(safe.invocationId),
        () => active.delete(safe.invocationId),
      )
      {
        const result = await abortable(pending, safe.signal)
        context(call, scope, true)
        if (!result.ok) return { ok: false, error: checked('RuntimeError', result.error) }
        return result
      }
    } catch (error) {
      let failure = error
      try {
        context(call, scope, true)
      } catch (reason) {
        failure = reason
      }
      const validated = validateRuntime('RuntimeError', failure)
      return {
        ok: false,
        error: validated.ok ? validated.value : problem('author_method_failed', 'internal'),
      }
    }
  }
  function request(method: string, value: Wire.ServiceOperation): Wire.ServiceOperation {
    const safe = checked('ServiceOperation', {
      target: value.target,
      method: value.method,
      input: value.input,
    })
    fail(equal(safe.target, binding) && safe.method === method, 'request_binding_mismatch')
    const input = payload(definition.contract, method, 'input', safe.input)
    if (method === 'plan') viewDigest(checked('CompactionPlanRequest', input).view)
    return safe
  }
  function planIdentity(plan: Wire.CompactionPlan): void {
    fail(equal(plan.algorithm, binding), 'plan_binding_mismatch')
    fail(
      definition.stateCodecs?.some((entry) => equal(entry.schema, plan.privatePlan.schema)),
      'plan_codec_undeclared',
    )
    decodeState(plan.privatePlan)
  }
  function query(method: string, handler: Local.QueryHandler): Local.QueryHandler {
    fail(typeof handler === 'function', 'handler_required')
    return (value, call) =>
      pure(call, async (safe) => {
        const inputQuery = checked('ServiceQuery', value)
        request(method, inputQuery)
        const result = await handler(inputQuery, safe)
        if (!result.ok) return result
        const reply = checked('QueryReply', result.value)
        if (reply.kind === 'value') {
          const output = payload(definition.contract, method, 'output', reply.output)
          fail(
            inputQuery.snapshot === undefined || inputQuery.snapshot === reply.snapshot,
            'snapshot_mismatch',
          )
          if (method === 'expand')
            fail(
              checked('CompactionExpandResult', output).snapshot === reply.snapshot,
              'page_snapshot_mismatch',
            )
          if (method === 'view') {
            const view = checked('ContextView', output)
            viewDigest(view)
            const source = checked(
              'ContextViewRequest',
              inline(inputQuery.input, RuntimeMethodSchemaRefs['agh.context'].view.input),
            )
            fail(view.baseRevision === source.atRevision, 'view_revision_mismatch')
          }
        }
        return { ok: true, value: reply }
      })
  }
  function compute(method: string, handler: Local.MethodHandler): Local.MethodHandler {
    fail(typeof handler === 'function', 'handler_required')
    return (value, call) =>
      pure(call, async (safe) => {
        const fixed = request(method, value)
        const result = await handler(fixed, safe)
        if (!result.ok) return result
        payload(definition.contract, method, 'output', result.value)
        const output = checked(
          'CompactionPlan',
          inline(result.value, RuntimeMethodSchemaRefs['agh.compaction'].plan.output),
        )
        const source = checked(
          'CompactionPlanRequest',
          inline(fixed.input, RuntimeMethodSchemaRefs['agh.compaction'].plan.input),
        )
        planIdentity(output)
        fail(output.baseRevision === source.view.baseRevision, 'plan_revision_mismatch')
        fail(
          source.protectedRefs.every((ref) =>
            output.preservedRefs.some((preserved) => equal(ref, preserved)),
          ),
          'protected_source_missing',
        )
        return { ok: true, value: copyJson(result.value) }
      })
  }
  function codec(value: Wire.VersionedState, reference: Wire.StateCodecRef | null): void {
    fail(
      reference && value.namespace === reference.namespace && value.codecVersion === reference.codecVersion,
      'state_codec_mismatch',
    )
    fail(equal(value.data.schema, reference.schema), 'state_schema_mismatch')
    decodeState(value.data)
    fail(equal(value.provenance.producer, binding), 'state_producer_mismatch')
  }
  function action(method: string, original: Local.ActionProviderFactory): Local.ActionProviderFactory {
    assertFields(original, ['kind', 'recovery', 'stateCodec', 'create'])
    fail(
      typeof original.create === 'function' && ['leaf', 'composite'].includes(original.kind),
      'action_factory_invalid',
    )
    checked('RecoveryLevel', original.recovery)
    const reference = original.stateCodec === null ? null : checked('StateCodecRef', original.stateCodec)
    fail(
      reference === null || definition.stateCodecs?.some((entry) => equal(entry, reference)),
      'undeclared_state_codec',
    )
    fail(original.kind !== 'composite' || reference !== null, 'composite_codec_required')
    const createAction = original.create.bind(original)
    const kind = original.kind
    return Object.freeze({
      kind: original.kind,
      recovery: original.recovery,
      stateCodec: reference,
      async create(suppliedScope: Local.ActionHandlerScope): Promise<Local.ActionProvider> {
        const actionScope = { ...suppliedScope, scope: checked('ScopeRef', suppliedScope.scope) }
        const drainScope = copyJson(actionScope.scope)
        fail(state === 'ready' && !signal.aborted && !actionScope.signal.aborted, 'provider_not_ready')
        checked('ScopeRef', actionScope.scope)
        fail(
          actionScope.bindingId === binding.bindingId &&
            within(scope, actionScope.scope) &&
            (!('runId' in actionScope.scope) || actionScope.scope.runId === actionScope.runId) &&
            (actionScope.scope.kind !== 'action' || actionScope.scope.actionId === actionScope.actionId),
          'action_scope_mismatch',
        )
        const childController = new AbortController()
        const childSignal = AbortSignal.any([signal, actionScope.signal, childController.signal])
        const creation = `create:${method}:${actionScope.actionId}`
        fail(!pendingCreations.has(creation), 'creation_active')
        pendingCreations.add(creation)
        let provider: Local.ActionProvider
        try {
          provider = await trackJob(createAction({ ...actionScope, signal: childSignal }))
        } catch (error) {
          pendingCreations.delete(creation)
          throw error
        }
        if (childSignal.aborted || state !== 'ready' || provider.kind !== kind) {
          try {
            await trackJob(provider.close('cancelled'))
          } finally {
            pendingCreations.delete(creation)
          }
          throw problem('action_creation_closed', 'cancelled')
        }
        children.add(provider)
        pendingCreations.delete(creation)
        let owned: Local.ActionProvider
        let closed = false
        let inputIdentity: Wire.Digest | undefined
        function frame(value: Wire.ActionFrame, reconciling = false): Wire.ActionFrame {
          const safe = checked('ActionFrame', value)
          fail(safe.attemptNumber > 0, 'action_not_dispatchable')
          if (kind === 'composite')
            fail(safe.attemptNumber === 1 && safe.requestIdentity === null, 'action_not_dispatchable')
          fail(!closed && !childSignal.aborted && state !== 'closed', 'cancelled')
          fail(
            safe.actionId === actionScope.actionId &&
              safe.runId === actionScope.runId &&
              safe.invocationId === safe.context.invocationId &&
              safe.bindingId === binding.bindingId &&
              safe.method === method,
            'action_frame_mismatch',
          )
          context({ ...safe.context, signal: childSignal }, actionScope.scope, true)
          if (!reconciling && Date.parse(safe.actionTimebox.maxDeadline) <= Date.now())
            throw problem('deadline_expired', 'timeout')
          const input = payload(definition.contract, method, 'input', safe.input)
          if (definition.contract === 'agh.compaction') {
            const request = checked(
              method === 'execute' ? 'CompactionExecuteRequest' : 'CompactionApplyRequest',
              input,
            )
            planIdentity(request.plan)
            fail(request.expectedRevision === request.plan.baseRevision, 'plan_revision_mismatch')
          }
          fail(safe.input.kind === 'inline' && safe.inputDigest === safe.input.digest, 'action_input_digest')
          if (safe.continuation) codec(safe.continuation, reference)
          fail(inputIdentity === undefined || inputIdentity === safe.inputDigest, 'action_input_changed')
          return safe
        }
        const lifecycle: Local.ProviderLifecycle = {
          ready: (call) => {
            fail(!closed, 'action_closed')
            return provider.ready(context(call, actionScope.scope))
          },
          health: (call) => {
            fail(!closed, 'action_closed')
            return provider.health(context(call, actionScope.scope, true))
          },
          drain: (deadline, call) => {
            fail(!closed, 'action_closed')
            return provider.drain(deadline, context(call, actionScope.scope, true, true))
          },
          async close(reason) {
            if (!closed) {
              closed = true
              childController.abort()
              try {
                await provider.close(reason)
              } finally {
                children.delete(owned)
                childDrains.delete(owned)
              }
            }
          },
        }
        function window(safe: Wire.ActionFrame, reconciling = false) {
          fail(!active.has(safe.invocationId), 'invocation_active')
          const actionKey = JSON.stringify([safe.runId, safe.actionId])
          fail(!activeActions.has(actionKey), 'action_active')
          inputIdentity = safe.inputDigest
          activeActions.add(actionKey)
          active.add(safe.invocationId)
          let open = true
          let finished = false
          let outstanding = 0
          const release = () => {
            if (!open && finished && outstanding === 0) {
              active.delete(safe.invocationId)
              activeActions.delete(actionKey)
            }
          }
          const invocationController = new AbortController()
          const invocationSignal = AbortSignal.any([
            childSignal,
            invocationController.signal,
            AbortSignal.timeout(
              Math.max(
                0,
                Math.min(
                  2_147_483_647,
                  Math.min(
                    reconciling ? Infinity : Date.parse(safe.actionTimebox.maxDeadline),
                    Date.parse(safe.context.deadline),
                  ) - Date.now(),
                ),
              ),
            ),
          ])
          const check = () => {
            if (childSignal.aborted || closed) throw problem('cancelled', 'cancelled')
            fail(open, 'invocation_closed')
            context({ ...safe.context, signal: childSignal }, actionScope.scope, true)
            if (!reconciling && Date.parse(safe.actionTimebox.maxDeadline) <= Date.now())
              throw problem('deadline_expired', 'timeout')
          }
          return {
            check,
            settled: () => outstanding === 0,
            signal: invocationSignal,
            finish: () => {
              finished = true
              release()
            },
            async track<T>(run: () => Promise<T>): Promise<T> {
              outstanding++
              try {
                return await trackEffect(run)
              } finally {
                outstanding--
                release()
              }
            },
            close: () => {
              open = false
              invocationController.abort()
              release()
            },
          }
        }
        function effects(
          call: Local.ActionContext,
          current: Local.CallContext,
          check: () => void,
          track: typeof trackEffect,
        ): Local.ActionContext {
          const guard = (supplied: Local.CallContext) => {
            check()
            if (current.signal.aborted) throw problem('cancelled', 'cancelled')
            const { signal: _signal, ...wire } = context(supplied, actionScope.scope, true)
            const { signal: _currentSignal, ...expected } = current
            fail(equal(wire, expected), 'effect_context_mismatch')
          }
          return {
            call: current,
            effects: {
              invoke: (request, supplied) => {
                guard(supplied)
                return track(() => call.effects.invoke(request, current))
              },
              stream: async (_request, supplied) => {
                guard(supplied)
                return { ok: false, error: problem('stream_requires_full_provider', 'incompatible') }
              },
              upload: (request, source, supplied) => {
                guard(supplied)
                return track(() => call.effects.upload(request, source, current))
              },
            },
            progress: (chunk) => {
              check()
              if (current.signal.aborted) throw problem('cancelled', 'cancelled')
              return track(() => call.progress(chunk))
            },
          }
        }
        function effect(result: Wire.EffectResult): Wire.EffectResult {
          const safe = checked('EffectResult', result)
          if (safe.outcome === 'succeeded') {
            fail(safe.result, 'result_required')
            payload(definition.contract, method, 'output', safe.result)
          }
          return safe
        }
        if (provider.kind === 'leaf') {
          owned = {
            ...lifecycle,
            kind: 'leaf',
            effectSemantics: provider.effectSemantics,
            ...(provider.executionUnit === undefined ? {} : { executionUnit: provider.executionUnit }),
            async execute(value, call) {
              const safe = frame(value)
              const current = context(call.call, actionScope.scope, true)
              const { signal: _signal, ...wire } = current
              fail(equal(wire, safe.context), 'action_context_mismatch')
              const invocation = window(safe)
              const actionSignal = AbortSignal.any([
                current.signal,
                invocation.signal,
                AbortSignal.timeout(
                  Math.max(
                    0,
                    Math.min(Date.parse(safe.actionTimebox.maxDeadline) - Date.now(), 2_147_483_647),
                  ),
                ),
              ])
              try {
                const result = effect(
                  await trackJob(
                    provider.execute(
                      safe,
                      effects(call, { ...current, signal: actionSignal }, invocation.check, invocation.track),
                    ),
                  ),
                )
                fail(result.outcome !== 'succeeded' || invocation.settled(), 'unsettled_effects')
                return result
              } finally {
                invocation.finish()
                invocation.close()
              }
            },
            async reconcile(value, evidence, call) {
              const safe = frame(value, true)
              const current = context(call.call, actionScope.scope, true)
              const { signal: _signal, ...wire } = current
              fail(equal(wire, safe.context), 'action_context_mismatch')
              for (const item of evidence) checked('DataRef', item)
              const invocation = window(safe, true)
              try {
                const result = checked(
                  'ReconcileResult',
                  await trackJob(
                    provider.reconcile(
                      safe,
                      copyJson(evidence),
                      effects(
                        call,
                        { ...current, signal: AbortSignal.any([current.signal, invocation.signal]) },
                        invocation.check,
                        invocation.track,
                      ),
                    ),
                  ),
                )
                if (result.kind === 'resolved') {
                  effect(result.result)
                  fail(result.result.outcome !== 'succeeded' || invocation.settled(), 'unsettled_effects')
                }
                return result
              } finally {
                invocation.finish()
                invocation.close()
              }
            },
          }
          children.delete(provider)
          children.add(owned)
          childDrains.set(owned, { scope: drainScope, drain: lifecycle.drain })
          return owned
        }
        const composite = provider
        async function transition(
          value: Wire.ActionFrame,
          ports: Local.LoopReadPorts,
          phase: 'start' | 'resume',
        ): Promise<Wire.ProviderTransition> {
          const safe = frame(value)
          fail(
            phase === 'start'
              ? safe.continuation === null && safe.providerRevision === 0
              : safe.continuation !== null && safe.providerRevision > 0,
            'action_phase_mismatch',
          )
          const invocation = window(safe)
          function read<T>(run: () => Promise<T>): Promise<T> {
            const pending = (async () => {
              invocation.check()
              const result = await invocation.track(run)
              invocation.check()
              return result
            })()
            // Observe detached author reads while retaining rejection for callers that await them.
            void pending.catch(() => {})
            return pending
          }
          const guarded: Local.LoopReadPorts = {
            query: (request) => read(() => ports.query(request)),
            compute: (request) => read(() => ports.compute(request)),
            resolveData: (ref) => read(() => ports.resolveData(ref)),
            prepare: (spec) => {
              invocation.check()
              return ports.prepare(spec)
            },
          }
          let result: Wire.ProviderTransition
          const pending = trackJob((async () => composite[phase](safe, guarded))())
          void pending.then(invocation.finish, invocation.finish)
          try {
            result = checked('ProviderTransition', await abortable(pending, invocation.signal))
            invocation.check()
            fail(invocation.settled(), 'unsettled_reads')
          } finally {
            invocation.close()
          }
          fail(result.expectedProviderRevision === safe.providerRevision, 'provider_revision_mismatch')
          codec(result.continuation, reference)
          if (result.next.kind === 'complete')
            payload(definition.contract, method, 'output', result.next.output)
          return result
        }
        owned = {
          ...lifecycle,
          kind: 'composite',
          start: (value, ports) => transition(value, ports, 'start'),
          resume: (value, ports) => transition(value, ports, 'resume'),
        }
        children.delete(provider)
        children.add(owned)
        childDrains.set(owned, { scope: drainScope, drain: lifecycle.drain })
        return owned
      },
    })
  }
  const wrapped: Record<string, unknown> = {}
  for (const name of names) {
    if (name === 'view' || name === 'expand') wrapped[name] = query(name, methods[name] as Local.QueryHandler)
    else if (name === 'plan') wrapped[name] = compute(name, methods[name] as Local.MethodHandler)
    else wrapped[name] = action(name, methods[name] as Local.ActionProviderFactory)
  }
  return {
    methods: Object.freeze(wrapped) as AlgorithmImplementationMap[K],
    async ready(call) {
      try {
        context(call, scope, true)
        fail(state === 'created' || state === 'ready', 'provider_draining')
        for (const requirement of definition.requires) {
          const result = environment.dependencies.get(requirement)
          if (!result.ok && !requirement.optional) throw result.error
        }
        state = 'ready'
        return { ok: true, value: undefined }
      } catch (error) {
        const result = validateRuntime('RuntimeError', error)
        return { ok: false, error: result.ok ? result.value : problem('ready_failed') }
      }
    },
    async health(call) {
      return pure(call, async () => ({ ok: true, value: { status: 'ready', diagnosticIds: [] } }))
    },
    async drain(deadline, call) {
      try {
        const safe = context(call, scope, true, true)
        checked('Timestamp', deadline)
        const stopAt = Math.min(Date.parse(deadline), Date.parse(safe.deadline))
        state = 'draining'
        controller.abort()
        const stopping = AbortSignal.any([
          safe.signal,
          AbortSignal.timeout(Math.max(0, Math.min(stopAt - Date.now(), 2_147_483_647))),
        ])
        const results: Wire.DrainResult[] = []
        const failures: Wire.RuntimeError[] = []
        let remaining = childDrains.size
        const controls = [...childDrains].map(async ([owner, child]) => {
          try {
            let issued = safe
            if (!equal(child.scope, safe.scope)) {
              if (!childDrainContext)
                throw {
                  ...problem('child_drain_context_required', 'denied'),
                  diagnosticId: 'author-child-drain-context-required',
                }
              issued = requireValue(
                await childDrainContext(copyJson(child.scope), { ...safe, signal: stopping }),
              )
            }
            fail(childDrains.get(owner) === child && state !== 'closed', 'child_drain_closed')
            fail(issued.signal instanceof AbortSignal, 'child_control_signal_invalid')
            const current = context(issued, child.scope, true, true)
            if (stopping.aborted)
              throw problem(
                stopping.reason?.name === 'TimeoutError' ? 'deadline_expired' : 'cancelled',
                stopping.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
              )
            if (Date.now() >= stopAt) throw problem('deadline_expired', 'timeout')
            const result = await child.drain(deadline, {
              ...current,
              signal: AbortSignal.any([current.signal, stopping]),
            })
            if (result.ok) results.push(checked('DrainResult', result.value))
            else failures.push(checked('RuntimeError', result.error))
          } catch (error) {
            const result = validateRuntime('RuntimeError', error)
            failures.push(result.ok ? result.value : problem('child_drain_failed', 'internal'))
          } finally {
            remaining--
          }
        })
        for (const control of controls) trackJob(control)
        const pending = (async () => {
          await Promise.allSettled(controls)
          while (jobs.size > 0) await Promise.allSettled([...jobs])
        })()
        try {
          if (stopAt > Date.now()) await abortable(pending, stopping)
        } catch (error) {
          if (call.signal.aborted) throw error
        }
        if (call.signal.aborted) throw problem('cancelled', 'cancelled')
        const activeInvocationIds = [
          ...new Set([...active, ...results.flatMap((result) => result.activeInvocationIds)]),
        ]
        const durableOwnerRefs = results.flatMap((result) => result.durableOwnerRefs)
        const blocked =
          remaining > 0 ||
          jobs.size > 0 ||
          pendingCreations.size > 0 ||
          pendingCalls > 0 ||
          activeInvocationIds.length > 0 ||
          durableOwnerRefs.length > 0 ||
          failures.length > 0 ||
          results.some((result) => result.state === 'blocked')
        return {
          ok: true,
          value: {
            state: blocked ? 'blocked' : 'drained',
            activeInvocationIds,
            durableOwnerRefs,
            diagnosticIds: [
              ...results.flatMap((result) => result.diagnosticIds),
              ...failures.map((error) => error.diagnosticId),
            ],
          },
        }
      } catch (error) {
        const result = validateRuntime('RuntimeError', error)
        return { ok: false, error: result.ok ? result.value : problem('drain_failed', 'internal') }
      }
    },
    async close(reason) {
      if (state === 'closed') return
      state = 'closed'
      controller.abort()
      const results = await Promise.allSettled([...children].map((child) => child.close(reason)))
      children.clear()
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
  }
}

export function createContextAuthorMethods<C>(
  definition: Definition<'agh.context', C>,
  environment: AlgorithmAuthorEnvironment,
): Promise<AlgorithmAuthorMethods<'agh.context'>> {
  return createAlgorithmAuthorMethods(definition, environment)
}
