/**
 * How a program starts on Windows: found as a shell finds it (each PATH directory in turn, trying the PATHEXT
 * extensions), and a batch file (`.cmd`, `.bat`) run through `cmd.exe`, which Node does not start directly. The
 * arguments of a batch file are escaped for `cmd.exe` twice, once for its command line and once for the `%*` a wrapper
 * passes on, as cross-spawn does; a line break cannot pass through `cmd.exe` at all, so such an argument is refused.
 */
import { statSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { variable } from '../infra/platform.js'

/** The program to spawn, its arguments, and whether Node must pass them unquoted (`windowsVerbatimArguments`). */
export interface WindowsLaunch {
  program: string
  args: string[]
  verbatim: boolean
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
/** The characters `cmd.exe` treats specially, each escaped with `^` (from cross-spawn, after https://qntm.org/cmd). */
const META = /([()\][%!^"`<>&|;, *?])/g
const BATCH = /\.(cmd|bat)$/i

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The file `name` runs on Windows with `env`'s PATH and PATHEXT: `name` itself when it is a path, else the first PATH
 * directory holding it with one of the PATHEXT extensions (or as named, when its extension is one). Undefined when no
 * file matches. The files are this machine's, so its own path functions join them.
 */
export function findWindowsProgram(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const extensions = (variable(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT)
    .split(';')
    .filter((extension) => extension.startsWith('.'))
  const named = extensions.some((extension) => name.toLowerCase().endsWith(extension.toLowerCase()))
  const candidates = (base: string) => [...(named ? [base] : []), ...extensions.map((ext) => `${base}${ext}`)]
  if (/[\\/]/.test(name)) return candidates(name).find(isFile)
  for (const dir of (variable(env, 'PATH', 'win32') ?? '').split(';')) {
    const directory = dir.replace(/^"(.*)"$/, '$1')
    if (!isAbsolute(directory)) continue
    const found = candidates(join(directory, name)).find(isFile)
    if (found) return found
  }
  return undefined
}

/** `arg` quoted for a program's command line and escaped for `cmd.exe`; `twice` for a batch file that passes it on. */
export function cmdArgument(arg: string, twice: boolean): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1')
  return twice ? quoted.replace(META, '^$1') : quoted
}

/**
 * How `name` with `args` starts on Windows under `env`. A batch file runs as `cmd.exe /d /s /c "<line>"`.
 * @throws Error when a batch file would receive an argument with a line break, which `cmd.exe` cuts off.
 */
export function windowsLaunch(
  name: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): WindowsLaunch {
  const program = findWindowsProgram(name, env) ?? name
  if (!BATCH.test(program)) return { program, args: [...args], verbatim: false }
  if (args.some((arg) => /[\r\n]/.test(arg)))
    throw new Error(
      `${win32.basename(program)} is a batch file, which cannot receive an argument with a line break`,
    )
  const line = [program.replace(META, '^$1'), ...args.map((arg) => cmdArgument(arg, true))].join(' ')
  return {
    program: variable(env, 'ComSpec', 'win32') || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  }
}
