import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defaultLoopStateCodec } from '../../../../packages/core/src/runtime/loop/default-state.js'
import { createContextFactory } from '../../../../packages/core/src/runtime/providers/context.js'
import {
  createDefaultLoopFactory,
  type DefaultLoopInputs,
} from '../../../../packages/core/src/runtime/providers/loop.js'
import { createTextStatisticsTool } from '../../../../packages/core/src/runtime/tools/definitions.js'
import type {
  CallContext,
  LoopReadPorts,
  Outcome,
} from '../../../../packages/extension-api/src/runtime/index.js'
import { defineGeneratedAuthorSchema } from '../../../../packages/extension-api/src/runtime/index.js'
import {
  contextFixtureData,
  contextInline,
} from '../../../../packages/extension-api/testkit/runtime/contracts/context.js'
import {
  type LoopContractFixture,
  registerLoopContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/loop.js'
import {
  type ConformanceHarness,
  createTestServiceContainer,
} from '../../../../packages/extension-api/testkit/runtime/harness.js'
import type * as W from '../../../../packages/protocol/src/runtime/index.js'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs as M,
  RuntimeSchemaRefs as S,
  validateRuntime,
} from '../../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

const error = (detailCode: string, code: W.RuntimeError['code'] = 'denied'): W.RuntimeError => ({
  code,
  detailCode,
  message: 'Restricted Loop fixture refused',
  diagnosticId: 'loop-fixture',
  retryAdvice: { kind: 'never' },
})
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Loop fixture value absent')
  return value
}
function value(ref: W.DataRef): W.JsonValue {
  if (ref.kind !== 'inline') throw new Error('F02 inline only')
  return ref.value
}
/** F02 peers plan real public SPI actions and expose synthetic receipts. No durable owner or cold State is manufactured. */
export async function openLoopFixture(options?: {
  credentials: { binding: W.SecretConsumerBinding | null; handle: W.SecretHandle | null }
}): Promise<
  LoopContractFixture & {
    receipts: Map<string, W.ActionResultView>
    bindings: Record<string, W.BindingRef>
    source: { allowed: boolean; blocked?: Promise<Outcome<void>> }
    issued: W.PreparedAction[]
  }
> {
  const data = contextFixtureData()
  const controller = new AbortController()
  const bindings: Record<string, W.BindingRef> = Object.fromEntries(
    ['loop', 'context', 'routing', 'model', 'tools', 'supervisor'].map((name) => [
      name,
      { bindingId: name, contract: `agh.${name}`, logicalName: 'default', providerId: `fixture/${name}` },
    ]),
  )
  const loop = required(bindings.loop)
  loop.providerId = 'agh.default/loop'
  const context: CallContext = {
    ...data.context,
    bindingId: loop.bindingId,
    invocationId: 'loop-0',
    signal: controller.signal,
  }
  const { signal: _signal, ...wire } = context
  const parameters: W.SessionParameterRevision = {
    sessionId: 's',
    revision: 1,
    previousRevision: null,
    sourceRequestId: 'parameter-request',
    presetId: 'fixed',
    presetDigest: canonicalJsonDigest({}),
    parameters: { schema: data.config.schema, value: {} },
    effective: { kind: 'immediate', revision: 0, runId: null, afterRequestId: null },
    committedAt: '2026-10-05T00:00:00Z',
  }
  const closed = (properties: Record<string, W.JsonValue>): W.JsonValue => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  })
  const text: W.JsonValue = { type: 'string' },
    integer: W.JsonValue = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    nullable: W.JsonValue = { anyOf: [text, { type: 'null' }] }
  const parameterDocument = closed({
    sessionId: text,
    revision: integer,
    previousRevision: { anyOf: [integer, { type: 'null' }] },
    sourceRequestId: text,
    presetId: text,
    presetDigest: text,
    parameters: closed({
      schema: closed({ typeId: text, revision: integer, digest: text }),
      value: closed({}),
    }),
    effective: closed({
      kind: { enum: ['immediate'] },
      revision: integer,
      runId: nullable,
      afterRequestId: nullable,
    }),
    committedAt: text,
  })
  const parameterCodec = defineGeneratedAuthorSchema<W.SessionParameterRevision>({
    ownerPackageId: 'fixture.loop',
    name: 'Parameters',
    typeId: 'fixture.loop/parameters@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Parameters',
      $defs: { Parameters: parameterDocument },
    },
  })
  const reference: W.DomainReference = {
    authorityId: 'fixture-authority',
    recordId: 'parameters',
    recordRevision: 1,
    schema: parameterCodec.ref,
    digest: canonicalJsonDigest(parameters),
  }
  const frame: W.RunFrame = {
    apiMajor: 1,
    runId: 'r',
    sessionId: 's',
    workspaceId: 'w',
    bindingId: loop.bindingId,
    revision: 0,
    invocationId: context.invocationId,
    writerEpoch: 1,
    reason: 'start',
    input: required(data.source.items[0]).body,
    continuation: null,
    conversation: null,
    sessionParameters: { value: parameters, reference },
    signals: { items: [], nextCursor: null, snapshot: 'fixture-snapshot', complete: true },
    receipts: { items: [], nextCursor: null, snapshot: 'fixture-snapshot', complete: true },
    signalHighWater: 0,
    snapshot: 'fixture-snapshot',
    observedAt: new Date().toISOString(),
    context: wire,
    actionTimebox: { defaultTimeoutMs: 60_000, maxDeadline: context.deadline },
  }
  const requirements: W.ServiceRequirement[] = ['context', 'routing', 'model', 'tools', 'supervisor'].map(
    (name) => ({
      contract: `agh.${name}`,
      major: 1,
      logicalName: 'default',
      scope: 'run',
      optional: false,
      features: [],
    }),
  )
  const descriptor: W.ProviderDescriptor = {
    ...data.descriptor,
    contract: 'agh.loop',
    providerId: loop.providerId,
    features: [],
    requires: requirements,
    stateCodecs: [defaultLoopStateCodec],
    operations: (['start', 'resume'] as const).map((method) => ({
      method,
      kind: 'compute',
      inputSchema: M['agh.loop'][method].input,
      outputSchema: M['agh.loop'][method].output,
      requiredCapabilities: [],
      retrySafety: 'read-only',
    })),
  }
  const implementation = createHash('sha256')
  for (const path of ['providers/loop.ts', 'loop/default-plan.ts', 'loop/default-state.ts'])
    implementation.update(
      readFileSync(new URL(`../../../../packages/core/src/runtime/${path}`, import.meta.url)),
    )
  descriptor.packageDigest = implementation.digest('hex')
  const source = { allowed: true } as { allowed: boolean; blocked?: Promise<Outcome<void>> }
  const check = async (): Promise<Outcome<void>> =>
    source.blocked ?? (source.allowed ? ok(undefined) : { ok: false, error: error('loop_fixture_revoked') })
  const author = createTextStatisticsTool()
  const definition: W.ToolDefinition = {
    resource: { resourceId: author.id, version: '1', digest: canonicalJsonDigest(author.id) },
    executor: required(bindings.tools),
    name: author.id,
    inputSchema: S.StandardToolOutput,
    outputSchema: S.StandardToolOutput,
    requiredCapabilities: [],
    retrySafety: 'idempotent',
    publicAnnotations: contextInline(S.StandardToolOutput, {
      content: [{ type: 'text', text: author.description }],
    }),
    policy: {
      version: '1',
      classifierRef: null,
      defaults: {
        isReadOnly: true,
        isDestructive: false,
        replay: 'idempotent',
        requiresApproval: 'never',
        approvalScopes: [],
      },
    },
    execution: {
      concurrency: 'parallel',
      isOpenWorld: false,
      costHint: null,
      deferLoading: false,
      requiredModelInput: [],
    },
  }
  const features: W.ModelFeatures = {
    input: ['text'],
    output: ['text'],
    tools: true,
    structuredOutput: false,
    streaming: false,
  }
  const route: W.ModelRouteSnapshot = {
    routeId: 'fixture-model',
    routeRevision: 1,
    adapter: required(bindings.model),
    model: 'f02-text',
    endpointRef: 'restricted-peer',
    catalogRevision: 1,
    features,
    priceVersion: 'fixed',
    credentialAudience: 'restricted',
    credentialBinding: options?.credentials.binding ?? null,
  }
  const input: W.ContextViewRequest = structuredClone(value(data.request.input)) as W.ContextViewRequest
  const contextSource = structuredClone(data.source)
  const contextFactory = createContextFactory({
    ...data,
    deployment: {
      capture: () => ok(contextSource),
      checkCurrent: () => source.allowed,
      sourceCurrent: () => source.allowed,
    },
  })
  const contextProvider = await contextFactory.create(
    data.config,
    createTestServiceContainer().dependencies,
    data.factoryContext,
  )
  await contextProvider.ready(data.context)
  const receipts = new Map<string, W.ActionResultView>(),
    issued: W.PreparedAction[] = []
  const container = createTestServiceContainer()
  for (const requirement of requirements)
    container.register({
      requirement,
      binding: required(bindings[requirement.contract.slice(4)]),
      async query(request, call) {
        if (!source.allowed) return { ok: false, error: error('loop_fixture_revoked') }
        if (requirement.contract === 'agh.context' && contextProvider.query)
          return contextProvider.query(request, { ...call, bindingId: required(bindings.context).bindingId })
        if (requirement.contract === 'agh.supervisor') {
          const parsed = validateRuntime('SupervisorActionReceiptRequest', value(request.input))
          if (!parsed.ok || !('localKey' in parsed.value.action))
            return { ok: false, error: error('receipt_request') }
          const receipt = receipts.get(parsed.value.action.localKey) ?? null
          return ok({
            kind: 'value',
            snapshot: frame.snapshot,
            output: contextInline(M['agh.supervisor'].actionReceipt.output, {
              actionId: receipt?.actionId ?? `action-${parsed.value.action.localKey}`,
              receipt,
              visibility: receipt ? 'ready' : 'pending',
            }),
          })
        }
        return { ok: false, error: error('fixture_query_unavailable') }
      },
      async compute(request) {
        if (!source.allowed) return { ok: false, error: error('loop_fixture_revoked') }
        const payload = value(request.input)
        if (requirement.contract === 'agh.routing')
          return ok(contextInline(M['agh.routing'].select.output, { route, reason: 'restricted fixed peer' }))
        if (requirement.contract === 'agh.tools' && request.method === 'catalog') {
          const catalog = { revision: 1, tools: [definition] }
          return ok(
            contextInline(M['agh.tools'].catalog.output, {
              ...catalog,
              digest: canonicalJsonDigest(catalog),
            }),
          )
        }
        if (requirement.contract === 'agh.tools' && request.method === 'classify') {
          const parsed = validateRuntime('ToolsClassifyRequest', payload)
          if (!parsed.ok || parsed.value.input.kind !== 'inline')
            return { ok: false, error: error('classify_request') }
          const policy = {
            ...definition.policy.defaults,
            policyVersion: '1',
            classifierDigest: canonicalJsonDigest(definition.policy),
            inputDigest: parsed.value.input.digest,
            definitionDigest: canonicalJsonDigest(definition),
          }
          return ok(
            contextInline(M['agh.tools'].classify.output, {
              ...policy,
              fingerprint: canonicalJsonDigest(policy),
            }),
          )
        }
        if (requirement.contract === 'agh.model' && request.method === 'prepare') {
          const parsed = validateRuntime('ModelPrepareRequest', payload)
          if (!parsed.ok) return { ok: false, error: error('model_prepare_request') }
          const prepared: W.PreparedModelRequest = {
            preparedId: 'fixed-preparation',
            ownerBinding: required(bindings.model),
            target: parsed.value.route,
            view: parsed.value.view,
            inputDigest: canonicalJsonDigest(payload),
            outputSchema: parsed.value.outputSchema,
            toolCatalog: parsed.value.toolCatalog,
            generation: parsed.value.generation,
            mediaPlans: [],
            estimatedUnits: [],
            hookResults: null,
            sessionParameterRef: reference,
            legacyRequestOverrides: null,
            credentialRef: parsed.value.credentialRef,
          }
          return ok(
            contextInline(M['agh.model'].prepare.output, {
              preparedRef: contextInline(S.PreparedModelRequest, prepared),
              targetSnapshot: route,
              inputDigest: prepared.inputDigest,
              estimatedUnits: [],
              mediaPlanRefs: [],
            }),
          )
        }
        return { ok: false, error: error('fixture_compute_unavailable') }
      },
    })
  const ports: LoopReadPorts = {
    prepare(spec) {
      const prepared = validateRuntime('PreparedAction', {
        ...spec,
        intentFingerprint: canonicalJsonDigest(spec),
      })
      if (!prepared.ok) return { ok: false, error: error('fixture_prepare_invalid', 'invalid_input') }
      issued.push(prepared.value)
      return ok(prepared.value)
    },
    async resolveData(ref) {
      return source.allowed && ref.kind === 'inline'
        ? ok(ref.value)
        : { ok: false, error: error('loop_fixture_revoked') }
    },
    async query(request) {
      const requirement = required(requirements.find((item) => item.contract === request.target.contract))
      const service = container.dependencies.get(requirement)
      return service.ok ? service.value.query(request, context) : service
    },
    async compute(request) {
      const requirement = required(requirements.find((item) => item.contract === request.target.contract))
      const service = container.dependencies.get(requirement)
      return service.ok ? service.value.compute(request, context) : service
    },
  }
  const factory = createDefaultLoopFactory(descriptor, {
    checkCurrent: check,
    async readInputs(currentFrame, stage, readPorts) {
      if (stage === 'second-model') {
        const receipt = receipts.get('tool')
        if (!receipt?.result) return { ok: false, error: error('fixture_tool_receipt_missing') }
        const result = await readPorts.resolveData(receipt.result)
        if (!result.ok) return result
        const parsed = validateRuntime('ToolModelResult', result.value)
        if (!parsed.ok) return { ok: false, error: error('fixture_tool_result_invalid') }
        const output = await readPorts.resolveData(parsed.value.output)
        if (!output.ok) return output
        const content = validateRuntime('StandardToolOutput', output.value)
        if (!content.ok) return { ok: false, error: error('fixture_tool_content_invalid') }
        const encoded = data.configSchema.encode({})
        if (!encoded.ok) return encoded
        const text = required(data.source.items[0]).body.schema
        required(contextSource.items[0]).body = contextInline(text, required(content.value.content[0]).text)
        input.purpose = 'observe pure text statistics result'
      }
      contextSource.inputDigest = canonicalJsonDigest(input)
      const captured: DefaultLoopInputs = {
        snapshot: currentFrame.snapshot,
        inputDigest:
          currentFrame.input.kind === 'inline' ? currentFrame.input.digest : currentFrame.input.blob.digest,
        sessionParameterRef: reference,
        context: structuredClone(input),
        routing: {
          purpose: 'fixed text loop',
          requiredFeatures: features,
          allowedRoutes: [route],
          catalogRevision: 1,
          budgetSnapshot: data.config,
          inputMeta: data.config,
        },
        tools: [definition],
        catalogPolicy: {
          disclosure: 'standard',
          discoveredResourceIds: [],
          compactionAgentCallable: true,
          mainModel: null,
          policyRevision: 1,
        },
        generation: { maxOutputTokens: 200, thinking: null },
        credentialRef: options?.credentials.handle ?? null,
      }
      return ok(captured)
    },
  })
  return {
    factory,
    config: data.config,
    dependencies: container.dependencies,
    factoryContext: { ...data.factoryContext, bindingId: loop.bindingId, signal: controller.signal },
    context,
    frame,
    ports,
    source,
    bindings,
    receipts,
    issued,
    nextFrame(transition) {
      frame.revision++
      frame.continuation = structuredClone(transition.continuation)
      frame.reason = 'continue'
      frame.invocationId = `loop-${frame.revision}`
      frame.context.invocationId = frame.invocationId
      return structuredClone(frame)
    },
    async accept(action) {
      let output: W.DataRef
      if (action.key === 'tool') {
        const call = validateRuntime('ToolCall', value(action.input))
        if (!call.ok) throw new Error('F02 ToolCall invalid')
        const parsed = author.input.parse(value(call.value.input))
        if (!parsed.ok) throw new Error('F02 tool input invalid')
        const content = await author.execute(parsed.value, { signal: controller.signal, config: {} })
        // F02 models the business-visible projection explicitly; this is not a production receipt owner.
        const raw = validateRuntime('ToolResult', {
          output: contextInline(S.StandardToolOutput, content),
          artifacts: [],
          provenance: { producer: required(bindings.tools), sourceRefs: [], trustLabels: ['derived'] },
          details: contextInline(S.StandardToolOutput, {
            content: [{ type: 'text', text: 'raw detail must never reach the Loop' }],
          }),
        })
        if (!raw.ok) throw new Error('F02 raw ToolResult invalid')
        const { details: _rawDetails, ...modelVisible } = raw.value
        output = contextInline(S.ToolModelResult, modelVisible)
      } else {
        const content: W.StandardToolOutput =
          action.key === 'first-model'
            ? {
                content: [{ type: 'text', text: 'count' }],
                structured: {
                  toolCalls: [
                    {
                      toolUseId: 'fixed-tool-use',
                      name: author.id,
                      ordinal: 0,
                      args: { content: [{ type: 'text', text: 'short text' }] },
                    },
                  ],
                },
              }
            : { content: [{ type: 'text', text: 'statistics complete' }] }
        output = contextInline(M['agh.model'].infer.output, {
          outputRef: contextInline(S.StandardToolOutput, content),
          finishReason: action.key === 'first-model' ? 'tool-calls' : 'stop',
          usageFactRefs: [],
          providerReceipt: null,
          actualModel: route.model,
        })
      }
      const receipt: W.ActionResultView = {
        receiptId: `receipt-${action.key}`,
        sourceReceiptId: `receipt-${action.key}`,
        viewId: `view-${action.key}`,
        actionId: `action-${action.key}`,
        attemptId: `attempt-${action.key}`,
        bindingId: action.target.bindingId,
        inputDigest: action.input.kind === 'inline' ? action.input.digest : action.input.blob.digest,
        outcome: 'succeeded',
        result: output,
        externalRequests: [],
        usageRefs: [],
        references: [],
        provenance: { producer: action.target, sourceRefs: [], trustLabels: [] },
        completedAt: frame.observedAt,
        visibility: 'ready',
        hookResultSetRef: null,
      }
      receipts.set(action.key, receipt)
    },
    revoke() {
      source.allowed = false
    },
    cancel() {
      controller.abort()
    },
    async cold() {
      throw new Error(
        'loop_cold_state_consumer_unavailable: public State continuation/source read and Supervisor commit assembly are required',
      )
    },
    async close() {
      await contextProvider.close('shutdown')
      await container.dependencies.close()
    },
  }
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: { command: string; contracts: readonly string[] | 'all'; providers: readonly string[] },
) {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.loop'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((id) => id === 'default')
  for (const providerId of providers)
    registerLoopContract(harness, {
      providerId,
      command: request.command,
      build: getConformanceBuildIdentity(),
      open: openLoopFixture,
    })
  return { contracts: ['agh.loop'], providers }
}
