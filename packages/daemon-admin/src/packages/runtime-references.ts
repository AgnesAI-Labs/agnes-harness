import type { PackageReferences } from '@agnes/package-manager'
import { PackageError } from '@agnes/package-manager'
import { type PackageBlocker, validatePackageAdminData } from '@agnes/protocol'

export type PackageRuntimeReference = Readonly<{
  kind: 'drainable' | 'blocking' | 'candidate' | 'pin' | 'unknown-contribution'
  reference: string
}>

export type PackageReferenceFacts = Readonly<{
  dependencies: readonly string[]
  profile: readonly string[]
  deployments: readonly string[]
  runtime: readonly PackageRuntimeReference[]
}>

export type PackageReferenceFactReader = (
  input: Readonly<{
    profile: string
    packageId: string
    operation: 'disable' | 'update' | 'rollback' | 'remove'
    extensions: readonly string[]
  }>,
) => Promise<PackageReferenceFacts>

const factKinds = new Set<PackageRuntimeReference['kind']>([
  'drainable',
  'blocking',
  'candidate',
  'pin',
  'unknown-contribution',
])

function references(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (reference) => typeof reference === 'string' && reference.length > 0 && reference.length <= 256,
    )
  )
}

function checkedFacts(value: PackageReferenceFacts): PackageReferenceFacts {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['dependencies', 'profile', 'deployments', 'runtime'].includes(key)) ||
    !references(value.dependencies) ||
    !references(value.profile) ||
    !references(value.deployments) ||
    !Array.isArray(value.runtime) ||
    value.runtime.length > 128 ||
    value.runtime.some(
      (fact) =>
        !fact ||
        typeof fact !== 'object' ||
        Array.isArray(fact) ||
        Object.keys(fact).some((key) => !['kind', 'reference'].includes(key)) ||
        !factKinds.has(fact.kind) ||
        typeof fact.reference !== 'string' ||
        fact.reference.length === 0 ||
        fact.reference.length > 256,
    )
  )
    throw new PackageError('E_EXT_LOAD', 'package reference facts are invalid')
  return structuredClone(value)
}

function blocker(code: PackageBlocker['code'], input: readonly string[]): PackageBlocker | undefined {
  const unique = [...new Set(input)].sort()
  if (!unique.length) return undefined
  const value = { code, references: unique }
  if (!validatePackageAdminData('PackageBlocker', value).ok)
    throw new PackageError('E_EXT_LOAD', 'package reference facts exceed protocol limits')
  return value
}

/**
 * Adapts one admission-frozen daemon fact snapshot to PackageManager's reference authority.
 * Drainable runtime calls are handed to activation for hot replacement, but remove still requires
 * them to be absent. Candidate, pin, unsupported-contribution and durable configuration facts are
 * never waived here.
 */
export function createPackageReferences(readFacts: PackageReferenceFactReader): PackageReferences {
  return async (profile, packageId, operation, extensions = []) => {
    const facts = checkedFacts(
      await readFacts({ profile, packageId, operation, extensions: Object.freeze([...extensions]) }),
    )
    const runtime = facts.runtime.filter((fact) => fact.kind !== 'drainable' || operation === 'remove')
    const blockers = [
      blocker('dependency', facts.dependencies),
      blocker('profile', facts.profile),
      blocker('deployment', facts.deployments),
      blocker(
        'generation',
        runtime.filter((fact) => fact.kind !== 'unknown-contribution').map((fact) => fact.reference),
      ),
      blocker(
        'unknown-contribution',
        runtime.filter((fact) => fact.kind === 'unknown-contribution').map((fact) => fact.reference),
      ),
    ].filter((value): value is PackageBlocker => value !== undefined)
    return Object.freeze(blockers.map((value) => Object.freeze(value)))
  }
}
