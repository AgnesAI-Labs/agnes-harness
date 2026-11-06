import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

const file = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Preserve Bash probes on Windows; a PATH entry named bash.exe can instead be the WSL launcher. */
export function probeShell({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return '/bin/bash'
  const candidates = []
  for (const directory of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    if (!file(join(directory, 'git.exe'))) continue
    candidates.push(
      join(directory, 'bash.exe'),
      join(directory, '..', 'bin', 'bash.exe'),
      join(directory, '..', 'usr', 'bin', 'bash.exe'),
      join(directory, '..', '..', 'usr', 'bin', 'bash.exe'),
    )
  }
  for (const directory of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean))
    candidates.push(
      join(directory, 'Git', 'bin', 'bash.exe'),
      join(directory, 'Git', 'usr', 'bin', 'bash.exe'),
    )
  return candidates.find(file)
}

export function runProbe(command, cwd, env) {
  return new Promise((resolveProbe) => {
    const shell = probeShell({ env })
    if (!shell) {
      resolveProbe({ exit: null, output: 'Git for Windows Bash is required to run the suite probes.' })
      return
    }
    const child = spawn(command, { cwd, shell, env })
    let output = ''
    child.stdout.on('data', (b) => {
      output += b
    })
    child.stderr.on('data', (b) => {
      output += b
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveProbe({ exit: null, output: `${output}${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveProbe({ exit: code, output })
    })
  })
}
