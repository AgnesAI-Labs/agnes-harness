import { canonicalJson, sha256hex } from './canonical.js'
import type { ResolvedProfile } from './types.js'

/**
 * What a durable approval grant is bound to: the resolved profile fields that decide who may
 * authorize what, and nothing else. The whole-profile `hash` also moves with the model route,
 * credential store, installed packages and data directories, so a grant bound to it is orphaned by
 * changes that cannot widen or narrow authorization. Tool identity and policy settings are bound by
 * the grant itself (`definitionFingerprint`, `policyBinding`).
 */
export function policyDigest(profile: ResolvedProfile): string {
  const { adapters } = profile
  return `sha256-${sha256hex(
    canonicalJson({
      approvals: profile.approvals,
      policy: profile.policy,
      computerUse: profile.computerUse,
      seams: profile.seams,
      presets: profile.presets,
      sandbox: profile.sandbox ?? null,
      extensionIsolation: profile.extensionIsolation ?? null,
      commandHooks: profile.commandHooks ?? null,
      adapters: {
        storage: adapters.storage,
        fs: adapters.fs,
        exec: adapters.exec,
        platform: adapters.platform,
      },
    }),
  )}`
}
