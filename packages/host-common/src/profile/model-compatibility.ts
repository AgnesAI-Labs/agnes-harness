import { canonicalJson } from './canonical.js'
import type { ResolvedProfile } from './types.js'

/** Profile fields that cannot change through Host.applyModelProfile. Package rows attest separately. */
export function modelProfileDeployment(profile: ResolvedProfile): string {
  const { provider: _provider, hash: _hash, chain: _chain, packages: _packages, adapters, ...rest } = profile
  const { secrets: _secrets, ...fixedAdapters } = adapters
  return canonicalJson({ ...rest, adapters: fixedAdapters })
}
