import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { expandShell } from '../src/sandbox-shell.js'

it.runIf(process.platform !== 'win32')(
  'runs the expanded argv with a real POSIX shell and observes command output',
  () => {
    const [binary, ...args] = expandShell(['$SHELL', "printf '%s' 'real shell;中文'"], 'posix')
    if (!binary) throw new Error('missing shell')
    const child = spawnSync(binary, args, { encoding: 'utf8', timeout: 1000 })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout).toBe('real shell;中文')
  },
)
