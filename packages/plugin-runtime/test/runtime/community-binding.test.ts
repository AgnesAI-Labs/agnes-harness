import { describe, expect, it } from 'vitest'
import {
  type CommunityContractDefinition,
  type CommunityOperation,
  communityDefinitionDigest,
} from '../../src/runtime/community-contract.js'
import type { AuthorizedPorts } from '../../src/runtime/cordis-adapter.js'
import { FixedCordisAssembly } from '../../src/runtime/cordis-adapter.js'

const DIGEST = 'a'.repeat(64)
const SCHEMA = { typeId: 'acme/goal@1', revision: 1, digest: DIGEST }
const LIST: CommunityOperation = {
  method: 'list',
  kind: 'query',
  inputSchema: SCHEMA,
  outputSchema: SCHEMA,
  requiredCapabilities: [],
  retrySafety: 'read-only',
}

function definition(operations: readonly CommunityOperation[] = [LIST]): CommunityContractDefinition {
  return {
    contract: 'acme/goals',
    major: 1,
    ownerPackageId: 'acme',
    scope: 'workspace',
    features: ['goals.v1'],
    operations,
  }
}

function ref(source: CommunityContractDefinition) {
  return { ownerPackageId: source.ownerPackageId, definitionDigest: communityDefinitionDigest(source) }
}

describe('community contract binding', () => {
  it('lets a consumer keep its source while a later implementation replaces the provider', async () => {
    const source = definition()
    const cited = ref(source)
    const seen: string[] = []
    const consume = (ports: AuthorizedPorts) => {
      const bound = ports.get({ contract: 'acme/goals', logicalName: 'default', scope: 'workspace' }) as {
        providerId?: string
      }
      seen.push(bound.providerId ?? 'missing')
    }
    const assembly = new FixedCordisAssembly()
    await assembly.open({
      generationId: 'old',
      contracts: [source],
      providers: [
        {
          providerId: 'provider-a',
          contract: 'acme/goals',
          major: 1,
          logicalName: 'default',
          scope: 'workspace',
          features: ['goals.v1'],
          packageDigest: DIGEST,
          capabilities: [],
          requires: [],
          contractDefinition: cited,
          operations: [LIST],
          token: () => 'a',
        },
        {
          providerId: 'consumer',
          contract: 'agh.reader',
          major: 1,
          logicalName: 'default',
          scope: 'workspace',
          features: [],
          packageDigest: DIGEST,
          capabilities: [],
          requires: [
            {
              contract: 'acme/goals',
              major: 1,
              logicalName: 'default',
              scope: 'workspace',
              features: ['goals.v1'],
              optional: false,
              capture: 'instance',
              contractDefinition: cited,
            },
          ],
          create: consume,
        },
      ],
    })
    assembly.pinRun('run-old')
    await assembly.open({
      generationId: 'next',
      contracts: [source],
      providers: [
        {
          providerId: 'provider-c',
          contract: 'acme/goals',
          major: 1,
          logicalName: 'default',
          scope: 'workspace',
          features: ['goals.v1'],
          packageDigest: 'b'.repeat(64),
          capabilities: [],
          requires: [],
          contractDefinition: cited,
          operations: [LIST],
          token: () => 'c',
        },
        {
          providerId: 'consumer',
          contract: 'agh.reader',
          major: 1,
          logicalName: 'default',
          scope: 'workspace',
          features: [],
          packageDigest: DIGEST,
          capabilities: [],
          requires: [
            {
              contract: 'acme/goals',
              major: 1,
              logicalName: 'default',
              scope: 'workspace',
              features: ['goals.v1'],
              optional: false,
              capture: 'instance',
              contractDefinition: cited,
            },
          ],
          create: consume,
        },
      ],
    })
    expect(seen).toEqual(['provider-a', 'provider-c'])
    expect(consume).toBe(consume)
    expect(assembly.invoke('run-old', 'provider-a').token).toBe('a')
    assembly.disable('old')
    expect(() => assembly.pinRun('run-new', 'old')).toThrow(expect.objectContaining({ code: 'disabled' }))
    expect(assembly.invoke('run-old', 'provider-a').generationId).toBe('old')
    const drained = await assembly.drain('old', Date.now())
    expect(drained.state).toBe('drained')
    expect(() => assembly.invoke('run-old', 'provider-a')).toThrow(
      expect.objectContaining({ code: 'closed' }),
    )
    assembly.noteUnknown('old', 'action-unknown')
    const closed = await assembly.close('old')
    expect(closed.resentActionIds).toEqual([])
    expect(assembly.view('old').unknownActionIds).toEqual(['action-unknown'])
    expect(assembly.invoke('run-next', 'provider-c').token).toBe('c')
  })

  it('refuses a bad community definition before the provider is created', async () => {
    const source = definition()
    const cited = ref(source)
    let created = 0
    const assembly = new FixedCordisAssembly()
    const provider = {
      providerId: 'provider-a',
      contract: 'acme/goals',
      major: 1,
      logicalName: 'default',
      scope: 'workspace' as const,
      features: ['goals.v1'],
      packageDigest: DIGEST,
      capabilities: [],
      requires: [],
      operations: [LIST],
      create() {
        created += 1
      },
    }
    await expect(
      assembly.open({
        generationId: 'missing',
        providers: [{ ...provider, contractDefinition: cited }],
      }),
    ).rejects.toMatchObject({ code: 'incompatible/contract_definition_missing' })
    await expect(
      assembly.open({
        generationId: 'owner',
        contracts: [{ ...source, ownerPackageId: 'other' }],
        providers: [{ ...provider, contractDefinition: { ...cited, ownerPackageId: 'other' } }],
      }),
    ).rejects.toMatchObject({ code: 'conflict/contract_owner_conflict' })
    await expect(
      assembly.open({
        generationId: 'digest',
        contracts: [source],
        providers: [{ ...provider, contractDefinition: { ...cited, definitionDigest: 'b'.repeat(64) } }],
      }),
    ).rejects.toMatchObject({ code: 'incompatible/contract_definition_mismatch' })
    await expect(
      assembly.open({
        generationId: 'method',
        contracts: [source],
        providers: [{ ...provider, contractDefinition: cited, operations: [] }],
      }),
    ).rejects.toMatchObject({ code: 'incompatible/contract_operation_mismatch' })
    await expect(
      assembly.open({
        generationId: 'feature',
        contracts: [source],
        providers: [
          { ...provider, contractDefinition: cited },
          {
            providerId: 'consumer',
            contract: 'agh.reader',
            major: 1,
            logicalName: 'default',
            scope: 'workspace',
            features: [],
            packageDigest: DIGEST,
            capabilities: [],
            requires: [
              {
                contract: 'acme/goals',
                major: 1,
                logicalName: 'default',
                scope: 'workspace' as const,
                features: ['goals.missing'],
                optional: false,
                capture: 'instance' as const,
                contractDefinition: cited,
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'incompatible/contract_feature_missing' })
    await expect(
      assembly.open({
        generationId: 'authority',
        contracts: [definition([{ ...LIST, kind: 'control', retrySafety: 'never' }])],
        providers: [
          {
            ...provider,
            contractDefinition: ref(definition([{ ...LIST, kind: 'control', retrySafety: 'never' }])),
            operations: [{ ...LIST, kind: 'control' as const, retrySafety: 'never' as const }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'denied/community_authority_forbidden' })
    await expect(
      assembly.open({
        generationId: 'official',
        providers: [
          {
            providerId: 'loop',
            contract: 'agh.loop',
            major: 1,
            logicalName: 'default',
            scope: 'runtime',
            features: [],
            packageDigest: DIGEST,
            capabilities: [],
            requires: [],
            contractDefinition: cited,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'denied/community_authority_forbidden' })
    expect(created).toBe(0)
  })
})
