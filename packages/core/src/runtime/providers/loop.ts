import type {
  CallContext,
  FactoryContext,
  LoopProvider,
  LoopReadPorts,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  checkedContent,
  checkedLoopDescriptor,
  checkPolicy,
  defaultLoopContracts as contracts,
  type DefaultLoopSource,
  type DefaultLoopDependencies as Dependencies,
  leafDeadline,
  modelTool,
  planDefaultModel,
  standardContentSchema,
} from '../loop/default-plan.js'
import {
  canonical,
  checkedPrepare,
  DefaultLoopFault,
  type DefaultLoopState,
  decode,
  encode,
  equal,
  freezeLoopValue as freeze,
  initialState,
  insist,
  readState,
  stateEnvelope,
  unwrap,
  waitForLoopAction as wait,
} from '../loop/default-state.js'

export type { DefaultLoopInputs, DefaultLoopSource } from '../loop/default-plan.js'

function fault(value: unknown): W.RuntimeError {
  return value instanceof DefaultLoopFault
    ? value.error
    : new DefaultLoopFault('loop_dependency_unavailable', 'internal').error
}
/** Narrow text-only default slice. Optional legacy/quality/Hook combinations are explicitly unsupported. */
export function createDefaultLoopFactory(
  descriptor: W.ProviderDescriptor,
  source?: DefaultLoopSource,
): ProviderFactory<LoopProvider> {
  const fixed = checkedLoopDescriptor(descriptor)
  return {
    descriptor: fixed,
    async create(config: W.DataRef, dependencies: ScopedDependencies, factory: FactoryContext) {
      insist(
        validateRuntime('ScopeRef', factory.scope).ok &&
          factory.scope.kind === 'run' &&
          !factory.signal.aborted,
        'loop_scope_invalid',
      )
      insist(
        validateRuntime('DataRef', config).ok &&
          config.kind === 'inline' &&
          equal(config.schema, fixed.configSchema),
        'loop_config_invalid',
      )
      const body = canonical(config.value)
      insist(
        body.bytes === config.bytes &&
          canonicalJsonDigest(body.json) === config.digest &&
          equal(body.json, {}),
        'loop_config_invalid',
      )
      const bindingId = factory.bindingId
      const scope = structuredClone(factory.scope)
      freeze(scope)
      const binding: W.BindingRef = {
        contract: 'agh.loop',
        logicalName: fixed.logicalName,
        providerId: fixed.providerId,
        bindingId: bindingId,
      }
      const stop = new AbortController(),
        signal = AbortSignal.any([factory.signal, stop.signal]),
        active = new Map<string, number>()
      const pendingReads = new Set<Promise<unknown>>()
      let accepting = false
      let selected: Dependencies | null = null
      function context(frame: W.RunFrame): CallContext {
        const wire = structuredClone(frame.context)
        freeze(wire)
        return Object.freeze({ ...wire, signal })
      }
      async function current(ctx: CallContext): Promise<void> {
        const { signal: callSignal, ...wire } = ctx
        insist(
          validateRuntime('CallContextWire', canonical(wire).json).ok &&
            equal(ctx.scope, scope) &&
            ctx.bindingId === bindingId,
          'loop_context_identity',
          'denied',
        )
        insist(!signal.aborted && !callSignal.aborted, 'loop_cancelled', 'cancelled')
        insist(Date.parse(ctx.deadline) > Date.now(), 'loop_invocation_expired', 'timeout')
        insist(source, 'loop_source_unavailable', 'incompatible')
        const captured = structuredClone(wire)
        freeze(captured)
        const nativeContext = Object.freeze({ ...captured, signal: callSignal })
        await raced(source.checkCurrent(nativeContext), nativeContext)
        insist(!signal.aborted && !callSignal.aborted, 'loop_cancelled', 'cancelled')
        insist(Date.parse(ctx.deadline) > Date.now(), 'loop_invocation_expired', 'timeout')
      }
      async function raced<T>(operation: Promise<Outcome<T>>, ctx: CallContext): Promise<T> {
        let cancel = () => {}
        const combined = AbortSignal.any([signal, ctx.signal])
        pendingReads.add(operation)
        void operation.then(
          () => pendingReads.delete(operation),
          () => pendingReads.delete(operation),
        )
        let timer: ReturnType<typeof setTimeout> | undefined
        const cancelled = new Promise<Outcome<never>>((resolve) => {
          cancel = () =>
            resolve({ ok: false, error: new DefaultLoopFault('loop_cancelled', 'cancelled').error })
          if (combined.aborted) cancel()
          else combined.addEventListener('abort', cancel, { once: true })
          timer = setTimeout(
            () =>
              resolve({ ok: false, error: new DefaultLoopFault('loop_invocation_expired', 'timeout').error }),
            Math.min(2_147_483_647, Math.max(0, Date.parse(ctx.deadline) - Date.now())),
          )
        })
        try {
          return unwrap(await Promise.race([operation, cancelled]))
        } finally {
          combined.removeEventListener('abort', cancel)
          clearTimeout(timer)
        }
      }
      async function read(
        ref: W.DataRef,
        schema: W.SchemaRef,
        ports: LoopReadPorts,
        ctx: CallContext,
      ): Promise<W.JsonValue> {
        await current(ctx)
        const value = await decode(ref, schema, {
          ...ports,
          resolveData: (data) =>
            raced(ports.resolveData(data), ctx).then((result) => ({ ok: true, value: result })),
        })
        await current(ctx)
        return value
      }
      async function compute(
        contract: keyof Dependencies,
        method: string,
        input: unknown,
        ports: LoopReadPorts,
        ctx: CallContext,
      ): Promise<W.JsonValue> {
        insist(selected, 'loop_not_ready', 'incompatible')
        const schema = (
          RuntimeMethodSchemaRefs[contracts[contract]] as Record<
            string,
            { input: W.SchemaRef; output: W.SchemaRef }
          >
        )[method]
        insist(
          schema && RuntimeServiceCatalog[contracts[contract]].methods[method as never],
          'loop_method_unavailable',
          'incompatible',
        )
        await current(ctx)
        const ref = await raced(
          ports.compute({ target: selected[contract], method, input: encode(schema.input, input) }),
          ctx,
        )
        await current(ctx)
        return read(ref, schema.output, ports, ctx)
      }
      function transition(
        frame: W.RunFrame,
        state: DefaultLoopState,
        next: W.NextStep,
        actions: W.PreparedAction[] = [],
        conversation: W.ConversationContribution[] = [],
      ): W.LoopTransition {
        return {
          expectedRevision: frame.revision,
          continuation: stateEnvelope(state, frame, binding),
          consumeSignals: [],
          actions,
          next,
          conversation,
        }
      }
      async function modelAction(
        frame: W.RunFrame,
        state: DefaultLoopState,
        stage: 'first-model' | 'second-model',
        ports: LoopReadPorts,
        ctx: CallContext,
      ): Promise<W.LoopTransition> {
        return planDefaultModel(frame, state, stage, ports, ctx, {
          source,
          selected,
          current,
          raced,
          read,
          compute,
          transition,
          wait,
        })
      }
      async function step(
        original: W.RunFrame,
        ports: LoopReadPorts,
        resumed: boolean,
      ): Promise<W.LoopTransition> {
        const frame = structuredClone(original),
          ctx = context(frame)
        let state = initialState(frame)
        try {
          insist(
            validateRuntime('RunFrame', canonical(frame).json).ok &&
              frame.bindingId === bindingId &&
              frame.runId === scope.runId &&
              frame.sessionId === scope.sessionId &&
              frame.workspaceId === scope.workspaceId &&
              ctx.invocationId === frame.invocationId,
            'loop_frame_identity',
            'denied',
          )
          insist(accepting && selected, 'loop_not_ready', 'incompatible')
          await current(ctx)
          insist(frame.reason !== 'cancel', 'loop_cancelled', 'cancelled')
          insist(frame.conversation === null, 'loop_conversation_codec_unavailable', 'incompatible')
          if (!resumed) {
            insist(
              frame.continuation === null && frame.revision === 0 && frame.reason === 'start',
              'loop_start_identity',
              'conflict',
            )
            return await modelAction(frame, state, 'first-model', ports, ctx)
          }
          insist(frame.revision > 0 && frame.reason !== 'start', 'loop_resume_identity', 'conflict')
          insist(
            frame.continuation && equal(frame.continuation.provenance.producer, binding),
            'loop_state_producer',
            'denied',
          )
          state = await readState(frame, {
            ...ports,
            resolveData: async (ref) => {
              await current(ctx)
              const value = await raced(ports.resolveData(ref), ctx)
              await current(ctx)
              return { ok: true, value }
            },
          })
          insist(state.pending && state.phase !== 'terminal', 'loop_already_terminal', 'conflict')
          const expectedTarget = state.phase === 'tool' ? selected.tools : selected.model
          insist(
            state.pending.key === state.phase &&
              equal(state.pending.target, expectedTarget) &&
              state.pending.method === (state.phase === 'tool' ? 'invoke' : 'infer'),
            'loop_pending_identity',
            'denied',
          )
          const { intentFingerprint: _fingerprint, ...savedSpec } = state.pending
          insist(
            equal(checkedPrepare(ports, savedSpec), state.pending),
            'loop_pending_fingerprint',
            'conflict',
          )
          await current(ctx)
          const pending = state.pending,
            refs = RuntimeMethodSchemaRefs['agh.supervisor'].actionReceipt
          const reply = await raced(
            ports.query({
              target: selected.supervisor,
              method: 'actionReceipt',
              input: encode(refs.input, { action: { localKey: pending.key } }),
            }),
            ctx,
          )
          insist(reply.kind === 'value', 'loop_receipt_unavailable', 'incompatible')
          const result = validateRuntime(
            'SupervisorActionReceiptResult',
            await read(reply.output, refs.output, ports, ctx),
          )
          insist(result.ok, 'loop_receipt_invalid')
          if (result.value.visibility !== 'ready') {
            insist(
              result.value.receipt === null && result.value.actionId !== null,
              'loop_pending_receipt_invalid',
              'conflict',
            )
            return transition(frame, state, wait(pending))
          }
          const receipt = result.value.receipt
          insist(
            receipt &&
              receipt.visibility === 'ready' &&
              result.value.actionId === receipt.actionId &&
              receipt.bindingId === pending.target.bindingId &&
              receipt.inputDigest ===
                (pending.input.kind === 'inline' ? pending.input.digest : pending.input.blob.digest),
            'loop_receipt_identity',
            'denied',
          )
          if (receipt.outcome === 'unknown_effect') return transition(frame, state, wait(pending, true))
          if (receipt.outcome !== 'succeeded')
            throw new DefaultLoopFault(
              receipt.error?.detailCode ?? 'loop_action_failed',
              receipt.outcome === 'cancelled' ? 'cancelled' : (receipt.error?.code ?? 'internal'),
            )
          insist(receipt.result, 'loop_result_missing')
          if (state.phase === 'tool') {
            const tool = validateRuntime(
              'ToolModelResult',
              await read(receipt.result, RuntimeSchemaRefs.ToolModelResult, ports, ctx),
            )
            insist(
              tool.ok && !tool.value.isError && !tool.value.terminate && !tool.value.deferred,
              'loop_tool_result_unsupported',
              'incompatible',
            )
            return await modelAction(frame, state, 'second-model', ports, ctx)
          }
          const output = validateRuntime(
            'ModelOutput',
            await read(receipt.result, RuntimeMethodSchemaRefs['agh.model'].infer.output, ports, ctx),
          )
          insist(output.ok, 'loop_model_output_invalid')
          const content = checkedContent(
            await read(output.value.outputRef, standardContentSchema, ports, ctx),
          )
          if (state.phase === 'second-model') {
            insist(output.value.finishReason === 'stop', 'loop_final_output_incomplete', 'incompatible')
            const structured = content.structured
            insist(
              !structured ||
                typeof structured !== 'object' ||
                Array.isArray(structured) ||
                !('toolCalls' in structured) ||
                (Array.isArray(structured.toolCalls) && structured.toolCalls.length === 0),
              'loop_extra_tool_call',
              'incompatible',
            )
            await current(ctx)
            return transition(
              frame,
              { ...state, phase: 'terminal', pending: null },
              { kind: 'complete', output: output.value.outputRef, references: receipt.references },
            )
          }
          insist(output.value.finishReason === 'tool-calls', 'loop_tool_call_missing', 'incompatible')
          const originalRequest = validateRuntime(
            'ModelInferRequest',
            await read(pending.input, RuntimeMethodSchemaRefs['agh.model'].infer.input, ports, ctx),
          )
          insist(originalRequest.ok, 'loop_model_context_invalid')
          const modelContext = validateRuntime(
            'PreparedModelRequest',
            await read(originalRequest.value.preparedRef, RuntimeSchemaRefs.PreparedModelRequest, ports, ctx),
          )
          insist(
            modelContext.ok &&
              equal(modelContext.value.ownerBinding, selected.model) &&
              modelContext.value.toolCatalog,
            'loop_model_context_invalid',
            'denied',
          )
          const tool = modelTool(content, modelContext.value.toolCatalog.tools)
          const policy = validateRuntime(
            'ToolPolicySnapshot',
            await compute('tools', 'classify', tool, ports, ctx),
          )
          insist(policy.ok, 'loop_policy_invalid')
          checkPolicy(tool.definition, tool.input, policy.value)
          await current(ctx)
          const action = checkedPrepare(ports, {
            key: 'tool',
            target: selected.tools,
            method: 'invoke',
            input: encode(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, {
              ...tool,
              expectedDefinitionDigest: canonicalJsonDigest(tool.definition),
              policy: policy.value,
              batchRef: null,
              modelContextRef: originalRequest.value.preparedRef,
            }),
            dependencies: [],
            retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
            obligation: 'mandatory',
            deadline: leafDeadline(frame),
            resultSchema: RuntimeSchemaRefs.ToolResult,
            references: receipt.references,
          })
          return transition(frame, { ...state, phase: 'tool', pending: action }, wait(action), [action])
        } catch (error) {
          return transition(frame, state, { kind: 'fail', error: fault(error) })
        }
      }
      async function evaluate(frame: W.RunFrame, ports: LoopReadPorts, resumed: boolean) {
        const invocationId = frame.invocationId
        active.set(invocationId, (active.get(invocationId) ?? 0) + 1)
        try {
          return await step(frame, ports, resumed)
        } finally {
          const remaining = (active.get(invocationId) ?? 1) - 1
          if (remaining) active.set(invocationId, remaining)
          else active.delete(invocationId)
        }
      }
      return {
        async ready(ctx) {
          try {
            await current(ctx)
            const resolved = {} as Dependencies
            for (const [name, contract] of Object.entries(contracts)) {
              const requires = fixed.requires.filter(
                (entry) => entry.contract === contract && !entry.optional,
              )
              insist(requires.length === 1 && requires[0], 'loop_dependency_missing', 'incompatible')
              const bound = unwrap(dependencies.get(requires[0])).binding
              insist(
                bound.contract === contract &&
                  bound.logicalName === requires[0].logicalName &&
                  validateRuntime('BindingRef', bound).ok,
                'loop_dependency_binding',
                'denied',
              )
              resolved[name as keyof Dependencies] = structuredClone(bound)
            }
            selected = resolved
            accepting = true
            return { ok: true, value: undefined }
          } catch (error) {
            return { ok: false, error: fault(error) }
          }
        },
        async health(ctx) {
          try {
            await current(ctx)
            return { ok: true, value: { status: accepting ? 'ready' : 'degraded', diagnosticIds: [] } }
          } catch (error) {
            return { ok: false, error: fault(error) }
          }
        },
        async drain(_deadline, ctx) {
          try {
            const { signal: _callSignal, ...wire } = ctx
            insist(
              validateRuntime('CallContextWire', canonical(wire).json).ok &&
                equal(ctx.scope, scope) &&
                ctx.bindingId === bindingId,
              'loop_context_identity',
              'denied',
            )
            accepting = false
            stop.abort()
            return {
              ok: true,
              value: {
                state: active.size || pendingReads.size ? 'blocked' : 'drained',
                activeInvocationIds: [...active.keys()],
                durableOwnerRefs: [],
                diagnosticIds: pendingReads.size ? ['loop_read_inflight'] : [],
              },
            }
          } catch (error) {
            return { ok: false, error: fault(error) }
          }
        },
        async close() {
          accepting = false
          stop.abort()
        },
        start: (frame, ports) => evaluate(frame, ports, false),
        resume: (frame, ports) => evaluate(frame, ports, true),
      }
    },
  }
}
