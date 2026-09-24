import { statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, normalize, resolve } from 'node:path'

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

export function windowsCommand(argv, cwd, env, mode) {
  const variable = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
  const command = argv[0]
  const hasPath = /[\\/:]/.test(command)
  const directories = hasPath ? [''] : [cwd, ...(variable('PATH') ?? '').split(delimiter)]
  const extensions = extname(command)
    ? ['']
    : (variable('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((ext) => /^\.(com|exe|bat|cmd)$/i.test(ext))
  let file
  for (const directory of directories) {
    const base = hasPath ? resolve(cwd, command) : resolve(cwd, directory.replace(/^"(.*)"$/, '$1'), command)
    for (const extension of extensions) {
      try {
        const candidate = base + extension
        if (statSync(candidate).isFile()) {
          file = candidate
          break
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      }
    }
    if (file) break
  }
  if (!file) throw fail('ENOENT')
  if (!/\.(cmd|bat)$/i.test(file)) return { argv: [file, ...argv.slice(1)], verbatim: false }
  if (argv.some((value) => /[\r\n]/.test(value))) throw fail('E_WINDOWS_BATCH_ARGUMENT')
  const root = process.env.SystemRoot
  if (!root || !isAbsolute(root)) throw fail('E_WINDOWS_SHELL_UNAVAILABLE')
  const line = `"${[escapeMeta(normalize(file)), ...argv.slice(1).map((value) => argument(value, mode === 'argv-proxy'))].join(' ')}"`
  if (line.length > 8000) throw fail('E_WINDOWS_BATCH_ARGUMENT')
  return { argv: [join(root, 'System32', 'cmd.exe'), '/d', '/v:off', '/s', '/c', line], verbatim: true }
}
