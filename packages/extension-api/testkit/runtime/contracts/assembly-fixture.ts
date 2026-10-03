import { jcs } from '@agnes/protocol'
import type {
  AssemblyGraph,
  ConfigResolveResult,
  DataRef,
  JsonValue,
  MigrationPlan,
  ReleasePlan,
  ReleaseSet,
  RuntimeWireTypes,
} from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeAuthorCapabilities,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateOwnedAuthorSchemaSource,
  validateRuntime,
} from '@agnes/protocol/runtime'

import { assemblyUiFixture } from './assembly-ui-fixture.js'

export function fixtureWire<K extends keyof RuntimeWireTypes>(
  schema: K,
  value: unknown,
): RuntimeWireTypes[K] {
  const result = validateRuntime(schema, value)
  if (!result.ok) throw new Error(`${schema}: ${JSON.stringify(result.errors)}`)
  return result.value
}
export const fixtureHash = (value: unknown): string => canonicalJsonDigest(fixtureWire('JsonValue', value))
export function fixtureRef<T>(value: T, typeId = 'acme.release/fixture@1') {
  const json = fixtureWire('JsonValue', value)
  return {
    kind: 'inline' as const,
    schema: { typeId, revision: 1, digest: fixtureHash({ typeId }) },
    value: json as JsonValue & T,
    digest: fixtureHash(json),
    bytes: Buffer.byteLength(jcs(json)),
  }
}
export const ASSEMBLY_UNFINISHED = Object.freeze([
  'publish',
  'persistent-pin-drain',
  'admission',
  'cold-recovery',
] as const)

/** Synthetic public locks and observations, never a deployable provider or authority proof. */
export function assemblyFixture() {
  const ui = assemblyUiFixture()
  const uiManifest = fixtureRef(ui.manifest)
  const packageId = 'acme.release',
    tree = fixtureHash('synthetic package tree')
  const source = {
    ownerPackageId: packageId,
    name: 'Empty',
    typeId: `${packageId}/empty@1`,
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Empty',
      $defs: { Empty: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    },
  }
  const schema = validateOwnedAuthorSchemaSource(source).ref
  const model = fixtureWire('CapabilityRequirement', RuntimeAuthorCapabilities.modelInference)
  const methodSchemas: Readonly<
    Record<
      string,
      Readonly<
        Record<string, { input: RuntimeWireTypes['SchemaRef']; output: RuntimeWireTypes['SchemaRef'] }>
      >
    >
  > = RuntimeMethodSchemaRefs
  const bindings = Object.entries(RuntimeServiceCatalog).map(([contract, definition]) => {
    const providerId = `${packageId}/${contract.slice(4)}`
    return fixtureWire('ProviderBindingSnapshot', {
      binding: { bindingId: `binding:${contract}`, contract, logicalName: 'default', providerId },
      descriptor: {
        providerId,
        contract,
        major: definition.major,
        logicalName: 'default',
        packageVersion: '1.0.0',
        packageDigest: tree,
        features: [],
        scope: 'runtime',
        configSchema: schema,
        requires: [],
        capabilities: contract === 'agh.model' ? [model] : [],
        recovery: 'R0',
        isolation: ['trusted-in-process'],
        stateCodecs: [],
        activationMode: 'eager',
        operations: Object.entries(definition.methods)
          .filter(([, method]) => !('local' in method && method.local) && !('requiredFeature' in method))
          .map(([method, declaration]) => ({
            method,
            kind: declaration.kind,
            inputSchema: methodSchemas[contract]?.[method]?.input,
            outputSchema: methodSchemas[contract]?.[method]?.output,
            requiredCapabilities: contract === 'agh.model' && method === 'infer' ? [model] : [],
            retrySafety: 'read-only',
          })),
      },
      isolation: 'trusted-in-process',
      config: fixtureRef({}),
      configDigest: fixtureHash({}),
      dependencies: [],
      codecRefs: [],
      schemaRefs: [schema],
    })
  })
  for (const binding of bindings) binding.config.schema = schema
  const preset = fixtureWire('RuntimePreset', {
    $schema: 'https://agnes.ai/schema/runtime/v1/preset.schema.json',
    kind: 'agh.preset',
    schemaVersion: '1.0',
    id: 'approved',
    revision: 1,
    selections: [],
    configOverrides: [],
    parameters: { schema, value: {} },
    restrictions: {},
  })
  const manifest = fixtureRef({ packageId, version: '1.0.0', packageDigest: tree })
  const profile = fixtureWire('RuntimeProfile', {
    $schema: 'https://agnes.ai/schema/runtime/v1/profile.schema.json',
    kind: 'agh.profile',
    schemaVersion: '1.0',
    id: 'fixture-profile',
    revision: 1,
    requiredContractSet: 'agh.runtime/full-v1',
    packages: [
      {
        id: packageId,
        enabled: true,
        source: { kind: 'local', path: './fixture', packageDigest: tree },
        manifestDigest: manifest.digest,
      },
    ],
    selections: bindings.map((row) => ({
      contract: row.descriptor.contract,
      major: row.descriptor.major,
      logicalName: 'default',
      provider: { packageId, providerId: row.binding.providerId },
      isolation: row.isolation,
    })),
    providerConfigs: bindings.map((row) => ({
      provider: { packageId, providerId: row.binding.providerId },
      config: { schema, value: {} },
    })),
    selectionPolicy: bindings.map((row) => ({
      contract: row.descriptor.contract,
      major: row.descriptor.major,
      logicalName: 'default',
      allowedProviders: [{ packageId, providerId: row.binding.providerId }],
      allowSessionSelect: false,
      configOverridePaths: [],
      allowedIsolation: [row.isolation],
      minimumRecovery: 'R0',
    })),
    presets: { default: preset.id, allowed: [{ presetId: preset.id, digest: fixtureHash(preset) }] },
    policy: {
      capabilityCeiling: [model],
      minimumRecovery: 'R0',
      allowedIsolation: ['trusted-in-process'],
      sourcePolicy: { allowLocal: true, npmRegistries: [], gitOrigins: [], allowBuildScripts: false },
      grants: [
        {
          provider: { packageId, providerId: `${packageId}/model` },
          decision: 'allow',
          capabilities: [model],
          resourceScopes: [],
        },
      ],
    },
    limits: {},
    client: {
      rendererSelections: [],
      requiredTargets: ['web'],
      registry: { packageId, contributionId: 'registry' },
      shell: { packageId, contributionId: 'shell' },
      fallbackRenderer: { packageId, contributionId: 'fallback' },
    },
    storage: { dataDir: '/var/agnes/fixture-data', cacheDir: '/var/agnes/fixture-cache' },
    overrides: { allowWorkspaceRestrictions: false, sessionParametersSchema: schema },
  })
  const configuration: ConfigResolveResult = {
    status: 'candidate',
    algorithm: 'agh.config/resolve-v1',
    sourceSetDigest: fixtureHash('fixture-source-set'),
    profile,
    preset,
    profileDigest: fixtureHash(profile),
    presetDigest: fixtureHash(preset),
    provenance: [
      {
        path: '/parameters',
        sourceId: 'fixture-profile',
        sourceDigest: fixtureHash(profile),
        revision: 1,
        operation: 'default',
        resultDigest: fixtureHash({}),
      },
    ],
  }
  const directory = {
    locatorId: 'fixture-locator',
    locatorRevision: 1,
    directoryEpoch: 1,
    routeId: 'fixture-route',
    routeRevision: null as number | null,
    releaseSetId: null as string | null,
  }
  const effective = {
    kind: 'assembly-effective-fixture',
    configuration,
    features: [] as { bindingId: string; features: string[]; path: string; sourceId: string }[],
    bundles: [ui.bundle],
    jointDomains: [] as RuntimeWireTypes['DispatchAtomicDomain'][],
    directory,
    deployments: {
      extensions: [],
      profileFragment: {},
      presets: [],
      fixtures: [],
      surfaces: [{ id: 'fixture-surface', path: './surface.json', digest: fixtureHash('synthetic surface') }],
    },
  }
  const release = {
    releaseSetId: '',
    formatVersion: 1,
    hostAbi: 'fixture-host-v1',
    packages: [
      {
        packageId,
        version: '1.0.0',
        digest: tree,
        sourceRef: 'fixture-source',
        integrityRef: manifest.digest,
        entries: { backend: { digest: fixtureHash('synthetic backend entry'), platform: 'node' } },
      },
      {
        packageId: ui.manifest.id,
        version: ui.manifest.version,
        digest: ui.manifest.packageDigest,
        sourceRef: 'fixture-ui-source',
        integrityRef: uiManifest.digest,
        entries: { web: { digest: ui.bundle.digest, platform: 'web' } },
      },
    ],
    bindings,
    profileRef: {
      id: profile.id,
      revision: profile.revision,
      digest: fixtureHash(profile),
      data: fixtureRef(profile),
    },
    presetRef: {
      id: preset.id,
      revision: preset.revision,
      digest: fixtureHash(preset),
      data: fixtureRef(preset),
    },
    configSnapshotRef: fixtureRef(effective),
    schemasRef: fixtureRef({
      schemas: [source, ui.source],
      builtinContracts: Object.entries(methodSchemas).map(([contract, schemas]) => ({
        contract,
        digest: fixtureHash(schemas),
      })),
      contracts: [] as RuntimeWireTypes['CommunityContractDefinition'][],
    }),
    clientBundlesRef: fixtureRef({ bundles: effective.bundles }),
    recoveryManifestRef: fixtureRef({ codecs: [] as RuntimeWireTypes['StateCodecRef'][] }),
    resourceClaimsRef: fixtureRef({ resources: [] }),
  } satisfies ReleaseSet
  const lock = {
    entries: [
      fixtureWire('PackageLockEntry', {
        packageId,
        version: '1.0.0',
        digest: tree,
        locator: { kind: 'local', sourceId: 'fixture-source', pathRef: 'fixture-path', digest: tree },
        manifestRef: manifest,
        dependencies: [],
      }),
      fixtureWire('PackageLockEntry', {
        packageId: ui.manifest.id,
        version: ui.manifest.version,
        digest: ui.manifest.packageDigest,
        locator: {
          kind: 'local',
          sourceId: 'fixture-ui-source',
          pathRef: 'fixture-ui-path',
          digest: ui.manifest.packageDigest,
        },
        manifestRef: uiManifest,
        dependencies: [],
      }),
    ],
    digest: '',
  }
  const graph = {
    graphId: 'fixture-graph',
    configRef: release.configSnapshotRef,
    lock,
    bindings,
    dependencies: [] as AssemblyGraph['dependencies'],
    requiredContributions: bindings.map((row) => row.binding.bindingId),
    digest: '',
  } satisfies AssemblyGraph
  const plan = {
    planId: 'fixture-plan',
    upgradeId: 'fixture-upgrade',
    planFingerprint: '',
    operation: 'install' as ReleasePlan['operation'],
    routeId: directory.routeId,
    expectedRouteRevision: null as number | null,
    sourceReleaseSetId: null as string | null,
    targetReleaseSet: release,
    affectedContributions: graph.requiredContributions,
    configDigest: '',
    permissionDifference: {
      beforeProfileDigest: null as string | null,
      afterProfileDigest: configuration.profileDigest,
      added: [model],
      removed: [] as RuntimeWireTypes['CapabilityRequirement'][],
      policyChanges: (['policy', 'selectionPolicy', 'limits'] as const).map((key) => ({
        path: `/${key}`,
        before: null,
        after: fixtureRef(profile[key]),
      })) as ReleasePlan['permissionDifference']['policyChanges'],
    },
    requiredPins: ['fixture-package-pin'],
    readinessChecks: [],
    prerequisiteMigrationPlans: [] as ReleasePlan['prerequisiteMigrationPlans'],
    authorizedBy: 'fixture-authorizer',
    expiresAt: '2030-01-01T00:00:00Z',
    rollbackOf: null,
  } satisfies ReleasePlan
  const input = {
    plan,
    graph,
    configuration,
    resolution: {
      lockGraph: lock,
      conflicts: [] as RuntimeWireTypes['PackageResolverResolveResult']['conflicts'],
      configDigest: fixtureHash('fixture-resolution-input'),
    },
    fixture: {
      kind: 'public-fixture' as const,
      now: '2026-10-03T00:00:00Z',
      contents: [] as { ref: DataRef; value: JsonValue }[],
      previousRelease: null as ReleaseSet | null,
      previousConfiguration: null as ConfigResolveResult | null,
      directory: structuredClone(directory),
      jointDomains: [] as RuntimeWireTypes['DispatchAtomicDomain'][],
      migrations: [] as {
        plan: MigrationPlan
        receipt: RuntimeWireTypes['MigrationReceipt']
        commit: { commitRef: string; upgradeId: string; planFingerprint: string; directory: typeof directory }
      }[],
      packagePermissions: [{ packageId, capabilities: [model] }],
    },
  }
  resealAssemblyFixture(input)
  fixtureWire('ReleasePlan', input.plan)
  fixtureWire('AssemblyGraph', input.graph)
  return input
}
export type AssemblyFixture = ReturnType<typeof assemblyFixture>
/** Re-sign only synthetic content identities after a deliberate fixture mutation. */
export function resealAssemblyFixture(input: AssemblyFixture): void {
  const release = input.plan.targetReleaseSet
  input.configuration.profileDigest = fixtureHash(input.configuration.profile)
  input.configuration.presetDigest = fixtureHash(input.configuration.preset)
  input.plan.permissionDifference.afterProfileDigest = input.configuration.profileDigest
  input.fixture.contents = []
  for (const change of input.plan.permissionDifference.policyChanges) {
    const key = change.path.slice(1)
    if (key === 'policy' || key === 'selectionPolicy' || key === 'limits') {
      const inline = fixtureRef(input.configuration.profile[key])
      const ref: DataRef = {
        kind: 'blob',
        schema: inline.schema,
        blob: {
          authorityId: 'fixture-content',
          blobId: `content:${inline.digest}`,
          digest: inline.digest,
          bytes: inline.bytes,
          mediaType: 'application/json',
          pinId: 'fixture-content-pin',
        },
      }
      change.after = ref
      input.fixture.contents.push({ ref, value: inline.value })
    }
  }
  release.configSnapshotRef.value.configuration = input.configuration
  release.profileRef = {
    id: input.configuration.profile.id,
    revision: input.configuration.profile.revision,
    digest: input.configuration.profileDigest,
    data: fixtureRef(input.configuration.profile),
  }
  release.presetRef = {
    id: input.configuration.preset.id,
    revision: input.configuration.preset.revision,
    digest: input.configuration.presetDigest,
    data: fixtureRef(input.configuration.preset),
  }
  const refs: DataRef[] = [
    release.profileRef.data,
    release.presetRef.data,
    release.configSnapshotRef,
    release.schemasRef,
    release.clientBundlesRef,
    release.recoveryManifestRef,
    release.resourceClaimsRef,
  ]
  for (const ref of refs)
    if (ref.kind === 'inline') {
      ref.digest = fixtureHash(ref.value)
      ref.bytes = Buffer.byteLength(jcs(ref.value))
    }
  const { releaseSetId: identity, ...body } = release
  release.releaseSetId = fixtureHash(body)
  input.resolution.lockGraph.digest = fixtureHash(
    [...input.resolution.lockGraph.entries].sort((a, b) =>
      a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0,
    ),
  )
  input.graph.lock = input.resolution.lockGraph
  input.graph.bindings = release.bindings
  input.graph.configRef = release.configSnapshotRef
  input.plan.configDigest = fixtureHash(release.configSnapshotRef.value)
  const { digest: graphId, ...graph } = input.graph
  input.graph.digest = fixtureHash(graph)
  const { planFingerprint: planId, ...plan } = input.plan
  input.plan.planFingerprint = fixtureHash(plan)
}
