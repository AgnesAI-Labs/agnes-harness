/**
 * Superagent's shims on Windows: `.cmd` files, which PowerShell and `cmd.exe` find on PATH through PATHEXT, as the
 * POSIX shims are `#!/bin/sh` scripts. The `gh` shim takes its own directory off PATH and the GitHub tokens out of its
 * environment, then runs the agent's CLI by its absolute path, so neither it nor a wrapper that runs `gh` by name
 * reaches the shim again. Each shim starts with `setlocal`, so what it changes never reaches a caller that runs it
 * inside its own `cmd.exe` (a `cmd /c "gh … & gh …"` chain, `call gh`); the change holds for the CLI it starts, which
 * takes the shim's place, and the exit code of that CLI is the shim's. The `setlocal` also turns delayed expansion off
 * and command extensions on, whatever the caller had, so a `!` in PATH or in an argument stays as it is.
 *
 * `cmd.exe` reads a batch file in the console's code page, not as UTF-8, so a shim holds only ASCII: the shims
 * directory, which sits under the user's profile by default, is the shim's own directory (`%~dp0`) as `cmd.exe` found
 * it, never a literal; the CLI's path is written as it is, and one with other characters is refused.
 */
import { SetupError } from '../setup.js'

const lines = (...text: string[]): string => `${text.join('\r\n')}\r\n`
/** `text` for an `echo` in a batch file: its special characters escaped. */
const echoed = (text: string): string => text.replace(/[\^&|<>]/g, '^$&').replaceAll('%', '%%')
/** A shim's third line: its changes stay its own, with the expansions it is written for. */
const SETLOCAL = 'setlocal EnableExtensions DisableDelayedExpansion'
/** The variable the `gh` shim holds its own directory in while it edits PATH. */
const SELF = 'SUPERAGENT_SHIMS'
/** The longest command line `cmd.exe` reads; the shim's PATH edit expands PATH into one. */
export const CMD_LINE_LIMIT = 8191
/** The characters the shim's PATH edit adds to PATH on its longest line. */
const PATH_EDIT_OVERHEAD = 32

/**
 * Refuses what a `gh.cmd` shim cannot hold: a shims directory with `%`, `=`, `"`, `^` or `!`, which its PATH edit cannot
 * match (its `call` doubles a caret, and a caller's delayed expansion would take a `!` before the shim starts);
 * a CLI path with characters other than printable ASCII; and a PATH (`sessionPath`, the sessions' PATH with the shims
 * first) longer than `cmd.exe` reads in one line.
 * @throws SetupError `environmentFailed`, `agentCliPathNotAscii` or `shimsPathTooLong`.
 */
export function checkWindowsShim(shimsDir: string, cli: string, sessionPath: string): void {
  if (/[%="^!]/.test(shimsDir))
    throw new SetupError('environmentFailed', {
      output: `The shims directory ${shimsDir} holds %, =, ", ^ or !, which a Windows shim cannot take off PATH; choose another state directory.`,
    })
  if (!/^[\x20-\x7e]+$/.test(cli) || cli.includes('"')) throw new SetupError('agentCliPathNotAscii', { cli })
  const length = sessionPath.length + PATH_EDIT_OVERHEAD
  if (length > CMD_LINE_LIMIT)
    throw new SetupError('shimsPathTooLong', { length: String(length), limit: String(CMD_LINE_LIMIT) })
}

/**
 * The `gh.cmd` shim: `marker` (a `rem` line) second, after `@echo off`, then `setlocal` (`SETLOCAL`). Every entry of PATH equal to
 * the shim's own directory is removed (`cmd.exe` compares without case), the variables in `tokens` are cleared, and
 * `cli` runs with the arguments. See `checkWindowsShim` for what the caller checks first.
 */
export function windowsGhShim(marker: string, cli: string, tokens: readonly string[]): string {
  // `call set` expands the directory into the substitution first, then performs it.
  const remove = `call set "PATH=%%PATH:;%${SELF}%;=;%%"`
  return lines(
    '@echo off',
    marker,
    SETLOCAL,
    `set "${SELF}=%~dp0"`,
    `set "${SELF}=%${SELF}:~0,-1%"`,
    // Bracketed by separators, every entry is matched whole; twice, for two entries in a row.
    'set "PATH=;%PATH%;"',
    remove,
    remove,
    'set "PATH=%PATH:~1,-1%"',
    `set "${SELF}="`,
    ...tokens.map((name) => `set "${name}="`),
    `"${cli.replaceAll('%', '%%')}" %*`,
  )
}

/** A blocked command's shim: `marker` second, then `setlocal`; it prints `message` on standard error and exits with 1. */
export function windowsBlockedShim(marker: string, message: string): string {
  return lines('@echo off', marker, SETLOCAL, `echo ${echoed(message)} 1>&2`, 'exit /b 1')
}
