/** Compile the macOS-only extension-runner profile; availability still requires an actual probe. */
export function seatbeltExtensionRunnerArgv(argv: readonly string[], readPaths: readonly string[]): string[] {
  const invalid = (): never => {
    throw new Error('invalid extension isolation policy')
  }
  const quote = (value: string): string => {
    if (
      !value.startsWith('/') ||
      [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return invalid()
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  if (!argv.length || argv.some((value) => typeof value !== 'string' || value.includes('\0')))
    return invalid()
  if (!readPaths.length || new Set(readPaths).size !== readPaths.length) return invalid()
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow sysctl-read)',
    '(allow process-info*)',
    // sandbox-exec must perform the initial exec; descendants still cannot fork.
    '(allow process-exec)',
    '(deny process-fork)',
    '(allow file-read-metadata)',
    // Node enumerates the root directory during bootstrap. A literal does not authorize descendants.
    `(allow file-read-data (literal "/") ${readPaths.map((path) => `(subpath ${quote(path)})`).join(' ')})`,
    '(deny network*)',
  ].join('\n')
  return ['/usr/bin/sandbox-exec', '-p', profile, ...argv]
}
