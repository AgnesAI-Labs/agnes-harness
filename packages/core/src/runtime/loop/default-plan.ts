import type { CallContext, LoopReadPorts, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  canonical,
  checkedPrepare,
  DefaultLoopFault,
  type DefaultLoopState,
  defaultLoopStateCodec,
  encode,
  equal,
  inputDigest,
  insist,
} from './default-state.js'

export function leafDeadline(frame: W.RunFrame): string {
  const deadline = Math.min(
    Date.parse(frame.observedAt) + frame.actionTimebox.defaultTimeoutMs,
    Date.parse(frame.actionTimebox.maxDeadline),
  )
  insist(deadline > Date.parse(frame.observedAt), 'loop_action_deadline', 'timeout')
  return new Date(deadline).toISOString()
}
/** Only the checked C07 StandardToolOutput representation is accepted by this narrow slice. */
export function modelTool(
  content: W.StandardToolOutput,
  definitions: readonly W.ToolDefinition[],
): { definition: W.ToolDefinition; input: W.DataRef } {
  const structured = content.structured
  insist(structured && typeof structured === 'object' && !Array.isArray(structured), 'loop_tool_call_missing')
  const calls = structured.toolCalls
  insist(Array.isArray(calls) && calls.length === 1, 'loop_single_tool_required', 'incompatible')
  const call = calls[0]
  insist(call && typeof call === 'object' && !Array.isArray(call), 'loop_tool_call_invalid')
  // C07 emits the existing public model ToolCall with toolUseId/name/args/ordinal.
  const keys = Object.keys(call).sort().join(',')
  insist(
    keys === 'args,name,ordinal,toolUseId' &&
      typeof call.toolUseId === 'string' &&
      call.toolUseId.length > 0 &&
      call.toolUseId.length <= 128 &&
      call.ordinal === 0 &&
      typeof call.name === 'string',
    'loop_tool_call_invalid',
  )
  const matching = definitions.filter((entry) => entry.name === call.name)
  insist(matching.length === 1 && matching[0], 'loop_tool_not_in_catalog', 'denied')
  const definition = matching[0]
  insist(
    definition.execution.isOpenWorld === false &&
      definition.execution.requiredModelInput.length === 0 &&
      definition.policy.classifierRef === null &&
      definition.policy.defaults.isReadOnly &&
      !definition.policy.defaults.isDestructive &&
      definition.policy.defaults.replay === 'idempotent' &&
      definition.policy.defaults.requiresApproval === 'never' &&
      definition.requiredCapabilities.length === 0,
    'loop_pure_tool_required',
    'incompatible',
  )
  return { definition, input: encode(definition.inputSchema, call.args) }
}
export function checkPolicy(
  definition: W.ToolDefinition,
  input: W.DataRef,
  policy: W.ToolPolicySnapshot,
): void {
  insist(
    validateRuntime('ToolPolicySnapshot', policy).ok &&
      equal(
        {
          isReadOnly: policy.isReadOnly,
          isDestructive: policy.isDestructive,
          replay: policy.replay,
          requiresApproval: policy.requiresApproval,
          approvalScopes: policy.approvalScopes,
        },
        definition.policy.defaults,
      ),
    'loop_policy_mismatch',
    'denied',
  )
  const { fingerprint, ...body } = policy
  insist(
    policy.definitionDigest === canonicalJsonDigest(definition) &&
      policy.policyVersion === definition.policy.version &&
      policy.inputDigest === (input.kind === 'inline' ? input.digest : input.blob.digest) &&
      fingerprint === canonicalJsonDigest(body),
    'loop_policy_identity',
    'denied',
  )
}
export function checkedContent(value: unknown): W.StandardToolOutput {
  const parsed = validateRuntime('StandardToolOutput', value)
  if (!parsed.ok) throw new DefaultLoopFault('loop_model_content_invalid')
  return parsed.value
}
export const standardContentSchema = RuntimeSchemaRefs.StandardToolOutput

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}
interface PlanningPorts {
  source: DefaultLoopSource | undefined
  selected: {
    context: W.BindingRef
    routing: W.BindingRef
    model: W.BindingRef
    tools: W.BindingRef
    supervisor: W.BindingRef
  } | null
  current(ctx: CallContext): Promise<void>
  raced<T>(operation: Promise<Outcome<T>>, ctx: CallContext): Promise<T>
  read(ref: W.DataRef, schema: W.SchemaRef, ports: LoopReadPorts, ctx: CallContext): Promise<W.JsonValue>
  compute(
    contract: 'context' | 'routing' | 'model' | 'tools' | 'supervisor',
    method: string,
    input: unknown,
    ports: LoopReadPorts,
    ctx: CallContext,
  ): Promise<W.JsonValue>
  transition(
    frame: W.RunFrame,
    state: DefaultLoopState,
    next: W.NextStep,
    actions?: W.PreparedAction[],
  ): W.LoopTransition
  wait(action: W.PreparedAction): W.NextStep
}
function checkCredential(route: W.ModelRouteSnapshot, handle: W.SecretHandle | null): void {
  const binding = route.credentialBinding
  if (binding === null) {
    insist(handle === null, 'loop_credential_binding', 'denied')
    return
  }
  insist(handle !== null, 'loop_model_credentials_unavailable', 'incompatible')
  insist(
    binding.consumer === 'model' &&
      binding.secretId === handle.secretId &&
      binding.audience === handle.audience &&
      route.credentialAudience === handle.audience,
    'loop_credential_binding',
    'denied',
  )
  insist(Date.parse(handle.expiresAt) > Date.now(), 'loop_credential_expired', 'denied')
}
export async function planDefaultModel(
  frame: W.RunFrame,
  state: DefaultLoopState,
  stage: 'first-model' | 'second-model',
  ports: LoopReadPorts,
  ctx: CallContext,
  api: PlanningPorts,
): Promise<W.LoopTransition> {
  const { source, selected, current, raced, read, compute, transition, wait } = api
  async function inputs(
    frame: W.RunFrame,
    stage: 'first-model' | 'second-model',
    ports: LoopReadPorts,
    ctx: CallContext,
  ): Promise<DefaultLoopInputs> {
    insist(source, 'loop_source_unavailable', 'incompatible')
    await current(ctx)
    const data = await raced(source.readInputs(structuredClone(frame), stage, ports), ctx)
    const fixedInput = structuredClone(data)
    canonical(fixedInput)
    await current(ctx)
    insist(
      fixedInput.snapshot === frame.snapshot &&
        fixedInput.inputDigest === inputDigest(frame) &&
        equal(fixedInput.sessionParameterRef, frame.sessionParameters.reference),
      'loop_source_snapshot',
      'conflict',
    )
    insist(
      validateRuntime('ContextViewRequest', fixedInput.context).ok &&
        validateRuntime('RoutingSelectInput', fixedInput.routing).ok &&
        validateRuntime('ToolCatalogPolicy', fixedInput.catalogPolicy).ok &&
        validateRuntime('GenerationOptions', fixedInput.generation).ok &&
        (fixedInput.credentialRef === null || validateRuntime('SecretHandle', fixedInput.credentialRef).ok) &&
        fixedInput.tools.length === 1 &&
        fixedInput.tools.every((tool) => validateRuntime('ToolDefinition', tool).ok),
      'loop_source_invalid',
    )
    insist(
      fixedInput.context.hookResults === null &&
        fixedInput.context.resourceRefs.length === 0 &&
        fixedInput.context.contributions.runtimeContext.length === 0,
      'loop_context_preparation_unavailable',
      'incompatible',
    )
    insist(
      fixedInput.context.sessionRef.sessionId === frame.sessionId &&
        fixedInput.context.atRevision === frame.sessionParameters.value.revision,
      'loop_context_source_identity',
      'denied',
    )
    insist(
      fixedInput.routing.allowedRoutes.length === 1 && fixedInput.routing.allowedRoutes[0],
      'loop_model_credentials_unavailable',
      'incompatible',
    )
    checkCredential(fixedInput.routing.allowedRoutes[0], fixedInput.credentialRef)
    freeze(fixedInput)
    return fixedInput
  }
  insist(selected, 'loop_not_ready', 'incompatible')
  const fixedInput = await inputs(frame, stage, ports, ctx)
  const routed = await compute('routing', 'select', fixedInput.routing, ports, ctx)
  const route = validateRuntime('RoutingSelectResult', routed)
  insist(
    route.ok && fixedInput.routing.allowedRoutes.some((allowed) => equal(allowed, route.value.route)),
    'loop_route_mismatch',
    'denied',
  )
  const catalog = await compute(
    'tools',
    'catalog',
    { tools: fixedInput.tools, policy: { ...fixedInput.catalogPolicy, mainModel: route.value.route } },
    ports,
    ctx,
  )
  const tools = validateRuntime('ToolCatalog', catalog)
  insist(tools.ok && equal(tools.value.tools, fixedInput.tools), 'loop_catalog_mismatch', 'denied')
  insist(
    tools.value.digest === canonicalJsonDigest({ revision: tools.value.revision, tools: tools.value.tools }),
    'loop_catalog_digest',
    'denied',
  )
  await current(ctx)
  const contextSchema = RuntimeMethodSchemaRefs['agh.context'].view
  const response = await raced(
    ports.query({
      target: selected.context,
      method: 'view',
      input: encode(contextSchema.input, fixedInput.context),
      snapshot: frame.snapshot,
    }),
    ctx,
  )
  insist(response.kind === 'value', 'loop_context_refresh_unavailable', 'incompatible')
  insist(response.snapshot === frame.snapshot, 'loop_context_snapshot', 'conflict')
  const view = validateRuntime('ContextView', await read(response.output, contextSchema.output, ports, ctx))
  insist(
    view.ok &&
      view.value.runtimeInstructionRefs.length === 0 &&
      view.value.tokenEstimate <= fixedInput.context.target.tokenLimit &&
      view.value.inputDigest === canonicalJsonDigest(fixedInput.context),
    'loop_context_mismatch',
    'denied',
  )
  const { digest: viewDigest, ...viewBody } = view.value
  insist(
    viewDigest === canonicalJsonDigest(viewBody) &&
      view.value.baseRevision === fixedInput.context.atRevision &&
      view.value.format === fixedInput.context.target.format,
    'loop_context_digest',
    'denied',
  )
  const catalogInput =
    stage === 'first-model'
      ? tools.value
      : {
          ...tools.value,
          tools: [],
          digest: canonicalJsonDigest({ revision: tools.value.revision, tools: [] }),
        }
  const prepared = validateRuntime(
    'ModelPrepareResult',
    await compute(
      'model',
      'prepare',
      {
        view: view.value,
        route: route.value.route,
        outputSchema: null,
        toolCatalog: catalogInput,
        generation: fixedInput.generation,
        hookResults: null,
        sessionParameterRef: frame.sessionParameters.reference,
        credentialRef: fixedInput.credentialRef,
      },
      ports,
      ctx,
    ),
  )
  insist(
    prepared.ok && equal(prepared.value.targetSnapshot, route.value.route),
    'loop_prepared_mismatch',
    'denied',
  )
  const locked = validateRuntime(
    'PreparedModelRequest',
    await read(prepared.value.preparedRef, RuntimeSchemaRefs.PreparedModelRequest, ports, ctx),
  )
  insist(
    locked.ok &&
      equal(locked.value.ownerBinding, selected.model) &&
      equal(locked.value.target, route.value.route) &&
      equal(locked.value.view, view.value) &&
      equal(locked.value.toolCatalog, catalogInput) &&
      equal(locked.value.generation, fixedInput.generation) &&
      locked.value.outputSchema === null &&
      equal(locked.value.credentialRef, fixedInput.credentialRef) &&
      locked.value.hookResults === null &&
      locked.value.legacyRequestOverrides === null &&
      locked.value.mediaPlans.length === 0 &&
      equal(locked.value.sessionParameterRef, frame.sessionParameters.reference) &&
      locked.value.inputDigest === prepared.value.inputDigest,
    'loop_prepared_identity',
    'denied',
  )
  await current(ctx)
  checkCredential(route.value.route, fixedInput.credentialRef)
  const action = checkedPrepare(ports, {
    key: stage,
    target: selected.model,
    method: 'infer',
    input: encode(RuntimeMethodSchemaRefs['agh.model'].infer.input, {
      preparedRef: prepared.value.preparedRef,
    }),
    dependencies: [],
    retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
    obligation: 'mandatory',
    deadline: leafDeadline(frame),
    resultSchema: RuntimeMethodSchemaRefs['agh.model'].infer.output,
    references: [],
  })
  return transition(frame, { ...state, phase: stage, pending: action }, wait(action), [action])
}

/** Native assembly supplies authorized, fixed inputs, including the exact credential handle
 * issued for the selected consumer by C22/model preparation. Wire equality cannot prove issuance.
 * This seam is not a public service or an owner; missing source or current permission must refuse. */
export interface DefaultLoopSource {
  checkCurrent(context: CallContext): Promise<Outcome<void>>
  readInputs(
    frame: W.RunFrame,
    stage: 'first-model' | 'second-model',
    ports: LoopReadPorts,
  ): Promise<Outcome<DefaultLoopInputs>>
}
export interface DefaultLoopInputs {
  snapshot: string
  inputDigest: W.Digest
  sessionParameterRef: W.DomainReference
  context: W.ContextViewRequest
  routing: W.RoutingSelectInput
  tools: readonly W.ToolDefinition[]
  catalogPolicy: W.ToolCatalogPolicy
  generation: W.GenerationOptions
  credentialRef: W.SecretHandle | null
}

export function checkedLoopDescriptor(descriptor: W.ProviderDescriptor): W.ProviderDescriptor {
  const loopMethods = RuntimeMethodSchemaRefs['agh.loop']
  const fixed = structuredClone(descriptor)
  insist(
    validateRuntime('ProviderDescriptor', canonical(fixed).json).ok &&
      fixed.contract === 'agh.loop' &&
      fixed.major === 1 &&
      fixed.scope === 'run' &&
      fixed.recovery === 'R1',
    'loop_descriptor_invalid',
  )
  insist(
    fixed.features.length === 0 && equal(fixed.stateCodecs, [defaultLoopStateCodec]),
    'loop_feature_unavailable',
    'incompatible',
  )
  insist(
    fixed.operations.length === 2 &&
      (['start', 'resume'] as const).every((name) =>
        fixed.operations.some(
          (op) =>
            op.method === name &&
            op.kind === 'compute' &&
            equal(op.inputSchema, loopMethods[name].input) &&
            equal(op.outputSchema, loopMethods[name].output),
        ),
      ),
    'loop_methods_invalid',
  )
  freeze(fixed)
  return fixed
}

export type DefaultLoopDependencies = {
  context: W.BindingRef
  routing: W.BindingRef
  model: W.BindingRef
  tools: W.BindingRef
  supervisor: W.BindingRef
}
export const defaultLoopContracts = {
  context: 'agh.context',
  routing: 'agh.routing',
  model: 'agh.model',
  tools: 'agh.tools',
  supervisor: 'agh.supervisor',
} as const
