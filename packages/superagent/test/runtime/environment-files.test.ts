import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeEnvironment } from '../../src/runtime/environment.js'
import { posixIt } from '../fixtures/posix.js'

// The exact files Superagent writes into its state directory. The POSIX ones are pinned byte for byte: they are what
// the original writes, and Windows support must not change them.
let root: string
let stateDir: string
let cli: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-files-')))
  stateDir = join(root, 'state')
  mkdirSync(join(root, 'bin'))
  cli = join(root, 'bin', 'gh-agent')
  writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
const config = {
  login: 'agent-bot',
  email: '1+agent-bot@users.noreply.github.com',
  blocked: ['curl'],
  cli: '',
}

// POSIX hosts only: the pinned text holds POSIX paths, which a Windows host's paths are not.
posixIt('writes the POSIX shims and the git configuration byte for byte as before', async () => {
  await writeEnvironment(stateDir, { ...config, cli }, 'linux')
  const shims = join(stateDir, 'worker-bin')
  expect(readdirSync(shims).sort()).toEqual(['curl', 'gh'])
  expect(readFileSync(join(shims, 'gh'), 'utf8')).toBe(
    [
      '#!/bin/sh',
      '# Written by Superagent on every start; edits are lost.',
      `self='${shims}'`,
      'rest=',
      'IFS=:',
      'set -f',
      'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
      'set +f',
      'unset IFS',
      'PATH=$rest',
      'export PATH',
      'unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST',
      `exec '${cli}' "$@"`,
      '',
    ].join('\n'),
  )
  expect(readFileSync(join(shims, 'curl'), 'utf8')).toBe(
    [
      '#!/bin/sh',
      '# Written by Superagent on every start; edits are lost.',
      "echo 'curl is blocked in this installation; use gh, which acts as agent-bot.' >&2",
      'exit 1',
      '',
    ].join('\n'),
  )
  expect(readFileSync(join(stateDir, 'worker-gitconfig'), 'utf8')).toBe(
    [
      '# Written by Superagent on every start; edits are lost.',
      '[user]',
      '\tname = "agent-bot"',
      '\temail = "1+agent-bot@users.noreply.github.com"',
      '\tuseConfigOnly = true',
      '[credential]',
      '\thelper =',
      '[credential "https://github.com"]',
      `\thelper = "!'${cli}' auth git-credential"`,
      '[url "https://github.com/"]',
      '\tinsteadOf = git@github.com:',
      '\tinsteadOf = ssh://git@github.com/',
      '[core]',
      '\taskPass =',
      '[filter "lfs"]',
      '\tclean = git-lfs clean -- %f',
      '\tsmudge = git-lfs smudge -- %f',
      '\tprocess = git-lfs filter-process',
      '\trequired = true',
      '',
    ].join('\n'),
  )
})

it('writes .cmd shims on Windows that leave the shims and the tokens behind and run the agent CLI by its path', async () => {
  // The agent CLI is a `gh-agent.cmd` wrapper, found by its name through PATHEXT on a Windows PATH.
  const wrapper = join(root, 'bin', 'gh-agent.cmd')
  writeFileSync(wrapper, '@echo off\r\n')
  // Lower case, so the files match on a case-sensitive file system too.
  const env = { PATH: `${join(root, 'bin')};${join(stateDir, 'worker-bin')}`, PATHEXT: '.com;.exe;.bat;.cmd' }
  await writeEnvironment(
    stateDir,
    { ...config, blocked: ['curl', 'Curl', 'GH', 'git'], cli: 'gh-agent' },
    'win32',
    env,
  )
  const shims = join(stateDir, 'worker-bin')
  expect(readdirSync(shims).sort()).toEqual(['curl.cmd', 'gh.cmd'])
  expect(readFileSync(join(shims, 'gh.cmd'), 'utf8')).toBe(
    [
      '@echo off',
      'rem # Written by Superagent on every start; edits are lost.',
      // Its changes stay in this cmd.exe and the CLI it starts, never in a caller's.
      'setlocal EnableExtensions DisableDelayedExpansion',
      // Its own directory as cmd.exe found it, so no path is written into the file.
      'set "SUPERAGENT_SHIMS=%~dp0"',
      'set "SUPERAGENT_SHIMS=%SUPERAGENT_SHIMS:~0,-1%"',
      'set "PATH=;%PATH%;"',
      'call set "PATH=%%PATH:;%SUPERAGENT_SHIMS%;=;%%"',
      'call set "PATH=%%PATH:;%SUPERAGENT_SHIMS%;=;%%"',
      'set "PATH=%PATH:~1,-1%"',
      'set "SUPERAGENT_SHIMS="',
      'set "GH_TOKEN="',
      'set "GITHUB_TOKEN="',
      'set "GH_ENTERPRISE_TOKEN="',
      'set "GITHUB_ENTERPRISE_TOKEN="',
      'set "GH_HOST="',
      `"${wrapper}" %*`,
      '',
    ].join('\r\n'),
  )
  expect(readFileSync(join(shims, 'curl.cmd'), 'utf8')).toBe(
    [
      '@echo off',
      'rem # Written by Superagent on every start; edits are lost.',
      'setlocal EnableExtensions DisableDelayedExpansion',
      'echo curl is blocked in this installation; use gh, which acts as agent-bot. 1>&2',
      'exit /b 1',
      '',
    ].join('\r\n'),
  )
  const gitconfig = readFileSync(join(stateDir, 'worker-gitconfig'), 'utf8')
  expect(gitconfig).toContain('[core]\n\taskPass =\n\tlongpaths = true\n[filter "lfs"]')
  // Git for Windows runs the helper with its own shell, which reads forward slashes.
  expect(gitconfig).toContain(`\thelper = "!'${wrapper.replaceAll('\\', '/')}' auth git-credential"`)
  // Written again, its own .cmd files count as its own, and a shim no longer wanted goes.
  await writeEnvironment(stateDir, { ...config, blocked: [], cli: 'gh-agent' }, 'win32', env)
  expect(readdirSync(shims)).toEqual(['gh.cmd'])
})

it('refuses a Windows shims directory a batch PATH edit cannot match', async () => {
  writeFileSync(join(root, 'bin', 'gh.exe'), '')
  const named = { ...config, cli: join(root, 'bin', 'gh.exe') }
  // `call` doubles a caret, and a caller's delayed expansion takes a `!`, before the edit compares the directory.
  for (const name of ['state=1', 'state%1', 'state^1', 'state!1'])
    await expect(
      writeEnvironment(join(root, name), named, 'win32', { PATH: '' }),
      name,
    ).rejects.toMatchObject({
      code: 'environmentFailed',
    })
  await expect(
    writeEnvironment(join(root, 'state (1)'), named, 'win32', { PATH: '' }),
  ).resolves.toBeUndefined()
})

it('writes Windows shims in ASCII under a state directory that is not, and refuses a CLI path it could not write', async () => {
  // A user profile whose name is not ASCII holds the default state directory; cmd.exe would misread it in a batch file.
  const profile = join(root, '张三 (x86)')
  const state = join(profile, 'state')
  writeFileSync(join(root, 'bin', 'gh.exe'), '')
  await writeEnvironment(state, { ...config, cli: join(root, 'bin', 'gh.exe') }, 'win32', { PATH: '' })
  const shim = readFileSync(join(state, 'worker-bin', 'gh.cmd'), 'utf8')
  expect([...shim].filter((char) => char.charCodeAt(0) > 0x7f)).toEqual([])
  expect(shim).not.toContain(profile)
  // The CLI's own path is written as it is, so one that is not ASCII is refused, with its own setup problem.
  mkdirSync(join(profile, 'bin'))
  writeFileSync(join(profile, 'bin', 'gh-agent.cmd'), '')
  const cli = join(profile, 'bin', 'gh-agent.cmd')
  await expect(
    writeEnvironment(join(root, 'other'), { ...config, cli }, 'win32', { PATH: '' }),
  ).rejects.toMatchObject({
    code: 'agentCliPathNotAscii',
    place: 'github',
    values: { cli },
  })
})

it('refuses a Windows PATH longer than the line a shim reads it into', async () => {
  writeFileSync(join(root, 'bin', 'gh.exe'), '')
  const named = { ...config, cli: join(root, 'bin', 'gh.exe') }
  const shims = join(stateDir, 'worker-bin')
  // The sessions' PATH is the shims, a separator and the daemon's PATH; the shim adds 32 characters around it.
  const fits = 'x'.repeat(8191 - 32 - shims.length - 1)
  await expect(writeEnvironment(stateDir, named, 'win32', { PATH: fits })).resolves.toBeUndefined()
  await expect(writeEnvironment(stateDir, named, 'win32', { PATH: `${fits}x` })).rejects.toMatchObject({
    code: 'shimsPathTooLong',
    values: { length: '8192', limit: '8191' },
  })
})
