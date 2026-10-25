import { statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

const fail = (code) => Object.assign(new Error('Windows command cannot be launched'), { code })
const meta = /[()\][%!^"`<>&|;, *?]/g
const escapeMeta = (text) => text.replace(meta, '^$&')

// CRT quoting first, then cmd metacharacters. Linear scans keep adversarial slash runs bounded.
function argument(text, proxy) {
  let output = '"',
    slashes = 0
  for (const character of text) {
    if (character === '\\') slashes++
    else {
      output += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character
      slashes = 0
    }
  }
  output += `${'\\'.repeat(slashes * 2)}"`
  output = escapeMeta(output)
  return proxy ? escapeMeta(output) : output
}

const exists = (candidate) => {
  try {
    return statSync(candidate).isFile()
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false
    throw error
  }
}

/**
 * Resolve a command the way Rust (1.58+) and Go (1.19+) do on Windows, not the way cmd.exe, libuv
 * (Node's spawn) or `which` do: a bare name is looked up in absolute PATH entries only. The current
 * directory, relative PATH entries and any match inside `cwd` (the workspace a child runs in) are
 * never used, so a repository's own `git.cmd` cannot stand in for git. A name with a path separator
 * or drive is an explicit path and resolves against `cwd`. PATHEXT supplies the extensions for a
 * name without one. Returns undefined when nothing qualifies. `fs`/`path` are injectable so tests
 * can exercise Windows path rules on any host.
 */
export function resolveWindowsCommand(command, cwd, env, io = {}) {
  const path = io.path ?? { delimiter, extname, isAbsolute, join, resolve, relative }
  const isFile = io.isFile ?? exists
  const variable = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
  const extensions = path.extname(command)
    ? ['']
    : (variable('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((ext) => /^\.(com|exe|bat|cmd)$/i.test(ext))
  const first = (base) =>
    extensions.map((extension) => base + extension).find((candidate) => isFile(candidate))
  if (/[\\/:]/.test(command)) return first(path.resolve(cwd, command))
  const workspace = path.resolve(cwd)
  const inside = (file) => {
    const rest = path.relative(workspace, file)
    return rest === '' || (!path.isAbsolute(rest) && rest !== '..' && !/^\.\.[\\/]/.test(rest))
  }
  // On Windows only a drive or UNC root is absolute: `\bin` depends on the current drive and `C:bin`
  // on that drive's current directory.
  const absolute =
    path.delimiter === ';'
      ? (directory) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(directory)
      : (directory) => path.isAbsolute(directory)
  for (const entry of (variable('PATH') ?? '').split(path.delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    if (!absolute(directory)) continue
    const found = first(path.join(directory, command))
    if (found && !inside(found)) return found
  }
  return undefined
}

export function windowsCommand(argv, cwd, env, mode) {
  const file = resolveWindowsCommand(argv[0], cwd, env)
  if (!file) throw fail('ENOENT')
  if (!/\.(cmd|bat)$/i.test(file)) return { argv: [file, ...argv.slice(1)], verbatim: false }
  if (argv.some((value) => /[\r\n]/.test(value))) throw fail('E_WINDOWS_BATCH_ARGUMENT')
  const root = process.env.SystemRoot
  if (!root || !isAbsolute(root)) throw fail('E_WINDOWS_SHELL_UNAVAILABLE')
  const line = `"${[escapeMeta(normalize(file)), ...argv.slice(1).map((value) => argument(value, mode === 'argv-proxy'))].join(' ')}"`
  if (line.length > 8000) throw fail('E_WINDOWS_BATCH_ARGUMENT')
  return { argv: [join(root, 'System32', 'cmd.exe'), '/d', '/v:off', '/s', '/c', line], verbatim: true }
}
