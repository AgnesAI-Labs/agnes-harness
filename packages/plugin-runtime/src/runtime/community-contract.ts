import { createHash } from 'node:crypto'
import { AssemblyRefusal } from './assembly-refusal.js'
import type { AssemblyProvider, ServiceRequirement } from './cordis-adapter.js'

const DIGEST = /^[a-f0-9]{64}$/u
const SHORT_NAME = /^[a-z][a-z0-9-]*$/u
const OFFICIAL = /^(?:agh|agh[./].*)$/u

export type CommunityContractRef = {
  readonly ownerPackageId: string
  readonly definitionDigest: string
}

export type ContractSchemaRef = {
  readonly typeId: string
  readonly revision: number
  readonly digest: string
}

export type ContractCapability = {
  readonly capability: string
  readonly resourceTypes: readonly string[]
  readonly operations: readonly string[]
}

export type CommunityOperationKind =
  | 'query'
  | 'compute'
  | 'action'
  | 'control'
  | 'maintenance'
  | 'observe'
  | 'ingress'

export type CommunityOperation = {
  readonly method: string
  readonly kind: CommunityOperationKind
  readonly inputSchema: ContractSchemaRef
  readonly outputSchema: ContractSchemaRef
  readonly requiredCapabilities: readonly ContractCapability[]
  readonly retrySafety: 'read-only' | 'idempotent' | 'reconcile-first' | 'never'
}

export type CommunityContractDefinition = {
  readonly contract: string
  readonly major: number
  readonly ownerPackageId: string
  readonly scope: 'runtime' | 'workspace' | 'session' | 'run' | 'action' | 'installation'
  readonly features: readonly string[]
  readonly operations: readonly CommunityOperation[]
}

const MISSING = 'incompatible/contract_definition_missing'
const OWNER = 'conflict/contract_owner_conflict'
const MISMATCH = 'incompatible/contract_definition_mismatch'
const OPERATION = 'incompatible/contract_operation_mismatch'
const FEATURE = 'incompatible/contract_feature_missing'
const AUTHORITY = 'denied/community_authority_forbidden'

export function isCommunityContractName(contract: string): boolean {
  return !isOfficialContract(contract) && communityOwner(contract) !== undefined
}

export function communityDefinitionDigest(definition: CommunityContractDefinition): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex')
}

export function assertCommunityContracts(
  contracts: readonly CommunityContractDefinition[],
  providers: readonly AssemblyProvider[],
): void {
  const catalog = indexCatalog(contracts)
  for (const provider of providers) {
    if (isOfficialContract(provider.contract)) {
      if (provider.contractDefinition || catalog.has(cellKey(provider.contract, provider.major))) {
        refuse(AUTHORITY, 'an official contract cannot be replaced by a community definition', {
          contract: provider.contract,
          providerId: provider.providerId,
        })
      }
    } else {
      const owner = communityOwner(provider.contract)
      const definition = selectDefinition(
        provider.contract,
        provider.major,
        owner,
        provider.contractDefinition,
        catalog,
        {
          providerId: provider.providerId,
        },
      )
      assertAuthority(definition, { contract: definition.contract, providerId: provider.providerId })
      if (provider.scope !== definition.scope) {
        refuse(OPERATION, 'community provider scope does not match its definition', {
          contract: definition.contract,
          providerId: provider.providerId,
        })
      }
      assertOperations(provider.operations ?? [], definition, provider.providerId)
      assertFeatureSubset(provider.features, definition.features, {
        contract: definition.contract,
        providerId: provider.providerId,
      })
    }
    for (const requirement of provider.requires) {
      assertRequirement(requirement, provider, providers, catalog)
    }
  }
}

function assertRequirement(
  requirement: ServiceRequirement,
  provider: AssemblyProvider,
  providers: readonly AssemblyProvider[],
  catalog: ReadonlyMap<string, CommunityContractDefinition>,
): void {
  if (isOfficialContract(requirement.contract)) {
    if (requirement.contractDefinition) {
      refuse(AUTHORITY, 'an official requirement cannot carry a community definition', {
        contract: requirement.contract,
        providerId: provider.providerId,
      })
    }
    return
  }
  if (!isCommunityContractName(requirement.contract)) return
  const owner = communityOwner(requirement.contract)
  const cited = requirement.contractDefinition
  const definition = selectDefinition(requirement.contract, requirement.major, owner, cited, catalog, {
    contract: requirement.contract,
    providerId: provider.providerId,
  })
  assertAuthority(definition, { contract: definition.contract, providerId: provider.providerId })
  const target = providers.find(
    (item) =>
      item.contract === requirement.contract &&
      item.major === requirement.major &&
      item.logicalName === requirement.logicalName &&
      item.scope === requirement.scope,
  )
  if (!target) return
  if (
    target.contractDefinition &&
    cited &&
    target.contractDefinition.definitionDigest !== cited.definitionDigest
  ) {
    refuse(MISMATCH, 'community requirement digest does not match the selected implementation', {
      contract: requirement.contract,
      providerId: provider.providerId,
      expectedDigest: cited.definitionDigest,
    })
  }
  for (const feature of requirement.features) {
    if (!target.features.includes(feature)) {
      refuse(FEATURE, `community provider is missing feature ${feature}`, {
        contract: requirement.contract,
        feature,
        providerId: target.providerId,
      })
    }
  }
}

function selectDefinition(
  contract: string,
  major: number,
  owner: string | undefined,
  ref: CommunityContractRef | undefined,
  catalog: ReadonlyMap<string, CommunityContractDefinition>,
  detail: Record<string, string>,
): CommunityContractDefinition {
  if (!owner) refuse(OWNER, 'community contract name must be owner/short-name', { ...detail, contract })
  const found = catalog.get(cellKey(contract, major))
  if (!found || !ref) {
    refuse(MISSING, `missing community contract definition: ${contract}`, { ...detail, contract })
  }
  if (found.ownerPackageId !== owner || ref.ownerPackageId !== found.ownerPackageId) {
    refuse(OWNER, 'community contract owner does not match the definition package', {
      ...detail,
      contract,
      ownerPackageId: ref.ownerPackageId,
    })
  }
  const digest = communityDefinitionDigest(found)
  if (ref.definitionDigest !== digest) {
    refuse(MISMATCH, 'community contract digest does not match its definition', {
      ...detail,
      contract,
      expectedDigest: digest,
    })
  }
  return found
}

function indexCatalog(
  contracts: readonly CommunityContractDefinition[],
): Map<string, CommunityContractDefinition> {
  const catalog = new Map<string, CommunityContractDefinition>()
  for (const definition of contracts) {
    const owner = communityOwner(definition.contract)
    if (!owner || definition.ownerPackageId !== owner || isOfficialContract(definition.contract)) {
      refuse(
        isOfficialContract(definition.contract) ? AUTHORITY : OWNER,
        'community contract owner is not valid',
        {
          contract: definition.contract,
          ownerPackageId: definition.ownerPackageId,
        },
      )
    }
    const key = cellKey(definition.contract, definition.major)
    const previous = catalog.get(key)
    if (previous && communityDefinitionDigest(previous) !== communityDefinitionDigest(definition)) {
      refuse(MISMATCH, 'one contract major cannot select two definitions', {
        contract: definition.contract,
        expectedDigest: communityDefinitionDigest(previous),
      })
    }
    catalog.set(key, definition)
  }
  return catalog
}

function assertAuthority(definition: CommunityContractDefinition, detail: Record<string, string>): void {
  if (definition.scope === 'installation') {
    refuse(AUTHORITY, 'a community contract cannot use the installation scope', detail)
  }
  for (const operation of definition.operations) {
    if (
      operation.kind === 'control' ||
      operation.kind === 'maintenance' ||
      operation.kind === 'observe' ||
      operation.kind === 'ingress'
    ) {
      refuse(AUTHORITY, `community method ${operation.method} cannot use kind ${operation.kind}`, {
        ...detail,
        method: operation.method,
      })
    }
  }
}

function assertOperations(
  operations: readonly CommunityOperation[],
  definition: CommunityContractDefinition,
  providerId: string,
): void {
  const defined = indexOperations(definition.operations, definition.contract)
  const implemented = indexOperations(operations, definition.contract)
  if (defined.size !== implemented.size) {
    refuse(OPERATION, 'community provider methods do not match the definition', {
      contract: definition.contract,
      providerId,
    })
  }
  for (const [method, expected] of defined) {
    const actual = implemented.get(method)
    if (!actual || !sameOperation(expected, actual)) {
      refuse(OPERATION, `community method ${method} does not match its definition`, {
        contract: definition.contract,
        method,
        providerId,
        expectedDigest: communityDefinitionDigest(definition),
      })
    }
    if (!covers(actual.requiredCapabilities, expected.requiredCapabilities)) {
      refuse(OPERATION, `community method ${method} drops a required capability`, {
        contract: definition.contract,
        method,
        providerId,
      })
    }
  }
}

function indexOperations(
  operations: readonly CommunityOperation[],
  contract: string,
): Map<string, CommunityOperation> {
  if (operations.length === 0) {
    refuse(OPERATION, 'a community contract needs at least one method', { contract })
  }
  const indexed = new Map<string, CommunityOperation>()
  for (const operation of operations) {
    if (operation.method.length === 0 || indexed.has(operation.method)) {
      refuse(OPERATION, `duplicate or empty community method: ${operation.method}`, {
        contract,
        method: operation.method,
      })
    }
    if (
      (operation.kind === 'query' || operation.kind === 'compute') &&
      operation.retrySafety !== 'read-only'
    ) {
      refuse(OPERATION, `community ${operation.kind} method must be read-only`, {
        contract,
        method: operation.method,
      })
    }
    assertSchema(operation.inputSchema, contract, operation.method)
    assertSchema(operation.outputSchema, contract, operation.method)
    indexed.set(operation.method, operation)
  }
  return indexed
}

function sameOperation(expected: CommunityOperation, actual: CommunityOperation): boolean {
  return (
    expected.kind === actual.kind &&
    expected.retrySafety === actual.retrySafety &&
    sameSchema(expected.inputSchema, actual.inputSchema) &&
    sameSchema(expected.outputSchema, actual.outputSchema)
  )
}

function covers(actual: readonly ContractCapability[], expected: readonly ContractCapability[]): boolean {
  const have = new Set(actual.map((capability) => canonicalJson(normalizeCapability(capability))))
  return expected.every((capability) => have.has(canonicalJson(normalizeCapability(capability))))
}

function normalizeCapability(capability: ContractCapability): ContractCapability {
  return {
    capability: capability.capability,
    operations: [...capability.operations].sort(),
    resourceTypes: [...capability.resourceTypes].sort(),
  }
}

function assertSchema(schema: ContractSchemaRef, contract: string, method: string): void {
  if (
    schema.typeId.length === 0 ||
    schema.typeId.length > 256 ||
    !Number.isSafeInteger(schema.revision) ||
    schema.revision < 0 ||
    !DIGEST.test(schema.digest)
  ) {
    refuse(MISMATCH, 'community schema reference is not usable', { contract, method })
  }
}

function sameSchema(left: ContractSchemaRef, right: ContractSchemaRef): boolean {
  return left.typeId === right.typeId && left.revision === right.revision && left.digest === right.digest
}

function assertFeatureSubset(
  actual: readonly string[],
  allowed: readonly string[],
  detail: Record<string, string>,
): void {
  for (const feature of actual) {
    if (!allowed.includes(feature)) {
      refuse(FEATURE, `community provider feature ${feature} is not in the definition`, {
        ...detail,
        feature,
      })
    }
  }
}

function cellKey(contract: string, major: number): string {
  return `${contract}\u0000${major}`
}

function isOfficialContract(contract: string): boolean {
  return OFFICIAL.test(contract)
}

function communityOwner(contract: string): string | undefined {
  const slash = contract.lastIndexOf('/')
  if (slash <= 0) return undefined
  const owner = contract.slice(0, slash)
  const shortName = contract.slice(slash + 1)
  if (!SHORT_NAME.test(shortName) || owner.length === 0 || owner.length > 256 || hasControlCharacter(owner)) {
    return undefined
  }
  if (isOfficialContract(contract) || isOfficialContract(owner)) return undefined
  return owner
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function refuse(code: string, message: string, detail: Record<string, string>): never {
  throw new AssemblyRefusal(code, message, detail)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key])
    return sorted
  }
  return value
}
