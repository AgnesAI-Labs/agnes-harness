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
    // These mounts occur after writable binds, so a deny below an allow remains masked.
    ...policy.denyPaths
      .filter((path) =>
        [...(policy.readPaths ?? ['/']), ...policy.allowPaths].some(
          (root) => root === '/' || path === root || path.startsWith(`${root}/`),
        ),
      )
      .flatMap((path) => ['--tmpfs', path, '--remount-ro', path]),
    ...(policy.readPaths ? ['--dir', policy.cwd, '--remount-ro', '/'] : []),
    '--chdir',
    policy.cwd,
    '--',
    ...command,
  ]
}
