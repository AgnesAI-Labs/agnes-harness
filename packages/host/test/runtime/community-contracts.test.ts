import { expect, it } from 'vitest'
import {
  type ContractPackage,
  resolveCommunityContracts,
} from '../../src/runtime/config/community-contracts.js'

const SCHEMA = {
  typeId: 'acme.goals/track-query@1',
  revision: 1,
  digest: 'a'.repeat(64),
}
const CAPABILITY = { capability: 'goals.read', resourceTypes: [] as string[], operations: ['read'] }

function definition(features: string[] = ['progress']) {
  return {
    contract: '@acme/goals/track',
    major: 1,
    ownerPackageId: '@acme/goals',
    scope: 'session',
    features,
    operations: [
      {
        method: 'read',
        kind: 'query',
        inputSchema: SCHEMA,
        outputSchema: SCHEMA,
        requiredCapabilities: [CAPABILITY],
        retrySafety: 'read-only',
      },
    ],
  }
}

function definitionPackage(contract: Record<string, unknown> = definition()): ContractPackage {
  return {
    packageId: '@acme/goals',
    contracts: [contract],
    schemas: [SCHEMA],
  }
}

function providerDescriptor(definitionDigest: string, operations = definition().operations) {
  return {
    providerId: '@acme/goals-impl/track',
    contract: '@acme/goals/track',
    major: 1,
    logicalName: 'track',
    packageVersion: '1.0.0',
    packageDigest: 'b'.repeat(64),
    features: ['progress'],
    scope: 'session',
    configSchema: SCHEMA,
    requires: [],
    capabilities: [CAPABILITY],
    recovery: 'R0',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'lazy',
    operations,
    contractDefinition: { ownerPackageId: '@acme/goals', definitionDigest },
  }
}

function requirement(definitionDigest: string, features: string[] = ['progress'], optional = false) {
  return {
    contract: '@acme/goals/track',
    major: 1,
    logicalName: 'track',
    features,
    scope: 'session',
    optional,
    contractDefinition: { ownerPackageId: '@acme/goals', definitionDigest },
  }
}

function digestOf(contract: Record<string, unknown> = definition()): string {
  const resolved = resolveCommunityContracts([definitionPackage(contract)])
  expect(resolved.status).toBe('accepted')
  const digest = resolved.definitions[0]?.definitionDigest
  if (!digest) throw new Error('missing definition digest')
  return digest
}

it('selects a community provider and keeps capability requests ungranted', () => {
  const digest = digestOf()
  const input: ContractPackage[] = [
    definitionPackage(),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      providers: [{ descriptor: providerDescriptor(digest) }],
    },
    {
      packageId: '@acme/app',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      requirements: [requirement(digest)],
    },
  ]
  const snap = structuredClone(input)
  const resolved = resolveCommunityContracts(input)
  expect(input).toEqual(snap)
  expect(resolved.status).toBe('accepted')
  expect(resolved.definitions.map((item) => item.definitionDigest)).toEqual([digest])
  expect(resolved.providers).toEqual([
    {
      packageId: '@acme/goals-impl',
      providerId: '@acme/goals-impl/track',
      contract: '@acme/goals/track',
      major: 1,
      definitionDigest: digest,
      requests: [CAPABILITY],
      grants: [],
    },
  ])
})

it('uses the same definition digest when keys and features are ordered differently', () => {
  const forward = digestOf(definition(['progress', 'export']))
  const reversed = {
    operations: definition(['export', 'progress']).operations,
    features: ['export', 'progress'],
    scope: 'session',
    ownerPackageId: '@acme/goals',
    major: 1,
    contract: '@acme/goals/track',
  }
  expect(digestOf(reversed)).toBe(forward)
})

it('accepts an official provider without a community definition', () => {
  const resolved = resolveCommunityContracts([
    {
      packageId: '@agnes/host',
      providers: [
        {
          descriptor: {
            providerId: 'agh.default/config',
            contract: 'agh.config',
            major: 1,
            logicalName: 'config',
            packageVersion: '1.0.0',
            packageDigest: 'c'.repeat(64),
            features: [],
            scope: 'runtime',
            configSchema: SCHEMA,
            requires: [],
            capabilities: [],
            recovery: 'R0',
            isolation: ['trusted-in-process'],
            stateCodecs: [],
            activationMode: 'lazy',
            operations: [],
          },
        },
      ],
      requirements: [
        {
          contract: 'agh.config',
          major: 1,
          logicalName: 'config',
          features: [],
          scope: 'runtime',
          optional: false,
        },
      ],
    },
  ])
  expect(resolved.status).toBe('accepted')
  expect(resolved.definitions).toEqual([])
  expect(resolved.providers[0]?.definitionDigest).toBeNull()
  expect(resolved.providers[0]?.grants).toEqual([])
})

it('refuses a community definition on an official contract', () => {
  const resolved = resolveCommunityContracts([
    {
      packageId: '@agnes/host',
      providers: [
        {
          descriptor: {
            providerId: 'agh.default/config',
            contract: 'agh.config',
            major: 1,
            logicalName: 'config',
            packageVersion: '1.0.0',
            packageDigest: 'c'.repeat(64),
            features: [],
            scope: 'runtime',
            configSchema: SCHEMA,
            requires: [],
            capabilities: [],
            recovery: 'R0',
            isolation: ['trusted-in-process'],
            stateCodecs: [],
            activationMode: 'lazy',
            operations: [],
            contractDefinition: { ownerPackageId: '@acme/goals', definitionDigest: 'd'.repeat(64) },
          },
        },
      ],
    },
  ])
  expect(resolved.status).toBe('refused')
  expect(resolved.providers).toEqual([])
  expect(resolved.diagnostics.some((item) => item.code === 'incompatible/contract_definition_mismatch')).toBe(
    true,
  )
})

it('refuses a digest mismatch and accepts the same provider once the digest is corrected', () => {
  const digest = digestOf()
  const wrong = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      providers: [{ descriptor: providerDescriptor('e'.repeat(64)) }],
    },
  ])
  expect(wrong.status).toBe('refused')
  expect(wrong.providers).toEqual([])
  expect(wrong.diagnostics.some((item) => item.expectedDigest === digest)).toBe(true)

  const recovered = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      providers: [{ descriptor: providerDescriptor(digest) }],
    },
  ])
  expect(recovered.status).toBe('accepted')
  expect(recovered.providers[0]?.definitionDigest).toBe(digest)
  expect(recovered.providers[0]?.grants).toEqual([])
})

it.each([
  {
    title: 'a missing major',
    code: 'incompatible/contract_definition_missing',
    contract: () => {
      const value = definition()
      delete (value as { major?: number }).major
      return value
    },
  },
  {
    title: 'an owner that is not the declaring package',
    code: 'conflict/contract_owner_conflict',
    contract: () => ({ ...definition(), ownerPackageId: '@other/goals', contract: '@other/goals/track' }),
  },
  {
    title: 'a control operation',
    code: 'denied/community_authority_forbidden',
    contract: () => {
      const value = definition()
      value.operations[0] = {
        method: 'read',
        kind: 'control',
        inputSchema: SCHEMA,
        outputSchema: SCHEMA,
        requiredCapabilities: [CAPABILITY],
        retrySafety: 'never',
      }
      return value
    },
  },
  {
    title: 'a query that is not read-only',
    code: 'denied/community_authority_forbidden',
    contract: () => {
      const value = definition()
      value.operations[0] = {
        method: 'read',
        kind: 'query',
        inputSchema: SCHEMA,
        outputSchema: SCHEMA,
        requiredCapabilities: [CAPABILITY],
        retrySafety: 'idempotent',
      }
      return value
    },
  },
  {
    title: 'an unknown schema',
    code: 'incompatible/contract_definition_mismatch',
    contract: () => definition(),
    schemas: [] as unknown[],
  },
])('refuses $title', ({ code, contract, schemas }) => {
  const resolved = resolveCommunityContracts([
    { packageId: '@acme/goals', contracts: [contract()], schemas: schemas ?? [SCHEMA] },
  ])
  expect(resolved.status).toBe('refused')
  expect(resolved.providers).toEqual([])
  expect(resolved.diagnostics.some((item) => item.code === code)).toBe(true)
})

it('does not execute a function while looking for a contract', () => {
  let called = false
  const resolved = resolveCommunityContracts([
    {
      packageId: '@acme/goals',
      contracts: [
        () => {
          called = true
          return definition()
        },
      ],
    },
  ])
  expect(called).toBe(false)
  expect(resolved.status).toBe('refused')
  expect(resolved.definitions).toEqual([])
})

it('refuses a development dependency and a non-empty grant list', () => {
  const digest = digestOf()
  const development = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'development' }],
      providers: [{ descriptor: providerDescriptor(digest) }],
    },
  ])
  expect(development.status).toBe('refused')
  expect(
    development.diagnostics.some((item) => item.code === 'incompatible/contract_definition_missing'),
  ).toBe(true)
  expect(development.providers).toEqual([])

  const granted = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      providers: [{ descriptor: providerDescriptor(digest), grants: [CAPABILITY] }],
    },
  ])
  expect(granted.status).toBe('refused')
  expect(granted.providers).toEqual([])
  expect(granted.diagnostics.some((item) => item.code === 'denied/community_authority_forbidden')).toBe(true)
  expect(JSON.stringify(granted)).not.toContain('"grants":[{"capability"')
})

it('refuses a consumer feature the provider does not declare', () => {
  const digest = digestOf(definition(['progress', 'export']))
  const resolved = resolveCommunityContracts([
    definitionPackage(definition(['progress', 'export'])),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      providers: [{ descriptor: providerDescriptor(digest) }],
    },
    {
      packageId: '@acme/app',
      dependencies: [{ packageId: '@acme/goals', kind: 'peer' }],
      requirements: [requirement(digest, ['export'])],
    },
  ])
  expect(resolved.status).toBe('refused')
  expect(resolved.providers).toEqual([])
  expect(resolved.diagnostics.some((item) => item.code === 'incompatible/contract_feature_missing')).toBe(
    true,
  )
})

it('allows an optional consumer to omit a provider and still refuses a bad definition', () => {
  const digest = digestOf()
  const absent = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/app',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      requirements: [requirement(digest, ['progress'], true)],
    },
  ])
  expect(absent.status).toBe('accepted')
  expect(absent.providers).toEqual([])

  const bad = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/app',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      requirements: [requirement('f'.repeat(64), ['progress'], true)],
    },
  ])
  expect(bad.status).toBe('refused')
  expect(bad.diagnostics.some((item) => item.code === 'incompatible/contract_definition_missing')).toBe(true)
})

it('refuses a provider that drops a required capability and keeps a stricter request ungranted', () => {
  const digest = digestOf()
  const dropped = definition().operations[0]
  if (!dropped) throw new Error('missing operation')
  const weaker = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      providers: [
        {
          descriptor: providerDescriptor(digest, [{ ...dropped, requiredCapabilities: [] }]),
        },
      ],
    },
  ])
  expect(weaker.status).toBe('refused')
  expect(weaker.diagnostics.some((item) => item.code === 'incompatible/contract_operation_mismatch')).toBe(
    true,
  )
  expect(weaker.providers).toEqual([])

  const stricterCapability = { capability: 'goals.audit', resourceTypes: [], operations: ['read'] }
  const stricter = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/goals-impl',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
      providers: [
        {
          descriptor: {
            ...providerDescriptor(digest, [
              { ...dropped, requiredCapabilities: [CAPABILITY, stricterCapability] },
            ]),
            capabilities: [CAPABILITY, stricterCapability],
          },
        },
      ],
    },
  ])
  expect(stricter.status).toBe('accepted')
  expect(stricter.providers[0]?.requests).toEqual([CAPABILITY, stricterCapability])
  expect(stricter.providers[0]?.grants).toEqual([])
})

it('refuses two definitions of one contract instead of letting the later one win', () => {
  const resolved = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/other',
      contracts: [{ ...definition(), ownerPackageId: '@acme/other', contract: '@acme/other/track' }],
      schemas: [SCHEMA],
    },
  ])
  expect(resolved.status).toBe('accepted')

  const conflict = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/goals',
      contracts: [definition(), definition(['export'])],
      schemas: [SCHEMA],
    },
  ])
  expect(conflict.status).toBe('refused')
  expect(conflict.definitions).toEqual([])
  expect(
    conflict.diagnostics.some(
      (item) =>
        item.code === 'incompatible/contract_definition_mismatch' ||
        item.code === 'conflict/contract_owner_conflict',
    ),
  ).toBe(true)
})

it('does not treat a package dependency as a service selection', () => {
  const digest = digestOf()
  const resolved = resolveCommunityContracts([
    definitionPackage(),
    {
      packageId: '@acme/app',
      dependencies: [{ packageId: '@acme/goals', kind: 'runtime' }],
    },
  ])
  expect(resolved.status).toBe('accepted')
  expect(resolved.providers).toEqual([])
  expect(resolved.definitions[0]?.definitionDigest).toBe(digest)
})
