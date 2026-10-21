import { LOOPBACK_GATE_PATH_PREFIX } from '@agnes/system-node'

/** Closed-network Seatbelt compiler. Selection, path resolution and enforcement reporting belong
 * to the assembling seam; this leaf does not claim a backend is available. */
export function seatbeltDenyNetworkArgv(
  argv: string[],
  policy: {
    allowPaths: string[]
    denyPaths: string[]
    readPaths?: string[]
    network?: 'deny' | 'allow'
    loopbackServe?: boolean
  },
): string[] {
  const invalid = () => new Error('invalid sandbox policy')
  if (
    (policy.loopbackServe !== undefined && typeof policy.loopbackServe !== 'boolean') ||
    (policy.loopbackServe && policy.network === 'allow')
  )
    throw invalid()
  const quote = (value: string): string => {
    if (
      typeof value !== 'string' ||
      !value.startsWith('/') ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw invalid()
    // Escape backslashes before quotes. Never interpolate a path as Scheme syntax.
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    !argv[0] ||
    argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw invalid()
  if (!Array.isArray(policy.allowPaths) || !Array.isArray(policy.denyPaths)) throw invalid()
  const parents = new Set(
    (policy.readPaths ?? []).flatMap((path) => {
      quote(path)
      const parts = path.split('/')
      return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/') || '/')
    }),
  )
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    // Common tools open the null sink read/write; entropy and zero sources need only reads.
    // Exact literals grant no other devices. The explicit denies below still take precedence.
    '(allow file-read* file-write* (literal "/dev/null"))',
    ...['/dev/zero', '/dev/random', '/dev/urandom'].map(
      (path) => `(allow file-read* (literal ${quote(path)}))`,
    ),
    // Job control changes only the foreground group of the caller's controlling terminal
    // (the kernel enforces session ownership). No other ioctls are granted.
    '(allow file-ioctl (require-all (regex #"^/dev/tty(s[0-9]+)?$") (ioctl-command TIOCSPGRP)))',
    ...(policy.readPaths
      ? [
          ...[...parents].map((path) => `(allow file-read-metadata (literal ${quote(path)}))`),
          '(allow file-read* (literal "/"))',
        ]
      : []),
    ...(policy.readPaths
      ? policy.readPaths.map((path) => `(allow file-read* (subpath ${quote(path)}))`)
      : ['(allow file-read*)']),
    ...policy.allowPaths.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    ...policy.denyPaths.map((path) => `(deny file-read* file-write* (subpath ${quote(path)}))`),
    // A protected subtree must not become readable by renaming one of its writable ancestors.
    ...[
      ...new Set(
        policy.denyPaths.flatMap((path) => {
          quote(path)
          const parts = path.split('/')
          return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/') || '/')
        }),
      ),
    ].map((path) => `(deny file-write-unlink (literal ${quote(path)}))`),
    ...(policy.network === 'allow'
      ? ['(allow network*)']
      : policy.loopbackServe
        ? [
            // Default deny still blocks outbound (including Unix peers), UDP and all binds.
            // Host supplies an already-bound private listener behind its TCP gate. Never grant bind: Seatbelt's
            // localhost inbound filter also matches wildcard/LAN addresses on this host.
            '(allow network-inbound (local tcp "localhost:*"))',
            '(allow network-inbound (local unix-socket))',
            '(deny network-bind)',
            // The transport path cannot be replaced with a symlink to an unrelated Unix peer,
            // even for a workspace that includes the Host's temporary directory.
            `(deny file-write* (regex #"^${LOOPBACK_GATE_PATH_PREFIX}[^/]+(/|$)"))`,
            '(deny file-write-unlink (literal "/private/tmp") (literal "/private"))',
          ]
        : ['(deny network*)']),
  ].join('\n')
  return ['/usr/bin/sandbox-exec', '-p', profile, ...argv]
}
