import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema, routingInputSchema } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type { BindingRef, RoutingSelectInput } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'

const config = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: '@fixture/routing',
  name: 'RuntimeEmptyConfig',
  typeId: '@fixture/routing/empty@1',
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
function fixtureCodec(name: string) {
  return defineGeneratedAuthorSchema<{ value: number }>({
    ownerPackageId: '@fixture/routing',
    name,
    typeId: `@fixture/routing/${name.toLowerCase()}@1`,
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: `#/$defs/${name}`,
      $defs: {
        [name]: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'integer', minimum: 0, maximum: 1000000 } },
          required: ['value'],
        },
      },
    },
  })
}
const budgetCodec = fixtureCodec('Budget'),
  metaCodec = fixtureCodec('Metadata')
const value = <T>(result: Outcome<T>): T => {
  if (!result.ok) throw new Error(result.error.detailCode)
  return result.value
}
const binding: BindingRef = {
  bindingId: 'routing-binding',
  contract: 'agh.routing',
  logicalName: 'default',
  providerId: 'agh.default/routing',
}
const scope = {
  kind: 'workspace' as const,
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
}
function input(): RoutingSelectInput {
  return {
    purpose: 'answer',
    catalogRevision: 1,
    requiredFeatures: {
      input: ['text'],
      output: ['text'],
      streaming: true,
      tools: false,
      structuredOutput: false,
    },
    allowedRoutes: [
      {
        routeId: 'primary',
        routeRevision: 1,
        adapter: {
          bindingId: 'adapter',
          contract: 'agh.model-adapter',
          logicalName: 'default',
          providerId: 'adapter-provider',
        },
        model: 'fixed-model',
        endpointRef: 'endpoint',
        catalogRevision: 1,
        features: {
          input: ['text'],
          output: ['text'],
          streaming: true,
          tools: false,
          structuredOutput: false,
        },
        priceVersion: 'price-1',
        credentialAudience: 'model-endpoint',
        credentialBinding: null,
      },
    ],
    budgetSnapshot: value(budgetCodec.encode({ value: 10 })),
    inputMeta: value(metaCodec.encode({ value: 1 })),
  }
}

function harness(reference = false) {
  const context: CallContext = {
    principalRef: 'fixture-user',
    scope,
    bindingId: binding.bindingId,
    invocationId: 'invocation',
    deadline: new Date(Date.now() + 10000).toISOString(),
    traceRef: 'trace',
    authorizationRef: 'fixture-authorization',
    signal: new AbortController().signal,
  }
  const container = createTestServiceContainer()
  const issued = new WeakSet<object>([context])
  let live = true
  const deployment = {
    packageDigest: 'a'.repeat(64),
    packageVersion: '1.0.0',
    config,
    budget: budgetCodec,
    inputMeta: metaCodec,
    current: (call: CallContext) => live && issued.has(call),
  }
  const factory = reference
    ? createReferenceRoutingFactory(deployment)
    : createDefaultRoutingFactory({ ...deployment, priority: ['primary'] })
  const open = () =>
    factory.create(value(config.encode({})), container.dependencies, {
      instanceId: 'instance',
      bindingId: binding.bindingId,
      scope,
      signal: new AbortController().signal,
    })
  return {
    open,
    factory,
    deployment,
    context,
    revoke: () => {
      live = false
    },
    clone: () => ({ ...context }),
    container,
  }
}

import { createReferenceRoutingFactory } from '../../../../examples/runtime-reference/src/providers/routing.js'
import { runRoutingContractScenario } from '../../../extension-api/testkit/runtime/contracts/routing.js'
import { SCENARIOS } from '../../../extension-api/testkit/runtime/evidence.js'
import { createDefaultRoutingFactory } from '../../src/runtime/providers/routing.js'

for (const reference of [false, true])
  it.each(SCENARIOS)(
    `selected routing implementation reference=${reference} scenario=%s`,
    async (scenario) => {
      const open = async () => {
        const h = harness(reference)
        return {
          factory: h.factory,
          configuration: value(config.encode({})),
          dependencies: h.container.dependencies,
          factoryContext: {
            instanceId: 'tck-instance',
            bindingId: binding.bindingId,
            scope,
            signal: new AbortController().signal,
          },
          call: h.context,
          input: value(routingInputSchema.encode(input())),
          revoke: async () => h.revoke(),
          restart: open,
          close: async () => {},
        }
      }
      await expect(runRoutingContractScenario(scenario, open)).resolves.toHaveProperty(
        'providerDigest',
        'a'.repeat(64),
      )
    },
  )
