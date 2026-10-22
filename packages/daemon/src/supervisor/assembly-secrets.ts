import { type ResolvedProfile, resolveFileSecretsDirectory } from '@agnes/host'
import type { DaemonConfig } from './config.js'
/** Where a `kind: 'file'` secrets adapter reads. A profile path wins. Otherwise the directory is
 * the credential store's `<home>/secrets`, and a store left under `<dataDir>/secrets` is moved there. */
export function secretsDirectory(profile: ResolvedProfile, config: DaemonConfig): string {
  return resolveFileSecretsDirectory({
    path: profile.adapters.secrets.path,
    dataDir: config.dataDir,
    ...(config.home !== undefined ? { home: config.home } : {}),
  })
}
