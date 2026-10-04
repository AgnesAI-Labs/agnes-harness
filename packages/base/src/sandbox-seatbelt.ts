/** Closed-network Seatbelt compiler. Selection, path resolution and enforcement reporting belong
 * to the assembling seam; this leaf does not claim a backend is available. */
export function seatbeltDenyNetworkArgv(
  argv: string[],
  policy: {
    allowPaths: string[]
    denyPaths: string[]
    denyExceptions?: readonly { path: string; except: readonly string[] }[]
  },
): string[] {
  const invalid = () => new Error('invalid sandbox policy')
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
  for (const entry of policy.denyExceptions ?? [])
    if (
      !policy.denyPaths.includes(entry.path) ||
      !entry.except.length ||
      entry.except.some((path) => !policy.allowPaths.includes(path) || !path.startsWith(`${entry.path}/`))
    )
      throw invalid()
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    ...policy.allowPaths.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    ...policy.denyPaths.map((path) => {
      const except = policy.denyExceptions?.find((entry) => entry.path === path)?.except ?? []
      const filter = except.length
        ? `(require-all (subpath ${quote(path)}) ${except.map((allowed) => `(require-not (subpath ${quote(allowed)}))`).join(' ')})`
        : `(subpath ${quote(path)})`
      return `(deny file-read* file-write* ${filter})`
    }),
    '(deny network*)',
  ].join('\n')
  return ['/usr/bin/sandbox-exec', '-p', profile, ...argv]
}
