import { type CallContext, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type { ModelRecord } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { CatalogPick } from '../../src/runtime/model/prepared-call.js'
import type { WireIdentity } from '../../src/runtime/model/wire-request.js'

export const fixtureModel: ModelRecord = {
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
export const fixtureRoute = {
  route: 'fixed-route',
  api: 'openai-completions',
  baseUrl: 'https://fake.invalid',
}
export const fixtureWire: WireIdentity = { sessionKey: 'session-1', slot: 'primary', contractId: null }
export const fixtureOwner: W.BindingRef = {
  bindingId: 'model-binding',
  providerId: 'agh.default/model',
  contract: 'agh.model',
  logicalName: 'default',
}
export const fixtureAdapter: W.BindingRef = {
  bindingId: 'adapter',
  providerId: 'agh.default/model-adapter',
  contract: 'agh.model-adapter',
  logicalName: 'default',
}
export function fixtureCatalog(output = 2) {
  const pick: CatalogPick = {
    route: fixtureRoute,
    model: { ...fixtureModel, cost: { ...fixtureModel.cost, output } },
  }
  return {
    digest: canonicalJsonDigest({ routes: [pick] } as never) as string,
    select: (route: string, model: string) =>
      route === 'fixed-route' && model === 'fixture-model' ? pick : undefined,
  }
}
export function fixturePick(output = 2): CatalogPick {
  const pick = fixtureCatalog(output).select('fixed-route', 'fixture-model')
  if (!pick) throw new Error('fixture catalog lost its pick')
  return pick
}
export function textItem(trust: 'system' | 'user', body: string): W.ContextItem {
  return {
    id: `item-${trust}-${body.length}`,
    kind: 'message',
    body: {
      kind: 'inline',
      schema: runtimeAuthorSchemas.StandardToolOutput.ref,
      value: body,
      digest: canonicalJsonDigest(body),
      bytes: new TextEncoder().encode(JSON.stringify(body)).length,
    },
    sourceRefs: [],
    provenance: { sourceRefs: ['s'], producer: fixtureOwner, trustLabels: [] },
    trust,
    tokenEstimate: 1,
    protected: false,
    toolPairRef: null,
    sourceRanges: [],
  } as W.ContextItem
}
export function prepareRequest(over: Partial<W.ModelPrepareRequest> = {}): W.ModelPrepareRequest {
  return {
    view: {
      viewId: 'view',
      format: 'fixture-text',
      schema: runtimeAuthorSchemas.StandardToolOutput.ref,
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
      adapter: fixtureAdapter,
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
      schema: runtimeAuthorSchemas.StandardToolOutput.ref,
      digest: canonicalJsonDigest({}),
    },
    credentialRef: null,
    ...over,
  }
}
export function runScope(runId = 'run-1'): W.ScopeRef {
  return {
    kind: 'run',
    installationId: 'installation',
    runtimeId: 'runtime',
    workspaceId: 'workspace',
    sessionId: 'session-1',
    runId,
  } as W.ScopeRef
}
export function callContext(
  over: { signal?: AbortSignal; scope?: W.ScopeRef; deadlineMs?: number } = {},
): CallContext {
  return {
    principalRef: 'fixture-user',
    scope: over.scope ?? runScope(),
    bindingId: fixtureOwner.bindingId,
    invocationId: 'invocation',
    deadline: new Date(Date.now() + (over.deadlineMs ?? 60_000)).toISOString(),
    traceRef: 'trace',
    authorizationRef: 'authorization',
    signal: over.signal ?? new AbortController().signal,
  }
}
