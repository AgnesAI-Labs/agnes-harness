import {
  type ConfigurationService,
  canonicalJson,
  hashInput,
  type ResolvedProfile,
  sha256hex,
} from '@agnes/host'
import type { ConfigSnapshot } from '@agnes/protocol'

/** Ignore inventory-derived boot metadata; actual deployment choices still require a restart. */
function fixedRuntime(profile: ResolvedProfile): string {
  const {
    hash: _hash,
    chain: _chain,
    provider: _provider,
    packages: _packages,
    bundleCatalog: _bundleCatalog,
    bundlePresets: _bundlePresets,
    compositionSources: _compositionSources,
    composition,
    adminBundles,
    adapters,
    ...rest
  } = profile
  const { secrets: _secrets, ...fixedAdapters } = adapters
  return canonicalJson({
    ...rest,
    ...(composition && Object.keys(composition).length ? { composition } : {}),
    ...(adminBundles?.length ? { adminBundles } : {}),
    adapters: fixedAdapters,
  })
}

/** Publish only account-owned fields. Package activation owns the running code and bundle choices. */
function modelProfile(current: ResolvedProfile, desired: ResolvedProfile): ResolvedProfile {
  const { hash: _hash, ...candidate } = {
    ...current,
    provider: desired.provider,
    adapters: { ...current.adapters, secrets: desired.adapters.secrets },
  }
  return { ...candidate, hash: `sha256-${sha256hex(canonicalJson(hashInput(candidate)))}` }
}

export async function configurationApplication(o: {
  service: ConfigurationService
  profile: ResolvedProfile
  reloadProfile?: () => Promise<ResolvedProfile>
  activate: (profile: ResolvedProfile) => Promise<void>
}): Promise<{
  profile(): ResolvedProfile
  present(snapshot: ConfigSnapshot): ConfigSnapshot
  apply(snapshot: ConfigSnapshot): Promise<ConfigSnapshot>
}> {
  let profile = o.profile
  let appliedRevision = (await o.service.get()).revision
  if (o.reloadProfile && (await o.reloadProfile()).hash !== profile.hash) appliedRevision = -1
  let pending = Promise.resolve()
  const present = (snapshot: ConfigSnapshot): ConfigSnapshot => ({
    ...snapshot,
    effect: snapshot.revision === appliedRevision ? 'new-sessions' : 'restart-required',
  })
  return {
    profile: () => profile,
    present,
    async apply(snapshot) {
      const operation = pending.then(async () => {
        if (!o.reloadProfile) return
        // Another client may have saved a newer revision before this callback acquired its turn.
        // Do not associate its profile with the older revision being acknowledged here.
        if ((await o.service.get()).revision !== snapshot.revision) return
        const next = await o.reloadProfile()
        if (fixedRuntime(next) !== fixedRuntime(profile)) return
        if ((await o.service.get()).revision !== snapshot.revision) return
        const candidate = modelProfile(profile, next)
        await o.activate(candidate)
        profile = candidate
        appliedRevision = snapshot.revision
      })
      pending = operation.catch(() => undefined)
      await pending
      return present(snapshot)
    },
  }
}
