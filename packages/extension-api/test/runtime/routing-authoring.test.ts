import { readFileSync } from 'node:fs'
import {
  type BindingRef,
  canonicalJsonDigest,
  type DataRef,
  type ModelRouteSnapshot,
  type RoutingSelectInput,
  type RoutingSelectResult,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { normalizeAuthorSchemaDocument } from '../../../protocol/tools/author-schema-document.js'
import { adaptProvider, defineRoutingStrategy } from '../../src/runtime/authoring.js'
import { defineGeneratedAuthorSchema } from '../../src/runtime/authoring-source.js'
import type { CallContext, Outcome } from '../../src/runtime/public-api.js'
import {
  createRoutingAlgorithmFactory,
  createRoutingStrategyFactory,
  routingInputSchema,
  routingResultSchema,
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
function compute(provider: import('../../src/runtime/public-api.js').ServiceProvider) {
  if (!provider.compute) throw new Error('compute missing')
  return provider.compute
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
    context,
    revoke: () => {
      live = false
    },
    clone: () => ({ ...context }),
    container,
  }
}
const request = (data = input()) => ({
  target: binding,
  method: 'select',
  input: value(routingInputSchema.encode(data)),
})

describe('complete routing author execution', () => {
  it.each([false, true])(
    'runs a successful selected strategy through the public compute method (algorithm=%s)',
    async (algorithm) => {
      const h = harness((data) => ({ route: first(data), reason: 'authorized fixed candidate' }), algorithm)
      const provider = await h.open()
      expect((await provider.ready(h.context)).ok).toBe(true)
      const requirement = {
        contract: 'agh.routing',
        major: 1,
        logicalName: 'default',
        features: [],
        scope: 'workspace' as const,
        optional: false,
      }
      h.container.register({ requirement, binding, compute: compute(provider) })
      const selected = value(h.container.dependencies.get(requirement))
      const output = value(await selected.compute(request(), h.context))
      expect(output.kind).toBe('inline')
      if (output.kind !== 'inline') throw new Error('unexpected blob')
      expect(value(routingResultSchema.parse(output.value)).route.model).toBe('fixed-model')
      expect(output.digest).toBe(canonicalJsonDigest(output.value))
      expect((await provider.health(h.context)).ok).toBe(true)
      await provider.close('shutdown')
      expect((await compute(provider)(request(), h.context)).ok).toBe(false)
    },
  )
  it('rejects a policy that preserves route id but changes price/model/identity', async () => {
    const h = harness((data) => ({
      route: { ...first(data), priceVersion: 'new-price' },
      reason: 'changed',
    }))
    const p = await h.open()
    await p.ready(h.context)
    const result = await compute(p)(request(), h.context)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detailCode).toBe('routing_candidate')
  })
  it('rejects a candidate that lacks required features', async () => {
    const h = harness((data) => ({ route: first(data), reason: 'selected' })),
      p = await h.open()
    await p.ready(h.context)
    const data = input()
    data.requiredFeatures.tools = true
    expect((await compute(p)(request(data), h.context)).ok).toBe(false)
  })
  it('rejects wrong data digest and untrusted copied context', async () => {
    const h = harness((data) => ({ route: first(data), reason: 'selected' })),
      p = await h.open()
    await p.ready(h.context)
    const r = request()
    r.input = { ...r.input, digest: 'b'.repeat(64) } as DataRef
    expect((await compute(p)(r, h.context)).ok).toBe(false)
    expect((await compute(p)(request(), h.clone())).ok).toBe(false)
  })
  it('refuses replaced nested schema rather than guessing its budget semantics', async () => {
    const h = harness((data) => ({ route: first(data), reason: 'selected' })),
      p = await h.open()
    await p.ready(h.context)
    const data = input()
    data.budgetSnapshot = value(routingResultSchema.encode({ route: first(data), reason: 'not budget' }))
    expect((await compute(p)(request(data), h.context)).ok).toBe(false)
  })
  it('rechecks current authorization after awaiting the author decision', async () => {
    const h = harness(async (data) => {
      await Promise.resolve()
      h.revoke()
      return { route: first(data), reason: 'late' }
    })
    const p = await h.open()
    await p.ready(h.context)
    expect((await compute(p)(request(), h.context)).ok).toBe(false)
  })
  it('drains a pending decision and never releases its late result', async () => {
    let release: ((result: RoutingSelectResult) => void) | undefined
    const h = harness(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      ),
      p = await h.open()
    await p.ready(h.context)
    const pending = compute(p)(request(), h.context)
    await Promise.resolve()
    await Promise.resolve()
    const drain = value(await p.drain(new Date().toISOString(), h.context))
    expect(drain.state).toBe('blocked')
    expect((await pending).ok).toBe(false)
    const data = input()
    if (!release) throw new Error('pending decision missing')
    release({ route: first(data), reason: 'late' })
    expect((await compute(p)(request(), h.context)).ok).toBe(false)
  })
  it('requires the whole algorithm method table', async () => {
    const h = harness((data) => ({ route: first(data), reason: 'selected' }))
    const declaration = adaptProvider({
      id: 'bad-routing',
      contract: 'agh.routing',
      requires: [],
      permissions: [],
      make: () => ({
        select: () => ({ route: first(input()), reason: 'selected' }),
        extra: () => 1,
      }),
    })
    const factory = createRoutingAlgorithmFactory(declaration.definition, {
      packageDigest: 'a'.repeat(64),
      packageVersion: '1.0.0',
      config,
      budget: budgetCodec,
      inputMeta: metaCodec,
      current: () => true,
    })
    await expect(
      factory.create(value(config.encode({})), h.container.dependencies, {
        instanceId: 'bad',
        bindingId: 'bad',
        scope,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/exactly select/)
  })
})
