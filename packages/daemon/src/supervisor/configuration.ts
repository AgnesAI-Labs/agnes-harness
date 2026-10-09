import type { ConfigurationService, ResolvedProfile } from '@agnes/host'
import type { ConfigSnapshot } from '@agnes/protocol'

/** Provider/package lock may change in-process; storage, policy, and data paths may not. */
function fixedRuntime(profile: ResolvedProfile): string {
  const { hash: _hash, chain: _chain, provider: _provider, packages: _packages, adapters, ...rest } = profile
  const { secrets: _secrets, ...fixedAdapters } = adapters
  return JSON.stringify({ ...rest, adapters: fixedAdapters })
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
        await o.activate(next)
        profile = next
        appliedRevision = snapshot.revision
      })
      pending = operation.catch(() => undefined)
      await pending
      return present(snapshot)
    },
  }
}
