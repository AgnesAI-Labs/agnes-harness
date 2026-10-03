import type { CallContext, Outcome, RuntimeError } from '@agnes/extension-api/runtime'
import { simpleLoopCapabilities } from '@agnes/extension-api/runtime/authoring'
import { jcs } from '@agnes/protocol'
import type {
  AssemblyDrainResult,
  AssemblyGraph,
  AssemblyPrepareResult,
  AssemblyPublishResult,
  CapabilityRequirement,
  ConfigResolveResult,
  DataRef,
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

const wireMethods: Readonly<
  Record<
    string,
    Readonly<Record<string, { input: RuntimeWireTypes['SchemaRef']; output: RuntimeWireTypes['SchemaRef'] }>>
  >
> = RuntimeMethodSchemaRefs
const builtins: Readonly<
  Record<
    string,
    {
      major: number
      methods: Readonly<Record<string, { kind?: string; local?: boolean; requiredFeature?: string }>>
    }
  >
> = RuntimeServiceCatalog

class InvalidRelease extends Error {
  constructor(
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason)
  }
}
function demand(valid: unknown, reason: string, message?: string): asserts valid {
  if (!valid) throw new InvalidRelease(reason, message)
}
function decode<K extends keyof RuntimeWireTypes>(schema: K, raw: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(schema, raw)
  demand(result.ok, 'schema_invalid')
  return result.value
}
function fingerprint(raw: unknown): string {
  return canonicalJsonDigest(decode('JsonValue', raw))
}
function matches(a: unknown, b: unknown): boolean {
  return jcs(a as RuntimeWireTypes['JsonValue']) === jcs(b as RuntimeWireTypes['JsonValue'])
}
function object(raw: unknown, keys: string[]): Record<string, unknown> {
  demand(raw && typeof raw === 'object' && !Array.isArray(raw), 'schema_invalid')
  const row = raw as Record<string, unknown>
  demand(Object.keys(row).sort().join('\n') === keys.sort().join('\n'), 'schema_invalid')
  return row
}
function list(raw: unknown): unknown[] {
  demand(Array.isArray(raw), 'schema_invalid')
  return raw
}
function readData(
  data: DataRef,
  snapshots: { ref: DataRef; value: RuntimeWireTypes['JsonValue'] }[],
): RuntimeWireTypes['JsonValue'] {
  if (data.kind === 'inline') {
    demand(
      fingerprint(data.value) === data.digest &&
        new TextEncoder().encode(jcs(data.value)).length === data.bytes,
      'content_identity_mismatch',
    )
    return data.value
  }
  const entries = snapshots.filter((snapshot) => matches(snapshot.ref, data))
  demand(entries.length === 1, 'content_unavailable')
  const entry = entries[0]
  demand(
    entry &&
      fingerprint(entry.value) === data.blob.digest &&
      new TextEncoder().encode(jcs(entry.value)).length === data.blob.bytes,
    'content_identity_mismatch',
  )
  return entry.value
}
function directory(raw: unknown) {
  const value = object(raw, [
    'locatorId',
    'locatorRevision',
    'directoryEpoch',
    'routeId',
    'routeRevision',
    'releaseSetId',
  ])
  return {
    locatorId: decode('Id', value.locatorId),
    locatorRevision: decode('UInt53', value.locatorRevision),
    directoryEpoch: decode('UInt53', value.directoryEpoch),
    routeId: decode('Id', value.routeId),
    routeRevision: value.routeRevision === null ? null : decode('UInt53', value.routeRevision),
    releaseSetId: value.releaseSetId === null ? null : decode('Id', value.releaseSetId),
  }
}
function decodeSnapshot(raw: unknown) {
  const envelope = object(raw, ['plan', 'graph', 'configuration', 'resolution', 'fixture'])
  const observation = object(envelope.fixture, [
    'kind',
    'now',
    'contents',
    'previousRelease',
    'previousConfiguration',
    'directory',
    'jointDomains',
    'migrations',
    'packagePermissions',
  ])
  demand(observation.kind === 'public-fixture', 'production_inputs_unavailable')
  const migrations = list(observation.migrations).map((item) => {
    const evidence = object(item, ['plan', 'receipt', 'commit'])
    const committed = object(evidence.commit, ['commitRef', 'upgradeId', 'planFingerprint', 'directory'])
    return {
      migration: decode('MigrationPlan', evidence.plan),
      receipt: decode('MigrationReceipt', evidence.receipt),
      commitId: decode('Id', committed.commitRef),
      upgrade: decode('Id', committed.upgradeId),
      hash: decode('Digest', committed.planFingerprint),
      current: directory(committed.directory),
    }
  })
  return {
    releasePlan: decode('ReleasePlan', envelope.plan),
    assembly: decode('AssemblyGraph', envelope.graph),
    config: decode('ConfigResolveResult', envelope.configuration),
    packages: decode('PackageResolverResolveResult', envelope.resolution),
    at: decode('Timestamp', observation.now),
    contents: list(observation.contents).map((raw) => {
      const document = object(raw, ['ref', 'value'])
      return { ref: decode('DataRef', document.ref), value: decode('JsonValue', document.value) }
    }),
    head: directory(observation.directory),
    historicalRelease:
      observation.previousRelease === null ? null : decode('ReleaseSet', observation.previousRelease),
    historicalConfig:
      observation.previousConfiguration === null
        ? null
        : decode('ConfigResolveResult', observation.previousConfiguration),
    domains: list(observation.jointDomains).map((domain) => decode('DispatchAtomicDomain', domain)),
    migrations,
    requestedPermissions: list(observation.packagePermissions).map((item) => {
      const row = object(item, ['packageId', 'capabilities'])
      return {
        id: decode('Id', row.packageId),
        requests: list(row.capabilities).map((value) => decode('CapabilityRequirement', value)),
      }
    }),
  }
}
type Snapshot = ReturnType<typeof decodeSnapshot>
function cyclic(nodes: string[], pairs: [string, string][]): boolean {
  const remaining = new Set(nodes)
  while (remaining.size) {
    const roots = [...remaining].filter((id) => !pairs.some(([from, to]) => from === id && remaining.has(to)))
    if (roots.length === 0) return true
    for (const id of roots) remaining.delete(id)
  }
  return false
}
function lockPhase(s: Snapshot): void {
  if (s.historicalRelease) {
    const { releaseSetId: historyId, ...history } = s.historicalRelease
    demand(historyId === fingerprint(history), 'content_identity_mismatch')
  }
  const content = (ref: DataRef) => readData(ref, s.contents)
  const p = s.releasePlan,
    a = s.assembly,
    target = p.targetReleaseSet
  const { planFingerprint: omittedPlan, ...planned } = p
  const { releaseSetId: omittedRelease, ...released } = target
  const { digest: omittedGraph, ...assembled } = a
  demand(p.planFingerprint === fingerprint(planned), 'plan_fingerprint_mismatch')
  demand(target.releaseSetId === fingerprint(released), 'release_digest_mismatch')
  demand(a.digest === fingerprint(assembled), 'graph_digest_mismatch')
  demand(Date.parse(p.expiresAt) > Date.parse(s.at), 'plan_stale')
  demand(
    matches(
      [p.routeId, p.expectedRouteRevision, p.sourceReleaseSetId],
      [s.head.routeId, s.head.routeRevision, s.head.releaseSetId],
    ),
    'plan_stale',
  )
  demand(
    p.operation === 'install'
      ? p.sourceReleaseSetId === null && p.expectedRouteRevision === null
      : p.sourceReleaseSetId !== null && p.expectedRouteRevision !== null,
    'plan_stale',
  )
  demand(s.packages.conflicts.length === 0, 'package_resolution_conflict')
  const locks = s.packages.lockGraph.entries
  demand(new Set(locks.map((item) => item.packageId)).size === locks.length, 'duplicate_package')
  demand(
    s.packages.lockGraph.digest ===
      fingerprint(
        [...locks].sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0)),
      ),
    'lock_digest_mismatch',
  )
  demand(matches(a.lock, s.packages.lockGraph), 'graph_lock_mismatch')
  demand(matches(a.bindings, target.bindings), 'graph_binding_mismatch')
  demand(
    matches(a.configRef, target.configSnapshotRef) &&
      p.configDigest === fingerprint(content(target.configSnapshotRef)),
    'config_digest_mismatch',
  )
  demand(
    s.config.profileDigest === fingerprint(s.config.profile) &&
      s.config.presetDigest === fingerprint(s.config.preset),
    'content_identity_mismatch',
  )
  const refs = [target.profileRef, target.presetRef],
    bodies = [s.config.profile, s.config.preset],
    hashes = [s.config.profileDigest, s.config.presetDigest]
  for (let n = 0; n < refs.length; n++) {
    const ref = refs[n],
      body = bodies[n]
    demand(
      ref &&
        body &&
        ref.digest === hashes[n] &&
        matches(content(ref.data), body) &&
        ref.id === body.id &&
        ref.revision === body.revision,
      'content_identity_mismatch',
    )
  }
  demand(target.packages.length === locks.length, 'package_lock_mismatch')
  for (const locked of locks) {
    const pinned = target.packages.find((item) => item.packageId === locked.packageId)
    demand(
      pinned &&
        pinned.version === locked.version &&
        pinned.digest === locked.digest &&
        pinned.sourceRef === locked.locator.sourceId &&
        pinned.integrityRef ===
          (locked.manifestRef.kind === 'inline'
            ? locked.manifestRef.digest
            : locked.manifestRef.blob.digest) &&
        locked.locator.digest === locked.digest,
      'package_lock_mismatch',
    )
    content(locked.manifestRef)
    const older = s.historicalRelease?.packages.find(
      (item) => item.packageId === locked.packageId && item.version === locked.version,
    )
    demand(
      !older ||
        (older.digest === pinned.digest &&
          older.integrityRef === pinned.integrityRef &&
          matches(older.entries, pinned.entries)),
      'same_version_content_changed',
    )
    demand(
      Object.entries(pinned.entries).every(
        ([name, artifact]) =>
          name.length && /^[a-f0-9]{64}$/.test(artifact.digest) && artifact.platform.length,
      ),
      'content_identity_mismatch',
    )
    for (const edge of locked.dependencies)
      demand(
        locks.some((item) => item.packageId === edge.packageId && item.digest === edge.digest),
        'required_dependency_missing',
      )
  }
  demand(
    !cyclic(
      locks.map((item) => item.packageId),
      locks.flatMap((item) =>
        item.dependencies.map((edge): [string, string] => [item.packageId, edge.packageId]),
      ),
    ),
    'dependency_cycle',
  )
}
function selectionPhase(s: Snapshot): void {
  const content = (ref: DataRef) => readData(ref, s.contents)
  const a = s.assembly,
    bindings = a.bindings
  const numbers = bindings.map((item) => item.binding.bindingId)
  const addresses = bindings.map((item) =>
    [
      item.descriptor.contract,
      item.descriptor.major,
      item.descriptor.logicalName,
      item.descriptor.scope,
    ].join('/'),
  )
  demand(
    new Set(numbers).size === numbers.length && new Set(addresses).size === addresses.length,
    'duplicate_cell',
  )
  demand(
    Object.keys(RuntimeServiceCatalog).every((contract) =>
      bindings.some((item) => item.descriptor.contract === contract),
    ),
    'required_contract_missing',
  )
  demand(
    a.requiredContributions.every((id) => numbers.includes(id)),
    'required_contract_missing',
  )
  demand(
    s.config.profile.presets.allowed.some(
      (item) => item.presetId === s.config.preset.id && item.digest === s.config.presetDigest,
    ) && s.config.profile.presets.allowed.some((item) => item.presetId === s.config.profile.presets.default),
    'entry_selection_invalid',
  )
  const chosen = [
    ...s.config.preset.selections,
    ...s.config.profile.selections.filter(
      (base) =>
        !s.config.preset.selections.some((override) =>
          matches(
            [override.contract, override.major, override.logicalName],
            [base.contract, base.major, base.logicalName],
          ),
        ),
    ),
  ]
  for (const selected of chosen) {
    const binding = bindings.find((item) =>
      matches(
        [item.descriptor.contract, item.descriptor.major, item.descriptor.logicalName],
        [selected.contract, selected.major, selected.logicalName],
      ),
    )
    demand(
      binding &&
        binding.binding.providerId === selected.provider.providerId &&
        binding.isolation === selected.isolation,
      'entry_selection_invalid',
    )
    demand(
      s.releasePlan.targetReleaseSet.packages.some(
        (item) =>
          item.packageId === selected.provider.packageId && item.digest === binding.descriptor.packageDigest,
      ),
      'package_lock_mismatch',
    )
    const allowed = s.config.profile.selectionPolicy.find((item) =>
      matches(
        [item.contract, item.major, item.logicalName],
        [selected.contract, selected.major, selected.logicalName],
      ),
    )
    demand(allowed, 'entry_selection_invalid')
    demand(
      allowed.allowedProviders.some((item) => matches(item, selected.provider)) &&
        allowed.allowedIsolation.includes(binding.isolation),
      'entry_selection_invalid',
    )
    demand(
      binding.descriptor.isolation.includes(binding.isolation) &&
        s.config.profile.policy.allowedIsolation.includes(binding.isolation) &&
        binding.descriptor.recovery >= allowed.minimumRecovery &&
        binding.descriptor.recovery >= s.config.profile.policy.minimumRecovery,
      'provider_config_invalid',
    )
    const configured = s.config.profile.providerConfigs.find((item) =>
      matches(item.provider, selected.provider),
    )
    demand(
      configured &&
        matches(configured.config.schema, binding.config.schema) &&
        matches(configured.config.value, content(binding.config)),
      'provider_config_invalid',
    )
  }
  const edges: typeof a.dependencies = []
  for (const item of bindings)
    for (const target of item.dependencies)
      edges.push({
        consumerId: item.binding.bindingId,
        dependencyId: target.bindingId,
        optional:
          item.descriptor.requires.find(
            (requirement) =>
              requirement.contract === target.contract && requirement.logicalName === target.logicalName,
          )?.optional ?? false,
      })
  demand(matches(edges, a.dependencies), 'graph_dependency_mismatch')
  for (const item of bindings) {
    const builtin = builtins[item.descriptor.contract]
    if (builtin) {
      demand(item.descriptor.major === builtin.major, 'official_contract_incompatible')
      const mandatory = Object.keys(builtin.methods).filter((name) => {
        const spec = builtin.methods[name]
        return (
          spec &&
          !spec.local &&
          (!spec.requiredFeature || item.descriptor.features.includes(spec.requiredFeature))
        )
      })
      demand(
        mandatory.every((name) =>
          item.descriptor.operations.some(
            (operation) => operation.method === name && operation.kind === builtin.methods[name]?.kind,
          ),
        ),
        'required_operation_missing',
      )
      for (const operation of item.descriptor.operations) {
        const spec = builtin.methods[operation.method],
          schemas = wireMethods[item.descriptor.contract]?.[operation.method]
        demand(
          spec &&
            !spec.local &&
            spec.kind === operation.kind &&
            schemas &&
            matches(operation.inputSchema, schemas.input) &&
            matches(operation.outputSchema, schemas.output),
          'official_contract_incompatible',
        )
      }
    }
    demand(
      matches(
        [item.binding.providerId, item.binding.contract, item.binding.logicalName],
        [item.descriptor.providerId, item.descriptor.contract, item.descriptor.logicalName],
      ),
      'binding_descriptor_mismatch',
    )
    demand(
      item.dependencies.every((ref) => bindings.some((target) => matches(target.binding, ref))),
      'required_dependency_missing',
    )
    for (const requirement of item.descriptor.requires) {
      const target = bindings.find((provider) =>
        matches(
          [provider.descriptor.contract, provider.descriptor.logicalName, provider.descriptor.scope],
          [requirement.contract, requirement.logicalName, requirement.scope],
        ),
      )
      demand(target || requirement.optional, 'required_dependency_missing')
      if (target)
        demand(
          item.dependencies.some((ref) => matches(ref, target.binding)) &&
            target.descriptor.major === requirement.major &&
            requirement.features.every((feature) => target.descriptor.features.includes(feature)),
          'dependency_incompatible',
        )
    }
    demand(
      s.releasePlan.targetReleaseSet.packages.some(
        (pkg) =>
          pkg.digest === item.descriptor.packageDigest && pkg.version === item.descriptor.packageVersion,
      ),
      'package_lock_mismatch',
    )
  }
  demand(
    !cyclic(
      numbers,
      a.dependencies.map((edge) => [edge.consumerId, edge.dependencyId]),
    ),
    'dependency_cycle',
  )
}
function materialPhase(s: Snapshot) {
  const content = (ref: DataRef) => readData(ref, s.contents)
  const target = s.releasePlan.targetReleaseSet
  const fixed = object(content(target.configSnapshotRef), [
    'kind',
    'configuration',
    'features',
    'bundles',
    'jointDomains',
    'directory',
    'deployments',
  ])
  demand(
    fixed.kind === 'assembly-effective-fixture' && matches(fixed.configuration, s.config),
    'config_digest_mismatch',
  )
  demand(matches(directory(fixed.directory), s.head), 'locator_route_stale')
  decode('JsonValue', fixed.deployments)
  for (const raw of list(fixed.features)) {
    const feature = object(raw, ['bindingId', 'features', 'path', 'sourceId'])
    const number = decode('Id', feature.bindingId),
      origin = decode('Id', feature.sourceId),
      pointer = decode('Id', feature.path)
    demand(
      s.config.provenance.some((row) => row.path === pointer && row.sourceId === origin),
      'feature_source_mismatch',
    )
    const selected = target.bindings.find((row) => row.binding.bindingId === number)
    demand(selected, 'required_contract_missing')
    for (const needed of list(feature.features))
      demand(
        selected.descriptor.features.includes(decode('Id', needed)),
        'required_feature_missing',
        `Missing feature ${String(needed)} at ${pointer} from ${origin}; select a provider declaring it or revise the locked requirement`,
      )
  }
  const schemas = object(content(target.schemasRef), ['schemas', 'builtinContracts', 'contracts'])
  const admitted = list(schemas.schemas).map((raw) => {
    const source = object(raw, ['ownerPackageId', 'name', 'typeId', 'revision', 'document'])
    return validateOwnedAuthorSchemaSource({
      ownerPackageId: decode('Id', source.ownerPackageId),
      name: decode('Id', source.name),
      typeId: decode('TypeId', source.typeId),
      revision: decode('UInt53', source.revision),
      document: decode('JsonValue', source.document),
    })
  })
  demand(
    new Set(admitted.map((schema) => fingerprint(schema.ref))).size === admitted.length,
    'duplicate_schema',
  )
  const manifest = object(content(target.recoveryManifestRef), ['codecs'])
  const codecs = list(manifest.codecs).map((raw) => decode('StateCodecRef', raw))
  const frozenWire = new Set<string>()
  for (const entry of list(schemas.builtinContracts)) {
    const citation = object(entry, ['contract', 'digest'])
    const name = decode('Id', citation.contract),
      exported = wireMethods[name]
    demand(
      exported && decode('Digest', citation.digest) === fingerprint(exported),
      'content_identity_mismatch',
    )
    Object.values(exported).forEach((method) => {
      frozenWire.add(fingerprint(method.input))
      frozenWire.add(fingerprint(method.output))
    })
  }
  const hasSchema = (ref: RuntimeWireTypes['SchemaRef']) =>
    admitted.some((codec) => matches(codec.ref, ref)) || frozenWire.has(fingerprint(ref))
  for (const provider of target.bindings) {
    const decoder = admitted.find((codec) => matches(codec.ref, provider.descriptor.configSchema))
    demand(decoder && matches(provider.config.schema, provider.descriptor.configSchema), 'schema_missing')
    const config = content(provider.config)
    demand(
      provider.configDigest === fingerprint(config) && decoder.validate(config).ok,
      'provider_config_invalid',
    )
    demand(
      [
        ...provider.schemaRefs,
        ...provider.descriptor.operations.flatMap((method) => [method.inputSchema, method.outputSchema]),
      ].every(hasSchema),
      'schema_missing',
    )
    demand(matches(provider.codecRefs, provider.descriptor.stateCodecs), 'recovery_codec_missing')
    demand(
      provider.codecRefs.every(
        (codec) => hasSchema(codec.schema) && codecs.some((available) => matches(codec, available)),
      ),
      'recovery_codec_missing',
    )
  }
  const client = object(content(target.clientBundlesRef), ['bundles'])
  const bundles = list(client.bundles)
  for (const raw of bundles) {
    const bundle = object(raw, ['bundleId', 'digest', 'platform', 'schema'])
    decode('Id', bundle.bundleId)
    decode('Digest', bundle.digest)
    decode('Id', bundle.platform)
    demand(hasSchema(decode('SchemaRef', bundle.schema)), 'schema_missing')
  }
  for (const raw of list(fixed.bundles)) {
    const required = object(raw, ['bundleId', 'digest', 'platform', 'schema'])
    decode('Id', required.bundleId)
    decode('Digest', required.digest)
    decode('Id', required.platform)
    demand(hasSchema(decode('SchemaRef', required.schema)), 'schema_missing')
    demand(
      bundles.some((bundle) => matches(bundle, required)),
      'required_ui_bundle_missing',
    )
  }
  const definitions = list(schemas.contracts).map((raw) => decode('CommunityContractDefinition', raw))
  checkCommunity(definitions, target.bindings)
  for (const definition of definitions) {
    demand(
      target.packages.some((pkg) => pkg.packageId === definition.ownerPackageId),
      'community_owner_missing',
    )
    demand(
      definition.operations.every(
        (method) => hasSchema(method.inputSchema) && hasSchema(method.outputSchema),
      ),
      'schema_missing',
    )
  }
  content(target.resourceClaimsRef)
  return list(fixed.jointDomains).map((domain) => decode('DispatchAtomicDomain', domain))
}
function checkCommunity(
  definitions: RuntimeWireTypes['CommunityContractDefinition'][],
  bindings: RuntimeWireTypes['ProviderBindingSnapshot'][],
): void {
  const citation = (row: object): RuntimeWireTypes['CommunityContractRef'] | undefined =>
    'contractDefinition' in row ? decode('CommunityContractRef', row.contractDefinition) : undefined
  const official = (name: string) => /^(?:agh|agh[./].*)$/u.test(name)
  const owner = (name: string) => {
    const slash = name.lastIndexOf('/')
    return slash > 0 && /^[a-z][a-z0-9-]*$/u.test(name.slice(slash + 1)) ? name.slice(0, slash) : undefined
  }
  const catalog = new Map<string, RuntimeWireTypes['CommunityContractDefinition']>()
  for (const definition of definitions) {
    demand(!official(definition.contract), 'community_authority_forbidden')
    demand(owner(definition.contract) === definition.ownerPackageId, 'contract_owner_conflict')
    const key = `${definition.contract}@${definition.major}`,
      prior = catalog.get(key)
    demand(!prior || matches(prior, definition), 'contract_definition_mismatch')
    catalog.set(key, definition)
  }
  const resolve = (
    name: string,
    major: number,
    ref: RuntimeWireTypes['CommunityContractRef'] | undefined,
  ) => {
    demand(owner(name), 'contract_owner_conflict')
    const definition = catalog.get(`${name}@${major}`)
    demand(definition && ref, 'contract_definition_missing')
    demand(ref.ownerPackageId === definition.ownerPackageId, 'contract_owner_conflict')
    demand(ref.definitionDigest === fingerprint(definition), 'contract_definition_mismatch')
    demand(
      definition.operations.every((method) => ['query', 'compute', 'action'].includes(method.kind)),
      'community_authority_forbidden',
    )
    return definition
  }
  const methods = (operations: RuntimeWireTypes['ProviderBindingSnapshot']['descriptor']['operations']) => {
    demand(
      operations.length > 0 &&
        new Set(operations.map((operation) => operation.method)).size === operations.length,
      'contract_operation_mismatch',
    )
    demand(
      operations.every(
        (operation) =>
          operation.method &&
          (!['query', 'compute'].includes(operation.kind) || operation.retrySafety === 'read-only'),
      ),
      'contract_operation_mismatch',
    )
  }
  for (const { descriptor } of bindings) {
    if (official(descriptor.contract))
      demand(
        !citation(descriptor) && !catalog.has(`${descriptor.contract}@${descriptor.major}`),
        'community_authority_forbidden',
      )
    else {
      const definition = resolve(descriptor.contract, descriptor.major, citation(descriptor))
      demand(definition.scope === descriptor.scope, 'contract_operation_mismatch')
      methods(definition.operations)
      methods(descriptor.operations)
      demand(definition.operations.length === descriptor.operations.length, 'contract_operation_mismatch')
      for (const expected of definition.operations) {
        const actual = descriptor.operations.find((operation) => operation.method === expected.method)
        demand(
          actual &&
            matches(
              [actual.kind, actual.inputSchema, actual.outputSchema, actual.retrySafety],
              [expected.kind, expected.inputSchema, expected.outputSchema, expected.retrySafety],
            ) &&
            expected.requiredCapabilities.every((capability) =>
              permits(actual.requiredCapabilities, capability),
            ),
          'contract_operation_mismatch',
        )
      }
      demand(
        descriptor.features.every((feature) => definition.features.includes(feature)),
        'contract_feature_missing',
      )
    }
    for (const requirement of descriptor.requires) {
      if (official(requirement.contract)) {
        demand(!citation(requirement), 'community_authority_forbidden')
        continue
      }
      if (!owner(requirement.contract)) continue
      resolve(requirement.contract, requirement.major, citation(requirement))
      const selected = bindings.find(({ descriptor: candidate }) =>
        matches(
          [candidate.contract, candidate.major, candidate.logicalName, candidate.scope],
          [requirement.contract, requirement.major, requirement.logicalName, requirement.scope],
        ),
      )
      if (selected) {
        demand(
          !citation(selected.descriptor) ||
            !citation(requirement) ||
            citation(selected.descriptor)?.definitionDigest === citation(requirement)?.definitionDigest,
          'contract_definition_mismatch',
        )
        demand(
          requirement.features.every((feature) => selected.descriptor.features.includes(feature)),
          'contract_feature_missing',
        )
      }
    }
  }
}
function capabilities(config: ConfigResolveResult | null): CapabilityRequirement[] {
  const unique = new Map<string, CapabilityRequirement>()
  for (const grant of config?.profile.policy.grants ?? [])
    if (grant.decision !== 'deny')
      for (const capability of grant.capabilities) {
        const normalized = {
          capability: capability.capability,
          resourceTypes: [...new Set(capability.resourceTypes)].sort(),
          operations: [...new Set(capability.operations)].sort(),
        }
        unique.set(fingerprint(normalized), normalized)
      }
  return [...unique.keys()].sort().map((key) => unique.get(key) as CapabilityRequirement)
}
function permits(
  available: readonly CapabilityRequirement[],
  needed: {
    readonly capability: string
    readonly operations: readonly string[]
    readonly resourceTypes: readonly string[]
  },
): boolean {
  return available.some(
    (capability) =>
      capability.capability === needed.capability &&
      needed.operations.every((operation) => capability.operations.includes(operation)) &&
      needed.resourceTypes.every((type) => capability.resourceTypes.includes(type)),
  )
}
function permissionPhase(s: Snapshot): void {
  const content = (ref: DataRef) => readData(ref, s.contents)
  if (s.historicalConfig)
    demand(
      s.historicalConfig.profileDigest === fingerprint(s.historicalConfig.profile) &&
        s.historicalConfig.presetDigest === fingerprint(s.historicalConfig.preset),
      'content_identity_mismatch',
    )
  const source = capabilities(s.historicalConfig),
    destination = capabilities(s.config),
    difference = s.releasePlan.permissionDifference
  demand(
    difference.beforeProfileDigest === (s.historicalConfig?.profileDigest ?? null) &&
      difference.afterProfileDigest === s.config.profileDigest,
    'permission_difference_mismatch',
  )
  demand(
    matches(
      difference.added,
      destination.filter((capability) => !source.some((old) => matches(old, capability))),
    ) &&
      matches(
        difference.removed,
        source.filter((capability) => !destination.some((current) => matches(current, capability))),
      ),
    'permission_difference_mismatch',
  )
  const changed = (['policy', 'selectionPolicy', 'limits'] as const).filter(
    (key) => !matches(s.historicalConfig?.profile[key] ?? null, s.config.profile[key]),
  )
  demand(
    changed.length === difference.policyChanges.length &&
      new Set(difference.policyChanges.map((change) => change.path)).size === changed.length,
    'permission_difference_mismatch',
  )
  for (const key of changed) {
    const row = difference.policyChanges.find((change) => change.path === `/${key}`)
    demand(
      row?.after &&
        matches(content(row.after), s.config.profile[key]) &&
        (s.historicalConfig
          ? row.before && matches(content(row.before), s.historicalConfig.profile[key])
          : row.before === null),
      'permission_difference_mismatch',
    )
  }
  demand(
    RuntimeAuthorCapabilities.modelInference === simpleLoopCapabilities.modelInference,
    'author_capability_source_mismatch',
  )
  for (const binding of s.releasePlan.targetReleaseSet.bindings) {
    const pkg = s.releasePlan.targetReleaseSet.packages.find(
      (item) =>
        item.digest === binding.descriptor.packageDigest &&
        item.version === binding.descriptor.packageVersion,
    )
    const declared = s.requestedPermissions.find((item) => item.id === pkg?.packageId)
    demand(pkg && declared, 'package_permissions_missing')
    const granted = s.config.profile.policy.grants.find(
      (grant) =>
        grant.provider.packageId === pkg.packageId &&
        grant.provider.providerId === binding.descriptor.providerId &&
        grant.decision !== 'deny',
    )
    for (const capability of binding.descriptor.capabilities)
      demand(
        permits(declared.requests, capability) &&
          permits(s.config.profile.policy.capabilityCeiling, capability) &&
          granted &&
          permits(granted.capabilities, capability),
        'configuration_widens_authority',
      )
    for (const method of binding.descriptor.operations) {
      demand(
        method.requiredCapabilities.every((capability) =>
          permits(binding.descriptor.capabilities, capability),
        ),
        'configuration_widens_authority',
      )
      if (binding.descriptor.contract === 'agh.model' && method.method === 'infer')
        demand(
          permits(method.requiredCapabilities, RuntimeAuthorCapabilities.modelInference),
          'model_inference_capability_missing',
        )
    }
  }
}
function prerequisites(s: Snapshot, joint: RuntimeWireTypes['DispatchAtomicDomain'][]): void {
  demand(new Set(joint.map((domain) => domain.domainId)).size === joint.length, 'joint_dispatch_incompatible')
  for (const domain of joint) {
    const participant = (binding: RuntimeWireTypes['BindingRef'], contract: string) =>
      s.releasePlan.targetReleaseSet.bindings.find(
        (provider) => provider.descriptor.contract === contract && matches(provider.binding, binding),
      )
    demand(
      participant(domain.stateBinding, 'agh.state')?.descriptor.features.includes('joint-dispatch.v1') &&
        participant(domain.budgetBinding, 'agh.budget')?.descriptor.features.includes('joint-dispatch.v1'),
      'joint_dispatch_not_declared',
    )
    demand(
      s.domains.some((current) => matches(domain, current)),
      'joint_dispatch_stale',
    )
  }
  demand(
    new Set(s.releasePlan.prerequisiteMigrationPlans.map((plan) => plan.planId)).size ===
      s.releasePlan.prerequisiteMigrationPlans.length,
    'migration_fingerprint_mismatch',
  )
  for (const required of s.releasePlan.prerequisiteMigrationPlans) {
    const observed = s.migrations.find((item) => item.migration.planId === required.planId)
    demand(observed, 'prerequisite_migration_incomplete')
    const { planFingerprint: omitted, ...body } = observed.migration
    demand(
      observed.migration.planFingerprint === required.planFingerprint &&
        fingerprint(body) === observed.migration.planFingerprint &&
        observed.hash === required.planFingerprint,
      'migration_fingerprint_mismatch',
    )
    demand(
      observed.receipt.state === 'completed' &&
        observed.receipt.upgradeId === observed.migration.upgradeId &&
        observed.receipt.commitRef !== null,
      'prerequisite_migration_incomplete',
    )
    demand(
      observed.receipt.commitRef === observed.commitId && observed.upgrade === observed.migration.upgradeId,
      'migration_commit_mismatch',
    )
    demand(
      Date.parse(observed.migration.expiresAt) > Date.parse(s.at) && matches(observed.current, s.head),
      'migration_stale',
    )
  }
}
function immutable<T>(raw: T): T {
  if (raw && typeof raw === 'object') Object.values(raw).forEach(immutable)
  return raw && typeof raw === 'object' ? Object.freeze(raw) : raw
}
function refusal(reason: string, message?: string): Outcome<never> {
  const code: RuntimeError['code'] =
    reason === 'schema_invalid'
      ? 'invalid_input'
      : reason.includes('unimplemented')
        ? 'incompatible'
        : 'conflict'
  return {
    ok: false,
    error: {
      code,
      detailCode: reason,
      message: message ?? 'Reference release planning refused the locked inputs',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'reference-assembly',
    },
  }
}
export function constructReferenceReleaseSet(raw: unknown): Outcome<ReleaseSet> {
  try {
    const s = decodeSnapshot(raw)
    lockPhase(s)
    selectionPhase(s)
    const paired = materialPhase(s)
    permissionPhase(s)
    prerequisites(s, paired)
    return { ok: true, value: immutable(s.releasePlan.targetReleaseSet) }
  } catch (error) {
    return refusal(
      error instanceof InvalidRelease ? error.reason : 'schema_invalid',
      error instanceof InvalidRelease ? error.message : undefined,
    )
  }
}
/** This independent example plans detached fixtures; it performs no publication or migration. */
export function createReferenceAssemblyProvider(raw: unknown) {
  let pinned: unknown
  let captureRefusal: Outcome<never> | null = null
  try {
    object(raw, ['plan', 'graph', 'configuration', 'resolution', 'fixture'])
    pinned = immutable(structuredClone(raw))
  } catch (error) {
    captureRefusal = refusal(
      error instanceof InvalidRelease ? error.reason : 'schema_invalid',
      error instanceof InvalidRelease ? error.message : undefined,
    )
  }
  return {
    providerId: 'agh.reference/assembly',
    contract: 'agh.assembly',
    implemented: Object.freeze(['plan']),
    incomplete: Object.freeze(['prepare', 'publish', 'drain', 'admission', 'cold-recovery']),
    async plan(request: unknown, context: CallContext): Promise<Outcome<AssemblyGraph>> {
      if (context.signal.aborted) {
        const stopped = refusal('plan_cancelled')
        if (!stopped.ok) stopped.error.code = 'cancelled'
        return stopped
      }
      if (captureRefusal) return captureRefusal
      try {
        const operation = decode('AssemblyPlanRequest', request),
          s = decodeSnapshot(pinned)
        demand(
          matches(operation.configRef, s.assembly.configRef) && matches(operation.lock, s.assembly.lock),
          'plan_input_mismatch',
        )
        const checked = constructReferenceReleaseSet(pinned)
        return checked.ok ? { ok: true, value: immutable(s.assembly) } : checked
      } catch (error) {
        return refusal(
          error instanceof InvalidRelease ? error.reason : 'schema_invalid',
          error instanceof InvalidRelease ? error.message : undefined,
        )
      }
    },
    async prepare(_request: unknown, _context: CallContext): Promise<Outcome<AssemblyPrepareResult>> {
      return refusal('assembly_prepare_unimplemented')
    },
    async publish(_request: unknown, _context: CallContext): Promise<Outcome<AssemblyPublishResult>> {
      return refusal('assembly_publish_unimplemented')
    },
    async drain(_request: unknown, _context: CallContext): Promise<Outcome<AssemblyDrainResult>> {
      return refusal('assembly_drain_unimplemented')
    },
  }
}
