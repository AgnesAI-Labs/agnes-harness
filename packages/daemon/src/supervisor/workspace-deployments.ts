import { listWorkspaceDeployments, readLock } from '@agnes/package-manager'

/**
 * The build label the daemon's PackageManager stamps into a lock it creates. `0.0.0` is the
 * placeholder every unpublished build carries; it is a label only and takes part in no
 * compatibility check, which the harness contract version in `@agnes/protocol` decides.
 */
export const PACKAGE_MANAGER_VERSION = '0.0.0'

/** Offered from the same lock `packages.trustWorkspace` will then write. */
export async function workspaceDeployments(
  runtime: { profileDirectory(profile: string): string | Promise<string> } | undefined,
  profile: string,
) {
  if (!runtime) return []
  const directory = await runtime.profileDirectory(profile)
  return listWorkspaceDeployments(directory, () =>
    readLock(directory, { profile, agnesVersion: PACKAGE_MANAGER_VERSION }),
  )
}
