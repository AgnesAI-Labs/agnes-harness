/**
 * Superagent's shims on Windows: `.cmd` files, which PowerShell and `cmd.exe` find on PATH through PATHEXT, as the
 * POSIX shims are `#!/bin/sh` scripts. The `gh` shim takes the shims directory off PATH and the GitHub tokens out of its
 * environment, then runs the agent's CLI by its absolute path, so neither it nor a wrapper that runs `gh` by name
 * reaches the shim again. It runs in the `cmd.exe` its caller starts, so what it changes ends with it. A shim ends in
 * the program it starts: a batch CLI takes the shim's place, and the exit code of either is the shim's.
 */
import { SetupError } from '../setup.js'

const lines = (...text: string[]): string => `${text.join('\r\n')}\r\n`
/** `text` for an `echo` in a batch file: its special characters escaped. */
const echoed = (text: string): string => text.replace(/[\^&|<>]/g, '^$&').replaceAll('%', '%%')

/**
 * The `gh.cmd` shim: `marker` (a `rem` line) second, after `@echo off`. Every entry of PATH equal to `shimsDir` is
 * removed (cmd.exe compares without case), the variables in `tokens` are cleared, and `cli` runs with the arguments.
 * @throws SetupError `environmentFailed` when `shimsDir` holds `%` or `=`, which a batch PATH edit cannot match.
 */
export function windowsGhShim(
  marker: string,
  shimsDir: string,
  cli: string,
  tokens: readonly string[],
): string {
  if (/[%="]/.test(shimsDir))
    throw new SetupError('environmentFailed', {
      output: `The shims directory ${shimsDir} holds %, = or ", which a Windows shim cannot take off PATH; choose another state directory.`,
    })
  const remove = `set "PATH=%PATH:;${shimsDir};=;%"`
  return lines(
    '@echo off',
    marker,
    // Bracketed by separators, every entry is matched whole; twice, for two entries in a row.
    'set "PATH=;%PATH%;"',
    remove,
    remove,
    'set "PATH=%PATH:~1,-1%"',
    ...tokens.map((name) => `set "${name}="`),
    `"${cli.replaceAll('%', '%%')}" %*`,
  )
}

/** A blocked command's shim: `marker` second; it prints `message` on standard error and exits with 1. */
export function windowsBlockedShim(marker: string, message: string): string {
  return lines('@echo off', marker, `echo ${echoed(message)} 1>&2`, 'exit /b 1')
}
