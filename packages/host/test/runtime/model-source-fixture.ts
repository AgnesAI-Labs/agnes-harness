import { fakeModel } from '@agnes/ai/testkit'
import {
  assemblePrepared,
  createPreparedRegistry,
  type ModelCapture,
  type PreparedEntry,
  type PreparedRegistry,
  type WireIdentity,
} from '@agnes/core'
import { type ActionContext, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  type ActionFrame,
  canonicalJsonDigest,
  type DataRef,
  RuntimeMethodSchemaRefs,
} from '@agnes/protocol/runtime'
import {
  captureModelCatalog,
  type SelectedModelCatalog,
} from '../../src/runtime/model/model-catalog-capture.js'
import type { ModelSourcePorts } from '../../src/runtime/model/model-source-reader.js'

export const fixtureModel: ModelRecord = fakeModel({ id: 'fixture-model', route: 'fixed-route' })
export const fixtureWire: WireIdentity = { sessionKey: 'session-1', slot: 'primary', contractId: null }

/** A capture over a registry holding only the fixture route and model; `output` sets cost.output. */
export function fixtureCatalog(output = 2): SelectedModelCatalog {
  return captureModelCatalog({
    routes: () => [
      { route: 'fixed-route', api: 'openai-completions', baseUrl: 'https://fake.invalid' } as RouteDecl,
    ],
    models: () => [{ ...fixtureModel, cost: { ...fixtureModel.cost, output } }],
    seal: () => {},
  })
}

const inline = (schema: DataRef['schema'], value: Wire.JsonValue): Extract<DataRef, { kind: 'inline' }> => ({
  kind: 'inline',
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})

export function captureOf(catalog: SelectedModelCatalog): ModelCapture {
  const picked = catalog.select('fixed-route', 'fixture-model')
  if (!picked) throw new Error('fixture catalog lacks the fixture model')
  const { route, api, baseUrl } = picked.route
  return { adapterPackageDigest: 'package-1', route: { route, api, baseUrl }, model: picked.model }
}

export function preparedFixture(): Wire.PreparedModelRequest {
  const schema = runtimeAuthorSchemas.StandardToolOutput.ref
  const base: Wire.PreparedModelRequest = {
    preparedId: 'prepared',
    ownerBinding: {
      bindingId: 'model-gateway',
      providerId: 'gateway',
      contract: 'agh.model',
      logicalName: 'default',
    },
    target: {
      routeId: 'fixed-route',
      routeRevision: 1,
      adapter: {
        bindingId: 'adapter',
        providerId: 'agh.default/model-adapter',
        contract: 'agh.model-adapter',
        logicalName: 'default',
      },
      model: 'fixture-model',
      endpointRef: 'fixture-endpoint',
      catalogRevision: 1,
      features: { input: ['text'], output: ['text'], tools: false, structuredOutput: false, streaming: true },
      priceVersion: 'fixture-price-1',
      credentialAudience: 'fixture-endpoint',
      credentialBinding: {
        consumer: 'model',
        secretId: 'fixture-secret',
        accountRef: null,
        serverRef: 'fixture-endpoint',
        audience: 'fixture-endpoint',
        purpose: 'model-inference',
      },
    },
    view: {
      viewId: 'view',
      format: 'fixture-text',
      schema,
      baseRevision: 1,
      items: [
        {
          id: 'item-1',
          kind: 'message',
          body: inline(schema, 'hello'),
          sourceRefs: [],
          provenance: {
            sourceRefs: ['s'],
            producer: {
              bindingId: 'model-gateway',
              providerId: 'gateway',
              contract: 'agh.model',
              logicalName: 'default',
            },
            trustLabels: [],
          },
          trust: 'user',
          tokenEstimate: 1,
          protected: false,
          toolPairRef: null,
          sourceRanges: [],
        } as Wire.ContextItem,
      ],
      tokenEstimate: 1,
      protectedRefs: [],
      inputDigest: 'a'.repeat(64),
      digest: 'b'.repeat(64),
      runtimeInstructionRefs: [],
    },
    inputDigest: 'a'.repeat(64),
    outputSchema: null,
    toolCatalog: null,
    generation: { maxOutputTokens: 32, thinking: null },
    mediaPlans: [],
    estimatedUnits: [],
    hookResults: null,
    sessionParameterRef: {
      authorityId: 'fixture-config',
      recordId: 'parameters',
      recordRevision: 1,
      schema,
      digest: canonicalJsonDigest({}),
    },
    legacyRequestOverrides: null,
    credentialRef: {
      handleId: 'fixture-handle',
      secretId: 'fixture-secret',
      version: 'fixed-v1',
      audience: 'fixture-endpoint',
      expiresAt: '2026-10-05T10:00:00Z',
    },
  }
  return base
}

export const fixtureIds = { runId: 'run-1', sessionId: 'session-1' }

/** The handle reference and registry entry that a real prepare would produce for the fixture request. */
export function assembledFixture(
  catalog = fixtureCatalog(),
  wire = fixtureWire,
  ids: { runId: string; sessionId: string } = fixtureIds,
) {
  const base = preparedFixture()
  const assembled = assemblePrepared({
    ...ids,
    owner: base.ownerBinding,
    request: {
      view: base.view,
      route: base.target,
      outputSchema: base.outputSchema,
      toolCatalog: base.toolCatalog,
      generation: base.generation,
      sessionParameterRef: base.sessionParameterRef,
      credentialRef: base.credentialRef,
    },
    capture: captureOf(catalog),
    wire,
    estimatedUnits: [],
  })
  if (!assembled.ok) throw new Error(assembled.error.detailCode)
  return assembled.value
}

export function preparedRef(
  catalog = fixtureCatalog(),
  wire = fixtureWire,
): Extract<DataRef, { kind: 'inline' }> {
  return assembledFixture(catalog, wire).ref
}

export function fixtureFrame(ref: DataRef, key = 'ext-1'): ActionFrame {
  const request = { preparedCallRef: ref, externalIdempotencyKey: key }
  return {
    actionId: 'act-1',
    runId: fixtureIds.runId,
    input: inline(
      RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.input,
      request as unknown as Wire.JsonValue,
    ),
    requestIdentity: { system: 's', aghRequestId: 'r', idempotencyKey: key, requestDigest: 'a'.repeat(64) },
  } as unknown as ActionFrame
}

export function fixtureContext(signal?: AbortSignal, sessionId = fixtureIds.sessionId): ActionContext {
  const scope = { kind: 'action', sessionId, runId: fixtureIds.runId, actionId: 'act-1' }
  return { call: { signal, scope } } as unknown as ActionContext
}

type Slots = Record<string, { route: string; model: string; fallbacks?: { route: string; model: string }[] }>

export function fixturePorts(
  over: Partial<ModelSourcePorts> & {
    slots?: Slots
    catalog?: SelectedModelCatalog
    wire?: WireIdentity
    registry?: PreparedRegistry
  } = {},
): {
  ports: ModelSourcePorts
  ref: Extract<DataRef, { kind: 'inline' }>
  registry: PreparedRegistry
  entry: PreparedEntry
} {
  const wire = over.wire ?? fixtureWire
  const assembled = assembledFixture(over.catalog ?? fixtureCatalog(), wire)
  const registry = over.registry ?? createPreparedRegistry()
  registry.put(assembled.handleId, assembled.entry)
  const slots = over.slots ?? { primary: { route: 'fixed-route', model: 'fixture-model' } }
  const ports: ModelSourcePorts = {
    packageDigest: over.packageDigest ?? 'package-1',
    registry: over.registry ?? registry,
    prices: over.prices ?? { version: (target) => target.priceVersion },
    session: over.session ?? sessionWith(slots),
    authorize: over.authorize ?? { epoch: () => 1 },
  }
  return { ports, ref: assembled.ref, registry, entry: assembled.entry }
}

export function sessionWith(slots: Slots): ModelSourcePorts['session'] {
  return {
    parameters: async () => ({
      ok: true,
      value: {
        sessionId: 'session-1',
        parameters: {
          schema: runtimeAuthorSchemas.StandardToolOutput.ref,
          value: { model: { route: slots } },
        },
      } as unknown as Wire.SessionParameterRevision,
    }),
  }
}
