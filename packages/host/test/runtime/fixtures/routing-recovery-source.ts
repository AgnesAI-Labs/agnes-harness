import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema, routingInputSchema } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type { BindingRef, RoutingSelectInput } from '@agnes/protocol/runtime'

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

import {
  canonicalJsonDigest,
  type DataRef,
  type ProviderDescriptor,
  type RoutingSelectResult,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createReferenceRoutingFactory } from '../../../../../examples/runtime-reference/src/providers/routing.js'
import { createDefaultRoutingFactory } from '../../../src/runtime/providers/routing.js'

export type RoutingRecoveryKind = 'default' | 'reference'
export interface RoutingRecoverySeed {
  readonly kind: RoutingRecoveryKind
  readonly context: Omit<CallContext, 'signal'>
  readonly configuration: DataRef
  readonly input: DataRef
  readonly configurationSchema: typeof config.ref
  readonly budgetSchema: typeof budgetCodec.ref
  readonly metadataSchema: typeof metaCodec.ref
  readonly priority: readonly string[]
  readonly packageDigest: string
  readonly packageVersion: string
}
/** Restricted offline issuer data; this does not reconstruct public caller authorization. */
export function routingRecoverySeed(kind: RoutingRecoveryKind): RoutingRecoverySeed {
  return {
    kind,
    context: {
      principalRef: 'fixture-user',
      scope,
      bindingId: binding.bindingId,
      invocationId: 'original-routing-invocation',
      deadline: new Date(Date.now() + 60000).toISOString(),
      traceRef: 'original-trace',
      authorizationRef: 'fixture-owner-authorization',
    },
    configuration: value(config.encode({})),
    input: value(routingInputSchema.encode(input())),
    configurationSchema: config.ref,
    budgetSchema: budgetCodec.ref,
    metadataSchema: metaCodec.ref,
    priority: ['primary'],
    packageDigest: 'a'.repeat(64),
    packageVersion: '1.0.0',
  }
}
export interface RoutingRecoveryResult {
  descriptor: ProviderDescriptor
  result: DataRef
  route: RoutingSelectResult
  inputDigest: string
  configurationDigest: string
}
export async function recoverRoutingSelection(
  seed: RoutingRecoverySeed,
  onSelected?: (result: RoutingRecoveryResult) => Promise<void>,
) {
  if (seed.kind !== 'default' && seed.kind !== 'reference') throw new Error('Unknown original implementation')
  if (
    canonicalJsonDigest(seed.configurationSchema) !== canonicalJsonDigest(config.ref) ||
    canonicalJsonDigest(seed.budgetSchema) !== canonicalJsonDigest(budgetCodec.ref) ||
    canonicalJsonDigest(seed.metadataSchema) !== canonicalJsonDigest(metaCodec.ref)
  )
    throw new Error('Original schema changed')
  if (seed.configuration.kind !== 'inline' || !config.parse(seed.configuration.value).ok)
    throw new Error('Bad fixed configuration')
  if (seed.input.kind !== 'inline' || !validateRuntime('RoutingSelectInput', seed.input.value).ok)
    throw new Error('Bad fixed input')
  if (seed.input.digest !== canonicalJsonDigest(seed.input.value)) throw new Error('Input proof changed')
  const context: CallContext = { ...seed.context, signal: new AbortController().signal }
  const issued = new WeakSet<object>([context])
  const container = createTestServiceContainer()
  const deployment = {
    packageDigest: seed.packageDigest,
    packageVersion: seed.packageVersion,
    config,
    budget: budgetCodec,
    inputMeta: metaCodec,
    current: (call: CallContext) => issued.has(call),
  }
  const factory =
    seed.kind === 'default'
      ? createDefaultRoutingFactory({ ...deployment, priority: seed.priority })
      : createReferenceRoutingFactory(deployment)
  const provider = await factory.create(seed.configuration, container.dependencies, {
    instanceId: 'original-instance',
    bindingId: context.bindingId,
    scope: context.scope,
    signal: new AbortController().signal,
  })
  try {
    const ready = await provider.ready(context)
    if (!ready.ok) throw new Error('Original provider not ready')
    if (!provider.compute) throw new Error('Missing select')
    const requirement = {
      contract: 'agh.routing',
      major: 1,
      logicalName: factory.descriptor.logicalName,
      features: [],
      scope: 'workspace' as const,
      optional: false,
    }
    const target = {
      bindingId: context.bindingId,
      contract: 'agh.routing',
      logicalName: factory.descriptor.logicalName,
      providerId: factory.descriptor.providerId,
    }
    container.register({ requirement, binding: target, compute: provider.compute })
    const selected = value(container.dependencies.get(requirement))
    const result = value(await selected.compute({ target, method: 'select', input: seed.input }, context))
    if (result.kind !== 'inline') throw new Error('Expected original inline selection')
    const parsed = validateRuntime('RoutingSelectResult', result.value)
    if (!parsed.ok) throw new Error('Invalid selection')
    const data = validateRuntime('RoutingSelectInput', seed.input.value)
    if (
      !data.ok ||
      !data.value.allowedRoutes.some(
        (route) => canonicalJsonDigest(route) === canonicalJsonDigest(parsed.value.route),
      )
    )
      throw new Error('Rerouted outside original source')
    const proof = {
      descriptor: factory.descriptor,
      result,
      route: parsed.value,
      inputDigest: canonicalJsonDigest(seed.input),
      configurationDigest: canonicalJsonDigest(seed.configuration),
    }
    if (onSelected) await onSelected(proof)
    return proof
  } finally {
    await provider.close('shutdown')
  }
}

/** Codec validation here proves plain JSON bytes only, never caller authorization. */
export function routingProofDigest(value: unknown): string {
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) throw new Error('Invalid fixed routing JSON proof')
  return canonicalJsonDigest(parsed.value)
}
