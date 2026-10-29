import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'

// Rust is not listed: the workspace is always untrusted and Rust servers do not run there.
const SERVERS: ReadonlyArray<[label: string, executables: readonly string[]]> = [
  ['TS', ['typescript-language-server']],
  ['Python', ['pyright-langserver', 'basedpyright-langserver']],
  ['Go', ['gopls']],
]

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Which language servers this machine's PATH offers, skipping directories inside the workspace like the
 * worker does.
 *
 * ponytail: this reads the PATH of the machine the TUI runs on, not the worker's real registry state,
 * so a server the worker cannot start still shows here. A true answer needs a daemon-to-worker query.
 */
export function probeLanguageServers(
  cwd: string,
  searchPath: string = process.env.PATH ?? '',
): Array<[label: string, found: boolean]> {
  const root = real(cwd)
  const dirs = searchPath
    .split(delimiter)
    .filter((dir) => dir !== '' && isAbsolute(dir) && !inside(root, real(dir)))
  // The Windows launcher spellings are tried everywhere; they simply do not exist elsewhere.
  const suffixes = ['', '.cmd', '.exe']
  const has = (name: string) =>
    dirs.some((dir) =>
      suffixes.some((suffix) => {
        try {
          accessSync(join(dir, name + suffix), constants.X_OK)
          return true
        } catch {
          return false
        }
      }),
    )
  return SERVERS.map(([label, names]) => [label, names.some(has)])
}
