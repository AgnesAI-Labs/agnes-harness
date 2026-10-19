/** Resolves the home's profile so a package can be added to it before the first boot. */
export function resolveHomeProfile(options: {
  home: string
  profile: string
  agnesVersion: string
  cwd: string
}): Promise<void>
export function ensureJevLoopInstalled(options: {
  home: string
  profile: string
  agnesVersion: string
  /** The directory profile files may be resolved against (a workspace root). */
  cwd: string
}): Promise<boolean>
