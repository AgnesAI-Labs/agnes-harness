import { readFileSync } from 'node:fs'
import type {
  BindingRef,
  ModelRouteSnapshot,
  RoutingSelectInput,
  RoutingSelectResult,
} from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { normalizeAuthorSchemaDocument } from '../../../protocol/tools/author-schema-document.js'
import { adaptProvider, defineRoutingStrategy } from '../../src/runtime/authoring.js'
import { defineGeneratedAuthorSchema } from '../../src/runtime/authoring-source.js'
import type { CallContext, Outcome } from '../../src/runtime/public-api.js'
import {
  createRoutingAlgorithmFactory,
  createRoutingStrategyFactory,
  routingInputSchema,
} from '../../src/runtime/routing-authoring.js'
import { createTestServiceContainer } from '../../testkit/runtime/index.js'

const config = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: '@fixture/routing',
  name: 'RuntimeEmptyConfig',
  typeId: '@fixture/routing/empty@1',
  revision: 1,
  document: normalizeAuthorSchemaDocument(
    JSON.parse(
      readFileSync(
        new URL('../../../protocol/schema/runtime/empty-config.schema.json', import.meta.url),
        'utf8',
      ),
    ),
    'RuntimeEmptyConfig',
  ),
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
  providerId: 'fixture-routing',
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
function first(data: Readonly<RoutingSelectInput>): ModelRouteSnapshot {
  const route = data.allowedRoutes[0]
  if (!route) throw new Error('fixture candidate missing')
  return route
}
function harness(
  select: (input: Readonly<RoutingSelectInput>) => RoutingSelectResult | Promise<RoutingSelectResult>,
  algorithm = false,
) {
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
  const factory = algorithm
    ? createRoutingAlgorithmFactory(
        adaptProvider({
          id: binding.providerId,
          contract: 'agh.routing',
          requires: [],
          permissions: [],
          make: () => ({ select }),
        }).definition,
        deployment,
      )
    : createRoutingStrategyFactory(defineRoutingStrategy({ id: binding.providerId, select }), deployment)
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

import { runRoutingContractScenario } from '../../testkit/runtime/contracts/routing.js'
import { SCENARIOS } from '../../testkit/runtime/evidence.js'

it.each(SCENARIOS)('runs actual selected Routing contract %s', async (scenario) => {
  const open = async () => {
    const h = harness((data) => ({ route: first(data), reason: 'Fixed TCK candidate' }))
    const current = {
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
    return current
  }
  const evidence = await runRoutingContractScenario(scenario, open)
  expect(evidence.providerDigest).toBe('a'.repeat(64))
})
