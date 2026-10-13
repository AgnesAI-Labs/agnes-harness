import { listWorkspaceDeployments, readLock } from '@agnes/package-manager'

/** The version the daemon's PackageManager checks a deploy manifest's `harnessRange` against. */
export const PACKAGE_MANAGER_VERSION = '0.0.0'

/** Offered with the same lock and version `packages.trustWorkspace` will then check. */
export async function workspaceDeployments(
  runtime: { profileDirectory(profile: string): string | Promise<string> } | undefined,
  profile: string,
) {
  if (!runtime) return []
  const directory = await runtime.profileDirectory(profile)
  const lock = () => readLock(directory, { profile, agnesVersion: PACKAGE_MANAGER_VERSION })
  return listWorkspaceDeployments(directory, lock, PACKAGE_MANAGER_VERSION)
}
