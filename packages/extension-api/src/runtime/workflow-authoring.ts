import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type AuthorSchema,
  type DurableWorkflowDefinition,
  defineDurableWorkflow,
  type WorkflowPorts,
} from './authoring.js'
import { assertAuthorSchema } from './authoring-schemas.js'
import { copyJson } from './authoring-validation.js'
import type {
  ActionFrame,
  ActionHandlerScope,
  ActionProviderFactory,
  BindingRef,
  CallContext,
  CompositeActionProvider,
  DataRef,
  Digest,
  JsonValue,
  LoopReadPorts,
  Outcome,
  Provenance,
  ProviderTransition,
  RuntimeError,
  ScopedDependencies,
  StateCodecRef,
} from './public-api.js'

/** Trusted assembly supplies existing source evidence for this fixed input. This is not an authorization port. */
export interface WorkflowAuthorBinding {
  readonly packageId: string
  readonly binding: BindingRef
  readonly inputDigest: Digest
  readonly provenance: Provenance
  readonly dependencies: ScopedDependencies
  readonly config?: DataRef
}

class WorkflowAuthorError extends Error {
  readonly runtimeError: RuntimeError
  constructor(detailCode: string, code: RuntimeError['code'] = 'invalid_input') {
    super(`Workflow author call refused: ${detailCode}`)
    this.runtimeError = {
      code,
      detailCode,
      message: this.message,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'workflow-author',
    }
  }
}
function requireValue<T>(result: Outcome<T>): T {
  if (!result.ok) throw new WorkflowAuthorError(result.error.detailCode, result.error.code)
  return result.value
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJsonDigest(left as JsonValue) === canonicalJsonDigest(right as JsonValue)
}
function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new WorkflowAuthorError(detail)
}
function refused(error: unknown): Outcome<never> {
  return {
    ok: false,
    error:
      error instanceof WorkflowAuthorError
        ? error.runtimeError
        : new WorkflowAuthorError('author_failure', 'internal').runtimeError,
  }
}
async function decode<T>(schema: AuthorSchema<T>, ref: DataRef, ports?: LoopReadPorts): Promise<T> {
  check(validateRuntime('DataRef', ref).ok && same(ref.schema, schema.ref), 'schema_mismatch')
  const value =
    ref.kind === 'inline'
      ? ref.value
      : requireValue(
          await (ports?.resolveData(ref) ??
            Promise.resolve(refused(new WorkflowAuthorError('data_not_resolved')))),
        )
  const limits = RuntimeAuthorCodecPolicy.payload
  const canonical = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  check(canonical.ok, 'invalid_data')
  const identity = ref.kind === 'inline' ? ref : ref.blob
  check(
    canonicalJsonDigest(canonical.value.json) === identity.digest && canonical.value.bytes === identity.bytes,
    'data_integrity',
  )
  return requireValue(schema.parse(canonical.value.json))
}

/** Internal assembly entry. Public exports and descriptor generation are owned by the runtime generator. */
export function createWorkflowAuthorAdapter<I, S, O, C>(
  inputDefinition: DurableWorkflowDefinition<I, S, O, C>,
  inputBinding: WorkflowAuthorBinding,
): Omit<ActionProviderFactory, 'create'> & {
  create(scope: ActionHandlerScope): Promise<CompositeActionProvider>
} {
  const definition = defineDurableWorkflow(inputDefinition)
  const { dependencies } = inputBinding
  const binding = copyJson(inputBinding.binding)
  const provenance = copyJson(inputBinding.provenance)
  const inputDigest = inputBinding.inputDigest
  check(
    validateRuntime('BindingRef', binding).ok && validateRuntime('Provenance', provenance).ok,
    'invalid_binding',
  )
  check(binding.providerId === `${inputBinding.packageId}/contribution/${definition.id}`, 'provider_identity')
  check(same(provenance.producer, binding) && provenance.sourceRefs.length > 0, 'missing_source')
  check(validateRuntime('Digest', inputDigest).ok, 'invalid_input_digest')
  const stateCodec: StateCodecRef = copyJson({
    namespace: `${inputBinding.packageId}/${definition.id}`,
    codecVersion: definition.state.codecVersion,
    schema: definition.state.schema.ref,
  })
  check(validateRuntime('StateCodecRef', stateCodec).ok, 'invalid_codec')
  const configRef = inputBinding.config === undefined ? undefined : copyJson(inputBinding.config)

  return {
    kind: 'composite',
    recovery: 'R1',
    stateCodec,
    async create(inputScope) {
      check(validateRuntime('ScopeRef', inputScope.scope).ok, 'invalid_scope')
      check(
        (inputScope.scope.kind !== 'action' || inputScope.scope.actionId === inputScope.actionId) &&
          (!('runId' in inputScope.scope) || inputScope.scope.runId === inputScope.runId) &&
          inputScope.bindingId === binding.bindingId,
        'scope_mismatch',
      )
      const scope = { ...inputScope, scope: copyJson(inputScope.scope) }
      const stop = new AbortController()
      const signal = AbortSignal.any([scope.signal, stop.signal])
      let accepting = false
      let closing = false
      const active = new Map<string, Promise<unknown>>()
      if (definition.config === undefined) check(configRef === undefined, 'unexpected_config')
      const config =
        definition.config === undefined
          ? (Object.freeze({}) as Readonly<C>)
          : configRef === undefined
            ? definition.config.defaults
            : await decode(definition.config.schema, configRef)

      function validateContext(context: CallContext) {
        const { signal: callSignal, ...wire } = context
        check(validateRuntime('CallContextWire', wire).ok, 'invalid_context')
        check(context.bindingId === scope.bindingId && same(context.scope, scope.scope), 'context_mismatch')
        if (callSignal.aborted || Date.parse(context.deadline) <= Date.now())
          throw new WorkflowAuthorError('call_cancelled', 'cancelled')
      }
      function current() {
        if (!accepting || closing || signal.aborted) throw new WorkflowAuthorError('call_closed', 'cancelled')
      }
      function typedPorts(
        ports: LoopReadPorts,
        ensureActive: () => void,
        gate: { open: boolean; reads: Set<Promise<unknown>> },
      ): WorkflowPorts {
        function usable() {
          check(gate.open, 'invocation_closed')
          ensureActive()
        }
        function read<T>(invoke: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
          const pending = (async () => {
            usable()
            const value = await invoke()
            usable()
            return value
          })()
          gate.reads.add(pending)
          void pending.then(
            () => gate.reads.delete(pending),
            () => gate.reads.delete(pending),
          )
          return pending
        }
        return {
          query: (request) => read(() => ports.query(request)),
          compute: (request) => read(() => ports.compute(request)),
          resolveData: (ref) => read(() => ports.resolveData(ref)),
          prepare(spec) {
            try {
              usable()
              return ports.prepare(spec)
            } catch (error) {
              return refused(error)
            }
          },
          prepareTyped(request) {
            try {
              usable()
              const { operation, input, ...rest } = request
              assertAuthorSchema(operation.input)
              assertAuthorSchema(operation.output)
              const catalogs = RuntimeServiceCatalog as Readonly<
                Record<string, { methods: Readonly<Record<string, { kind?: string }>> }>
              >
              const schemas = RuntimeMethodSchemaRefs as Readonly<
                Record<string, Readonly<Record<string, { input: unknown; output: unknown }>>>
              >
              const method = schemas[operation.contract]?.[operation.method]
              check(
                catalogs[operation.contract]?.methods[operation.method]?.kind === 'action' &&
                  method !== undefined,
                'unknown_typed_operation',
              )
              check(
                same(operation.input.ref, method.input) && same(operation.output.ref, method.output),
                'operation_schema_mismatch',
              )
              const declared = definition.requires.filter(
                (requirement) =>
                  requirement.contract === operation.contract &&
                  requirement.logicalName === operation.logicalName,
              )
              const requirement = declared[0]
              check(declared.length === 1 && requirement !== undefined, 'undeclared_operation')
              const target = requireValue(dependencies.get(requirement)).binding
              check(
                target.contract === operation.contract && target.logicalName === operation.logicalName,
                'operation_binding_mismatch',
              )
              return ports.prepare({
                ...copyJson(rest),
                dependencies: [...rest.dependencies],
                references: [...rest.references],
                target,
                method: operation.method,
                input: requireValue(operation.input.encode(input)),
                resultSchema: operation.output.ref,
              })
            } catch (error) {
              return refused(error)
            }
          },
        }
      }
      async function execute(
        phase: 'start' | 'resume',
        inputFrame: ActionFrame,
        ports: LoopReadPorts,
      ): Promise<ProviderTransition> {
        current()
        check(validateRuntime('ActionFrame', inputFrame).ok, 'invalid_frame')
        const frame = copyJson(inputFrame)
        check(
          frame.actionId === scope.actionId &&
            frame.runId === scope.runId &&
            frame.bindingId === scope.bindingId &&
            frame.invocationId === frame.context.invocationId,
          'frame_binding_mismatch',
        )
        validateContext({ ...frame.context, signal })
        check(frame.attemptNumber === 1 && frame.requestIdentity === null, 'invalid_composite_attempt')
        check(
          frame.inputDigest === inputDigest &&
            (frame.input.kind === 'inline' ? frame.input.digest : frame.input.blob.digest) === inputDigest,
          'input_changed',
        )
        check(
          phase === 'start'
            ? frame.continuation === null && frame.providerRevision === 0
            : frame.continuation !== null && frame.providerRevision > 0,
          'invalid_phase',
        )
        check(!active.has(frame.invocationId) && active.size === 0, 'call_in_flight')
        const timeout = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = Math.min(
          Date.parse(frame.context.deadline),
          Date.parse(frame.actionTimebox.maxDeadline),
        )
        const arm = () => {
          const left = deadline - Date.now()
          if (left <= 0) timeout.abort()
          else timer = setTimeout(arm, Math.min(left, 2147483647))
        }
        arm()
        const callSignal = AbortSignal.any([signal, timeout.signal])
        const ensureActive = () => {
          current()
          if (Date.now() >= deadline) timeout.abort()
          if (callSignal.aborted) throw new WorkflowAuthorError('call_cancelled', 'cancelled')
        }
        const gate = { open: true, reads: new Set<Promise<unknown>>() }
        const wrappedPorts = typedPorts(ports, ensureActive, gate)
        const operation = (async () => {
          const input = await decode(definition.input, frame.input, wrappedPorts)
          let state: S | null = null
          if (frame.continuation !== null) {
            const saved = frame.continuation
            check(
              saved.namespace === stateCodec.namespace && saved.codecVersion === stateCodec.codecVersion,
              'codec_mismatch',
            )
            check(
              same(saved.provenance.producer, binding) && saved.provenance.sourceRefs.length > 0,
              'state_source_mismatch',
            )
            state = await decode(definition.state.schema, saved.data, wrappedPorts)
          }
          ensureActive()
          const { input: _input, continuation: _continuation, ...runtime } = frame
          const result = await definition[phase]({ input, state, runtime }, wrappedPorts, {
            signal: callSignal,
            config,
          })
          ensureActive()
          check(gate.reads.size === 0, 'unsettled_reads')
          gate.open = false
          const savedProvenance = frame.continuation?.provenance
          const stateProvenance =
            savedProvenance === undefined
              ? provenance
              : {
                  producer: binding,
                  sourceRefs: [...new Set([...savedProvenance.sourceRefs, ...provenance.sourceRefs])],
                  trustLabels: [...new Set([...savedProvenance.trustLabels, ...provenance.trustLabels])],
                }
          const transition: ProviderTransition = copyJson({
            expectedProviderRevision: frame.providerRevision,
            continuation: {
              namespace: stateCodec.namespace,
              codecVersion: stateCodec.codecVersion,
              data: requireValue(definition.state.schema.encode(result.state)),
              provenance: stateProvenance,
              createdAt: frame.observedAt,
              references: [...result.references],
            },
            consumeSignals: [...(result.consumeSignals ?? [])],
            children: [...(result.children ?? [])],
            next: result.next,
          })
          check(validateRuntime('ProviderTransition', transition).ok, 'invalid_transition')
          const visibleSignals = new Set(frame.signals.items.map((item) => item.signalId))
          check(
            transition.consumeSignals.every((id) => visibleSignals.has(id)),
            'unknown_signal',
          )
          check(
            new Set(transition.children.map((child) => child.key)).size === transition.children.length,
            'duplicate_child_key',
          )
          if (transition.next.kind === 'complete')
            await decode(definition.output, transition.next.output, ports)
          ensureActive()
          return transition
        })()
        const settled = operation.then(
          async () => {
            gate.open = false
            await Promise.allSettled([...gate.reads])
          },
          async () => {
            gate.open = false
            await Promise.allSettled([...gate.reads])
          },
        )
        const tracked = settled.then(() => {
          if (timer !== undefined) clearTimeout(timer)
          active.delete(frame.invocationId)
        })
        active.set(frame.invocationId, tracked)
        let onAbort: () => void = () => undefined
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            gate.open = false
            reject(new WorkflowAuthorError('call_cancelled', 'cancelled'))
          }
          if (callSignal.aborted) onAbort()
          else callSignal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          return await Promise.race([operation, aborted])
        } catch (error) {
          if (Date.now() >= deadline) timeout.abort()
          if (callSignal.aborted) throw new WorkflowAuthorError('call_cancelled', 'cancelled')
          throw error instanceof WorkflowAuthorError
            ? error
            : new WorkflowAuthorError('author_failure', 'internal')
        } finally {
          gate.open = false
          callSignal.removeEventListener('abort', onAbort)
        }
      }
      return {
        kind: 'composite',
        async ready(context) {
          try {
            validateContext(context)
            if (closing || signal.aborted) throw new WorkflowAuthorError('instance_closed', 'cancelled')
            for (const requirement of definition.requires) {
              const dependency = dependencies.get(requirement)
              if (!requirement.optional) requireValue(dependency)
            }
            accepting = true
            return { ok: true, value: undefined }
          } catch (error) {
            return refused(error)
          }
        },
        async health(context) {
          try {
            validateContext(context)
            return {
              ok: true,
              value: { status: accepting && !signal.aborted ? 'ready' : 'failed', diagnosticIds: [] },
            }
          } catch (error) {
            return refused(error)
          }
        },
        async drain(deadline, context) {
          try {
            validateContext(context)
            check(validateRuntime('Timestamp', deadline).ok, 'invalid_deadline')
            accepting = false
            closing = true
            stop.abort()
            const left = Math.min(Date.parse(deadline), Date.parse(context.deadline)) - Date.now()
            if (active.size > 0 && left > 0) {
              let timer: ReturnType<typeof setTimeout> | undefined
              let onAbort: () => void = () => undefined
              try {
                await Promise.race([
                  Promise.allSettled([...active.values()]),
                  new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, Math.min(left, 2147483647))
                  }),
                  new Promise<void>((resolve) => {
                    onAbort = resolve
                    if (context.signal.aborted) resolve()
                    else context.signal.addEventListener('abort', onAbort, { once: true })
                  }),
                ])
              } finally {
                if (timer !== undefined) clearTimeout(timer)
                context.signal.removeEventListener('abort', onAbort)
              }
            }
            validateContext(context)
            return {
              ok: true,
              value: {
                state: active.size === 0 ? 'drained' : 'blocked',
                activeInvocationIds: [...active.keys()],
                durableOwnerRefs: [],
                diagnosticIds: [],
              },
            }
          } catch (error) {
            return refused(error)
          }
        },
        async close() {
          accepting = false
          closing = true
          stop.abort()
        },
        start: (frame, ports) => execute('start', frame, ports),
        resume: (frame, ports) => execute('resume', frame, ports),
      }
    },
  }
}
