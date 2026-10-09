import type { ClosedNetworkConfineOptions } from './shared.js'
import { validateArgv, validateClosedNetworkOptions } from './shared.js'

/**
 * Compile a closed-network bubblewrap argv. This is an exec-file argument vector, never shell
 * source. Availability probing, canonical path resolution and enforcement reporting remain Host
 * responsibilities and this leaf is intentionally not wired into the default sandbox seam.
 */
export function bwrapConfine(argv: readonly string[], options: ClosedNetworkConfineOptions): string[] {
  const command = validateArgv(argv)
  const policy = validateClosedNetworkOptions(options)
  const visibleDenies = policy.denyPaths.filter((path) =>
    [...(policy.readPaths ?? ['/']), ...policy.allowPaths].some(
      (root) => root === '/' || path === root || path.startsWith(`${root}/`),
    ),
  )
  // A parent mask already hides every descendant. Mounting a child after remount-ro would
  // attempt to create its mountpoint inside that empty read-only mask and fail with EROFS.
  const denyRoots = visibleDenies.filter(
    (path) => !visibleDenies.some((parent) => parent !== path && path.startsWith(`${parent}/`)),
  )
  const writableAncestors = [
    ...new Set(
      denyRoots.flatMap((path) => {
        const parts = path.split('/')
        return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/') || '/')
      }),
    ),
  ]
    .filter((path) =>
      policy.allowPaths.some((root) => path !== root && path.startsWith(root === '/' ? '/' : `${root}/`)),
    )
    .sort((left, right) => left.split('/').length - right.split('/').length)
  return [
    'bwrap',
    ...(policy.readPaths
      ? policy.readPaths.flatMap((path) => ['--ro-bind', path, path])
      : [policy.allowPaths.includes('/') ? '--bind' : '--ro-bind', '/', '/']),
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    ...(policy.network === 'allow' ? [] : ['--unshare-net']),
    '--die-with-parent',
    ...policy.allowPaths.filter((path) => path !== '/').flatMap((path) => ['--bind', path, path]),
    // A mountpoint cannot be renamed or unlinked. Anchor writable ancestors as well as the
    // masked leaf, so a child cannot relocate Host's private installation directories.
    ...writableAncestors.flatMap((path) => ['--bind', path, path]),
    // These mounts occur after writable binds, so a deny below an allow remains masked.
    ...denyRoots.flatMap((path) => ['--tmpfs', path, '--remount-ro', path]),
    ...(policy.readPaths ? ['--dir', policy.cwd, '--remount-ro', '/'] : []),
    '--chdir',
    policy.cwd,
    '--',
    ...command,
  ]
}
