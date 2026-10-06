import {
  assemblePrepared,
  type CatalogPick,
  createDefaultModelFactory,
  createPreparedRegistry,
  type ModelDeployment,
  modelCaptureOf,
  modelInputDigest,
  type PreparedRegistry,
} from '@agnes/core'
import { defineGeneratedAuthorSchema, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type { ModelRecord } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  createModelChildPeer,
  type ModelChildPeer,
  type ModelContractFixture,
} from '../../../extension-api/testkit/runtime/contracts/model.js'

export const owner: W.BindingRef = {
  bindingId: 'model-binding',
  providerId: 'agh.default/model',
  contract: 'agh.model',
  logicalName: 'default',
}
export const adapter: W.BindingRef = {
  bindingId: 'adapter',
  providerId: 'agh.default/model-adapter',
  contract: 'agh.model-adapter',
  logicalName: 'default',
}
export const stateBinding: W.BindingRef = {
  bindingId: 'state',
  contract: 'agh.state',
  logicalName: 'default',
  providerId: 'agh.default/state',
}
export const wire = { sessionKey: 'session-1', slot: 'primary' as const, contractId: null }
const model: ModelRecord = {
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
export const pick: CatalogPick = {
  route: { route: 'fixed-route', api: 'openai-completions', baseUrl: 'https://fake.invalid' },
  model,
}
export const config = defineGeneratedAuthorSchema<Record<string, never>>({
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
const schema = runtimeAuthorSchemas.StandardToolOutput.ref
export const inline = (ref: W.SchemaRef, value: unknown): W.DataRef => ({
  kind: 'inline',
  schema: ref,
  value: value as W.JsonValue,
  digest: canonicalJsonDigest(value as never),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})
export function prepareRequest(): W.ModelPrepareRequest {
  const body = 'hello'
  return {
    view: {
      viewId: 'view',
      format: 'fixture-text',
      schema,
      baseRevision: 1,
      items: [
        {
          id: 'item-user',
          kind: 'message',
          body: inline(schema, body),
          sourceRefs: [],
          provenance: { sourceRefs: ['s'], producer: owner, trustLabels: [] },
          trust: 'user',
          tokenEstimate: 1,
          protected: false,
          toolPairRef: null,
          sourceRanges: [],
        } as W.ContextItem,
      ],
      tokenEstimate: 1,
      protectedRefs: [],
      inputDigest: 'a'.repeat(64),
      digest: 'b'.repeat(64),
      runtimeInstructionRefs: [],
    },
    route: {
      routeId: 'fixed-route',
      routeRevision: 1,
      adapter,
      model: 'fixture-model',
      endpointRef: 'fixture-endpoint',
      catalogRevision: 1,
      features: { input: ['text'], output: ['text'], tools: false, structuredOutput: false, streaming: true },
      priceVersion: 'fixture-price-1',
      credentialAudience: 'fixture-endpoint',
      credentialBinding: {
        consumer: 'model',
        secretId: 's',
        accountRef: null,
        serverRef: 'e',
        audience: 'fixture-endpoint',
        purpose: 'model-inference',
      },
    },
    outputSchema: null,
    toolCatalog: null,
    hookResults: null,
    generation: { maxOutputTokens: 32, thinking: null },
    sessionParameterRef: {
      authorityId: 'fixture-config',
      recordId: 'parameters',
      recordRevision: 1,
      schema,
      digest: canonicalJsonDigest({}),
    },
    credentialRef: {
      handleId: 'h',
      secretId: 's',
      version: 'v1',
      audience: 'fixture-endpoint',
      expiresAt: '2099-01-01T00:00:00Z',
    },
  }
}
export function runCall(signal = new AbortController().signal) {
  return {
    principalRef: 'fixture-user',
    scope: {
      kind: 'run',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session-1',
      runId: 'run-1',
    } as W.ScopeRef,
    bindingId: owner.bindingId,
    invocationId: 'invocation',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    traceRef: 'trace',
    authorizationRef: 'authorization',
    signal,
  }
}
export type ModelState = { current: boolean; adapterSelectable: boolean }

/** A handle for the fixture request; by default this process's registry also holds it, so only its binding can refuse it. */
function held(
  over: { owner?: W.BindingRef; runId?: string; tokens?: number; keep?: boolean },
  registry: PreparedRegistry,
): W.DataRef {
  const request = prepareRequest()
  const assembled = assemblePrepared({
    runId: over.runId ?? 'run-1',
    sessionId: 'session-1',
    owner: over.owner ?? owner,
    request: over.tokens
      ? { ...request, generation: { ...request.generation, maxOutputTokens: over.tokens } }
      : request,
    capture: modelCaptureOf('package-1', pick),
    wire,
    estimatedUnits: [],
  })
  if (!assembled.ok) throw new Error(assembled.error.detailCode)
  if (over.keep !== false) registry.put(assembled.value.handleId, assembled.value.entry)
  return assembled.value.ref
}

/** The default implementation's fixture; `state` and `peer` outlive a restart. */
export function defaultModelFixture(
  state: ModelState = { current: true, adapterSelectable: true },
  peer: ModelChildPeer = createModelChildPeer({ adapter, state: stateBinding.bindingId }),
): ModelContractFixture {
  // A new fixture is a new process: it holds no prepared call from before a restart.
  const registry = createPreparedRegistry()
  const deployment: ModelDeployment = {
    packageDigest: 'f'.repeat(64),
    config,
    secrets: null,
    credentials: { verifyIssued: () => true },
    state: stateBinding,
    current: () => state.current,
    catalog: {
      capture: () => ({
        ok: true,
        value: {
          digest: canonicalJsonDigest({ routes: [pick] } as never),
          select: (route, id) => (route === 'fixed-route' && id === 'fixture-model' ? pick : undefined),
        },
      }),
    },
    prices: { version: (target) => target.priceVersion },
    wire: { resolve: async () => ({ ok: true, value: wire }) },
    adapters: {
      select: (target) =>
        state.adapterSelectable && target.bindingId === adapter.bindingId
          ? { binding: adapter, packageDigest: 'package-1' }
          : null,
    },
    registry,
    bridge: { ready: () => ({ ok: true, value: undefined }) },
  }
  const encoded = config.encode({})
  if (!encoded.ok) throw new Error('fixture configuration rejected')
  return {
    factory: createDefaultModelFactory(deployment),
    configuration: encoded.value,
    dependencies: createTestServiceContainer().dependencies,
    factoryContext: {
      instanceId: 'instance',
      bindingId: owner.bindingId,
      scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as W.ScopeRef,
      signal: new AbortController().signal,
    },
    call: runCall(),
    prepareInput: inline(RuntimeMethodSchemaRefs['agh.model'].prepare.input, prepareRequest()),
    recomputeDigest(input) {
      const parsed = input.kind === 'inline' ? validateRuntime('ModelPrepareRequest', input.value) : null
      if (!parsed?.ok) throw new Error('bad prepare input')
      const assembled = assemblePrepared({
        runId: 'run-1',
        sessionId: 'session-1',
        owner,
        request: parsed.value,
        capture: modelCaptureOf('package-1', pick),
        wire,
        estimatedUnits: [],
      })
      if (!assembled.ok) throw new Error(assembled.error.detailCode)
      return modelInputDigest(assembled.value.prepared, modelCaptureOf('package-1', pick), wire)
    },
    peer,
    foreignOwnedPrepared: () => held({ owner: { ...owner, bindingId: 'other-owner' } }, registry),
    foreignRunPrepared: () => held({ runId: 'run-2' }, registry),
    unpreparedHandle: () => held({ tokens: 33, keep: false }, registry),
    async retarget() {
      state.adapterSelectable = false
    },
    async revoke() {
      state.current = false
    },
    async restart() {
      state.current = true
      state.adapterSelectable = true
      return defaultModelFixture(state, peer)
    },
    async close() {},
  }
}
