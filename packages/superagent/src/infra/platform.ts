/**
 * The operating system Superagent runs on, and what differs on Windows: the shell (PowerShell, not `sh`), the shims
 * (`.cmd` files), how a process tree stops (`taskkill`), how programs are found (`PATHEXT`) and that variable names
 * compare without case. Every function that differs takes the platform as a parameter, defaulting to this process's, so
 * tests cover both without changing this process's own.
 */
import { posix, win32 } from 'node:path'

/** This process's platform, as Node names it (`win32`, `darwin`, `linux`). */
export const HOST_PLATFORM: string = process.platform // guards-allow-platform: Superagent's shell, shims and process stops differ on Windows; code takes it as a parameter.

export const isWindows = (platform: string): boolean => platform === 'win32'
/** The path functions of `platform`. */
export const pathsOf = (platform: string): typeof posix => (isWindows(platform) ? win32 : posix)
/** The separator of PATH entries on `platform`. */
export const pathDelimiter = (platform: string): string => pathsOf(platform).delimiter
/** Whether `path` is absolute on `platform`; on Windows only a path with its drive or a UNC path counts. */
export const isAbsolutePath = (path: string, platform: string): boolean =>
  isWindows(platform) ? /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path) : path.startsWith('/')

/**
 * The value of `name` in `env`. Windows compares variable names without case; `process.env` does so itself there, a
 * plain record does not.
 */
export function variable(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: string,
): string | undefined {
  if (!isWindows(platform) || env[name] !== undefined) return env[name]
  const upper = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === upper)?.[1]
}

/**
 * `layers` merged in order, later values over earlier ones; `undefined` removes a variable. On Windows each variable
 * keeps one entry, in the spelling it first had, so `Path` and `PATH` never both reach a child.
 */
export function mergeVariables(
  layers: readonly Readonly<Record<string, string | undefined>>[],
  platform: string,
): Record<string, string> {
  const merged = new Map<string, readonly [name: string, value: string | undefined]>()
  const fold = (name: string) => (isWindows(platform) ? name.toUpperCase() : name)
  for (const layer of layers)
    for (const [name, value] of Object.entries(layer)) {
      const key = fold(name)
      merged.set(key, [merged.get(key)?.[0] ?? name, value])
    }
  return Object.fromEntries(
    [...merged.values()].filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  )
}
