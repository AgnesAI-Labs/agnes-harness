import type { HostRuntimeLoopInstallation, HostRuntimeLoopRun } from '@agnes/host'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { openToolsFixture, toolsRef } from '../../../core/test/runtime/tools-fixture.js'
import { createPureToolAuthorAdapter } from '../../../extension-api/src/runtime/tool-authoring.js'
import { contextFixtureData } from '../../../extension-api/testkit/runtime/contracts/context.js'
import type { LoopContractFixture } from '../../../extension-api/testkit/runtime/contracts/loop.js'
import { admissionRequest } from './runtime-admission-owner.js'

function required<T>(value: T | undefined | null): T {
  if (value == null) throw Error('Restricted owner fixture value missing')
  return value
}
const data = contextFixtureData()
export const loopAdmissionRequest: W.RunAdmission = {
  ...admissionRequest,
  runId: 'r',
  sessionId: 's',
  workspaceId: 'w',
  input: required(data.source.items[0]).body,
}
const ok = <T>(value: T) => ({ ok: true as const, value })
const failed = (detailCode: string) => ({
  ok: false as const,
  error: {
    code: 'incompatible' as const,
    detailCode,
    message: 'Restricted owner unavailable',
    diagnosticId: 'loop-owner-fixture',
    retryAdvice: { kind: 'never' as const },
  },
})

/** Restricted in-memory State/Model/Supervisor peers. No production identity, persistence or model proof. */
export async function loopOwnerFixture(
  mode = 'tools-source',
  observe: (event: Record<string, unknown>) => void = () => {},
) {
  const kind = mode.endsWith('-reference') ? 'reference' : 'default'
  mode = mode.replace(/-(default|reference)$/, '')
  const module = (await import(
    new URL('../../../../tools/acceptance/runtime/platform/loop-conformance.ts', import.meta.url).href
  )) as {
    openLoopFixture(): Promise<
      LoopContractFixture & {
        bindings: Record<string, W.BindingRef>
        receipts: Map<string, W.ActionResultView>
      }
    >
  }
  const f = await module.openLoopFixture()
  const t = await openToolsFixture(kind)
  const requests = new Map<string, W.ServiceOperation>()
  const probe = await f.factory.create(f.config, f.dependencies, f.factoryContext)
  await probe.ready(f.context)
  await probe.start(f.frame, {
    ...f.ports,
    compute: async (request) => {
      requests.set(request.method, request)
      return f.ports.compute(request)
    },
    query: async (request) => {
      requests.set(request.method, request)
      return f.ports.query(request)
    },
  })
  await probe.close('shutdown')
  function body<K extends keyof W.RuntimeWireTypes>(method: string, schema: K): W.RuntimeWireTypes[K] {
    const request = requests.get(method)
    if (request?.input.kind !== 'inline') throw Error('fixture capture missing')
    const checked = validateRuntime(schema, request.input.value)
    if (!checked.ok) throw Error('fixture capture invalid')
    return checked.value
  }
  const catalog = body('catalog', 'ToolsCatalogRequest')
  const model = body('prepare', 'ModelPrepareRequest')
  const inputs: Extract<
    Awaited<ReturnType<HostRuntimeLoopInstallation['loop']['source']['readInputs']>>,
    { ok: true }
  >['value'] = {
    snapshot: f.frame.snapshot,
    inputDigest: f.frame.input.kind === 'inline' ? f.frame.input.digest : f.frame.input.blob.digest,
    sessionParameterRef: f.frame.sessionParameters.reference,
    context: body('view', 'ContextViewRequest'),
    routing: body('select', 'RoutingSelectInput'),
    tools: catalog.tools,
    catalogPolicy: catalog.policy,
    generation: model.generation,
    credentialRef: null,
  }
  const toolsBinding = required(f.bindings.tools)
  const loopBinding = required(f.bindings.loop)
  const contextBinding = required(f.bindings.context)
  let terminal: W.RuntimeError | undefined
  let live = 0
  let opened = false
  let modelRef: W.DataRef | undefined
  let toolResult: W.ToolModelResult | undefined
  let current = true
  let complete = false
  let modelAction: W.PreparedAction | undefined
  const referenceFactory =
    kind === 'reference'
      ? (
          (await import(
            new URL('../../../../examples/runtime-reference/src/providers/tools.ts', import.meta.url).href
          )) as { createReferenceToolsFactory: NonNullable<HostRuntimeLoopInstallation['toolsFactory']> }
        ).createReferenceToolsFactory
      : undefined
  const installation: HostRuntimeLoopInstallation = {
    ...(referenceFactory ? { toolsFactory: referenceFactory } : {}),
    ...(mode === 'tools-source'
      ? {}
      : {
          toolCallSource: {
            async verifyCall(call, frame, context) {
              observe({ method: 'source.verifyCall', modelContextRef: call.modelContextRef })
              if (
                !current ||
                frame.runId !== 'r' ||
                frame.actionId !== 'action-tool' ||
                context.scope.kind !== 'action' ||
                context.scope.runId !== 'r' ||
                !modelRef ||
                canonicalJsonDigest(call.modelContextRef) !== canonicalJsonDigest(modelRef)
              )
                return failed('tools_model_context_source_mismatch')
              await Promise.resolve()
              if (mode === 'revoked') current = false
              return current && !context.signal.aborted
                ? ok(undefined)
                : failed('tools_model_context_source_revoked')
            },
          },
        }),
    tools: {
      ...t.deployment,
      descriptor: { ...t.deployment.descriptor, providerId: toolsBinding.providerId, scope: 'run' },
      definition: required(inputs.tools[0]),
      snapshot: f.frame.snapshot,
      checkCurrent: async (context) => (context.signal.aborted ? failed('fixture_cancelled') : ok(undefined)),
      createExecutor(call) {
        observe({ method: 'executor.create' })
        return createPureToolAuthorAdapter(t.author, {
          definition: required(inputs.tools[0]),
          inputDigest: call.input.kind === 'inline' ? call.input.digest : call.input.blob.digest,
          provenance: {
            producer: toolsBinding,
            sourceRefs: ['synthetic-original-model-action'],
            trustLabels: ['derived'],
          },
        })
      },
    },
    context: {
      ...data,
      configuration: data.config,
      binding: contextBinding,
      descriptor: { ...data.descriptor, providerId: contextBinding.providerId },
      deployment: {
        capture: () => ok(data.source),
        checkCurrent: (ctx) => !ctx.signal.aborted,
        sourceCurrent: (_source, ctx) => !ctx.signal.aborted,
      },
    },
    loop: {
      descriptor: f.factory.descriptor,
      configuration: f.config,
      binding: loopBinding,
      source: {
        checkCurrent: async (ctx) => (ctx.signal.aborted ? failed('fixture_cancelled') : ok(undefined)),
        readInputs: async (_frame, stage) => {
          if (stage === 'second-model') {
            if (toolResult?.output.kind !== 'inline') return failed('fixture_tool_result_missing')
            const content = validateRuntime('StandardToolOutput', toolResult.output.value)
            if (!content.ok) return failed('fixture_tool_content_invalid')
            required(data.source.items[0]).body = toolsRef(
              required(data.source.items[0]).body.schema,
              required(content.value.content[0]).text,
            )
          }
          return ok(inputs)
        },
      },
    },
    peers: ['routing', 'model', 'supervisor'].map((name) => ({
      binding: required(f.bindings[name]),
      major: 1,
      scope: 'run',
      features: [],
      packageDigest: 'a'.repeat(64),
      ownerId: required(f.bindings[name]).providerId,
      permissions: [],
      query: (request, _context) => f.ports.query(request),
      compute: (request, _context) => f.ports.compute(request),
    })),
    grants: Object.values(f.bindings).map((binding) => ({
      authorizationRef: f.context.authorizationRef,
      ownerId: binding.providerId,
      permissions: [],
      scope: 'run',
    })),
    async open(_request, signal) {
      if (terminal) return { ok: false, error: terminal }
      if (complete) return ok(null)
      if (opened) return ok(null)
      opened = true
      live++
      const contextFor = (binding: W.BindingRef) => ({ ...f.context, bindingId: binding.bindingId, signal })
      const state: NonNullable<HostRuntimeLoopRun['state']> = {
        control: {
          acceptInbox: async () => failed('fixture_intake_not_used'),
          advanceRun: async () => failed('fixture_commit_adapter_only'),
          publishActionResult: async () => failed('fixture_visibility_adapter_only'),
        },
        async commit(_frame, transition) {
          observe({ method: 'state.transition', next: transition.next.kind })
          if (transition.next.kind === 'complete') {
            complete = true
            observe({ method: 'state.complete', output: transition.next.output })
          }
          return ok(f.nextFrame(transition))
        },
      }
      const run: HostRuntimeLoopRun = {
        frame: { ...f.frame, reason: mode === 'cold' ? 'recovery' : 'start' },
        contextFor,
        factoryContextFor: (binding) => ({ ...f.factoryContext, bindingId: binding.bindingId, signal }),
        reads: f.ports,
        ...(mode === 'state' ? {} : { state }),
        ...(mode === 'model'
          ? {}
          : {
              model: {
                kind: 'leaf' as const,
                recovery: 'R1' as const,
                stateCodec: null,
                create: async () => {
                  const action = required(modelAction)
                  return {
                    kind: 'leaf' as const,
                    effectSemantics: 'idempotent' as const,
                    ready: async () => ok(undefined),
                    health: async () => ok({ status: 'ready' as const, diagnosticIds: [] }),
                    drain: async () =>
                      ok({
                        state: 'drained' as const,
                        activeInvocationIds: [],
                        durableOwnerRefs: [],
                        diagnosticIds: [],
                      }),
                    close: async () => {
                      observe({ method: 'model.action.close', key: action.key })
                    },
                    reconcile: async () => {
                      throw Error('fixture_model_reconcile_unavailable')
                    },
                    async execute() {
                      await f.accept(action)
                      const receipt = required(f.receipts.get(action.key))
                      return {
                        outcome: 'succeeded' as const,
                        result: required(receipt.result),
                        externalRequests: [],
                        usage: [],
                        references: [],
                      }
                    },
                  }
                },
              },
            }),
        ...(mode === 'supervisor'
          ? {}
          : {
              supervisor: {
                async dispatch(_frame, transition, actions) {
                  const action = transition.actions[0]
                  if (!action) return failed('fixture_action_missing')
                  observe({ method: 'dispatch', key: action.key })
                  if (mode === 'blocked') {
                    await new Promise<void>((resolve) => {
                      signal.addEventListener('abort', () => resolve(), { once: true })
                      if (signal.aborted) resolve()
                    })
                    return failed('fixture_cancelled')
                  }
                  if (action.key !== 'tool') {
                    if (action.key === 'first-model') {
                      if (action.input.kind !== 'inline') return failed('fixture_model_input_invalid')
                      const parsed = validateRuntime('ModelInferRequest', action.input.value)
                      if (!parsed.ok) return failed('fixture_model_input_invalid')
                      modelRef = parsed.value.preparedRef
                    }
                    modelAction = action
                    const modelCall = contextFor(action.target)
                    if (modelCall.scope.kind !== 'run') throw Error('fixture model run scope missing')
                    modelCall.scope = { ...modelCall.scope, kind: 'action', actionId: `action-${action.key}` }
                    const factory = required(actions.get(`${action.target.bindingId}/${action.method}`))
                    const child = await factory.create({
                      instanceId: `model-${action.key}`,
                      runId: 'r',
                      actionId: modelCall.scope.actionId,
                      bindingId: action.target.bindingId,
                      scope: modelCall.scope,
                      signal,
                    })
                    try {
                      const ready = await child.ready(modelCall)
                      if (!ready.ok) return ready
                      if (child.kind !== 'leaf') return failed('fixture_model_leaf_required')
                      const { signal: _signal, ...wire } = modelCall
                      const modelFrame = {
                        ...t.frame,
                        actionId: modelCall.scope.actionId,
                        runId: 'r',
                        bindingId: action.target.bindingId,
                        method: action.method,
                        input: action.input,
                        inputDigest:
                          action.input.kind === 'inline' ? action.input.digest : action.input.blob.digest,
                        invocationId: modelCall.invocationId,
                        context: wire,
                      }
                      const result = await child.execute(modelFrame, { ...t.actionContext, call: modelCall })
                      if ('error' in result) return { ok: false, error: result.error }
                    } finally {
                      await child.close('shutdown')
                    }
                    return ok({ ...f.frame, reason: 'continue' })
                  }
                  const call = contextFor(action.target)
                  if (call.scope.kind !== 'run') throw Error('fixture run scope missing')
                  call.scope = { ...call.scope, kind: 'action', actionId: 'action-tool' }
                  call.invocationId = 'tool-execution'
                  const { signal: _signal, ...wire } = call
                  const actionInput = structuredClone(action.input)
                  if (mode === 'wrong-ref' && actionInput.kind === 'inline') {
                    const call = validateRuntime('ToolCall', actionInput.value)
                    if (!call.ok) return failed('fixture_tool_call_invalid')
                    call.value.modelContextRef = toolsRef(RuntimeSchemaRefs.PreparedModelRequest, {})
                    Object.assign(actionInput, toolsRef(actionInput.schema, call.value))
                  }
                  const frame: W.ActionFrame = {
                    ...t.frame,
                    runId: 'r',
                    bindingId: action.target.bindingId,
                    actionId: 'action-tool',
                    invocationId: call.invocationId,
                    context: wire,
                    input: actionInput,
                    inputDigest: actionInput.kind === 'inline' ? actionInput.digest : actionInput.blob.digest,
                    actionTimebox: f.frame.actionTimebox,
                  }
                  const factory = actions.get(`${action.target.bindingId}/${action.method}`)
                  if (!factory) return failed('fixture_action_not_registered')
                  const child = await factory.create({
                    instanceId: 'tool-action-instance',
                    runId: 'r',
                    actionId: frame.actionId,
                    bindingId: frame.bindingId,
                    scope: call.scope,
                    signal,
                  })
                  try {
                    const ready = await child.ready(call)
                    if (!ready.ok) return ready
                    if (child.kind !== 'leaf') return failed('fixture_leaf_required')
                    const result = await child.execute(frame, { ...t.actionContext, call })
                    observe({
                      method: 'tool.result',
                      outcome: result.outcome,
                      modelContextRef:
                        action.input.kind === 'inline'
                          ? (action.input.value as Record<string, W.JsonValue>).modelContextRef
                          : null,
                      error: 'error' in result ? result.error : null,
                    })
                    if ('error' in result) return { ok: false, error: result.error }
                    if (result.result?.kind !== 'inline') return failed('fixture_tool_result_invalid')
                    const raw = validateRuntime('ToolResult', result.result.value)
                    if (!raw.ok) return failed('fixture_tool_result_invalid')
                    const { details: _details, ...visible } = raw.value
                    toolResult = visible
                    f.receipts.set('tool', {
                      receiptId: 'receipt-tool',
                      sourceReceiptId: 'receipt-tool',
                      viewId: 'view-tool',
                      actionId: frame.actionId,
                      attemptId: frame.attemptId,
                      bindingId: frame.bindingId,
                      inputDigest:
                        actionInput.kind === 'inline' ? actionInput.digest : actionInput.blob.digest,
                      outcome: 'succeeded',
                      result: toolsRef(RuntimeSchemaRefs.ToolModelResult, visible),
                      externalRequests: [],
                      usageRefs: [],
                      references: [],
                      provenance: raw.value.provenance,
                      completedAt: f.frame.observedAt,
                      visibility: 'ready',
                      hookResultSetRef: null,
                    })
                    return ok({ ...f.frame, reason: 'continue' })
                  } finally {
                    await child.close('shutdown')
                    observe({ method: 'action.close' })
                  }
                },
              },
            }),
        async close() {
          live--
          observe({ method: 'run.close', live })
          await f.close()
          await t.dependencies.close()
        },
      }
      return ok(run)
    },
    async reject(_request, error) {
      terminal = error
      observe({ method: 'state.refused', state: 'refused', error })
      return ok(undefined)
    },
  }
  return {
    installation,
    close: async () => {
      await f.close()
      await t.dependencies.close()
    },
  }
}
