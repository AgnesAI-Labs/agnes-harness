/** Closed-network Seatbelt compiler. Selection, path resolution and enforcement reporting belong
 * to the assembling seam; this leaf does not claim a backend is available. */
export function seatbeltDenyNetworkArgv(
  argv: string[],
  policy: { allowPaths: string[]; denyPaths: string[] },
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
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    ...policy.allowPaths.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    ...policy.denyPaths.map((path) => `(deny file-read* file-write* (subpath ${quote(path)}))`),
    '(deny network*)',
  ].join('\n')
  return ['/usr/bin/sandbox-exec', '-p', profile, ...argv]
}
