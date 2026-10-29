import { statSync } from 'node:fs'
import { win32 } from 'node:path'

export type GitCommandIo = Readonly<{
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  isFile?: (candidate: string) => boolean
}>

const exists = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * The program to hand `execFile` for `git` run in `cwd`.
 *
 * On Windows libuv searches the child's working directory before PATH, so a repository's own
 * `git.exe` would run instead of git when the TUI reads the folder. There this returns the first
 * `git.exe`/`git.com` in an absolute PATH entry (a drive or UNC root) that is not inside `cwd`, or
 * undefined. Relative entries are skipped; batch files are not candidates because `execFile`
 * cannot start them without a shell. These are the same rules as the process broker's resolver in
 * `@agnes/system-node`, which this package may not import. Elsewhere `git` is returned unchanged.
 */
export function gitCommand(cwd: string, io: GitCommandIo = {}): string | undefined {
  const platform = io.platform ?? process.platform // guards-allow-platform: libuv searches the child's cwd only on Windows.
  if (platform !== 'win32') return 'git'
  const env = io.env ?? process.env
  const isFile = io.isFile ?? exists
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const workspace = win32.resolve(cwd)
  const inside = (file: string): boolean => {
    const rest = win32.relative(workspace, file)
    return rest === '' || (!win32.isAbsolute(rest) && rest !== '..' && !/^\.\.[\\/]/.test(rest))
  }
  for (const entry of path.split(';')) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    // `\bin` depends on the current drive and `C:bin` on that drive's current directory.
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(directory)) continue
    for (const name of ['git.com', 'git.exe']) {
      const candidate = win32.join(directory, name)
      if (!inside(candidate) && isFile(candidate)) return candidate
    }
  }
  return undefined
}
