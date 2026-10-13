import { canonicalJson, sha256hex } from '@agnes/host-common/profile/canonical'
import type {
  CompositionPatch,
  CompositionProviders,
  ResolvedComposition,
} from '@agnes/host-common/profile/composition'
import { freezeTree } from '@agnes/host-common/profile/composition-freeze'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { capabilityEnabled, resolveSessionCapabilities } from './session-capabilities.js'

/** Compile a preset tree into a separate Host profile, without changing an existing session. */
export function profileForComposition(profile: ResolvedProfile, tree: ResolvedComposition): ResolvedProfile {
  const patch = tree.selection
  const { hash: _hash, compaction: _compaction, ...rest } = profile
  const capabilities = resolveSessionCapabilities({
    composition: tree,
    installed: { modelAdapters: [...new Set((profile.provider.routes ?? []).map((route) => route.api))] },
  })
  const providers: CompositionProviders = {
    ...(patch.modelAdapters ? { 'model-adapter': { provider: patch.modelAdapters } } : {}),
    ...(patch.loop ? { loop: { provider: patch.loop.id, version: patch.loop.version } } : {}),
    ...(patch.compaction === undefined
      ? {}
      : { compaction: patch.compaction === null ? null : { provider: patch.compaction.engine } }),
    ...(patch.persistence ? { persistence: patch.persistence } : {}),
    ...(patch.sandbox ? { sandbox: patch.sandbox } : {}),
  }
  const overrides = new Map((patch.packages ?? []).map((pkg) => [pkg.id, pkg]))
  const next = {
    ...rest,
    ...(patch.loop ? { loop: patch.loop } : {}),
    ...(patch.compaction ? { compaction: patch.compaction } : {}),
    ...(patch.persistence ? { persistence: patch.persistence } : {}),
    ...(patch.sandbox ? { sandbox: patch.sandbox } : {}),
    presets: { ...profile.presets, default: tree.preset },
    ...(patch.modelAdapters?.length
      ? {
          provider: {
            ...profile.provider,
            routes: (profile.provider.routes ?? []).filter((route) =>
              capabilityEnabled(capabilities.modelAdapters, route.api),
            ),
          },
        }
      : {}),
    packages: profile.packages.map((pkg) => {
      const requested = overrides.get(pkg.id)
      return {
        ...pkg,
        ...(requested?.config ? { config: requested.config } : {}),
        enabled: pkg.enabled && (!requested || capabilityEnabled(capabilities.packages, pkg.id)),
      }
    }),
    composition: {
      ...Object.fromEntries(
        Object.entries(patch).filter(
          ([key]) => !['modelAdapters', 'loop', 'compaction', 'persistence', 'sandbox'].includes(key),
        ),
      ),
      ...(Object.keys(providers).length ? { providers } : {}),
    } as CompositionPatch,
    compositionToolScope: tree.toolScope ?? { bundlePackages: [], activePackages: [] },
    compositionSources: tree.sources,
    ...(tree.sessionBundles !== undefined || tree.sources.loop?.layer === 'session'
      ? {
          sessionComposition: {
            ...(tree.sessionBundles === undefined ? {} : { bundles: [...tree.sessionBundles] }),
            ...(tree.sources.loop?.layer === 'session' && tree.sources.loop.name === 'request' && patch.loop
              ? { loop: patch.loop }
              : {}),
          },
        }
      : {}),
  }
  return freezeTree({ ...next, hash: `sha256-${sha256hex(canonicalJson(next))}` })
}

/** Policy is enforced at invocation, including tools scheduled outside the model tool list. */
export function compositionAllowsTool(
  selection: Pick<CompositionPatch, 'packages' | 'toolPolicy' | 'tools' | 'mcp'>,
  name: string,
  isReadOnly: boolean,
): boolean {
  return capabilityEnabled(
    resolveSessionCapabilities({
      selection,
      installed: { tools: [{ name, readOnly: isReadOnly }] },
    }).tools,
    name,
  )
}
