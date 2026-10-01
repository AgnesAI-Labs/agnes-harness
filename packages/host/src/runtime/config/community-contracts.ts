// Resolve community contract definitions, provider selections, and consumer requirements.
// A capability request is recorded as a request. It is not turned into a grant.

import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

export type ContractDiagnosticCode =
  | 'incompatible/contract_definition_missing'
  | 'conflict/contract_owner_conflict'
  | 'incompatible/contract_definition_mismatch'
  | 'incompatible/contract_operation_mismatch'
  | 'incompatible/contract_feature_missing'
  | 'denied/community_authority_forbidden'
  | 'schema_invalid'
  | 'provider_not_selected'

export type ContractDiagnostic = {
  code: ContractDiagnosticCode
  path: string
  message: string
  packageId?: string
  contract?: string
  method?: string
  expectedDigest?: string
}

export type PackageDependency = {
  packageId: string
  kind: 'runtime' | 'peer' | 'development'
}

export type ContractProvider = {
  descriptor: unknown
  grants?: readonly unknown[]
}

export type ContractPackage = {
  packageId: string
  contracts?: readonly unknown[]
  schemas?: readonly unknown[]
  dependencies?: readonly PackageDependency[]
  providers?: readonly ContractProvider[]
  requirements?: readonly unknown[]
}

export type ResolvedDefinition = {
  packageId: string
  contract: string
  major: number
  definitionDigest: string
}

export type ResolvedProvider = {
  packageId: string
  providerId: string
  contract: string
  major: number
  definitionDigest: string | null
  requests: unknown[]
  grants: []
}

export type CommunityResolution = {
  status: 'accepted' | 'refused'
  definitions: ResolvedDefinition[]
  providers: ResolvedProvider[]
  diagnostics: ContractDiagnostic[]
}

const AUTHORITY_KINDS = new Set(['control', 'maintenance', 'observe', 'ingress'])
const QUERY_KINDS = new Set(['query', 'compute'])

const json = (value: unknown): Parameters<typeof canonicalJsonDigest>[0] =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof canonicalJsonDigest>[0]

function digest(value: unknown): string {
  return canonicalJsonDigest(json(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diagnostic(
  code: ContractDiagnosticCode,
  path: string,
  message: string,
  extra?: Partial<Pick<ContractDiagnostic, 'packageId' | 'contract' | 'method' | 'expectedDigest'>>,
): ContractDiagnostic {
  const item: ContractDiagnostic = { code, path, message }
  if (extra?.packageId !== undefined) item.packageId = extra.packageId
  if (extra?.contract !== undefined) item.contract = extra.contract
  if (extra?.method !== undefined) item.method = extra.method
  if (extra?.expectedDigest !== undefined) item.expectedDigest = extra.expectedDigest
  return item
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function isOfficialContract(contract: string): boolean {
  return contract === 'agh' || contract.startsWith('agh.') || contract.startsWith('agh/')
}

function schemaKey(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (
    typeof value.typeId !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.digest !== 'string'
  ) {
    return null
  }
  return digest({ typeId: value.typeId, revision: value.revision, digest: value.digest })
}

function visibleSchemas(pkg: ContractPackage, byId: ReadonlyMap<string, ContractPackage>): Set<string> {
  const keys = new Set<string>()
  const add = (source: ContractPackage | undefined) => {
    for (const schema of source?.schemas ?? []) {
      const key = schemaKey(schema)
      if (key) keys.add(key)
    }
  }
  add(pkg)
  for (const dependency of pkg.dependencies ?? []) {
    if (dependency.kind === 'development') continue
    add(byId.get(dependency.packageId))
  }
  return keys
}

function seesPackage(pkg: ContractPackage, ownerPackageId: string): boolean {
  if (pkg.packageId === ownerPackageId) return true
  return (pkg.dependencies ?? []).some(
    (dependency) =>
      dependency.packageId === ownerPackageId &&
      (dependency.kind === 'runtime' || dependency.kind === 'peer'),
  )
}

function capabilityKey(value: unknown): string {
  return digest(value)
}

function sameSchema(left: unknown, right: unknown): boolean {
  return schemaKey(left) !== null && schemaKey(left) === schemaKey(right)
}

type NormalizedDefinition = {
  contract: string
  major: number
  ownerPackageId: string
  scope: string
  features: string[]
  operations: Record<string, unknown>[]
}

function normalizeDefinition(value: Record<string, unknown>): NormalizedDefinition | null {
  if (
    typeof value.contract !== 'string' ||
    typeof value.major !== 'number' ||
    typeof value.ownerPackageId !== 'string' ||
    typeof value.scope !== 'string' ||
    !Array.isArray(value.features) ||
    !Array.isArray(value.operations)
  ) {
    return null
  }
  const features = value.features.filter((feature): feature is string => typeof feature === 'string')
  const operations = value.operations.filter(isRecord).map((operation) => structuredClone(operation))
  features.sort(compareUtf8)
  operations.sort((left, right) => compareUtf8(String(left.method), String(right.method)))
  return {
    contract: value.contract,
    major: value.major,
    ownerPackageId: value.ownerPackageId,
    scope: value.scope,
    features,
    operations,
  }
}

function shortNameMatches(contract: string, ownerPackageId: string): boolean {
  const prefix = `${ownerPackageId}/`
  if (!contract.startsWith(prefix)) return false
  return /^[a-z][a-z0-9-]*$/.test(contract.slice(prefix.length))
}

function pushSchemaErrors(
  diagnostics: ContractDiagnostic[],
  name: 'CommunityContractDefinition' | 'ProviderDescriptor' | 'ServiceRequirement',
  value: unknown,
  path: string,
  packageId: string,
): boolean {
  const validated = validateRuntime(name, value)
  if (validated.ok) return true
  for (const error of validated.errors) {
    diagnostics.push(
      diagnostic('schema_invalid', error.path || path, `${name} failed validation (${error.code})`, {
        packageId,
      }),
    )
  }
  return false
}

function authorityIssues(
  value: Record<string, unknown>,
  path: string,
  packageId: string,
  diagnostics: ContractDiagnostic[],
): void {
  const contract = typeof value.contract === 'string' ? value.contract : undefined
  if (value.scope === 'installation') {
    diagnostics.push(
      diagnostic(
        'denied/community_authority_forbidden',
        `${path}/scope`,
        'a community contract cannot use the installation scope',
        { packageId, ...(contract ? { contract } : {}) },
      ),
    )
  }
  if (!Array.isArray(value.operations)) return
  for (const operation of value.operations) {
    if (!isRecord(operation)) continue
    const method = typeof operation.method === 'string' ? operation.method : undefined
    const kind = typeof operation.kind === 'string' ? operation.kind : ''
    const forbidden =
      AUTHORITY_KINDS.has(kind) || (QUERY_KINDS.has(kind) && operation.retrySafety !== 'read-only')
    if (!forbidden) continue
    diagnostics.push(
      diagnostic(
        'denied/community_authority_forbidden',
        `${path}/operations/${method ?? kind}`,
        'community operations are query, compute, or action, and query or compute stays read-only',
        { packageId, ...(contract ? { contract } : {}), ...(method ? { method } : {}) },
      ),
    )
  }
}

type IndexedDefinition = ResolvedDefinition & { normalized: NormalizedDefinition }

function indexDefinitions(
  packages: readonly ContractPackage[],
  diagnostics: ContractDiagnostic[],
): IndexedDefinition[] {
  const indexed: IndexedDefinition[] = []
  for (const pkg of packages) {
    for (const [index, raw] of (pkg.contracts ?? []).entries()) {
      const path = `/packages/${pkg.packageId}/contracts/${index}`
      if (typeof raw === 'function') {
        diagnostics.push(
          diagnostic('schema_invalid', path, 'a contract definition must be data, not a function', {
            packageId: pkg.packageId,
          }),
        )
        continue
      }
      if (!isRecord(raw)) {
        diagnostics.push(
          diagnostic('schema_invalid', path, 'a contract definition must be an object', {
            packageId: pkg.packageId,
          }),
        )
        continue
      }
      if (typeof raw.contract === 'string' && isOfficialContract(raw.contract)) {
        diagnostics.push(
          diagnostic(
            'conflict/contract_owner_conflict',
            path,
            'an official contract is not a community definition',
            {
              packageId: pkg.packageId,
              contract: raw.contract,
            },
          ),
        )
      }
      if (typeof raw.major !== 'number' || !Number.isInteger(raw.major) || raw.major < 1) {
        diagnostics.push(
          diagnostic('incompatible/contract_definition_missing', `${path}/major`, 'major is required', {
            packageId: pkg.packageId,
            ...(typeof raw.contract === 'string' ? { contract: raw.contract } : {}),
          }),
        )
      }
      if (!Array.isArray(raw.features)) {
        diagnostics.push(
          diagnostic('incompatible/contract_feature_missing', `${path}/features`, 'features are required', {
            packageId: pkg.packageId,
            ...(typeof raw.contract === 'string' ? { contract: raw.contract } : {}),
          }),
        )
      }
      authorityIssues(raw, path, pkg.packageId, diagnostics)
      const schemaOk = pushSchemaErrors(diagnostics, 'CommunityContractDefinition', raw, path, pkg.packageId)
      const normalized = normalizeDefinition(raw)
      if (!schemaOk || !normalized) continue
      if (
        normalized.ownerPackageId !== pkg.packageId ||
        !shortNameMatches(normalized.contract, normalized.ownerPackageId)
      ) {
        diagnostics.push(
          diagnostic(
            'conflict/contract_owner_conflict',
            `${path}/ownerPackageId`,
            'the definition owner must be the package that declares it',
            { packageId: pkg.packageId, contract: normalized.contract },
          ),
        )
        continue
      }
      const methods = new Set<string>()
      for (const operation of normalized.operations) {
        const method = String(operation.method)
        if (methods.has(method)) {
          diagnostics.push(
            diagnostic(
              'incompatible/contract_operation_mismatch',
              `${path}/operations/${method}`,
              'duplicate method',
              {
                packageId: pkg.packageId,
                contract: normalized.contract,
                method,
              },
            ),
          )
        }
        methods.add(method)
      }
      if (new Set(normalized.features).size !== normalized.features.length) {
        diagnostics.push(
          diagnostic('incompatible/contract_definition_mismatch', `${path}/features`, 'duplicate feature', {
            packageId: pkg.packageId,
            contract: normalized.contract,
          }),
        )
      }
      const known = visibleSchemas(pkg, new Map(packages.map((item) => [item.packageId, item])))
      for (const operation of normalized.operations) {
        for (const side of ['inputSchema', 'outputSchema'] as const) {
          const key = schemaKey(operation[side])
          if (key && known.has(key)) continue
          diagnostics.push(
            diagnostic(
              'incompatible/contract_definition_mismatch',
              `${path}/operations/${String(operation.method)}/${side}`,
              'unknown schema',
              {
                packageId: pkg.packageId,
                contract: normalized.contract,
                method: String(operation.method),
              },
            ),
          )
        }
      }
      indexed.push({
        packageId: pkg.packageId,
        contract: normalized.contract,
        major: normalized.major,
        definitionDigest: digest(normalized),
        normalized,
      })
    }
  }
  const groups = new Map<string, IndexedDefinition[]>()
  for (const definition of indexed) {
    const key = `${definition.contract}\0${definition.major}`
    const group = groups.get(key) ?? []
    group.push(definition)
    groups.set(key, group)
  }
  const ambiguous = new Set<string>()
  for (const [key, group] of groups) {
    if (group.length < 2) continue
    ambiguous.add(key)
    const first = group[0]
    if (!first) continue
    const owners = new Set(group.map((definition) => definition.packageId))
    diagnostics.push(
      diagnostic(
        owners.size > 1 ? 'conflict/contract_owner_conflict' : 'incompatible/contract_definition_mismatch',
        `/contracts/${first.contract}`,
        'one assembly cell cannot hold two definitions of the same contract and major',
        { contract: first.contract, expectedDigest: first.definitionDigest },
      ),
    )
  }
  return indexed.filter((definition) => !ambiguous.has(`${definition.contract}\0${definition.major}`))
}

function operationsMatch(
  definition: NormalizedDefinition,
  operations: readonly Record<string, unknown>[],
): { ok: true } | { ok: false; method?: string; message: string } {
  if (operations.length !== definition.operations.length) {
    return { ok: false, message: 'the provider method set differs from the definition' }
  }
  const providerOps = [...operations].sort((left, right) =>
    compareUtf8(String(left.method), String(right.method)),
  )
  for (let index = 0; index < definition.operations.length; index++) {
    const required = definition.operations[index]
    const actual = providerOps[index]
    if (!required || !actual)
      return { ok: false, message: 'the provider method set differs from the definition' }
    const method = String(required.method)
    if (
      actual.method !== required.method ||
      actual.kind !== required.kind ||
      actual.retrySafety !== required.retrySafety
    ) {
      return { ok: false, method, message: `method ${method} does not match the definition` }
    }
    if (
      !sameSchema(actual.inputSchema, required.inputSchema) ||
      !sameSchema(actual.outputSchema, required.outputSchema)
    ) {
      return { ok: false, method, message: `method ${method} does not use the definition schemas` }
    }
    const requiredCaps = new Set(
      (Array.isArray(required.requiredCapabilities) ? required.requiredCapabilities : []).map(capabilityKey),
    )
    const actualCaps = new Set(
      (Array.isArray(actual.requiredCapabilities) ? actual.requiredCapabilities : []).map(capabilityKey),
    )
    for (const cap of requiredCaps) {
      if (!actualCaps.has(cap)) {
        return { ok: false, method, message: `method ${method} drops a required capability` }
      }
    }
  }
  return { ok: true }
}

type ProviderCandidate = ResolvedProvider & { admitted: boolean }

function resolveProviders(
  packages: readonly ContractPackage[],
  definitions: readonly IndexedDefinition[],
  diagnostics: ContractDiagnostic[],
): ProviderCandidate[] {
  const resolved: ProviderCandidate[] = []
  for (const pkg of packages) {
    for (const [index, provider] of (pkg.providers ?? []).entries()) {
      const path = `/packages/${pkg.packageId}/providers/${index}`
      if ((provider.grants?.length ?? 0) > 0) {
        diagnostics.push(
          diagnostic(
            'denied/community_authority_forbidden',
            `${path}/grants`,
            'a capability request is not a grant',
            {
              packageId: pkg.packageId,
            },
          ),
        )
      }
      const descriptor = provider.descriptor
      if (!isRecord(descriptor)) {
        diagnostics.push(
          diagnostic('schema_invalid', path, 'a provider descriptor must be an object', {
            packageId: pkg.packageId,
          }),
        )
        continue
      }
      const contract = typeof descriptor.contract === 'string' ? descriptor.contract : ''
      authorityIssues(descriptor, path, pkg.packageId, diagnostics)
      const official = isOfficialContract(contract)
      if (official && Object.hasOwn(descriptor, 'contractDefinition')) {
        diagnostics.push(
          diagnostic(
            'incompatible/contract_definition_mismatch',
            `${path}/contractDefinition`,
            'an official contract does not take a community definition',
            { packageId: pkg.packageId, contract },
          ),
        )
      }
      if (!official && !Object.hasOwn(descriptor, 'contractDefinition')) {
        diagnostics.push(
          diagnostic(
            'incompatible/contract_definition_missing',
            `${path}/contractDefinition`,
            'a community provider requires a definition reference',
            { packageId: pkg.packageId, ...(contract ? { contract } : {}) },
          ),
        )
      }
      if (!pushSchemaErrors(diagnostics, 'ProviderDescriptor', descriptor, path, pkg.packageId)) continue
      const requests = Array.isArray(descriptor.capabilities) ? structuredClone(descriptor.capabilities) : []
      if (official) {
        resolved.push({
          packageId: pkg.packageId,
          providerId: String(descriptor.providerId),
          contract,
          major: Number(descriptor.major),
          definitionDigest: null,
          requests,
          grants: [],
          admitted: !Object.hasOwn(descriptor, 'contractDefinition'),
        })
        continue
      }
      const reference = isRecord(descriptor.contractDefinition) ? descriptor.contractDefinition : undefined
      const match = definitions.find(
        (definition) =>
          definition.contract === contract &&
          definition.major === descriptor.major &&
          definition.packageId === reference?.ownerPackageId &&
          definition.definitionDigest === reference?.definitionDigest,
      )
      const sameCell = definitions.find(
        (definition) => definition.contract === contract && definition.major === descriptor.major,
      )
      if (!match) {
        const ownerKnown = definitions.some(
          (definition) => definition.packageId === reference?.ownerPackageId,
        )
        diagnostics.push(
          diagnostic(
            ownerKnown
              ? 'incompatible/contract_definition_mismatch'
              : 'incompatible/contract_definition_missing',
            `${path}/contractDefinition`,
            ownerKnown ? 'the definition digest does not match' : 'the definition package is not available',
            {
              packageId: pkg.packageId,
              contract,
              ...(sameCell ? { expectedDigest: sameCell.definitionDigest } : {}),
            },
          ),
        )
        continue
      }
      if (!seesPackage(pkg, match.packageId)) {
        diagnostics.push(
          diagnostic(
            'incompatible/contract_definition_missing',
            `${path}/contractDefinition`,
            'the definition is not in this package or a runtime or peer dependency',
            { packageId: pkg.packageId, contract, expectedDigest: match.definitionDigest },
          ),
        )
        continue
      }
      const features = Array.isArray(descriptor.features)
        ? descriptor.features.filter((feature): feature is string => typeof feature === 'string')
        : []
      for (const feature of features) {
        if (match.normalized.features.includes(feature)) continue
        diagnostics.push(
          diagnostic(
            'incompatible/contract_feature_missing',
            `${path}/features`,
            `missing feature ${feature}`,
            {
              packageId: pkg.packageId,
              contract,
            },
          ),
        )
      }
      if (descriptor.scope !== match.normalized.scope) {
        diagnostics.push(
          diagnostic(
            'incompatible/contract_definition_mismatch',
            `${path}/scope`,
            'scope differs from the definition',
            {
              packageId: pkg.packageId,
              contract,
              expectedDigest: match.definitionDigest,
            },
          ),
        )
      }
      const operations = Array.isArray(descriptor.operations) ? descriptor.operations.filter(isRecord) : []
      const compared = operationsMatch(match.normalized, operations)
      if (!compared.ok) {
        diagnostics.push(
          diagnostic('incompatible/contract_operation_mismatch', `${path}/operations`, compared.message, {
            packageId: pkg.packageId,
            contract,
            ...(compared.method ? { method: compared.method } : {}),
          }),
        )
        continue
      }
      const featureOk = features.every((feature) => match.normalized.features.includes(feature))
      const scopeOk = descriptor.scope === match.normalized.scope
      resolved.push({
        packageId: pkg.packageId,
        providerId: String(descriptor.providerId),
        contract,
        major: Number(descriptor.major),
        definitionDigest: match.definitionDigest,
        requests,
        grants: [],
        admitted: compared.ok && featureOk && scopeOk,
      })
    }
  }
  return resolved
}

function resolveRequirements(
  packages: readonly ContractPackage[],
  definitions: readonly IndexedDefinition[],
  providers: readonly ProviderCandidate[],
  diagnostics: ContractDiagnostic[],
): void {
  for (const pkg of packages) {
    for (const [index, raw] of (pkg.requirements ?? []).entries()) {
      const path = `/packages/${pkg.packageId}/requirements/${index}`
      if (!isRecord(raw)) {
        diagnostics.push(
          diagnostic('schema_invalid', path, 'a service requirement must be an object', {
            packageId: pkg.packageId,
          }),
        )
        continue
      }
      const contract = typeof raw.contract === 'string' ? raw.contract : ''
      if (!pushSchemaErrors(diagnostics, 'ServiceRequirement', raw, path, pkg.packageId)) continue
      const features = Array.isArray(raw.features)
        ? raw.features.filter((feature): feature is string => typeof feature === 'string')
        : []
      if (isOfficialContract(contract)) {
        const provider = providers.find(
          (candidate) =>
            candidate.admitted &&
            candidate.contract === contract &&
            candidate.major === raw.major &&
            candidate.definitionDigest === null,
        )
        if (!provider && raw.optional !== true) {
          diagnostics.push(
            diagnostic(
              'provider_not_selected',
              path,
              'no selected provider satisfies the official requirement',
              {
                packageId: pkg.packageId,
                contract,
              },
            ),
          )
        }
        continue
      }
      const reference = isRecord(raw.contractDefinition) ? raw.contractDefinition : undefined
      const definition = definitions.find(
        (candidate) =>
          candidate.contract === contract &&
          candidate.major === raw.major &&
          candidate.packageId === reference?.ownerPackageId &&
          candidate.definitionDigest === reference?.definitionDigest,
      )
      if (!definition || !seesPackage(pkg, definition.packageId)) {
        diagnostics.push(
          diagnostic(
            'incompatible/contract_definition_missing',
            path,
            'the consumer definition reference is not available through a runtime or peer dependency',
            {
              packageId: pkg.packageId,
              ...(contract ? { contract } : {}),
              ...(definition ? { expectedDigest: definition.definitionDigest } : {}),
            },
          ),
        )
        continue
      }
      const provider = providers.find(
        (candidate) =>
          candidate.admitted &&
          candidate.contract === contract &&
          candidate.major === raw.major &&
          candidate.definitionDigest === definition.definitionDigest,
      )
      if (!provider) {
        if (raw.optional === true) continue
        diagnostics.push(
          diagnostic('provider_not_selected', path, 'no selected provider satisfies the requirement', {
            packageId: pkg.packageId,
            contract,
            expectedDigest: definition.definitionDigest,
          }),
        )
        continue
      }
      for (const feature of features) {
        const provided = packages
          .flatMap((item) => item.providers ?? [])
          .map((item) => item.descriptor)
          .filter(isRecord)
          .find((descriptor) => descriptor.providerId === provider.providerId)
        const declared = Array.isArray(provided?.features) ? provided.features : []
        if (declared.includes(feature)) continue
        diagnostics.push(
          diagnostic(
            'incompatible/contract_feature_missing',
            `${path}/features`,
            `missing feature ${feature}`,
            {
              packageId: pkg.packageId,
              contract,
            },
          ),
        )
      }
    }
  }
}

export function resolveCommunityContracts(packages: readonly ContractPackage[]): CommunityResolution {
  const diagnostics: ContractDiagnostic[] = []
  const definitions = indexDefinitions(packages, diagnostics)
  const providers = resolveProviders(packages, definitions, diagnostics)
  resolveRequirements(packages, definitions, providers, diagnostics)
  const accepted = diagnostics.length === 0
  return {
    status: accepted ? 'accepted' : 'refused',
    definitions: definitions.map(({ packageId, contract, major, definitionDigest }) => ({
      packageId,
      contract,
      major,
      definitionDigest,
    })),
    providers: accepted
      ? providers
          .filter((provider) => provider.admitted)
          .map((provider) => ({
            packageId: provider.packageId,
            providerId: provider.providerId,
            contract: provider.contract,
            major: provider.major,
            definitionDigest: provider.definitionDigest,
            requests: provider.requests,
            grants: [],
          }))
      : [],
    diagnostics,
  }
}
