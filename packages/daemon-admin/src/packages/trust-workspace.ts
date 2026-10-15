import type { PackageManager } from '@agnes/package-manager'
import type { PackageTrustWorkspaceParams } from '@agnes/protocol'
import type { PackageProfileDirectory } from './project.js'

export type TrustParams = PackageTrustWorkspaceParams

/** Caller has already bound the request to an authenticated package administrator. */
export async function trustAndRefresh(
  options: { manager: PackageManager; profileDirectory: PackageProfileDirectory },
  params: TrustParams,
  refresh: (profile: string, directory: string, reason: 'trust') => Promise<void>,
): Promise<{ hash: string }> {
  const directory = await options.profileDirectory(params.profile)
  const result = await options.manager.trustWorkspace(directory, params.deployDir, params.expectedHash)
  await refresh(params.profile, directory, 'trust')
  return result
}
