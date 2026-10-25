import { resolveWindowsCommand } from '../runtime/windows-command.mjs'

const windows = process.platform === 'win32' // guards-allow-platform: shared system leaf, independent of Host.

/**
 * The program to hand `spawn`/`execFile` for a bare command such as `git` that runs with `cwd`.
 *
 * On Windows libuv searches the child's working directory before PATH, so a workspace `git.exe`
 * would run instead of git. There this returns the absolute PATH match, never one inside `cwd`, or
 * undefined when there is none; a batch file also yields undefined because `spawn` cannot start one
 * without a shell. Elsewhere the name is returned unchanged.
 */
export function commandPath(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (!windows) return command
  const file = resolveWindowsCommand(command, cwd, env)
  return file && !/\.(?:bat|cmd)$/i.test(file) ? file : undefined
}
