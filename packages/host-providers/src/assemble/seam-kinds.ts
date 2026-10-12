import type { Context } from '@agnes/cordis'
import { defineProviderKind } from '@agnes/extension-api'
import type { SeamKind, SeamProvider } from '@agnes/extension-api/seams'
import { PINNED_SEAM_KINDS, SEAM_KINDS } from '@agnes/extension-api/seams'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'

/**
 * The seven seam kinds are ordinary provider kinds: a package registers an implementation through
 * `ctx.providers.register`, the profile selects one with `seams.<kind>: { provider, version? }`, and
 * the Host's binding row creates the instance. `required` makes a missing selection a startup error.
 */
export function installSeamKinds(root: Context, origins?: RowOriginLookup): void {
  for (const kind of SEAM_KINDS) installSeamKind(root, kind, origins)
}

function installSeamKind(root: Context, kind: SeamKind, origins?: RowOriginLookup): void {
  const registry: ProviderRegistry<SeamProvider<object>> = installProviderRegistry(
    root,
    defineProviderKind<SeamProvider<object>>({
      kind,
      required: true,
      authority: 'open',
      pinned: (PINNED_SEAM_KINDS as readonly string[]).includes(kind),
      validate(provider) {
        if (typeof provider.create !== 'function')
          throw new Error(`invalid ${kind} provider: create() is required`)
      },
    }),
    (owner, source, provider) =>
      registry.register(providerSource(owner, origins, source, true), provider, owner),
  )
}
