import {
  type AssemblyFixture,
  assemblyFixture,
  fixtureHash,
  fixtureRef,
  fixtureWire,
  resealAssemblyFixture,
} from './assembly-fixture.js'

import { changedAssemblyUiEntryDigest } from './assembly-ui-fixture.js'

export function pairAssemblyFixture(input: AssemblyFixture): void {
  const state = input.plan.targetReleaseSet.bindings.find((row) => row.descriptor.contract === 'agh.state')
  const budget = input.plan.targetReleaseSet.bindings.find((row) => row.descriptor.contract === 'agh.budget')
  if (!state || !budget) throw new Error('fixture participant missing')
  state.descriptor.features.push('joint-dispatch.v1')
  budget.descriptor.features.push('joint-dispatch.v1')
  const domain = fixtureWire('DispatchAtomicDomain', {
    domainId: 'fixture-domain',
    revision: 2,
    stateAuthority: { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 3 },
    budgetAuthority: { authorityId: 'fixture-budget', tenantId: 'fixture-tenant', authorityEpoch: 4 },
    stateBinding: state.binding,
    budgetBinding: budget.binding,
  })
  input.plan.targetReleaseSet.configSnapshotRef.value.jointDomains = [domain]
  input.fixture.jointDomains = [structuredClone(domain)]
  resealAssemblyFixture(input)
}
export function migrationAssemblyFixture(input: AssemblyFixture): void {
  const plan = fixtureWire('MigrationPlan', {
    planId: 'prerequisite-plan',
    upgradeId: 'prerequisite-upgrade',
    planFingerprint: '0'.repeat(64),
    request: {
      upgradeId: 'prerequisite-upgrade',
      target: {
        kind: 'directory',
        sourceLocatorRevision: 1,
        targetProviderLock: fixtureRef({}),
        targetLocationRef: 'fixture-target',
        externalJournalRef: 'fixture-journal',
      },
      policyRef: 'fixture-migration-policy',
      reason: 'synthetic prerequisite',
      mode: 'explicit',
    },
    sourceHeads: {
      kind: 'directory',
      locatorId: input.fixture.directory.locatorId,
      locatorRevision: 1,
      directoryEpoch: 1,
    },
    migratorLock: fixtureRef({}),
    validatorLocks: [fixtureRef({})],
    requiredPins: ['fixture-migration-pin'],
    requiredCapabilities: [],
    invariants: {
      publicFacts: 'identical',
      effectIdentity: 'identical',
      accounting: 'identical',
      pendingOwnership: 'preserved-or-explicit-alias',
      unconsumedSignals: 'preserved',
      deletionAndRevocation: 'current',
      lineage: 'identical',
      additionalChecks: [],
    },
    resourceBudgetRef: 'fixture-budget',
    expiresAt: '2030-01-01T00:00:00Z',
    eligibility: 'eligible',
    reasonCodes: [],
  })
  const { planFingerprint: omitted, ...body } = plan
  plan.planFingerprint = fixtureHash(body)
  input.plan.prerequisiteMigrationPlans.push({ planId: plan.planId, planFingerprint: plan.planFingerprint })
  input.fixture.migrations.push({
    plan,
    receipt: {
      upgradeId: plan.upgradeId,
      state: 'completed',
      checkpointRevision: 1,
      cutoverId: 'fixture-cutover',
      commitRef: 'fixture-maintenance-commit',
      diagnosticIds: [],
    },
    commit: {
      commitRef: 'fixture-maintenance-commit',
      upgradeId: plan.upgradeId,
      planFingerprint: plan.planFingerprint,
      directory: structuredClone(input.fixture.directory),
    },
  })
  resealAssemblyFixture(input)
}
export function communityAssemblyFixture(input: AssemblyFixture): void {
  const original = firstFixtureRow(input.plan.targetReleaseSet.bindings)
  const operation = {
    method: 'inspect',
    kind: 'query',
    inputSchema: original.config.schema,
    outputSchema: original.config.schema,
    requiredCapabilities: [],
    retrySafety: 'read-only',
  }
  const definition = fixtureWire('CommunityContractDefinition', {
    contract: 'acme.release/inspection',
    major: 1,
    ownerPackageId: 'acme.release',
    scope: 'runtime',
    features: ['inspection.v1'],
    operations: [operation],
  })
  input.plan.targetReleaseSet.schemasRef.value.contracts.push(definition)
  const snapshot = fixtureWire('ProviderBindingSnapshot', {
    ...structuredClone(original),
    binding: {
      ...original.binding,
      bindingId: 'binding:community',
      contract: definition.contract,
      providerId: 'acme.release/inspection',
    },
    descriptor: {
      ...original.descriptor,
      providerId: 'acme.release/inspection',
      contract: definition.contract,
      features: ['inspection.v1'],
      capabilities: [],
      operations: [operation],
      contractDefinition: {
        ownerPackageId: definition.ownerPackageId,
        definitionDigest: fixtureHash(definition),
      },
    },
  })
  input.plan.targetReleaseSet.bindings.push(snapshot)
  resealAssemblyFixture(input)
}
function signPlan(input: AssemblyFixture): void {
  const { planFingerprint: omitted, ...body } = input.plan
  input.plan.planFingerprint = fixtureHash(body)
}
function signGraph(input: AssemblyFixture): void {
  const { digest: omitted, ...body } = input.graph
  input.graph.digest = fixtureHash(body)
}

function firstFixtureRow<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('required fixture row missing')
  return row
}

type Mutation = (input: AssemblyFixture) => void
export interface AssemblyRefusalFixture {
  readonly name: string
  readonly code: string
  readonly input: AssemblyFixture
}
/** Counterexamples are signed synthetic plans so that each exercises its own observable refusal. */
export function assemblyRefusalFixtures(): AssemblyRefusalFixture[] {
  const rows: { name: string; code: string; change: Mutation; seal?: boolean }[] = [
    {
      name: 'changed plan fingerprint',
      code: 'plan_fingerprint_mismatch',
      seal: false,
      change: (f) => {
        f.plan.planFingerprint = '0'.repeat(64)
      },
    },
    {
      name: 'changed release identity',
      code: 'release_digest_mismatch',
      seal: false,
      change: (f) => {
        f.plan.targetReleaseSet.releaseSetId = '0'.repeat(64)
        signPlan(f)
      },
    },
    {
      name: 'changed graph digest',
      code: 'graph_digest_mismatch',
      seal: false,
      change: (f) => {
        f.graph.digest = '0'.repeat(64)
      },
    },
    {
      name: 'changed package lock digest',
      code: 'lock_digest_mismatch',
      seal: false,
      change: (f) => {
        f.resolution.lockGraph.digest = '0'.repeat(64)
        signGraph(f)
      },
    },
    {
      name: 'different graph lock',
      code: 'graph_lock_mismatch',
      seal: false,
      change: (f) => {
        f.graph.lock = { ...f.graph.lock, digest: '0'.repeat(64) }
        signGraph(f)
      },
    },
    {
      name: 'different graph bindings',
      code: 'graph_binding_mismatch',
      seal: false,
      change: (f) => {
        f.graph.bindings = []
        signGraph(f)
      },
    },
    {
      name: 'resolver conflict',
      code: 'package_resolution_conflict',
      change: (f) => {
        f.resolution.conflicts = fixtureWire('PackageResolverResolveResult', {
          ...f.resolution,
          conflicts: [{ packageId: 'acme.release', reason: 'fixture conflict' }],
        }).conflicts
      },
    },
    {
      name: 'same version changed content',
      code: 'same_version_content_changed',
      change: (f) => {
        f.fixture.previousRelease = structuredClone(f.plan.targetReleaseSet)
        const pkg = f.fixture.previousRelease.packages[0]
        if (pkg) pkg.digest = '1'.repeat(64)
        const { releaseSetId: omitted, ...body } = f.fixture.previousRelease
        f.fixture.previousRelease.releaseSetId = fixtureHash(body)
      },
    },
    {
      name: 'same version changed entry bytes',
      code: 'same_version_content_changed',
      change: (f) => {
        f.fixture.previousRelease = structuredClone(f.plan.targetReleaseSet)
        firstFixtureRow(f.fixture.previousRelease.packages).entries.backend = {
          digest: '1'.repeat(64),
          platform: 'node',
        }
        const { releaseSetId: omitted, ...body } = f.fixture.previousRelease
        f.fixture.previousRelease.releaseSetId = fixtureHash(body)
      },
    },
    {
      name: 'locked blob content unavailable',
      code: 'content_unavailable',
      seal: false,
      change: (f) => {
        f.fixture.contents = []
      },
    },
    {
      name: 'locked blob bytes changed',
      code: 'content_identity_mismatch',
      seal: false,
      change: (f) => {
        firstFixtureRow(f.fixture.contents).value = {}
      },
    },
    {
      name: 'selected provider dependency cycle',
      code: 'dependency_cycle',
      change: (f) => {
        const first = firstFixtureRow(f.plan.targetReleaseSet.bindings),
          second = firstFixtureRow(f.plan.targetReleaseSet.bindings.slice(1))
        for (const [consumer, dependency] of [
          [first, second],
          [second, first],
        ]) {
          if (!consumer || !dependency) throw new Error('fixture participant missing')
          consumer.dependencies.push(dependency.binding)
          consumer.descriptor.requires.push({
            contract: dependency.descriptor.contract,
            major: dependency.descriptor.major,
            logicalName: dependency.descriptor.logicalName,
            scope: dependency.descriptor.scope,
            features: [],
            optional: false,
          })
        }
        f.graph.dependencies = [
          { consumerId: first.binding.bindingId, dependencyId: second.binding.bindingId, optional: false },
          { consumerId: second.binding.bindingId, dependencyId: first.binding.bindingId, optional: false },
        ]
      },
    },
    {
      name: 'package dependency cycle',
      code: 'dependency_cycle',
      change: (f) => {
        const entry = f.resolution.lockGraph.entries[0]
        if (entry) entry.dependencies.push({ packageId: entry.packageId, digest: entry.digest })
      },
    },
    {
      name: 'missing package dependency',
      code: 'required_dependency_missing',
      change: (f) => {
        f.resolution.lockGraph.entries[0]?.dependencies.push({ packageId: 'missing', digest: '0'.repeat(64) })
      },
    },
    {
      name: 'duplicate selected cell',
      code: 'duplicate_cell',
      change: (f) => {
        const row = f.plan.targetReleaseSet.bindings[0]
        if (row) f.plan.targetReleaseSet.bindings.push(structuredClone(row))
      },
    },
    {
      name: 'missing required service',
      code: 'required_contract_missing',
      change: (f) => {
        f.plan.targetReleaseSet.bindings.pop()
      },
    },
    {
      name: 'binding descriptor drift',
      code: 'binding_descriptor_mismatch',
      change: (f) => {
        const row = f.plan.targetReleaseSet.bindings[0]
        if (row) row.binding.logicalName = 'replacement'
      },
    },
    {
      name: 'missing mandatory binding',
      code: 'required_dependency_missing',
      change: (f) => {
        const row = f.plan.targetReleaseSet.bindings[0]
        if (row) {
          row.dependencies.push({
            bindingId: 'missing',
            contract: 'acme.release/missing',
            logicalName: 'missing',
            providerId: 'missing',
          })
          f.graph.dependencies.push({
            consumerId: row.binding.bindingId,
            dependencyId: 'missing',
            optional: false,
          })
        }
      },
    },
    {
      name: 'UI entry digest tampered under locked package',
      code: 'bundle_package_mismatch',
      change: (f) => {
        firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles).digest =
          changedAssemblyUiEntryDigest(true)
      },
    },
    {
      name: 'same version changed real UI entry bytes',
      code: 'same_version_content_changed',
      change: (f) => {
        f.fixture.previousRelease = structuredClone(f.plan.targetReleaseSet)
        const bundle = firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles)
        const pkg = firstFixtureRow(
          f.plan.targetReleaseSet.packages.filter((pkg) => pkg.packageId === bundle.packageId),
        )
        const changed = changedAssemblyUiEntryDigest()
        const artifact = pkg.entries.web
        if (!artifact) throw new Error('fixture entry missing')
        artifact.digest = changed
        bundle.digest = changed
        firstFixtureRow(f.plan.targetReleaseSet.configSnapshotRef.value.bundles).digest = changed
      },
    },
    {
      name: 'UI bundle package version disagrees',
      code: 'bundle_package_mismatch',
      change: (f) => {
        firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles).version = '2.0.0'
      },
    },
    {
      name: 'UI bundle entry absent',
      code: 'bundle_package_mismatch',
      change: (f) => {
        firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles).entry = 'missing'
      },
    },
    {
      name: 'UI bundle target disagrees with locked artifact',
      code: 'bundle_package_mismatch',
      change: (f) => {
        firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles).target = 'tui'
      },
    },
    {
      name: 'UI bundle legacy platform rejected',
      code: 'schema_invalid',
      change: (f) => {
        firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles).target = 'browser'
      },
    },
    {
      name: 'UI renderer range cannot read locked schema',
      code: 'bundle_schema_range_mismatch',
      change: (f) => {
        firstFixtureRow(
          firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles).viewSchemaRanges,
        ).minRevision = 2
      },
    },
    {
      name: 'UI bundle schema absent from catalog',
      code: 'schema_missing',
      change: (f) => {
        firstFixtureRow(
          firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles).schemas,
        ).digest = '1'.repeat(64)
      },
    },
    {
      name: 'UI bundle codec field is not a lock member',
      code: 'schema_invalid',
      change: (f) => {
        Object.assign(firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles), {
          codec: 'extra',
        })
      },
    },
    {
      name: 'duplicate UI bundle identity',
      code: 'duplicate_ui_bundle',
      change: (f) => {
        f.plan.targetReleaseSet.clientBundlesRef.value.bundles.push(
          structuredClone(firstFixtureRow(f.plan.targetReleaseSet.clientBundlesRef.value.bundles)),
        )
      },
    },
    {
      name: 'missing required UI bundle',
      code: 'required_ui_bundle_missing',
      change: (f) => {
        f.plan.targetReleaseSet.clientBundlesRef.value.bundles = []
      },
    },
    {
      name: 'missing schema',
      code: 'schema_missing',
      change: (f) => {
        f.plan.targetReleaseSet.schemasRef.value.schemas = []
      },
    },
    {
      name: 'missing R1 recovery codec',
      code: 'recovery_codec_missing',
      change: (f) => {
        const row = f.plan.targetReleaseSet.bindings[0]
        if (row) {
          const codec = {
            namespace: 'fixture-state',
            codecVersion: 'v1',
            schema: row.descriptor.configSchema,
          }
          row.descriptor.recovery = 'R1'
          row.descriptor.stateCodecs = [codec]
          row.codecRefs = [codec]
        }
      },
    },
    {
      name: 'forged empty permission difference',
      code: 'permission_difference_mismatch',
      change: (f) => {
        f.plan.permissionDifference.added = []
      },
    },
    {
      name: 'package permission request missing',
      code: 'package_permissions_missing',
      change: (f) => {
        f.fixture.packagePermissions = []
      },
    },
    {
      name: 'descriptor exceeds package ceiling',
      code: 'configuration_widens_authority',
      change: (f) => {
        firstFixtureRow(f.fixture.packagePermissions).capabilities = []
      },
    },
    {
      name: 'model infer capability missing',
      code: 'model_inference_capability_missing',
      change: (f) => {
        const row = f.plan.targetReleaseSet.bindings.find((item) => item.descriptor.contract === 'agh.model')
        const infer = row?.descriptor.operations.find((operation) => operation.method === 'infer')
        if (infer) infer.requiredCapabilities = []
      },
    },
    {
      name: 'effective default quality requirement unsupported',
      code: 'required_feature_missing',
      change: (f) => {
        f.plan.targetReleaseSet.configSnapshotRef.value.features.push({
          bindingId: 'binding:agh.loop',
          features: ['fixture-quality-slot'],
          path: '/parameters',
          sourceId: 'fixture-profile',
        })
      },
    },
    {
      name: 'feature requirement loses provenance',
      code: 'feature_source_mismatch',
      change: (f) => {
        f.plan.targetReleaseSet.configSnapshotRef.value.features.push({
          bindingId: 'binding:agh.loop',
          features: ['fixture-quality-slot'],
          path: '/parameters',
          sourceId: 'unknown',
        })
      },
    },
    {
      name: 'community definition absent',
      code: 'contract_definition_missing',
      change: (f) => {
        communityAssemblyFixture(f)
        f.plan.targetReleaseSet.schemasRef.value.contracts = []
      },
    },
    {
      name: 'community owner disagrees',
      code: 'contract_owner_conflict',
      change: (f) => {
        communityAssemblyFixture(f)
        firstFixtureRow(f.plan.targetReleaseSet.schemasRef.value.contracts).ownerPackageId = 'other.owner'
      },
    },
    {
      name: 'community definition changed at same major',
      code: 'contract_definition_mismatch',
      change: (f) => {
        communityAssemblyFixture(f)
        firstFixtureRow(f.plan.targetReleaseSet.schemasRef.value.contracts).features.push('changed.v1')
      },
    },
    {
      name: 'community operation disagrees',
      code: 'contract_operation_mismatch',
      change: (f) => {
        communityAssemblyFixture(f)
        const provider = f.plan.targetReleaseSet.bindings.find(
          (row) => row.binding.bindingId === 'binding:community',
        )
        if (provider) firstFixtureRow(provider.descriptor.operations).method = 'different-inspect'
      },
    },
    {
      name: 'community feature undeclared',
      code: 'contract_feature_missing',
      change: (f) => {
        communityAssemblyFixture(f)
        f.plan.targetReleaseSet.bindings
          .find((row) => row.binding.bindingId === 'binding:community')
          ?.descriptor.features.push('unknown.v1')
      },
    },
    {
      name: 'reserved official name fails the frozen community shape',
      code: 'schema_invalid',
      change: (f) => {
        communityAssemblyFixture(f)
        firstFixtureRow(f.plan.targetReleaseSet.schemasRef.value.contracts).contract = 'agh.model'
      },
    },
    {
      name: 'joint dispatch only State advertises',
      code: 'joint_dispatch_not_declared',
      change: (f) => {
        pairAssemblyFixture(f)
        const row = f.plan.targetReleaseSet.bindings.find((item) => item.descriptor.contract === 'agh.budget')
        if (row) row.descriptor.features = []
      },
    },
    {
      name: 'joint dispatch stale authority epoch',
      code: 'joint_dispatch_stale',
      change: (f) => {
        pairAssemblyFixture(f)
        firstFixtureRow(f.fixture.jointDomains).stateAuthority.authorityEpoch++
      },
    },
    {
      name: 'joint dispatch stale revision',
      code: 'joint_dispatch_stale',
      change: (f) => {
        pairAssemblyFixture(f)
        firstFixtureRow(f.fixture.jointDomains).revision++
      },
    },
    {
      name: 'joint dispatch replaced member',
      code: 'joint_dispatch_stale',
      change: (f) => {
        pairAssemblyFixture(f)
        firstFixtureRow(f.fixture.jointDomains).budgetBinding.bindingId = 'replacement'
      },
    },
    {
      name: 'prerequisite receipt missing',
      code: 'prerequisite_migration_incomplete',
      change: (f) => {
        migrationAssemblyFixture(f)
        f.fixture.migrations = []
      },
    },
    {
      name: 'prerequisite fingerprint changed',
      code: 'migration_fingerprint_mismatch',
      change: (f) => {
        migrationAssemblyFixture(f)
        firstFixtureRow(f.fixture.migrations).plan.planFingerprint = '0'.repeat(64)
      },
    },
    {
      name: 'prerequisite receipt not completed',
      code: 'prerequisite_migration_incomplete',
      change: (f) => {
        migrationAssemblyFixture(f)
        firstFixtureRow(f.fixture.migrations).receipt.state = 'aborted'
      },
    },
    {
      name: 'prerequisite commit is response ID',
      code: 'migration_commit_mismatch',
      change: (f) => {
        migrationAssemblyFixture(f)
        firstFixtureRow(f.fixture.migrations).receipt.commitRef = 'fixture-http-response'
      },
    },
    {
      name: 'prerequisite locator route expired',
      code: 'migration_stale',
      change: (f) => {
        migrationAssemblyFixture(f)
        firstFixtureRow(f.fixture.migrations).commit.directory.locatorRevision++
      },
    },
    {
      name: 'current locator route changed',
      code: 'locator_route_stale',
      change: (f) => {
        f.fixture.directory.locatorRevision++
      },
    },
    {
      name: 'release authorization expired',
      code: 'plan_stale',
      change: (f) => {
        f.plan.expiresAt = '2020-01-01T00:00:00Z'
      },
    },
  ]
  const seed = assemblyFixture()
  return rows.map(({ name, code, change, seal }) => {
    const input = structuredClone(seed)
    change(input)
    if (seal !== false) resealAssemblyFixture(input)
    return { name, code, input }
  })
}
