import type { Context } from '@agnes/cordis'
import type { ProviderKind } from '@agnes/extension-api'
import type { SeamKind, SeamProvider } from '@agnes/extension-api/seams'
import { SEAM_KIND_TOKENS, SEAM_KINDS } from '@agnes/extension-api/seams'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'

/**
 * The seven seam kinds are ordinary provider kinds: a package registers an implementation through
 * `ctx.providers.register`, the profile selects one with `providers.<kind>: { provider, version? }`, and
 * the Host's binding row creates the instance. `required` makes a missing selection a startup error.
 */
export function installSeamKinds(root: Context, origins?: RowOriginLookup): void {
  for (const kind of SEAM_KINDS) installSeamKind(root, kind, origins)
}

function installSeamKind(root: Context, kind: SeamKind, origins?: RowOriginLookup): void {
  const registry: ProviderRegistry<SeamProvider<object>> = installProviderRegistry(
    root,
    SEAM_KIND_TOKENS[kind] as unknown as ProviderKind<SeamProvider<object>>,
    (owner, source, provider) => registry.register(providerSource(owner, origins, source), provider, owner),
  )
}
