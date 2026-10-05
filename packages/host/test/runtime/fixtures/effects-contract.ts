import {
  defineGeneratedAuthorSchema,
  type EmptyAuthorConfig,
  type ProviderFactory,
  type ScopedDependencies,
  type ServiceProvider,
} from '@agnes/extension-api/runtime'
import type { contracts } from '@agnes/extension-api/testkit'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
} from '@agnes/protocol/runtime'
import type { EffectsAuthority } from '../../../../core/src/runtime/effects/authority.js'

type EffectsContractFixture = contracts.EffectsContractFixture

const configCodec = defineGeneratedAuthorSchema<EmptyAuthorConfig>({
  ownerPackageId: 'effects-fixture',
  name: 'EmptyConfig',
  typeId: 'effects-fixture/empty-config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/EmptyConfig',
    $defs: {
      EmptyConfig: { type: 'object', additionalProperties: false, required: [], properties: {} },
    },
  },
})

import { createEffectsAuthorityFixture } from './effects-authority.js'

export async function createEffectsContractFixture(
  file: string,
  create: (
    authority: EffectsAuthority,
    descriptor: ProviderDescriptor,
    codec: typeof configCodec,
  ) => ProviderFactory<ServiceProvider>,
  physical?: (identity: import('@agnes/protocol/runtime').RequestIdentity) => Promise<void>,
  checkpoint?: (stage: 'admitted' | 'receipt') => Promise<void>,
): Promise<EffectsContractFixture> {
  const source = await createEffectsAuthorityFixture(file, physical)
  if (checkpoint) {
    const admit = source.authority.admit,
      intake = source.authority.intake
    source.authority.admit = async (...args) => {
      const result = await admit(...args)
      await checkpoint('admitted')
      return result
    }
    source.authority.intake = async (...args) => {
      const result = await intake(...args)
      await checkpoint('receipt')
      return result
    }
  }
  const descriptor: ProviderDescriptor = {
    providerId: 'fixture-effects',
    contract: 'agh.effects',
    major: 1,
    logicalName: 'default',
    packageVersion: '1.0.0',
    packageDigest: 'a'.repeat(64),
    features: [],
    scope: 'installation',
    configSchema: configCodec.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: Object.entries(RuntimeServiceCatalog['agh.effects'].methods).map(([method, definition]) => {
      const refs =
        RuntimeMethodSchemaRefs['agh.effects'][
          method as keyof (typeof RuntimeMethodSchemaRefs)['agh.effects']
        ]
      return {
        method,
        kind: definition.kind,
        inputSchema: refs.input,
        outputSchema: refs.output,
        requiredCapabilities: [],
        retrySafety: 'reconcile-first' as const,
      }
    }),
  }
  const body = {
    committedActionRef: source.ticket.original.action,
    expectedWriterEpoch: 1,
    expectedAuthorityEpoch: 1,
  }
  const bytes = boundedCanonicalJson(body, { maxBytes: 4096, maxDepth: 16, maxMembers: 64 })
  if (!bytes.ok) throw Error('Fixture input refused')
  const configBody = boundedCanonicalJson({}, { maxBytes: 4096, maxDepth: 16, maxMembers: 64 })
  if (!configBody.ok) throw Error('Fixture config refused')
  const dependencies: ScopedDependencies = {
    get() {
      return {
        ok: false,
        error: {
          code: 'incompatible',
          detailCode: 'fixture_not_bound',
          message: 'Unbound service',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'effects-fixture',
        },
      }
    },
    async openScope() {
      return { ok: true, value: dependencies }
    },
    async close() {},
  }
  let closed = false
  return {
    factory: create(source.authority, descriptor, configCodec),
    config: {
      kind: 'inline',
      schema: configCodec.ref,
      value: configBody.value.json,
      digest: canonicalJsonDigest(configBody.value.json),
      bytes: configBody.value.bytes,
    },
    dependencies,
    factoryContext: {
      instanceId: 'effects',
      scope: source.context.scope,
      bindingId: 'binding',
      signal: new AbortController().signal,
    },
    context: source.context,
    dispatch: {
      target: {
        bindingId: 'binding',
        contract: 'agh.effects',
        logicalName: 'default',
        providerId: descriptor.providerId,
      },
      method: 'dispatch',
      input: {
        kind: 'inline',
        schema: RuntimeMethodSchemaRefs['agh.effects'].dispatch.input,
        value: bytes.value.json,
        digest: canonicalJsonDigest(bytes.value.json),
        bytes: bytes.value.bytes,
      },
    },
    physicalRequests: source.requests,
    revoke: source.revoke,
    cancel() {
      source.context.signal.throwIfAborted()
      source.revoke()
    },
    reopen: () => createEffectsContractFixture(file, create),
    async close() {
      if (!closed) {
        closed = true
        source.close()
      }
    },
  }
}
