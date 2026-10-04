import type { Outcome } from '@agnes/extension-api/runtime'
import { simpleLoopCapabilities } from '@agnes/extension-api/runtime/authoring'
import { AssemblyRefusal, assertCommunityContracts, detectDependencyCycle } from '@agnes/plugin-runtime/host'
import type {
  CapabilityRequirement,
  DataRef,
  DispatchAtomicDomain,
  ReleaseSet,
  SchemaRef,
} from '@agnes/protocol/runtime'
import {
  RuntimeAuthorCapabilities,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateOwnedAuthorSchemaSource,
} from '@agnes/protocol/runtime'
import { verifyClientBundles } from './client-bundles.js'
import { verifyClientLock } from './client-lock.js'
import { type ReleaseSetInputs, readInputs, readLocatorRoute } from './inputs.js'
import {
  array,
  attempt,
  digest,
  equal,
  fields,
  freeze,
  readContent,
  readWire,
  requireRelease,
} from './primitives.js'

const methodSchemas: Readonly<
  Record<string, Readonly<Record<string, { input: SchemaRef; output: SchemaRef }>>>
> = RuntimeMethodSchemaRefs
const serviceCatalog: Readonly<
  Record<
    string,
    {
      major: number
      methods: Readonly<Record<string, { kind?: string; local?: boolean; requiredFeature?: string }>>
    }
  >
> = RuntimeServiceCatalog

export type { ReleaseSetInputs } from './inputs.js'
export { digest as assemblyDigest } from './primitives.js'

/** Known self-identity fields alone are excluded. No other field is normalized away. */
export function releaseSetDigest(release: ReleaseSet): string {
  const { releaseSetId: _identity, ...content } = release
  return digest(content)
}
export function releasePlanFingerprint(plan: ReleaseSetInputs['plan']): string {
  const { planFingerprint: _fingerprint, ...content } = plan
  return digest(content)
}
export function assemblyGraphDigest(graph: ReleaseSetInputs['graph']): string {
  const { digest: _fingerprint, ...content } = graph
  return digest(content)
}

function verifyIdentities(input: ReleaseSetInputs): void {
  const read = (ref: DataRef, path: string) => readContent(ref, path, input.fixture.contents)
  const { plan, graph, configuration, resolution, fixture } = input
  const release = plan.targetReleaseSet
  if (fixture.previousRelease)
    requireRelease(
      fixture.previousRelease.releaseSetId === releaseSetDigest(fixture.previousRelease),
      'content_identity_mismatch',
      '/fixture/previousRelease',
    )
  requireRelease(
    plan.planFingerprint === releasePlanFingerprint(plan),
    'plan_fingerprint_mismatch',
    '/plan/planFingerprint',
  )
  requireRelease(
    release.releaseSetId === releaseSetDigest(release),
    'release_digest_mismatch',
    '/plan/targetReleaseSet/releaseSetId',
  )
  requireRelease(graph.digest === assemblyGraphDigest(graph), 'graph_digest_mismatch', '/graph/digest')
  requireRelease(Date.parse(plan.expiresAt) > Date.parse(fixture.now), 'plan_stale', '/plan/expiresAt')
  requireRelease(
    plan.routeId === fixture.directory.routeId &&
      plan.expectedRouteRevision === fixture.directory.routeRevision &&
      plan.sourceReleaseSetId === fixture.directory.releaseSetId,
    'plan_stale',
    '/plan/routeId',
  )
  requireRelease(
    plan.operation === 'install'
      ? plan.sourceReleaseSetId === null && plan.expectedRouteRevision === null
      : plan.sourceReleaseSetId !== null && plan.expectedRouteRevision !== null,
    'plan_stale',
    '/plan/operation',
  )
  requireRelease(resolution.conflicts.length === 0, 'package_resolution_conflict', '/resolution/conflicts')
  const entries = resolution.lockGraph.entries
  requireRelease(
    new Set(entries.map((entry) => entry.packageId)).size === entries.length,
    'duplicate_package',
    '/resolution/lockGraph',
  )
  const sorted = entries
    .slice()
    .sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0))
  requireRelease(
    resolution.lockGraph.digest === digest(sorted),
    'lock_digest_mismatch',
    '/resolution/lockGraph/digest',
  )
  requireRelease(equal(graph.lock, resolution.lockGraph), 'graph_lock_mismatch', '/graph/lock')
  requireRelease(equal(graph.bindings, release.bindings), 'graph_binding_mismatch', '/graph/bindings')
  requireRelease(
    equal(graph.configRef, release.configSnapshotRef) &&
      plan.configDigest === digest(read(release.configSnapshotRef, '/configSnapshotRef')),
    'config_digest_mismatch',
    '/plan/configDigest',
  )
  requireRelease(
    configuration.profileDigest === digest(configuration.profile) &&
      configuration.presetDigest === digest(configuration.preset),
    'content_identity_mismatch',
    '/configuration',
  )
  for (const [ref, value, fingerprint] of [
    [release.profileRef, configuration.profile, configuration.profileDigest],
    [release.presetRef, configuration.preset, configuration.presetDigest],
  ] as const) {
    requireRelease(
      ref.digest === fingerprint &&
        equal(read(ref.data, '/profile-or-preset'), value) &&
        ref.id === value.id &&
        ref.revision === value.revision,
      'content_identity_mismatch',
      '/profile-or-preset',
    )
  }
  requireRelease(release.packages.length === entries.length, 'package_lock_mismatch', '/packages')
  for (const entry of entries) {
    const packaged = release.packages.find((row) => row.packageId === entry.packageId)
    requireRelease(
      packaged &&
        packaged.version === entry.version &&
        packaged.digest === entry.digest &&
        packaged.sourceRef === entry.locator.sourceId &&
        packaged.integrityRef ===
          (entry.manifestRef.kind === 'inline' ? entry.manifestRef.digest : entry.manifestRef.blob.digest) &&
        entry.locator.digest === entry.digest,
      'package_lock_mismatch',
      '/packages',
    )
    read(entry.manifestRef, '/lock/manifestRef')
    const previous = fixture.previousRelease?.packages.find(
      (row) => row.packageId === entry.packageId && row.version === entry.version,
    )
    requireRelease(
      !previous ||
        (previous.digest === packaged.digest &&
          previous.integrityRef === packaged.integrityRef &&
          equal(previous.entries, packaged.entries)),
      'same_version_content_changed',
      '/packages',
    )
    for (const [name, artifact] of Object.entries(packaged.entries)) {
      requireRelease(
        name.length > 0 && /^[a-f0-9]{64}$/.test(artifact.digest) && artifact.platform.length > 0,
        'content_identity_mismatch',
        '/packages/entries',
      )
    }
    for (const dependency of entry.dependencies) {
      requireRelease(
        entries.some((row) => row.packageId === dependency.packageId && row.digest === dependency.digest),
        'required_dependency_missing',
        '/lock/dependencies',
      )
    }
  }
  requireRelease(
    !detectDependencyCycle(
      entries.map((entry) => entry.packageId),
      entries.flatMap((entry) =>
        entry.dependencies.map((dependency) => ({ from: entry.packageId, to: dependency.packageId })),
      ),
    ),
    'dependency_cycle',
    '/lock/dependencies',
  )
}

function covers(
  granted: readonly CapabilityRequirement[],
  requested: {
    readonly capability: string
    readonly operations: readonly string[]
    readonly resourceTypes: readonly string[]
  },
): boolean {
  return granted.some(
    (row) =>
      row.capability === requested.capability &&
      requested.operations.every((operation) => row.operations.includes(operation)) &&
      requested.resourceTypes.every((type) => row.resourceTypes.includes(type)),
  )
}
function permissionSet(config: ReleaseSetInputs['configuration'] | null): CapabilityRequirement[] {
  const list =
    config?.profile.policy.grants
      .filter((grant) => grant.decision !== 'deny')
      .flatMap((grant) => grant.capabilities) ?? []
  const normalized = list.map((row) => ({
    ...row,
    operations: [...new Set(row.operations)].sort(),
    resourceTypes: [...new Set(row.resourceTypes)].sort(),
  }))
  return [...new Map(normalized.map((row) => [digest(row), row])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, row]) => row)
}
function verifyPermissions(input: ReleaseSetInputs): void {
  const read = (ref: DataRef, path: string) => readContent(ref, path, input.fixture.contents)
  const { plan, configuration, fixture } = input
  const delta = plan.permissionDifference
  if (fixture.previousConfiguration)
    requireRelease(
      fixture.previousConfiguration.profileDigest === digest(fixture.previousConfiguration.profile) &&
        fixture.previousConfiguration.presetDigest === digest(fixture.previousConfiguration.preset),
      'content_identity_mismatch',
      '/fixture/previousConfiguration',
    )
  const before = permissionSet(fixture.previousConfiguration)
  const after = permissionSet(configuration)
  requireRelease(
    delta.beforeProfileDigest === (fixture.previousConfiguration?.profileDigest ?? null) &&
      delta.afterProfileDigest === configuration.profileDigest,
    'permission_difference_mismatch',
    '/plan/permissionDifference',
  )
  requireRelease(
    equal(
      delta.added,
      after.filter((row) => !before.some((old) => equal(old, row))),
    ) &&
      equal(
        delta.removed,
        before.filter((row) => !after.some((next) => equal(next, row))),
      ),
    'permission_difference_mismatch',
    '/plan/permissionDifference',
  )
  const profile = configuration.profile
  const old = fixture.previousConfiguration?.profile
  const changes = ['policy', 'selectionPolicy', 'limits'] as const
  const expected = changes.filter((key) => !equal(old?.[key] ?? null, profile[key]))
  requireRelease(
    delta.policyChanges.length === expected.length &&
      new Set(delta.policyChanges.map((row) => row.path)).size === expected.length,
    'permission_difference_mismatch',
    '/plan/permissionDifference/policyChanges',
  )
  for (const key of expected) {
    const change = delta.policyChanges.find((row) => row.path === `/${key}`)
    requireRelease(
      change?.after &&
        equal(read(change.after, '/permissionDifference/after'), profile[key]) &&
        (old
          ? change.before && equal(read(change.before, '/permissionDifference/before'), old[key])
          : change.before === null),
      'permission_difference_mismatch',
      '/plan/permissionDifference/policyChanges',
    )
  }
  requireRelease(
    simpleLoopCapabilities.modelInference === RuntimeAuthorCapabilities.modelInference,
    'author_capability_source_mismatch',
    '/author-capabilities/modelInference',
  )
  for (const provider of plan.targetReleaseSet.bindings) {
    const owner = plan.targetReleaseSet.packages.find(
      (row) =>
        row.digest === provider.descriptor.packageDigest &&
        row.version === provider.descriptor.packageVersion,
    )
    const permissions = fixture.packagePermissions.find((row) => row.packageId === owner?.packageId)
    requireRelease(owner && permissions, 'package_permissions_missing', '/fixture/packagePermissions')
    const grant = profile.policy.grants.find(
      (row) =>
        row.provider.packageId === owner.packageId &&
        row.provider.providerId === provider.descriptor.providerId &&
        row.decision !== 'deny',
    )
    for (const requested of provider.descriptor.capabilities) {
      requireRelease(
        covers(permissions.capabilities, requested) &&
          covers(profile.policy.capabilityCeiling, requested) &&
          grant &&
          covers(grant.capabilities, requested),
        'configuration_widens_authority',
        '/bindings/capabilities',
      )
    }
    for (const operation of provider.descriptor.operations) {
      for (const requested of operation.requiredCapabilities)
        requireRelease(
          covers(provider.descriptor.capabilities, requested),
          'configuration_widens_authority',
          '/bindings/operations/requiredCapabilities',
        )
      if (provider.descriptor.contract === 'agh.model' && operation.method === 'infer')
        requireRelease(
          covers(operation.requiredCapabilities, simpleLoopCapabilities.modelInference),
          'model_inference_capability_missing',
          '/bindings/operations/infer',
        )
    }
  }
}

function verifyGraph(input: ReleaseSetInputs): void {
  const read = (ref: DataRef, path: string) => readContent(ref, path, input.fixture.contents)
  const { graph, plan } = input
  const bindings = graph.bindings
  const ids = bindings.map((row) => row.binding.bindingId)
  const cells = bindings.map(
    (row) =>
      `${row.descriptor.contract}@${row.descriptor.major}/${row.descriptor.logicalName}/${row.descriptor.scope}`,
  )
  requireRelease(
    new Set(ids).size === ids.length && new Set(cells).size === cells.length,
    'duplicate_cell',
    '/graph/bindings',
  )
  for (const contract of Object.keys(RuntimeServiceCatalog))
    requireRelease(
      bindings.some((row) => row.descriptor.contract === contract),
      'required_contract_missing',
      '/graph/bindings',
    )
  for (const id of graph.requiredContributions)
    requireRelease(ids.includes(id), 'required_contract_missing', '/graph/requiredContributions')
  const configuration = input.configuration
  requireRelease(
    configuration.profile.presets.allowed.some(
      (allowed) =>
        allowed.presetId === configuration.preset.id && allowed.digest === configuration.presetDigest,
    ) &&
      configuration.profile.presets.allowed.some(
        (allowed) => allowed.presetId === configuration.profile.presets.default,
      ),
    'entry_selection_invalid',
    '/configuration/profile/presets',
  )
  const selections = new Map(
    configuration.profile.selections.map((row) => [`${row.contract}@${row.major}/${row.logicalName}`, row]),
  )
  for (const row of configuration.preset.selections)
    selections.set(`${row.contract}@${row.major}/${row.logicalName}`, row)
  for (const selected of selections.values()) {
    const row = bindings.find(
      (binding) =>
        binding.descriptor.contract === selected.contract &&
        binding.descriptor.major === selected.major &&
        binding.descriptor.logicalName === selected.logicalName,
    )
    requireRelease(
      row && row.binding.providerId === selected.provider.providerId && row.isolation === selected.isolation,
      'entry_selection_invalid',
      '/configuration/selections',
    )
    requireRelease(
      plan.targetReleaseSet.packages.some(
        (packaged) =>
          packaged.packageId === selected.provider.packageId &&
          packaged.digest === row.descriptor.packageDigest,
      ),
      'package_lock_mismatch',
      '/configuration/selections/provider',
    )
    const policy = configuration.profile.selectionPolicy.find(
      (allowed) =>
        allowed.contract === selected.contract &&
        allowed.major === selected.major &&
        allowed.logicalName === selected.logicalName,
    )
    requireRelease(policy, 'entry_selection_invalid', '/configuration/selectionPolicy')
    requireRelease(
      policy.allowedProviders.some((provider) => equal(provider, selected.provider)) &&
        policy.allowedIsolation.includes(row.isolation),
      'entry_selection_invalid',
      '/configuration/selectionPolicy',
    )
    requireRelease(
      row.descriptor.isolation.includes(row.isolation) &&
        configuration.profile.policy.allowedIsolation.includes(row.isolation) &&
        row.descriptor.recovery >= policy.minimumRecovery &&
        row.descriptor.recovery >= configuration.profile.policy.minimumRecovery,
      'provider_config_invalid',
      '/configuration/selectionPolicy/minimumRecovery',
    )
    const configured = configuration.profile.providerConfigs.find((item) =>
      equal(item.provider, selected.provider),
    )
    requireRelease(
      configured &&
        equal(configured.config.schema, row.config.schema) &&
        equal(configured.config.value, read(row.config, '/bindings/config')),
      'provider_config_invalid',
      '/configuration/providerConfigs',
    )
  }
  const expected = bindings.flatMap((row) =>
    row.dependencies.map((dependency) => ({
      consumerId: row.binding.bindingId,
      dependencyId: dependency.bindingId,
      optional:
        row.descriptor.requires.find(
          (required) =>
            required.contract === dependency.contract && required.logicalName === dependency.logicalName,
        )?.optional ?? false,
    })),
  )
  requireRelease(equal(graph.dependencies, expected), 'graph_dependency_mismatch', '/graph/dependencies')
  for (const row of bindings) {
    const contract = serviceCatalog[row.descriptor.contract]
    if (contract) {
      requireRelease(
        row.descriptor.major === contract.major,
        'official_contract_incompatible',
        '/bindings/descriptor/major',
      )
      for (const [method, declaration] of Object.entries(contract.methods)) {
        if (
          declaration.local ||
          (declaration.requiredFeature && !row.descriptor.features.includes(declaration.requiredFeature))
        )
          continue
        requireRelease(
          row.descriptor.operations.some(
            (operation) => operation.method === method && operation.kind === declaration.kind,
          ),
          'required_operation_missing',
          '/bindings/operations',
        )
      }
      for (const operation of row.descriptor.operations) {
        const declared = contract.methods[operation.method]
        const schemas = methodSchemas[row.descriptor.contract]?.[operation.method]
        requireRelease(
          declared &&
            !declared.local &&
            operation.kind === declared.kind &&
            schemas &&
            equal(operation.inputSchema, schemas.input) &&
            equal(operation.outputSchema, schemas.output),
          'official_contract_incompatible',
          '/bindings/operations',
        )
      }
    }
    requireRelease(
      row.binding.providerId === row.descriptor.providerId &&
        row.binding.contract === row.descriptor.contract &&
        row.binding.logicalName === row.descriptor.logicalName,
      'binding_descriptor_mismatch',
      '/bindings/binding',
    )
    for (const dependency of row.dependencies)
      requireRelease(
        bindings.some((target) => equal(target.binding, dependency)),
        'required_dependency_missing',
        '/bindings/dependencies',
      )
    for (const required of row.descriptor.requires) {
      const target = bindings.find(
        (item) =>
          item.descriptor.contract === required.contract &&
          item.descriptor.logicalName === required.logicalName &&
          item.descriptor.scope === required.scope,
      )
      requireRelease(target || required.optional, 'required_dependency_missing', '/bindings/requires')
      if (!target) continue
      requireRelease(
        row.dependencies.some((ref) => equal(ref, target.binding)) &&
          target.descriptor.major === required.major &&
          required.features.every((feature) => target.descriptor.features.includes(feature)),
        'dependency_incompatible',
        '/bindings/requires',
      )
    }
    requireRelease(
      plan.targetReleaseSet.packages.some(
        (packaged) =>
          packaged.digest === row.descriptor.packageDigest &&
          packaged.version === row.descriptor.packageVersion,
      ),
      'package_lock_mismatch',
      '/bindings/descriptor/packageDigest',
    )
  }
  requireRelease(
    !detectDependencyCycle(
      ids,
      graph.dependencies.map((edge) => ({ from: edge.consumerId, to: edge.dependencyId })),
    ),
    'dependency_cycle',
    '/graph/dependencies',
  )
}

function verifyMaterials(input: ReleaseSetInputs): DispatchAtomicDomain[] {
  const read = (ref: DataRef, path: string) => readContent(ref, path, input.fixture.contents)
  const release = input.plan.targetReleaseSet
  const config = fields(
    read(release.configSnapshotRef, '/configSnapshotRef'),
    ['kind', 'configuration', 'features', 'bundles', 'jointDomains', 'directory', 'deployments'],
    '/configSnapshotRef/value',
  )
  requireRelease(
    config.kind === 'assembly-effective-fixture' && equal(config.configuration, input.configuration),
    'config_digest_mismatch',
    '/configSnapshotRef/configuration',
  )
  requireRelease(
    equal(readLocatorRoute(config.directory), input.fixture.directory),
    'locator_route_stale',
    '/configSnapshotRef/directory',
  )
  // Preserve the entire deployment contribution, including surfaces and future asset bytes.
  readWire('JsonValue', config.deployments)
  for (const demand of array(config.features, '/configSnapshotRef/features')) {
    const row = fields(demand, ['bindingId', 'features', 'path', 'sourceId'], '/configSnapshotRef/features')
    const id = readWire('Id', row.bindingId)
    const path = readWire('Id', row.path)
    const sourceId = readWire('Id', row.sourceId)
    requireRelease(
      input.configuration.provenance.some((entry) => entry.path === path && entry.sourceId === sourceId),
      'feature_source_mismatch',
      '/configSnapshotRef/features',
    )
    const provider = release.bindings.find((item) => item.binding.bindingId === id)
    requireRelease(provider, 'required_contract_missing', path)
    for (const feature of array(row.features, path))
      requireRelease(
        provider.descriptor.features.includes(readWire('Id', feature)),
        'required_feature_missing',
        path,
        `Missing feature ${String(feature)} at ${path} from ${sourceId}; select a provider declaring it or revise the locked requirement`,
      )
  }
  const materials = fields(
    read(release.schemasRef, '/schemasRef'),
    ['schemas', 'builtinContracts', 'contracts'],
    '/schemasRef/value',
  )
  const catalog = new Map<string, ReturnType<typeof validateOwnedAuthorSchemaSource>>()
  for (const value of array(materials.schemas, '/schemasRef/schemas')) {
    const source = fields(
      value,
      ['ownerPackageId', 'name', 'typeId', 'revision', 'document'],
      '/schemasRef/schemas',
    )
    const checked = validateOwnedAuthorSchemaSource({
      ownerPackageId: readWire('Id', source.ownerPackageId),
      name: readWire('Id', source.name),
      typeId: readWire('TypeId', source.typeId),
      revision: readWire('UInt53', source.revision),
      document: readWire('JsonValue', source.document),
    })
    requireRelease(!catalog.has(digest(checked.ref)), 'duplicate_schema', '/schemasRef/schemas')
    catalog.set(digest(checked.ref), checked)
  }
  const builtinRefs = new Set<string>()
  for (const raw of array(materials.builtinContracts, '/schemasRef/builtinContracts')) {
    const lock = fields(raw, ['contract', 'digest'], '/schemasRef/builtinContracts')
    const name = readWire('Id', lock.contract)
    const expected = methodSchemas[name]
    requireRelease(
      expected && readWire('Digest', lock.digest) === digest(expected),
      'content_identity_mismatch',
      '/schemasRef/builtinContracts',
    )
    for (const schemas of Object.values(expected)) {
      builtinRefs.add(digest(schemas.input))
      builtinRefs.add(digest(schemas.output))
    }
  }
  const known = (schema: SchemaRef): boolean => catalog.has(digest(schema)) || builtinRefs.has(digest(schema))
  const recovery = fields(
    read(release.recoveryManifestRef, '/recoveryManifestRef'),
    ['codecs'],
    '/recoveryManifestRef/value',
  )
  const codecs = array(recovery.codecs, '/recoveryManifestRef/codecs').map((row) =>
    readWire('StateCodecRef', row),
  )
  for (const row of release.bindings) {
    const schema = catalog.get(digest(row.descriptor.configSchema))
    requireRelease(
      schema && equal(row.config.schema, row.descriptor.configSchema),
      'schema_missing',
      '/bindings/configSchema',
    )
    const configValue = read(row.config, '/bindings/config')
    requireRelease(
      row.configDigest === digest(configValue) && schema.validate(configValue).ok,
      'provider_config_invalid',
      '/bindings/config',
    )
    for (const ref of [
      ...row.schemaRefs,
      ...row.descriptor.operations.flatMap((operation) => [operation.inputSchema, operation.outputSchema]),
    ])
      requireRelease(known(ref), 'schema_missing', '/bindings/schemaRefs')
    requireRelease(
      equal(row.codecRefs, row.descriptor.stateCodecs),
      'recovery_codec_missing',
      '/bindings/codecRefs',
    )
    for (const codec of row.codecRefs)
      requireRelease(
        known(codec.schema) && codecs.some((available) => equal(codec, available)),
        'recovery_codec_missing',
        '/recoveryManifestRef/codecs',
      )
  }
  const bundleBody = read(release.clientBundlesRef, '/clientBundlesRef')
  const bundleFields = bundleBody as Record<string, unknown>
  const bundles = array(bundleFields.bundles, '/clientBundlesRef/bundles')
  verifyClientBundles(release, bundles, array(config.bundles, '/configSnapshotRef/bundles'), known)
  verifyClientLock(input, bundleBody)
  const definitions = array(materials.contracts, '/schemasRef/contracts').map((row) =>
    readWire('CommunityContractDefinition', row),
  )
  const providers = release.bindings.map((row) => row.descriptor)
  try {
    assertCommunityContracts(definitions, providers)
  } catch (error) {
    requireRelease(
      false,
      error instanceof AssemblyRefusal
        ? (error.code.split('/')[1] ?? 'community_contract_incompatible')
        : 'schema_invalid',
      '/schemasRef/contracts',
    )
  }
  for (const definition of definitions) {
    requireRelease(
      release.packages.some((row) => row.packageId === definition.ownerPackageId),
      'community_owner_missing',
      '/schemasRef/contracts',
    )
    for (const operation of definition.operations)
      requireRelease(
        known(operation.inputSchema) && known(operation.outputSchema),
        'schema_missing',
        '/schemasRef/contracts/operations',
      )
  }
  read(release.resourceClaimsRef, '/resourceClaimsRef')
  return array(config.jointDomains, '/configSnapshotRef/jointDomains').map((row) =>
    readWire('DispatchAtomicDomain', row),
  )
}

function verifyJointAndMigrations(input: ReleaseSetInputs, domains: DispatchAtomicDomain[]): void {
  const { fixture, plan } = input
  requireRelease(
    new Set(domains.map((domain) => domain.domainId)).size === domains.length,
    'joint_dispatch_incompatible',
    '/jointDomains',
  )
  for (const domain of domains) {
    const state = plan.targetReleaseSet.bindings.find(
      (row) => equal(row.binding, domain.stateBinding) && row.descriptor.contract === 'agh.state',
    )
    const budget = plan.targetReleaseSet.bindings.find(
      (row) => equal(row.binding, domain.budgetBinding) && row.descriptor.contract === 'agh.budget',
    )
    requireRelease(
      state?.descriptor.features.includes('joint-dispatch.v1') &&
        budget?.descriptor.features.includes('joint-dispatch.v1'),
      'joint_dispatch_not_declared',
      '/jointDomains',
    )
    requireRelease(
      fixture.jointDomains.some((current) => equal(current, domain)),
      'joint_dispatch_stale',
      '/jointDomains',
    )
  }
  requireRelease(
    new Set(plan.prerequisiteMigrationPlans.map((row) => row.planId)).size ===
      plan.prerequisiteMigrationPlans.length,
    'migration_fingerprint_mismatch',
    '/prerequisiteMigrationPlans',
  )
  for (const required of plan.prerequisiteMigrationPlans) {
    const evidence = fixture.migrations.find((row) => row.plan.planId === required.planId)
    requireRelease(evidence, 'prerequisite_migration_incomplete', '/prerequisiteMigrationPlans')
    const { plan: migration, receipt, commit } = evidence
    const { planFingerprint: _fingerprint, ...body } = migration
    requireRelease(
      migration.planFingerprint === required.planFingerprint &&
        migration.planFingerprint === digest(body) &&
        commit.planFingerprint === migration.planFingerprint,
      'migration_fingerprint_mismatch',
      '/prerequisiteMigrationPlans',
    )
    requireRelease(
      receipt.state === 'completed' &&
        receipt.upgradeId === migration.upgradeId &&
        receipt.commitRef !== null,
      'prerequisite_migration_incomplete',
      '/prerequisiteMigrationPlans',
    )
    requireRelease(
      commit.commitRef === receipt.commitRef && commit.upgradeId === migration.upgradeId,
      'migration_commit_mismatch',
      '/fixture/migrations/commit',
    )
    requireRelease(
      Date.parse(migration.expiresAt) > Date.parse(fixture.now) && equal(commit.directory, fixture.directory),
      'migration_stale',
      '/fixture/migrations/commit/directory',
    )
  }
}

/** Construct a detached, deeply frozen lock. This function performs no I/O or migration. */
export function constructReleaseSet(value: unknown): Outcome<ReleaseSet> {
  return attempt(() => {
    const input = readInputs(value)
    verifyIdentities(input)
    verifyGraph(input)
    const domains = verifyMaterials(input)
    verifyPermissions(input)
    verifyJointAndMigrations(input, domains)
    return freeze(input.plan.targetReleaseSet)
  })
}

/** Reuse the frozen plan while rechecking trusted current heads, evidence and time. */
export function revalidateReleasePublication(
  input: ReleaseSetInputs,
  observation: {
    now: string
    directory: ReleaseSetInputs['fixture']['directory']
    jointDomains: unknown
    migrations: unknown
  },
): Outcome<ReleaseSet> {
  return constructReleaseSet({ ...input, fixture: { ...input.fixture, ...observation } })
}
