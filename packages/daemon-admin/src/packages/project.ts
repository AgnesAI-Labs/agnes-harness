import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { rpcError } from '@agnes/protocol'

export type PackageProfileDirectory = (profile: string) => Promise<string> | string

/**
 * The daemon scope owns exactly one package profile.  A protocol profile parameter cannot be used
 * as a filesystem selector, and the returned path is never sent back to a client.
 */
export function scopedPackageProfileDirectory(input: {
  profile: string
  profileDir: string
  profilesRoot?: string
}): PackageProfileDirectory {
  const expected = input.profile
  const directory = resolve(input.profileDir)
  const root = resolve(input.profilesRoot ?? directory)
  const inside = (candidate: string): boolean => {
    const value = relative(root, candidate)
    return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  }
  return async (profile) => {
    if (profile !== expected)
      throw rpcError('CAPABILITY_DENIED', {
        method: 'packages',
        reason: 'profile is outside this daemon scope',
      })
    // Reject lexical escape before translating any symlinked root. This is separate from the final
    // canonical containment check: on macOS `/var` and `/private/var` are the same tree, while a
    // symlinked profile can still leave an otherwise valid lexical root.
    if (!inside(directory)) throw rpcError('INTERNAL_ERROR', { code: 'PACKAGE_PROFILE_SCOPE_INVALID' })
    let canonicalRoot: string
    let canonical: string
    try {
      canonicalRoot = await realpath(root)
    } catch {
      canonicalRoot = root
    }
    try {
      canonical = await realpath(directory)
    } catch {
      // Keep the relative relationship when only the trusted root has a canonical spelling (for
      // example `/var` -> `/private/var` on macOS). PackageManager owns a later missing-directory
      // failure; this code still never returns the path to the RPC caller.
      canonical = resolve(canonicalRoot, relative(root, directory))
    }
    const rooted = (candidate: string): boolean => {
      const value = relative(canonicalRoot, candidate)
      return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
    }
    if (!rooted(canonical)) throw rpcError('INTERNAL_ERROR', { code: 'PACKAGE_PROFILE_SCOPE_INVALID' })
    return canonical
  }
}
