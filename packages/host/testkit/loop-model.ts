import { createDefaultModelFactory, createPreparedRegistry, type ModelDeployment } from '@agnes/core'
import {
  type CallContext,
  defineGeneratedAuthorSchema,
  type FactoryContext,
  type ScopedDependencies,
} from '@agnes/extension-api/runtime'
import type { ModelRecord } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { modelBridgeReady } from '../src/runtime/model/model-bridge.js'

/** Real C04 over explicit synthetic catalog/price/wire sources. No production State or dispatch owner. */
export async function createLoopModelFixture(
  input: Readonly<{
    route: W.ModelRouteSnapshot
    dependencies: ScopedDependencies
    context: FactoryContext
    tools: NonNullable<ModelDeployment['tools']>
    credentials: NonNullable<ModelDeployment['credentials']>
    current(call: CallContext): boolean
  }>,
) {
  const config = defineGeneratedAuthorSchema<Record<string, never>>({
    ownerPackageId: 'fixture-loop-model',
    name: 'Empty',
    typeId: 'fixture-loop-model/empty@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Empty',
      $defs: { Empty: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    },
  })
  const route = { route: input.route.routeId, api: 'openai-completions', baseUrl: 'https://fixture.invalid' }
  const model: ModelRecord = {
    id: input.route.model,
    name: input.route.model,
    ...route,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
  }
  const registry = createPreparedRegistry()
  const deployment: ModelDeployment = {
    packageDigest: 'a'.repeat(64),
    config,
    secrets: null,
    state: { contract: 'agh.state', logicalName: 'default', providerId: 'fixture/state', bindingId: 'state' },
    current: input.current,
    catalog: {
      capture: () => ({
        ok: true,
        value: {
          digest: canonicalJsonDigest({ route, model } as never),
          select: (name, id) => (name === route.route && id === model.id ? { route, model } : undefined),
        },
      }),
    },
    prices: { version: () => input.route.priceVersion },
    wire: {
      resolve: async ({ context }) => {
        const scope = context.scope
        return scope.kind === 'run' || scope.kind === 'action'
          ? { ok: true, value: { sessionKey: scope.sessionId, slot: 'primary', contractId: null } }
          : {
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'model_scope',
                message: 'Fixture requires run scope',
                diagnosticId: 'loop-model-fixture',
                retryAdvice: { kind: 'never' },
              },
            }
      },
    },
    adapters: {
      select: (target) =>
        canonicalJsonDigest(target) === canonicalJsonDigest(input.route.adapter)
          ? { binding: input.route.adapter, packageDigest: 'a'.repeat(64) }
          : null,
    },
    tools: input.tools,
    credentials: input.credentials,
    registry,
    // This existing probe checks State method availability only; it does not grant dispatch rights.
    bridge: { ready: modelBridgeReady },
  }
  const factory = createDefaultModelFactory(deployment)
  const encoded = config.encode({})
  if (!encoded.ok) throw new Error(encoded.error.detailCode)
  const provider = await factory.create(encoded.value, input.dependencies, input.context)
  return { provider, registry }
}
