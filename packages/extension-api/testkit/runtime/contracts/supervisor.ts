import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
} from '@agnes/protocol/runtime'

const emptyConfig = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: '@agnes/supervisor-contract',
  name: 'RuntimeEmptyConfig',
  typeId: '@agnes/supervisor-contract/empty@1',
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

const catalog = RuntimeServiceCatalog['agh.supervisor'].methods
const refs = RuntimeMethodSchemaRefs['agh.supervisor']
type Method = keyof typeof catalog
const METHODS = Object.keys(catalog) as readonly Method[]

/** The official runtime-scope descriptor every implementation of the contract must be installable under. */
export function supervisorDescriptor(providerId: string, logicalName = 'default'): W.ProviderDescriptor {
  return {
    providerId,
    contract: 'agh.supervisor',
    major: 1,
    logicalName,
    packageVersion: '1.0.0',
    packageDigest: canonicalJsonDigest({ providerId, contract: 'agh.supervisor' }),
    features: [],
    scope: 'runtime',
    configSchema: emptyConfig.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: METHODS.map((method) => ({
      method,
      kind: catalog[method].kind,
      inputSchema: refs[method].input,
      outputSchema: refs[method].output,
      requiredCapabilities: [],
      retrySafety: catalog[method].kind === 'query' ? 'read-only' : 'never',
    })),
  } as W.ProviderDescriptor
}
/** An inline request body for one method, measured the way the Supervisor measures it. */
export function supervisorInput(method: Method, value: unknown): W.DataRef {
  const body = boundedCanonicalJson(value, { maxBytes: 65_536, maxDepth: 64, maxMembers: 10_000 })
  if (!body.ok) throw new Error('Supervisor contract: request body exceeds the inline limit')
  return {
    kind: 'inline',
    schema: refs[method].input,
    value: body.value.json,
    bytes: body.value.bytes,
    digest: canonicalJsonDigest(body.value.json),
  }
}
export function supervisorConfig(): W.DataRef {
  return { kind: 'inline', schema: emptyConfig.ref, value: {}, bytes: 2, digest: canonicalJsonDigest({}) }
}
