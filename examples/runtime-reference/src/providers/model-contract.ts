import type { CallContext, DataRef, FactoryContext } from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type { ModelRecord } from '@agnes/protocol'
import {
  type BindingRef,
  canonicalJsonDigest,
  type JsonValue,
  type ModelPrepareRequest,
  RuntimeMethodSchemaRefs,
  type SchemaRef,
  type ScopeRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  createModelChildPeer,
  type ModelChildPeer,
  type ModelContractFixture,
} from '../../../../packages/extension-api/testkit/runtime/contracts/model.js'
import {
  createReferenceModelFactory,
  createReferenceModelRegistry,
  type ReferenceCatalogPick,
  type ReferenceModelDeployment,
  type ReferenceModelRegistry,
  type ReferenceWireIdentity,
} from './model.js'

/** The fixed facts every reference model test shares; none of them comes from Core or Host. */
export const ADAPTER: BindingRef = {
  bindingId: 'adapter',
  providerId: 'agh.reference/model-adapter',
  contract: 'agh.model-adapter',
  logicalName: 'default',
}
export const STATE: BindingRef = {
  bindingId: 'state',
  providerId: 'agh.reference/state',
  contract: 'agh.state',
  logicalName: 'default',
}
export const OWNER_ID = 'model-binding'
export const WIRE: ReferenceWireIdentity = { sessionKey: 'session-1', slot: 'primary', contractId: null }
const MODEL: ModelRecord = {
  id: 'fixture-model',
  name: 'fixture-model',
  api: 'openai-completions',
  route: 'fixed-route',
  baseUrl: 'https://fake.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
export const PICK: ReferenceCatalogPick = {
  route: { route: 'fixed-route', api: 'openai-completions', baseUrl: 'https://fake.invalid' },
  model: MODEL,
}
export const PACKAGE_DIGEST = 'package-1'
const TEXT = runtimeAuthorSchemas.StandardToolOutput.ref
const config = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: '@fixture/model',
  name: 'RuntimeEmptyConfig',
  typeId: '@fixture/model/empty@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/RuntimeEmptyConfig',
    $defs: {
      RuntimeEmptyConfig: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
        maxProperties: 0,
      },
    },
  },
})
export const inlineRef = (schema: SchemaRef, value: unknown): DataRef => ({
  kind: 'inline',
  schema,
  value: value as JsonValue,
  digest: canonicalJsonDigest(value as never),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})
export function textItem(trust: 'system' | 'user', body: string) {
  return {
    id: `item-${trust}-${body.length}`,
    kind: 'message',
    body: inlineRef(TEXT, body),
    sourceRefs: [],
    provenance: { sourceRefs: ['s'], producer: ADAPTER, trustLabels: [] },
    trust,
    tokenEstimate: 1,
    protected: false,
    toolPairRef: null,
    sourceRanges: [],
  } as ModelPrepareRequest['view']['items'][number]
}
export function prepareRequestOf(over: Partial<ModelPrepareRequest> = {}): ModelPrepareRequest {
  return {
    view: {
      viewId: 'view',
      format: 'fixture-text',
      schema: TEXT,
      baseRevision: 1,
      items: [textItem('user', 'hello')],
      tokenEstimate: 1,
      protectedRefs: [],
      inputDigest: 'a'.repeat(64),
      digest: 'b'.repeat(64),
      runtimeInstructionRefs: [],
    },
    route: {
      routeId: 'fixed-route',
      routeRevision: 1,
      adapter: ADAPTER,
      model: 'fixture-model',
      endpointRef: 'fixture-endpoint',
      catalogRevision: 1,
      features: { input: ['text'], output: ['text'], tools: false, structuredOutput: false, streaming: true },
      priceVersion: 'fixture-price-1',
      credentialAudience: 'fixture-endpoint',
      credentialBinding: null,
    },
    outputSchema: null,
    toolCatalog: null,
    hookResults: null,
    generation: { maxOutputTokens: 32, thinking: null },
    sessionParameterRef: {
      authorityId: 'fixture-config',
      recordId: 'parameters',
      recordRevision: 1,
      schema: TEXT,
      digest: canonicalJsonDigest({}),
    },
    credentialRef: null,
    ...over,
  }
}
export function runCall(
  signal: AbortSignal = new AbortController().signal,
  over: { bindingId?: string; runId?: string } = {},
): CallContext {
  return {
    principalRef: 'fixture-user',
    scope: {
      kind: 'run',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session-1',
      runId: over.runId ?? 'run-1',
    } as ScopeRef,
    bindingId: over.bindingId ?? OWNER_ID,
    invocationId: 'invocation',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    traceRef: 'trace',
    authorizationRef: 'authorization',
    signal,
  }
}
export const factoryContext = (bindingId = OWNER_ID): FactoryContext => ({
  instanceId: 'instance',
  bindingId,
  scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as ScopeRef,
  signal: new AbortController().signal,
})

export type ReferenceModelState = { current: boolean; adapterSelectable: boolean }
/** A deployment wired to fixed fakes; `over` replaces any port, and `state` flips grants and selection. */
export function referenceDeployment(
  state: ReferenceModelState = { current: true, adapterSelectable: true },
  over: Partial<ReferenceModelDeployment> = {},
  registry: ReferenceModelRegistry = createReferenceModelRegistry(),
): ReferenceModelDeployment {
  return {
    packageDigest: 'f'.repeat(64),
    config,
    secrets: null,
    state: STATE,
    current: () => state.current,
    catalog: {
      capture: () => ({
        ok: true,
        value: {
          digest: canonicalJsonDigest({ routes: [PICK] } as never),
          select: (route, id) => (route === 'fixed-route' && id === 'fixture-model' ? PICK : undefined),
        },
      }),
    },
    prices: { version: (target) => target.priceVersion },
    wire: { resolve: async () => ({ ok: true, value: WIRE }) },
    adapters: {
      select: (target) =>
        state.adapterSelectable && target.bindingId === ADAPTER.bindingId
          ? { binding: ADAPTER, packageDigest: PACKAGE_DIGEST }
          : null,
    },
    registry,
    bridge: { ready: () => ({ ok: true, value: undefined }) },
    ...over,
  }
}
/** Open a service and ask it to prepare `input` as another binding or run, through its public compute only. */
async function preparedBy(
  deployment: ReferenceModelDeployment,
  bindingId: string,
  call: CallContext,
  input: ModelPrepareRequest,
): Promise<DataRef> {
  const encoded = deployment.config.encode({})
  if (!encoded.ok) throw new Error('fixture configuration rejected')
  const provider = await createReferenceModelFactory(deployment).create(
    encoded.value,
    createTestServiceContainer().dependencies,
    factoryContext(bindingId),
  )
  if (!(await provider.ready(call)).ok || !provider.compute) throw new Error('fixture service not ready')
  const reply = await provider.compute(
    {
      target: { bindingId, contract: 'agh.model', logicalName: 'default', providerId: 'agh.reference/model' },
      method: 'prepare',
      input: inlineRef(RuntimeMethodSchemaRefs['agh.model'].prepare.input, input),
    },
    call,
  )
  const result =
    reply.ok && reply.value.kind === 'inline'
      ? validateRuntime('ModelPrepareResult', reply.value.value)
      : null
  if (!result?.ok) throw new Error('fixture preparation refused')
  return result.value.preparedRef
}

/**
 * The independent expectation of the input digest: every prepared field written out by name, so a
 * dropped or added field in the provider changes one side only.
 */
export function expectedInputDigest(request: ModelPrepareRequest, ownerBinding: BindingRef): string {
  return canonicalJsonDigest({
    kind: 'agh.model/input@1',
    ownerBinding,
    target: request.route,
    view: request.view,
    outputSchema: request.outputSchema,
    toolCatalog: request.toolCatalog,
    generation: request.generation,
    mediaPlans: [],
    hookResults: null,
    sessionParameterRef: request.sessionParameterRef,
    legacyRequestOverrides: null,
    credentialRef: request.credentialRef,
    wire: WIRE,
    capture: {
      adapterPackageDigest: PACKAGE_DIGEST,
      route: PICK.route,
      model: PICK.model,
    },
  } as never)
}

/** The reference implementation's contract fixture; `state` and `peer` outlive a restart, the registry does not. */
export async function referenceModelFixture(
  state: ReferenceModelState = { current: true, adapterSelectable: true },
  peer: ModelChildPeer = createModelChildPeer({ adapter: ADAPTER, state: STATE.bindingId }),
): Promise<ModelContractFixture> {
  const registry = createReferenceModelRegistry()
  const deployment = referenceDeployment(state, {}, registry)
  const request = prepareRequestOf()
  // Foreign handles are produced by real services over this registry (or, for the unheld one, another).
  const foreignOwned = await preparedBy(
    deployment,
    'other-owner',
    runCall(undefined, { bindingId: 'other-owner' }),
    request,
  )
  const foreignRun = await preparedBy(deployment, OWNER_ID, runCall(undefined, { runId: 'run-2' }), request)
  const unheld = await preparedBy(
    referenceDeployment(state),
    OWNER_ID,
    runCall(),
    prepareRequestOf({ generation: { maxOutputTokens: 33, thinking: null } }),
  )
  const encoded = deployment.config.encode({})
  if (!encoded.ok) throw new Error('fixture configuration rejected')
  const factory = createReferenceModelFactory(deployment)
  const owner: BindingRef = {
    bindingId: OWNER_ID,
    contract: 'agh.model',
    logicalName: 'default',
    providerId: factory.descriptor.providerId,
  }
  return {
    factory,
    configuration: encoded.value,
    dependencies: createTestServiceContainer().dependencies,
    factoryContext: factoryContext(),
    call: runCall(),
    prepareInput: inlineRef(RuntimeMethodSchemaRefs['agh.model'].prepare.input, request),
    recomputeDigest(input) {
      const parsed = input.kind === 'inline' ? validateRuntime('ModelPrepareRequest', input.value) : null
      if (!parsed?.ok) throw new Error('bad prepare input')
      return expectedInputDigest(parsed.value, owner)
    },
    peer,
    foreignOwnedPrepared: () => foreignOwned,
    foreignRunPrepared: () => foreignRun,
    unpreparedHandle: () => unheld,
    async retarget() {
      state.adapterSelectable = false
    },
    async revoke() {
      state.current = false
    },
    async restart() {
      state.current = true
      state.adapterSelectable = true
      return referenceModelFixture(state, peer)
    },
    async close() {},
  }
}
