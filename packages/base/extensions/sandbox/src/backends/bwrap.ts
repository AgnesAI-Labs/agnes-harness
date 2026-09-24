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
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-net',
    '--die-with-parent',
    ...policy.allowPaths.flatMap((path) => ['--bind', path, path]),
    // These mounts occur after writable binds, so a deny below an allow remains masked.
    ...policy.denyPaths.flatMap((path) => ['--tmpfs', path]),
    '--chdir',
    policy.cwd,
    '--',
    ...command,
  ]
}
