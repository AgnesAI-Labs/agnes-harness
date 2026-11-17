import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { executable, machineOf, workerProbe } from '../src/deployment.js'
import { isAbsolutePath } from '../src/infra/platform.js'
import { withoutDirectory } from '../src/infra/worker-paths.js'
import { agentSessionEnvironment, credentialHelper, withEnvironment } from '../src/runtime/environment.js'
import { machineConfig } from '../src/runtime/index.js'

// Deployment settings and the agent's environment as Windows reads them, with the platform given.
let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'deployment-win-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

it('resolves the agent CLI on Windows by PATHEXT, skipping the shims directory, as a shell would', () => {
  const [shims, bin] = [join(dir, 'worker-bin'), join(dir, 'bin')]
  mkdirSync(shims)
  mkdirSync(bin)
  writeFileSync(join(shims, 'gh-agent.cmd'), '')
  writeFileSync(join(bin, 'gh-agent.cmd'), '')
  const env = { PATHEXT: '.com;.exe;.bat;.cmd' }
  expect(executable('gh-agent', `${shims};${bin}`, shims, 'win32', env)).toBe(join(bin, 'gh-agent.cmd'))
  expect(executable(join(bin, 'gh-agent.cmd'), '', shims, 'win32', env)).toBe(join(bin, 'gh-agent.cmd'))
  expect(() => executable('gh-agent', shims, shims, 'win32', env)).toThrow(
    'gh-agent is not an executable file on PATH',
  )
  expect(() => executable('bin\\gh-agent', bin, shims, 'win32', env)).toThrow(
    'must be a command name or an absolute path',
  )
  // A quoted entry is the directory inside the quotes; the shims compare without case, as Windows names do.
  expect(executable('gh-agent', `"${shims}";"${bin}"`, shims, 'win32', env)).toBe(join(bin, 'gh-agent.cmd'))
  expect(executable('gh-agent', `${shims.toUpperCase()};${bin}`, shims, 'win32', env)).toBe(
    join(bin, 'gh-agent.cmd'),
  )
  expect(withoutDirectory(`${shims.toUpperCase()};${bin}`, shims, ';', 'win32')).toBe(bin)
  // POSIX names keep their case (checked where the file system would not fold it for us).
  if (process.platform !== 'win32')
    expect(withoutDirectory(`${shims.toUpperCase()}:${bin}`, shims, ':', 'linux')).toBe(
      `${shims.toUpperCase()}:${bin}`,
    )
})

it('takes a Windows state directory with its drive, and keeps it inside the private one the platform gives', () => {
  expect([isAbsolutePath('C:\\Superagent', 'win32'), isAbsolutePath('\\\\host\\share', 'win32')]).toEqual([
    true,
    true,
  ])
  expect([
    isAbsolutePath('/srv', 'win32'),
    isAbsolutePath('C:\\x', 'linux'),
    isAbsolutePath('/srv', 'linux'),
  ]).toEqual([false, false, true])
  expect(machineOf({ stateDir: 'C:\\Superagent\\state' }, 'win32').stateDir).toBe('C:\\Superagent\\state')
  expect(() => machineOf({ stateDir: 'C:\\Superagent\\state' }, 'linux')).toThrow('not an absolute path here')
  const granted = 'C:\\Users\\agent\\.agh\\apps\\0123'
  expect(machineConfig(undefined, granted, 'win32').stateDir).toBe(granted)
  expect(machineConfig({ stateDir: `${granted}\\inner` }, granted, 'win32').stateDir).toBe(
    `${granted}\\inner`,
  )
  // A directory inside whose name starts with two dots is inside too.
  expect(machineConfig({ stateDir: `${granted}\\..x` }, granted, 'win32').stateDir).toBe(`${granted}\\..x`)
  expect(() => machineConfig({ stateDir: `${granted}\\..` }, granted, 'win32')).toThrow('private directory')
  expect(() => machineConfig({ stateDir: 'D:\\elsewhere' }, granted, 'win32')).toThrow(
    'On Windows Superagent keeps its state in the private directory the platform gives it',
  )
  // Elsewhere the configuration may name any absolute directory, as before.
  expect(machineConfig({ stateDir: '/srv/elsewhere' }, '/var/agh/0123', 'linux').stateDir).toBe(
    '/srv/elsewhere',
  )
})

it("writes the agent's environment over a Windows one: the shims first on its Path, in one key", () => {
  const env = withEnvironment(
    { Path: 'C:\\Windows', gh_token: 'x', SystemRoot: 'C:\\Windows' },
    agentSessionEnvironment('C:\\state'),
    'win32',
  )
  expect(Object.keys(env).filter((name) => name.toUpperCase() === 'PATH')).toEqual(['Path'])
  expect(env.Path).toBe(`${join('C:\\state', 'worker-bin')};C:\\Windows`)
  expect(Object.keys(env).map((name) => name.toUpperCase())).not.toContain('GH_TOKEN')
  // Git for Windows runs the helper with its own POSIX shell, which reads forward slashes.
  expect(credentialHelper('C:\\Program Files\\GitHub CLI\\gh.exe', 'win32')).toBe(
    "!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential",
  )
  expect(credentialHelper('/usr/local/bin/gh-agent', 'linux')).toBe(
    "!'/usr/local/bin/gh-agent' auth git-credential",
  )
})

it("runs the setup checks on Windows with the shims off the daemon's Path, in any case", async () => {
  const state = join(dir, 'state')
  const shims = join(state, 'worker-bin')
  vi.stubEnv('PATH', `${shims.toUpperCase()};${join(dir, 'bin')}`)
  const probe = workerProbe(state, dir, new AbortController().signal, 'win32')
  expect((await probe([process.execPath, '-e', 'process.stdout.write(process.env.PATH)'])).trim()).toBe(
    join(dir, 'bin'),
  )
  // A check that fails without a word names its program as messages do there: no path, no extension.
  await expect(probe([process.execPath, '-e', 'process.exit(2)'])).rejects.toThrow(
    /^node -e process\.exit\(2\) exited with 2$/,
  )
})
