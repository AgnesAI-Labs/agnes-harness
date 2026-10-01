import { isAbsolute } from 'node:path'
import { type ConfigResolveResult, validateRuntime } from '@agnes/protocol/runtime'
import {
  type ConfigOutcome,
  type ConfigRefusal,
  configRefusal,
  documentDigest,
  MAX_CONFIG_DEPTH,
  RESOLVE_ALGORITHM,
  sameDocument,
} from './config-digest.js'
import type { SchemaCatalog, SchemaRef } from './schema-catalog.js'

type Step<T> = { ok: true; value: T } | { ok: false; refusal: ConfigRefusal }
type Mode = 'child' | 'ceiling'
type Recovery = 'R0' | 'R1' | 'R2'
type Isolation = 'trusted-in-process' | 'isolated-process' | 'remote'
type Decision = 'allow' | 'ask' | 'deny'
type Operation = 'default' | 'replace' | 'merge' | 'intersect' | 'deny-union' | 'minimum' | 'maximum'

type ProviderRef = { packageId: string; providerId: string }
type Capability = { capability: string; resourceTypes: string[]; operations: string[] }
type Selection = {
  contract: string
  major: number
  logicalName: string
  provider: ProviderRef
  isolation: Isolation
}
type PolicyCell = {
  contract: string
  major: number
  logicalName: string
  allowedProviders: ProviderRef[]
  allowSessionSelect: boolean
  configOverridePaths: string[]
  allowedIsolation: Isolation[]
  minimumRecovery: Recovery
}
type PackageRow = {
  id: string
  source: unknown
  manifestDigest: string
  enabled: boolean
}
type ProviderConfig = { provider: ProviderRef; config: { schema: SchemaRef; value: unknown } }
type Grant = {
  provider: ProviderRef
  decision: Decision
  capabilities: Capability[]
  resourceScopes: string[]
}
type Policy = {
  capabilityCeiling: Capability[]
  minimumRecovery: Recovery
  allowedIsolation: Isolation[]
  sourcePolicy: {
    allowLocal: boolean
    npmRegistries: string[]
    gitOrigins: string[]
    allowBuildScripts: boolean
  }
  grants: Grant[]
}
type ProfileDoc = {
  $schema: string
  kind: string
  schemaVersion: string
  id: string
  revision: number
  extends?: { profileId: string; digest: string }
  requiredContractSet: string
  packages: PackageRow[]
  selections: Selection[]
  providerConfigs: ProviderConfig[]
  selectionPolicy: PolicyCell[]
  presets: { default: string; allowed: { presetId: string; digest: string }[] }
  policy: Policy
  limits: Record<string, number>
  client: unknown
  storage: { dataDir: string; cacheDir: string }
  overrides: { allowWorkspaceRestrictions: boolean; sessionParametersSchema: SchemaRef }
}
type Restrictions = {
  capabilityCeiling?: Capability[]
  minimumRecovery?: Recovery
  allowedIsolation?: Isolation[]
  limits?: Record<string, number>
}
type PresetDoc = {
  $schema: string
  kind: string
  schemaVersion: string
  id: string
  revision: number
  extends?: { presetId: string; digest: string }
  selections: Selection[]
  configOverrides: { provider: ProviderRef; patch: { path: string; value: unknown }[] }[]
  parameters: { schema: SchemaRef; value: unknown }
  restrictions: Restrictions
}
type Layer = { sourceId: string; sourceDigest: string; revision: number }
type Entry = {
  path: string
  sourceId: string
  sourceDigest: string
  revision: number
  operation: Operation
  resultDigest: string
}
type SourceIdentity = { sourceRef: string; revision: number; digest: string }
type Snapshot<T> = { source: SourceIdentity; document: T }

const RECOVERY: Recovery[] = ['R0', 'R1', 'R2']
const DECISION_RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 }
const MAX_LIMIT_KEYS = new Set(['MIN_RECOVERY_SUPPORT_DAYS'])
const SECRET_KEY = /^(api[-_]?key|token|secret|password|authorization)$/i
const SECRET_REFERENCE = /^secret:\/\/[A-Za-z0-9_./-]+$/
const DANGEROUS_KEY = new Set(['__proto__', 'constructor', 'prototype'])

const ok = <T>(value: T): Step<T> => ({ ok: true, value })
const fail = <T>(refusal: ConfigRefusal): Step<T> => ({ ok: false, refusal })
const firstError = (errors: { message: string }[]): string => errors[0]?.message ?? 'invalid document'

function record(provenance: Entry[], layer: Layer, path: string, operation: Operation, value: unknown): void {
  provenance.push({
    path,
    sourceId: layer.sourceId,
    sourceDigest: layer.sourceDigest,
    revision: layer.revision,
    operation,
    resultDigest: documentDigest(value),
  })
}

function providerKey(provider: ProviderRef): string {
  return `${provider.packageId}\n${provider.providerId}`
}

function cellKey(selection: { contract: string; major: number; logicalName: string }): string {
  return `${selection.contract}\n${selection.major}\n${selection.logicalName}`
}

function capabilityKey(capability: Capability): string {
  return documentDigest({
    capability: capability.capability,
    resourceTypes: [...capability.resourceTypes].sort(),
    operations: [...capability.operations].sort(),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function layerOf(source: SourceIdentity, document: unknown, path: string): Step<Layer> {
  if (source.digest !== documentDigest(document)) {
    return fail(configRefusal('content_identity_mismatch', path, 'source digest does not match the document'))
  }
  return ok({ sourceId: source.sourceRef, sourceDigest: source.digest, revision: source.revision })
}

function duplicate(
  keys: string[],
  path: string,
  code: 'duplicate_package' | 'duplicate_cell' | 'duplicate_declaration',
): ConfigRefusal | null {
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) return configRefusal(code, path, 'duplicate identity')
    seen.add(key)
  }
  return null
}

function secretScan(value: unknown, path: string): ConfigRefusal | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = secretScan(value[index], `${path}/${index}`)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const [key, child] of Object.entries(value)) {
    const pointer = `${path}/${key}`
    if (typeof child === 'string' && SECRET_KEY.test(key) && !SECRET_REFERENCE.test(child)) {
      return configRefusal('secret_material', pointer, 'redacted')
    }
    const found = secretScan(child, pointer)
    if (found) return found
  }
  return null
}

function storagePath(path: string, pointer: string): ConfigRefusal | null {
  if (path.includes('~')) return configRefusal('home_unresolved', pointer, 'home prefix is not expanded')
  if (!isAbsolute(path)) return configRefusal('path_not_absolute', pointer, 'storage path must be absolute')
  return null
}

function asProfile(value: unknown, path: string): Step<ProfileDoc> {
  const parsed = validateRuntime('RuntimeProfile', value)
  if (!parsed.ok) return fail(configRefusal('schema_invalid', path, firstError(parsed.errors)))
  return ok(structuredClone(parsed.value) as ProfileDoc)
}

function asPreset(value: unknown, path: string): Step<PresetDoc> {
  const parsed = validateRuntime('RuntimePreset', value)
  if (!parsed.ok) return fail(configRefusal('schema_invalid', path, firstError(parsed.errors)))
  return ok(structuredClone(parsed.value) as PresetDoc)
}

function knownSchema(catalog: SchemaCatalog, schema: SchemaRef, path: string): ConfigRefusal | null {
  return catalog.known(schema) ? null : configRefusal('unknown_schema', path, 'schema is not admitted')
}

function profileSchemas(catalog: SchemaCatalog, profile: ProfileDoc, path: string): ConfigRefusal | null {
  const session = knownSchema(
    catalog,
    profile.overrides.sessionParametersSchema,
    `${path}/overrides/sessionParametersSchema`,
  )
  if (session) return session
  for (let index = 0; index < profile.providerConfigs.length; index += 1) {
    const row = profile.providerConfigs[index]
    if (!row) continue
    const missing = knownSchema(catalog, row.config.schema, `${path}/providerConfigs/${index}/config/schema`)
    if (missing) return missing
    const invalid = catalog.checkValue(
      row.config.schema,
      row.config.value,
      `${path}/providerConfigs/${index}/config/value`,
    )
    if (invalid) return invalid
  }
  return null
}

function mergeLimits(
  base: Record<string, number>,
  child: Record<string, number>,
  layer: Layer,
  provenance: Entry[],
  path: string,
): Step<Record<string, number>> {
  const next: Record<string, number> = { ...base }
  for (const [key, childValue] of Object.entries(child)) {
    const current = next[key]
    const useMax = MAX_LIMIT_KEYS.has(key)
    const result =
      current === undefined
        ? childValue
        : useMax
          ? Math.max(current, childValue)
          : Math.min(current, childValue)
    next[key] = result
    record(provenance, layer, `${path}/${key}`, useMax ? 'maximum' : 'minimum', result)
  }
  const checked = validateRuntime('Limits', next)
  if (!checked.ok) return fail(configRefusal('schema_invalid', path, firstError(checked.errors)))
  return ok(checked.value as Record<string, number>)
}

function mergeMembers(
  parent: readonly string[],
  child: readonly string[],
  mode: Mode,
  layer: Layer,
  provenance: Entry[],
  path: string,
): Step<string[]> {
  if (mode === 'child') {
    for (const item of child) {
      if (!parent.includes(item)) {
        return fail(configRefusal('configuration_widens_authority', path, 'value is outside the parent set'))
      }
    }
  }
  const result = (mode === 'child' ? [...child] : [...parent]).filter((item) =>
    (mode === 'child' ? parent : child).includes(item),
  )
  record(provenance, layer, path, 'intersect', result)
  return ok(result)
}

function mergeCapabilities(
  parent: Capability[],
  child: Capability[],
  mode: Mode,
  layer: Layer,
  provenance: Entry[],
  path: string,
): Step<Capability[]> {
  const parentKeys = new Set(parent.map(capabilityKey))
  if (mode === 'child') {
    for (const capability of child) {
      if (!parentKeys.has(capabilityKey(capability))) {
        return fail(
          configRefusal('configuration_widens_authority', path, 'capability is outside the parent ceiling'),
        )
      }
    }
  }
  const childKeys = new Set(child.map(capabilityKey))
  const result = (mode === 'child' ? child : parent).filter((capability) =>
    (mode === 'child' ? parentKeys : childKeys).has(capabilityKey(capability)),
  )
  record(provenance, layer, path, 'intersect', result)
  return ok(result)
}

function mergeBool(parent: boolean, child: boolean, mode: Mode, path: string): Step<boolean> {
  if (mode === 'child' && child && !parent) {
    return fail(configRefusal('configuration_widens_authority', path, 'flag widens the parent'))
  }
  return ok(parent && child)
}

function mergePolicy(
  parent: Policy,
  child: Policy,
  mode: Mode,
  layer: Layer,
  provenance: Entry[],
  path: string,
): Step<Policy> {
  const ceiling = mergeCapabilities(
    parent.capabilityCeiling,
    child.capabilityCeiling,
    mode,
    layer,
    provenance,
    `${path}/capabilityCeiling`,
  )
  if (!ceiling.ok) return ceiling
  const isolation = mergeMembers(
    parent.allowedIsolation,
    child.allowedIsolation,
    mode,
    layer,
    provenance,
    `${path}/allowedIsolation`,
  )
  if (!isolation.ok) return isolation
  if (isolation.value.length === 0)
    return fail(
      configRefusal('limit_conflict', `${path}/allowedIsolation`, 'isolation intersection is empty'),
    )
  const local = mergeBool(
    parent.sourcePolicy.allowLocal,
    child.sourcePolicy.allowLocal,
    mode,
    `${path}/sourcePolicy/allowLocal`,
  )
  if (!local.ok) return local
  const scripts = mergeBool(
    parent.sourcePolicy.allowBuildScripts,
    child.sourcePolicy.allowBuildScripts,
    mode,
    `${path}/sourcePolicy/allowBuildScripts`,
  )
  if (!scripts.ok) return scripts
  const registries = mergeMembers(
    parent.sourcePolicy.npmRegistries,
    child.sourcePolicy.npmRegistries,
    mode,
    layer,
    provenance,
    `${path}/sourcePolicy/npmRegistries`,
  )
  if (!registries.ok) return registries
  const origins = mergeMembers(
    parent.sourcePolicy.gitOrigins,
    child.sourcePolicy.gitOrigins,
    mode,
    layer,
    provenance,
    `${path}/sourcePolicy/gitOrigins`,
  )
  if (!origins.ok) return origins
  const grants = mergeGrants(parent.grants, child.grants, mode, layer, provenance, `${path}/grants`)
  if (!grants.ok) return grants
  const minimumRecovery =
    RECOVERY[Math.max(recoveryRank(parent.minimumRecovery), recoveryRank(child.minimumRecovery))] ??
    parent.minimumRecovery
  record(provenance, layer, `${path}/minimumRecovery`, 'maximum', minimumRecovery)
  return ok({
    capabilityCeiling: ceiling.value,
    minimumRecovery,
    allowedIsolation: isolation.value as Isolation[],
    sourcePolicy: {
      allowLocal: local.value,
      npmRegistries: registries.value,
      gitOrigins: origins.value,
      allowBuildScripts: scripts.value,
    },
    grants: grants.value,
  })
}

function recoveryRank(value: Recovery): number {
  return RECOVERY.indexOf(value)
}

function mergeGrants(
  parent: Grant[],
  child: Grant[],
  mode: Mode,
  layer: Layer,
  provenance: Entry[],
  path: string,
): Step<Grant[]> {
  const parentByKey = new Map(parent.map((grant) => [providerKey(grant.provider), grant]))
  const result: Grant[] = parent.map((grant) => ({
    ...grant,
    capabilities: [...grant.capabilities],
    resourceScopes: [...grant.resourceScopes],
  }))
  for (const grant of child) {
    const key = providerKey(grant.provider)
    const current = parentByKey.get(key)
    if (!current) {
      if (mode === 'child')
        return fail(configRefusal('configuration_widens_authority', path, 'grant adds a provider'))
      if (grant.decision === 'deny') result.push(structuredClone(grant))
      continue
    }
    const capabilities = mergeCapabilities(
      current.capabilities,
      grant.capabilities,
      mode,
      layer,
      provenance,
      `${path}/capabilities`,
    )
    if (!capabilities.ok) return capabilities
    const scopes = mergeMembers(
      current.resourceScopes,
      grant.resourceScopes,
      mode,
      layer,
      provenance,
      `${path}/resourceScopes`,
    )
    if (!scopes.ok) return scopes
    const decision =
      DECISION_RANK[grant.decision] > DECISION_RANK[current.decision] ? grant.decision : current.decision
    const index = result.findIndex((item) => providerKey(item.provider) === key)
    if (index >= 0)
      result[index] = {
        provider: current.provider,
        decision,
        capabilities: capabilities.value,
        resourceScopes: scopes.value,
      }
  }
  record(provenance, layer, path, 'deny-union', result)
  return ok(result)
}

function mergePackages(
  parent: PackageRow[],
  child: PackageRow[],
  layer: Layer,
  provenance: Entry[],
): Step<PackageRow[]> {
  const duplicateParent = duplicate(
    parent.map((row) => row.id),
    '/packages',
    'duplicate_package',
  )
  if (duplicateParent) return fail(duplicateParent)
  const duplicateChild = duplicate(
    child.map((row) => row.id),
    '/packages',
    'duplicate_package',
  )
  if (duplicateChild) return fail(duplicateChild)
  const result = parent.map((row) => ({ ...row }))
  for (const row of child) {
    const current = result.find((item) => item.id === row.id)
    if (!current)
      return fail(
        configRefusal(
          'configuration_widens_authority',
          `/packages/${row.id}`,
          'package is not in the parent',
        ),
      )
    if (!sameDocument(current.source, row.source) || current.manifestDigest !== row.manifestDigest) {
      return fail(configRefusal('source_replaced', `/packages/${row.id}`, 'package source changed'))
    }
    if (!current.enabled && row.enabled) {
      return fail(
        configRefusal(
          'disabled_package_revived',
          `/packages/${row.id}`,
          'disabled package cannot be enabled by a weaker layer',
        ),
      )
    }
    current.enabled = current.enabled && row.enabled
  }
  record(provenance, layer, '/packages', 'merge', result)
  return ok(result)
}

function selectionAllowed(
  selection: Selection,
  policy: PolicyCell[],
  profilePolicy: Policy,
  catalog: SchemaCatalog,
  path: string,
  session: boolean,
): ConfigRefusal | null {
  const cell = policy.find((item) => cellKey(item) === cellKey(selection))
  if (!cell)
    return configRefusal(
      session ? 'session_selection_forbidden' : 'selection_not_allowed',
      path,
      'cell is not selectable',
    )
  if (session && !cell.allowSessionSelect) {
    return configRefusal('session_selection_forbidden', path, 'session cannot select this cell')
  }
  if (!cell.allowedProviders.some((provider) => sameDocument(provider, selection.provider))) {
    return configRefusal(
      session ? 'session_selection_forbidden' : 'selection_not_allowed',
      path,
      'provider is not allowed',
    )
  }
  if (
    !cell.allowedIsolation.includes(selection.isolation) ||
    !profilePolicy.allowedIsolation.includes(selection.isolation)
  ) {
    return configRefusal('selection_not_allowed', path, 'isolation is outside the ceiling')
  }
  const descriptor = catalog.provider(selection.provider.packageId, selection.provider.providerId)
  if (!descriptor) return configRefusal('provider_not_selected', path, 'provider descriptor is not admitted')
  if (
    descriptor.contract !== selection.contract ||
    descriptor.major !== selection.major ||
    descriptor.logicalName !== selection.logicalName
  ) {
    return configRefusal('provider_not_selected', path, 'provider descriptor does not match the cell')
  }
  if (!descriptor.isolation.includes(selection.isolation)) {
    return configRefusal('selection_not_allowed', path, 'provider does not offer the isolation')
  }
  const required =
    RECOVERY[Math.max(recoveryRank(cell.minimumRecovery), recoveryRank(profilePolicy.minimumRecovery))] ??
    cell.minimumRecovery
  if (recoveryRank(descriptor.recovery) < recoveryRank(required)) {
    return configRefusal('selection_not_allowed', path, 'provider recovery is below the minimum')
  }
  return null
}

function mergeSelections(
  parent: Selection[],
  child: Selection[],
  policy: PolicyCell[],
  profilePolicy: Policy,
  catalog: SchemaCatalog,
  layer: Layer,
  provenance: Entry[],
  path: string,
  session: boolean,
): Step<Selection[]> {
  const duplicateChild = duplicate(child.map(cellKey), path, 'duplicate_cell')
  if (duplicateChild) return fail(duplicateChild)
  const result = parent.map((selection) => structuredClone(selection))
  for (let index = 0; index < child.length; index += 1) {
    const selection = child[index]
    if (!selection) continue
    const refusal = selectionAllowed(selection, policy, profilePolicy, catalog, `${path}/${index}`, session)
    if (refusal) return fail(refusal)
    const existing = result.findIndex((item) => cellKey(item) === cellKey(selection))
    if (existing >= 0) result[existing] = structuredClone(selection)
    else result.push(structuredClone(selection))
  }
  record(provenance, layer, path, 'replace', result)
  return ok(result)
}

function mergePolicyCells(
  parent: PolicyCell[],
  child: PolicyCell[],
  mode: Mode,
  layer: Layer,
  provenance: Entry[],
): Step<PolicyCell[]> {
  const duplicateChild = duplicate(child.map(cellKey), '/selectionPolicy', 'duplicate_cell')
  if (duplicateChild) return fail(duplicateChild)
  const childByKey = new Map(child.map((cell) => [cellKey(cell), cell]))
  if (mode === 'child') {
    for (const cell of child) {
      if (!parent.some((item) => cellKey(item) === cellKey(cell))) {
        return fail(
          configRefusal(
            'configuration_widens_authority',
            '/selectionPolicy',
            'policy cell is not in the parent',
          ),
        )
      }
    }
  }
  const result: PolicyCell[] = []
  for (const cell of parent) {
    const incoming = childByKey.get(cellKey(cell))
    if (!incoming) {
      result.push(structuredClone(cell))
      continue
    }
    const providers = mergeMembers(
      cell.allowedProviders.map(providerKey),
      incoming.allowedProviders.map(providerKey),
      mode,
      layer,
      provenance,
      '/selectionPolicy/allowedProviders',
    )
    if (!providers.ok) return providers
    if (providers.value.length === 0) {
      return fail(
        configRefusal('limit_conflict', '/selectionPolicy', 'allowed providers intersection is empty'),
      )
    }
    const isolation = mergeMembers(
      cell.allowedIsolation,
      incoming.allowedIsolation,
      mode,
      layer,
      provenance,
      '/selectionPolicy/allowedIsolation',
    )
    if (!isolation.ok) return isolation
    if (isolation.value.length === 0)
      return fail(configRefusal('limit_conflict', '/selectionPolicy', 'isolation intersection is empty'))
    const paths = mergeMembers(
      cell.configOverridePaths,
      incoming.configOverridePaths,
      mode,
      layer,
      provenance,
      '/selectionPolicy/configOverridePaths',
    )
    if (!paths.ok) return paths
    const session = mergeBool(
      cell.allowSessionSelect,
      incoming.allowSessionSelect,
      mode,
      '/selectionPolicy/allowSessionSelect',
    )
    if (!session.ok) return session
    const providerOrder = mode === 'child' ? incoming.allowedProviders : cell.allowedProviders
    result.push({
      contract: cell.contract,
      major: cell.major,
      logicalName: cell.logicalName,
      allowedProviders: providerOrder.filter((provider) => providers.value.includes(providerKey(provider))),
      allowSessionSelect: session.value,
      configOverridePaths: paths.value,
      allowedIsolation: isolation.value as Isolation[],
      minimumRecovery:
        RECOVERY[Math.max(recoveryRank(cell.minimumRecovery), recoveryRank(incoming.minimumRecovery))] ??
        cell.minimumRecovery,
    })
  }
  record(provenance, layer, '/selectionPolicy', 'intersect', result)
  return ok(result)
}

function mergeAllowedPresets(
  parent: ProfileDoc['presets'],
  child: ProfileDoc['presets'],
  mode: Mode,
  layer: Layer,
  provenance: Entry[],
): Step<ProfileDoc['presets']> {
  const parentKeys = new Set(parent.allowed.map((item) => `${item.presetId}\n${item.digest}`))
  const childKeys = new Set(child.allowed.map((item) => `${item.presetId}\n${item.digest}`))
  if (mode === 'child') {
    for (const item of child.allowed) {
      if (!parentKeys.has(`${item.presetId}\n${item.digest}`)) {
        return fail(
          configRefusal(
            'configuration_widens_authority',
            '/presets/allowed',
            'preset is outside the parent set',
          ),
        )
      }
    }
  }
  const source = mode === 'child' ? child.allowed : parent.allowed
  const allowed = source.filter((item) =>
    (mode === 'child' ? parentKeys : childKeys).has(`${item.presetId}\n${item.digest}`),
  )
  if (
    duplicate(
      allowed.map((item) => item.presetId),
      '/presets/allowed',
      'duplicate_declaration',
    )
  ) {
    return fail(configRefusal('duplicate_declaration', '/presets/allowed', 'preset id is duplicated'))
  }
  const preferred = mode === 'child' ? child.default : parent.default
  if (!allowed.some((item) => item.presetId === preferred)) {
    return fail(configRefusal('entry_selection_invalid', '/presets/default', 'default preset is not allowed'))
  }
  record(provenance, layer, '/presets/allowed', 'intersect', allowed)
  return ok({ default: preferred, allowed })
}

function mergeProviderConfigs(
  parent: ProviderConfig[],
  child: ProviderConfig[],
  catalog: SchemaCatalog,
  layer: Layer,
  provenance: Entry[],
): Step<ProviderConfig[]> {
  const duplicateChild = duplicate(
    child.map((row) => providerKey(row.provider)),
    '/providerConfigs',
    'duplicate_declaration',
  )
  if (duplicateChild) return fail(duplicateChild)
  const result = parent.map((row) => structuredClone(row))
  for (let index = 0; index < child.length; index += 1) {
    const row = child[index]
    if (!row) continue
    const existing = result.findIndex((item) => providerKey(item.provider) === providerKey(row.provider))
    if (existing < 0)
      return fail(
        configRefusal(
          'configuration_widens_authority',
          `/providerConfigs/${index}`,
          'provider config is not in the parent',
        ),
      )
    const current = result[existing]
    if (!current || !sameDocument(current.config.schema, row.config.schema)) {
      return fail(
        configRefusal(
          'provider_config_invalid',
          `/providerConfigs/${index}`,
          'provider config schema changed',
        ),
      )
    }
    const invalid = catalog.checkValue(
      row.config.schema,
      row.config.value,
      `/providerConfigs/${index}/config/value`,
    )
    if (invalid) return fail(invalid)
    current.config = structuredClone(row.config)
  }
  record(provenance, layer, '/providerConfigs', 'replace', result)
  return ok(result)
}

function mergeProfile(
  base: ProfileDoc,
  child: ProfileDoc,
  layer: Layer,
  catalog: SchemaCatalog,
  provenance: Entry[],
  mode: Mode,
): Step<ProfileDoc> {
  const packages =
    mode === 'child'
      ? mergePackages(base.packages, child.packages, layer, provenance)
      : ok(base.packages.map((row) => ({ ...row })))
  if (!packages.ok) return packages
  const selections =
    mode === 'child'
      ? mergeSelections(
          base.selections,
          child.selections,
          base.selectionPolicy,
          base.policy,
          catalog,
          layer,
          provenance,
          '/selections',
          false,
        )
      : ok(base.selections.map((selection) => structuredClone(selection)))
  if (!selections.ok) return selections
  const configs =
    mode === 'child'
      ? mergeProviderConfigs(base.providerConfigs, child.providerConfigs, catalog, layer, provenance)
      : ok(base.providerConfigs.map((row) => structuredClone(row)))
  if (!configs.ok) return configs
  const policyCells = mergePolicyCells(base.selectionPolicy, child.selectionPolicy, mode, layer, provenance)
  if (!policyCells.ok) return policyCells
  const presets = mergeAllowedPresets(base.presets, child.presets, mode, layer, provenance)
  if (!presets.ok) return presets
  const policy = mergePolicy(base.policy, child.policy, mode, layer, provenance, '/policy')
  if (!policy.ok) return policy
  const limits = mergeLimits(base.limits, child.limits, layer, provenance, '/limits')
  if (!limits.ok) return limits
  if (mode === 'child' && !sameDocument(base.client, child.client)) {
    return fail(configRefusal('configuration_widens_authority', '/client', 'client selection cannot change'))
  }
  if (mode === 'child' && !sameDocument(base.storage, child.storage)) {
    return fail(configRefusal('configuration_widens_authority', '/storage', 'storage paths cannot change'))
  }
  const workspace = mergeBool(
    base.overrides.allowWorkspaceRestrictions,
    child.overrides.allowWorkspaceRestrictions,
    mode,
    '/overrides/allowWorkspaceRestrictions',
  )
  if (!workspace.ok) return workspace
  if (!sameDocument(base.overrides.sessionParametersSchema, child.overrides.sessionParametersSchema)) {
    return fail(
      configRefusal(
        'configuration_widens_authority',
        '/overrides/sessionParametersSchema',
        'session schema cannot change',
      ),
    )
  }
  const next: ProfileDoc = {
    ...structuredClone(mode === 'child' ? child : base),
    packages: packages.value,
    selections: selections.value,
    providerConfigs: configs.value,
    selectionPolicy: policyCells.value,
    presets: presets.value,
    policy: policy.value,
    limits: limits.value,
    client: structuredClone(base.client),
    storage: structuredClone(base.storage),
    overrides: {
      allowWorkspaceRestrictions: workspace.value,
      sessionParametersSchema: structuredClone(base.overrides.sessionParametersSchema),
    },
  }
  if (mode === 'ceiling') {
    next.id = base.id
    next.revision = base.revision
  }
  delete next.extends
  for (let index = 0; index < next.selections.length; index += 1) {
    const selection = next.selections[index]
    if (!selection) continue
    const refusal = selectionAllowed(
      selection,
      next.selectionPolicy,
      next.policy,
      catalog,
      `/selections/${index}`,
      false,
    )
    if (refusal) return fail(refusal)
  }
  record(provenance, layer, '/id', mode === 'child' ? 'replace' : 'intersect', next.id)
  return ok(next)
}

function managedProfile(
  base: ProfileDoc,
  managed: {
    policy: Policy
    selectionPolicy: PolicyCell[]
    allowedPresets: ProfileDoc['presets']['allowed']
    limits: Record<string, number>
    packagesDeny: string[]
    providerConfigRestrictions: PresetDoc['configOverrides']
  },
  layer: Layer,
  catalog: SchemaCatalog,
  provenance: Entry[],
): Step<ProfileDoc> {
  const synthetic: ProfileDoc = {
    ...structuredClone(base),
    policy: managed.policy,
    selectionPolicy: managed.selectionPolicy,
    presets: { default: base.presets.default, allowed: managed.allowedPresets },
    limits: managed.limits,
  }
  const merged = mergeProfile(base, synthetic, layer, catalog, provenance, 'ceiling')
  if (!merged.ok) return merged
  const packages = merged.value.packages.map((row) => ({ ...row }))
  for (const id of managed.packagesDeny) {
    const row = packages.find((item) => item.id === id)
    if (row) row.enabled = false
  }
  record(provenance, layer, '/packages', 'deny-union', packages)
  const next = { ...merged.value, packages }
  for (const override of managed.providerConfigRestrictions) {
    for (const cell of next.selectionPolicy) {
      if (!cell.allowedProviders.some((provider) => sameDocument(provider, override.provider))) continue
      const allowed = new Set(override.patch.map((patch) => patch.path))
      cell.configOverridePaths = cell.configOverridePaths.filter((path) => allowed.has(path))
    }
  }
  record(provenance, layer, '/selectionPolicy', 'intersect', next.selectionPolicy)
  return ok(next)
}

function mergeRestrictions(
  parent: Restrictions,
  child: Restrictions,
  mode: Mode,
  layer: Layer,
  provenance: Entry[],
  path: string,
): Step<Restrictions> {
  const next: Restrictions = {}
  const parentCeiling = parent.capabilityCeiling ?? []
  const childCeiling = child.capabilityCeiling ?? parentCeiling
  if (child.capabilityCeiling || parent.capabilityCeiling) {
    const ceiling = mergeCapabilities(
      parentCeiling,
      childCeiling,
      mode,
      layer,
      provenance,
      `${path}/capabilityCeiling`,
    )
    if (!ceiling.ok) return ceiling
    next.capabilityCeiling = ceiling.value
  }
  const parentIsolation = parent.allowedIsolation ?? []
  const childIsolation = child.allowedIsolation ?? parentIsolation
  if (child.allowedIsolation || parent.allowedIsolation) {
    const isolation = mergeMembers(
      parentIsolation,
      childIsolation,
      mode,
      layer,
      provenance,
      `${path}/allowedIsolation`,
    )
    if (!isolation.ok) return isolation
    if (isolation.value.length === 0)
      return fail(
        configRefusal('limit_conflict', `${path}/allowedIsolation`, 'isolation intersection is empty'),
      )
    next.allowedIsolation = isolation.value as Isolation[]
  }
  if (parent.minimumRecovery || child.minimumRecovery) {
    const parentRecovery = parent.minimumRecovery ?? 'R0'
    const childRecovery = child.minimumRecovery ?? parentRecovery
    next.minimumRecovery =
      RECOVERY[Math.max(recoveryRank(parentRecovery), recoveryRank(childRecovery))] ?? parentRecovery
    record(provenance, layer, `${path}/minimumRecovery`, 'maximum', next.minimumRecovery)
  }
  const limits = mergeLimits(parent.limits ?? {}, child.limits ?? {}, layer, provenance, `${path}/limits`)
  if (!limits.ok) return limits
  if (Object.keys(limits.value).length > 0) next.limits = limits.value
  return ok(next)
}

function mergeParameterValue(base: unknown, child: unknown, path: string): Step<unknown> {
  if (isRecord(base) && isRecord(child)) {
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(child)) {
      if (DANGEROUS_KEY.has(key))
        return fail(
          configRefusal('configuration_widens_authority', `${path}/${key}`, 'patch key is reserved'),
        )
      const current = merged[key]
      const nested =
        isRecord(current) && isRecord(value)
          ? mergeParameterValue(current, value, `${path}/${key}`)
          : ok(value)
      if (!nested.ok) return nested
      merged[key] = nested.value
    }
    return ok(merged)
  }
  return ok(child)
}

function mergeParameters(
  parent: PresetDoc['parameters'],
  child: PresetDoc['parameters'],
  catalog: SchemaCatalog,
  layer: Layer,
  provenance: Entry[],
  path: string,
): Step<PresetDoc['parameters']> {
  if (!sameDocument(parent.schema, child.schema)) {
    return fail(configRefusal('parameter_schema_mismatch', path, 'parameter schema changed'))
  }
  const merged = mergeParameterValue(parent.value, child.value, path)
  if (!merged.ok) return merged
  const invalid = catalog.checkValue(parent.schema, merged.value, path)
  if (invalid) return fail(invalid)
  record(provenance, layer, path, 'merge', merged.value)
  return ok({ schema: structuredClone(parent.schema), value: merged.value })
}

function mergePreset(
  base: PresetDoc,
  child: PresetDoc,
  profile: ProfileDoc,
  catalog: SchemaCatalog,
  layer: Layer,
  provenance: Entry[],
): Step<PresetDoc> {
  const selections = mergeSelections(
    base.selections,
    child.selections,
    profile.selectionPolicy,
    profile.policy,
    catalog,
    layer,
    provenance,
    '/preset/selections',
    false,
  )
  if (!selections.ok) return selections
  const restrictions = mergeRestrictions(
    base.restrictions,
    child.restrictions,
    'child',
    layer,
    provenance,
    '/restrictions',
  )
  if (!restrictions.ok) return restrictions
  const parameters = mergeParameters(
    base.parameters,
    child.parameters,
    catalog,
    layer,
    provenance,
    '/parameters',
  )
  if (!parameters.ok) return parameters
  const next: PresetDoc = {
    ...structuredClone(child),
    selections: selections.value,
    restrictions: restrictions.value,
    parameters: parameters.value,
    configOverrides: structuredClone(child.configOverrides),
  }
  delete next.extends
  record(provenance, layer, '/preset/id', 'replace', next.id)
  return ok(next)
}

function decodePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

function setPointer(root: unknown, pointer: string, value: unknown): ConfigRefusal | null {
  if (!pointer.startsWith('/'))
    return configRefusal('config_override_forbidden', pointer, 'patch path must be a JSON pointer')
  const segments = pointer.split('/').slice(1).map(decodePointer)
  if (segments.length === 0 || segments.some((segment) => segment === '-' || DANGEROUS_KEY.has(segment))) {
    return configRefusal('config_override_forbidden', pointer, 'patch path is not replaceable')
  }
  if (!isRecord(root))
    return configRefusal('provider_config_invalid', pointer, 'provider config is not an object')
  let cursor = root
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]
    if (!key || !isRecord(cursor[key]))
      return configRefusal('provider_config_invalid', pointer, 'patch path is missing')
    cursor = cursor[key] as Record<string, unknown>
  }
  const leaf = segments[segments.length - 1]
  if (!leaf) return configRefusal('config_override_forbidden', pointer, 'patch path is empty')
  cursor[leaf] = value
  return null
}

function applyOverrides(
  profile: ProfileDoc,
  overrides: PresetDoc['configOverrides'],
  catalog: SchemaCatalog,
  layer: Layer,
  provenance: Entry[],
): Step<ProfileDoc> {
  const next = structuredClone(profile)
  for (let index = 0; index < overrides.length; index += 1) {
    const override = overrides[index]
    if (!override) continue
    const config = next.providerConfigs.find((row) => sameDocument(row.provider, override.provider))
    if (!config)
      return fail(
        configRefusal('provider_config_invalid', `/configOverrides/${index}`, 'provider config is absent'),
      )
    const cells = next.selectionPolicy.filter((cell) =>
      cell.allowedProviders.some((provider) => sameDocument(provider, override.provider)),
    )
    for (const patch of override.patch) {
      if (!cells.some((cell) => cell.configOverridePaths.includes(patch.path))) {
        return fail(configRefusal('config_override_forbidden', patch.path, 'path is not overridable'))
      }
      const rejected = setPointer(config.config.value, patch.path, structuredClone(patch.value))
      if (rejected) return fail(rejected)
    }
    const invalid = catalog.checkValue(config.config.schema, config.config.value, `/configOverrides/${index}`)
    if (invalid) return fail(invalid)
  }
  record(provenance, layer, '/providerConfigs', 'replace', next.providerConfigs)
  return ok(next)
}

function chainProfiles(
  defaults: Snapshot<ProfileDoc>,
  profiles: Snapshot<ProfileDoc>[],
  catalog: SchemaCatalog,
  provenance: Entry[],
): Step<ProfileDoc> {
  if (1 + profiles.length > MAX_CONFIG_DEPTH) {
    return fail(configRefusal('extends_depth', '/profiles', 'profile chain exceeds 16 documents'))
  }
  const seen = new Set<string>([defaults.document.id])
  let current = defaults.document
  record(
    provenance,
    {
      sourceId: defaults.source.sourceRef,
      sourceDigest: defaults.source.digest,
      revision: defaults.source.revision,
    },
    '/id',
    'default',
    current.id,
  )
  for (let index = 0; index < profiles.length; index += 1) {
    const snapshot = profiles[index]
    if (!snapshot) continue
    const parent = index === 0 ? defaults.document : profiles[index - 1]?.document
    if (!parent)
      return fail(configRefusal('extends_missing', `/profiles/${index}`, 'parent profile is missing'))
    const extension = snapshot.document.extends
    if (!extension)
      return fail(
        configRefusal('extends_missing', `/profiles/${index}/extends`, 'profile does not name its parent'),
      )
    if (extension.profileId !== parent.id) {
      return fail(
        configRefusal(
          'extends_missing',
          `/profiles/${index}/extends`,
          'profile parent is not the previous document',
        ),
      )
    }
    if (extension.digest !== documentDigest(parent)) {
      return fail(
        configRefusal(
          'extends_digest_mismatch',
          `/profiles/${index}/extends`,
          'profile parent digest does not match',
        ),
      )
    }
    if (seen.has(snapshot.document.id))
      return fail(configRefusal('extends_cycle', `/profiles/${index}`, 'profile chain repeats an id'))
    seen.add(snapshot.document.id)
    const layer = {
      sourceId: snapshot.source.sourceRef,
      sourceDigest: snapshot.source.digest,
      revision: snapshot.source.revision,
    }
    const merged = mergeProfile(current, snapshot.document, layer, catalog, provenance, 'child')
    if (!merged.ok) return merged
    current = merged.value
  }
  return ok(current)
}

function chainPresets(
  defaults: Snapshot<PresetDoc>,
  presets: Snapshot<PresetDoc>[],
  profile: ProfileDoc,
  catalog: SchemaCatalog,
  provenance: Entry[],
): Step<PresetDoc> {
  if (1 + presets.length > MAX_CONFIG_DEPTH) {
    return fail(configRefusal('extends_depth', '/presets', 'preset chain exceeds 16 documents'))
  }
  const seen = new Set<string>([defaults.document.id])
  let current = defaults.document
  record(
    provenance,
    {
      sourceId: defaults.source.sourceRef,
      sourceDigest: defaults.source.digest,
      revision: defaults.source.revision,
    },
    '/preset/id',
    'default',
    current.id,
  )
  for (let index = 0; index < presets.length; index += 1) {
    const snapshot = presets[index]
    if (!snapshot) continue
    const parent = index === 0 ? defaults.document : presets[index - 1]?.document
    if (!parent)
      return fail(configRefusal('extends_missing', `/presets/${index}`, 'parent preset is missing'))
    const extension = snapshot.document.extends
    if (!extension)
      return fail(
        configRefusal('extends_missing', `/presets/${index}/extends`, 'preset does not name its parent'),
      )
    if (extension.presetId !== parent.id) {
      return fail(
        configRefusal(
          'extends_missing',
          `/presets/${index}/extends`,
          'preset parent is not the previous document',
        ),
      )
    }
    if (extension.digest !== documentDigest(parent)) {
      return fail(
        configRefusal(
          'extends_digest_mismatch',
          `/presets/${index}/extends`,
          'preset parent digest does not match',
        ),
      )
    }
    if (seen.has(snapshot.document.id))
      return fail(configRefusal('extends_cycle', `/presets/${index}`, 'preset chain repeats an id'))
    seen.add(snapshot.document.id)
    const layer = {
      sourceId: snapshot.source.sourceRef,
      sourceDigest: snapshot.source.digest,
      revision: snapshot.source.revision,
    }
    const merged = mergePreset(current, snapshot.document, profile, catalog, layer, provenance)
    if (!merged.ok) return merged
    current = merged.value
  }
  return ok(current)
}

function finishDocuments(
  profile: ProfileDoc,
  preset: PresetDoc,
): Step<{ profile: ProfileDoc; preset: PresetDoc }> {
  const dataDir = storagePath(profile.storage.dataDir, '/storage/dataDir')
  if (dataDir) return fail(dataDir)
  const cacheDir = storagePath(profile.storage.cacheDir, '/storage/cacheDir')
  if (cacheDir) return fail(cacheDir)
  const profileSecret = secretScan(profile, '/profile')
  if (profileSecret) return fail(profileSecret)
  const presetSecret = secretScan(preset, '/preset')
  if (presetSecret) return fail(presetSecret)
  const profileChecked = validateRuntime('RuntimeProfile', profile)
  if (!profileChecked.ok)
    return fail(configRefusal('schema_invalid', '/profile', firstError(profileChecked.errors)))
  const presetChecked = validateRuntime('RuntimePreset', preset)
  if (!presetChecked.ok)
    return fail(configRefusal('schema_invalid', '/preset', firstError(presetChecked.errors)))
  return ok({ profile: profileChecked.value as ProfileDoc, preset: presetChecked.value as PresetDoc })
}

export function resolveConfigRequest(
  input: unknown,
  catalog: SchemaCatalog,
): ConfigOutcome<ConfigResolveResult> {
  const parsed = validateRuntime('ConfigResolveRequest', input)
  if (!parsed.ok)
    return { ok: false, refusal: configRefusal('schema_invalid', '', firstError(parsed.errors)) }
  const leaked = secretScan(parsed.value, '')
  if (leaked) return { ok: false, refusal: leaked }
  const request = parsed.value
  const provenance: Entry[] = []
  const defaultProfile = asProfile(request.defaults.profile.document, '/defaults/profile')
  if (!defaultProfile.ok) return { ok: false, refusal: defaultProfile.refusal }
  const defaultProfileLayer = layerOf(
    request.defaults.profile.source,
    defaultProfile.value,
    '/defaults/profile/source',
  )
  if (!defaultProfileLayer.ok) return { ok: false, refusal: defaultProfileLayer.refusal }
  const defaultPreset = asPreset(request.defaults.preset.document, '/defaults/preset')
  if (!defaultPreset.ok) return { ok: false, refusal: defaultPreset.refusal }
  const defaultPresetLayer = layerOf(
    request.defaults.preset.source,
    defaultPreset.value,
    '/defaults/preset/source',
  )
  if (!defaultPresetLayer.ok) return { ok: false, refusal: defaultPresetLayer.refusal }
  const profiles: Snapshot<ProfileDoc>[] = []
  for (let index = 0; index < request.profiles.length; index += 1) {
    const snapshot = request.profiles[index]
    if (!snapshot) continue
    const document = asProfile(snapshot.document, `/profiles/${index}`)
    if (!document.ok) return { ok: false, refusal: document.refusal }
    const layer = layerOf(snapshot.source, document.value, `/profiles/${index}/source`)
    if (!layer.ok) return { ok: false, refusal: layer.refusal }
    const invalid = profileSchemas(catalog, document.value, `/profiles/${index}`)
    if (invalid) return { ok: false, refusal: invalid }
    const storage =
      storagePath(document.value.storage.dataDir, `/profiles/${index}/storage/dataDir`) ??
      storagePath(document.value.storage.cacheDir, `/profiles/${index}/storage/cacheDir`)
    if (storage) return { ok: false, refusal: storage }
    profiles.push({ source: snapshot.source, document: document.value })
  }
  const defaultSchemas = profileSchemas(catalog, defaultProfile.value, '/defaults/profile')
  if (defaultSchemas) return { ok: false, refusal: defaultSchemas }
  const presets: Snapshot<PresetDoc>[] = []
  for (let index = 0; index < request.presets.length; index += 1) {
    const snapshot = request.presets[index]
    if (!snapshot) continue
    const document = asPreset(snapshot.document, `/presets/${index}`)
    if (!document.ok) return { ok: false, refusal: document.refusal }
    const layer = layerOf(snapshot.source, document.value, `/presets/${index}/source`)
    if (!layer.ok) return { ok: false, refusal: layer.refusal }
    const parameters = knownSchema(
      catalog,
      document.value.parameters.schema,
      `/presets/${index}/parameters/schema`,
    )
    if (parameters) return { ok: false, refusal: parameters }
    presets.push({ source: snapshot.source, document: document.value })
  }
  const defaultParameters = knownSchema(
    catalog,
    defaultPreset.value.parameters.schema,
    '/defaults/preset/parameters/schema',
  )
  if (defaultParameters) return { ok: false, refusal: defaultParameters }
  const chainedProfile = chainProfiles(
    { source: request.defaults.profile.source, document: defaultProfile.value },
    profiles,
    catalog,
    provenance,
  )
  if (!chainedProfile.ok) return { ok: false, refusal: chainedProfile.refusal }
  let resolvedProfile = chainedProfile.value
  if (request.managed) {
    const managedDocument = validateRuntime('ConfigManagedPolicy', request.managed.document)
    if (!managedDocument.ok)
      return {
        ok: false,
        refusal: configRefusal('schema_invalid', '/managed', firstError(managedDocument.errors)),
      }
    const managedLayer = layerOf(request.managed.source, request.managed.document, '/managed/source')
    if (!managedLayer.ok) return { ok: false, refusal: managedLayer.refusal }
    const managed = managedProfile(
      resolvedProfile,
      managedDocument.value as Parameters<typeof managedProfile>[1],
      managedLayer.value,
      catalog,
      provenance,
    )
    if (!managed.ok) return { ok: false, refusal: managed.refusal }
    resolvedProfile = managed.value
  }
  if (!resolvedProfile.presets.allowed.some((item) => item.presetId === resolvedProfile.presets.default)) {
    return {
      ok: false,
      refusal: configRefusal('entry_selection_invalid', '/presets/default', 'default preset is not allowed'),
    }
  }
  const chainedPreset = chainPresets(
    { source: request.defaults.preset.source, document: defaultPreset.value },
    presets,
    resolvedProfile,
    catalog,
    provenance,
  )
  if (!chainedPreset.ok) return { ok: false, refusal: chainedPreset.refusal }
  let resolvedPreset = chainedPreset.value
  const leaf = presets[presets.length - 1]
  if (
    !leaf ||
    !resolvedProfile.presets.allowed.some(
      (item) => item.presetId === leaf.document.id && item.digest === documentDigest(leaf.document),
    )
  ) {
    return {
      ok: false,
      refusal: configRefusal('entry_selection_invalid', '/presets', 'selected preset is not allowed'),
    }
  }
  if (request.workspace) {
    if (!resolvedProfile.overrides.allowWorkspaceRestrictions) {
      return {
        ok: false,
        refusal: configRefusal('workspace_forbidden', '/workspace', 'workspace restrictions are not allowed'),
      }
    }
    const workspaceDocument = validateRuntime('ConfigWorkspaceOverlay', request.workspace.document)
    if (!workspaceDocument.ok)
      return {
        ok: false,
        refusal: configRefusal('schema_invalid', '/workspace', firstError(workspaceDocument.errors)),
      }
    const workspaceLayer = layerOf(request.workspace.source, request.workspace.document, '/workspace/source')
    if (!workspaceLayer.ok) return { ok: false, refusal: workspaceLayer.refusal }
    const restrictions = mergeRestrictions(
      resolvedPreset.restrictions,
      workspaceDocument.value.restrictions as Restrictions,
      'ceiling',
      workspaceLayer.value,
      provenance,
      '/restrictions',
    )
    if (!restrictions.ok) return { ok: false, refusal: restrictions.refusal }
    const parameters = mergeParameters(
      resolvedPreset.parameters,
      workspaceDocument.value.parameters,
      catalog,
      workspaceLayer.value,
      provenance,
      '/parameters',
    )
    if (!parameters.ok) return { ok: false, refusal: parameters.refusal }
    resolvedPreset = { ...resolvedPreset, restrictions: restrictions.value, parameters: parameters.value }
  }
  if (request.session) {
    const sessionDocument = validateRuntime('ConfigSessionOverlay', request.session.document)
    if (!sessionDocument.ok)
      return {
        ok: false,
        refusal: configRefusal('schema_invalid', '/session', firstError(sessionDocument.errors)),
      }
    const sessionLayer = layerOf(request.session.source, request.session.document, '/session/source')
    if (!sessionLayer.ok) return { ok: false, refusal: sessionLayer.refusal }
    const selections = mergeSelections(
      resolvedPreset.selections,
      sessionDocument.value.selections as Selection[],
      resolvedProfile.selectionPolicy,
      resolvedProfile.policy,
      catalog,
      sessionLayer.value,
      provenance,
      '/session/selections',
      true,
    )
    if (!selections.ok) return { ok: false, refusal: selections.refusal }
    const parameters = mergeParameters(
      resolvedPreset.parameters,
      sessionDocument.value.parameters,
      catalog,
      sessionLayer.value,
      provenance,
      '/parameters',
    )
    if (!parameters.ok) return { ok: false, refusal: parameters.refusal }
    const overrides = applyOverrides(
      resolvedProfile,
      sessionDocument.value.configOverrides as PresetDoc['configOverrides'],
      catalog,
      sessionLayer.value,
      provenance,
    )
    if (!overrides.ok) return { ok: false, refusal: overrides.refusal }
    resolvedProfile = overrides.value
    resolvedPreset = {
      ...resolvedPreset,
      selections: selections.value,
      parameters: parameters.value,
      configOverrides: structuredClone(sessionDocument.value.configOverrides) as PresetDoc['configOverrides'],
    }
  }
  const finished = finishDocuments(resolvedProfile, resolvedPreset)
  if (!finished.ok) return { ok: false, refusal: finished.refusal }
  const sourceSetDigest = documentDigest({
    algorithm: RESOLVE_ALGORITHM,
    defaults: { profile: request.defaults.profile.source, preset: request.defaults.preset.source },
    profiles: request.profiles.map((item) => item.source),
    presets: request.presets.map((item) => item.source),
    managed: request.managed?.source ?? null,
    workspace: request.workspace?.source ?? null,
    session: request.session?.source ?? null,
  })
  const result = {
    status: 'candidate' as const,
    algorithm: RESOLVE_ALGORITHM,
    sourceSetDigest,
    profile: finished.value.profile,
    preset: finished.value.preset,
    provenance,
    profileDigest: documentDigest(finished.value.profile),
    presetDigest: documentDigest(finished.value.preset),
  }
  const checked = validateRuntime('ConfigResolveResult', result)
  if (!checked.ok)
    return { ok: false, refusal: configRefusal('schema_invalid', '/resolve', firstError(checked.errors)) }
  return { ok: true, result: checked.value }
}
