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
      'set "PATH=;%PATH%;"',
      `set "PATH=%PATH:;${shims};=;%"`,
      `set "PATH=%PATH:;${shims};=;%"`,
      'set "PATH=%PATH:~1,-1%"',
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
  const odd = join(root, 'state=1')
  writeFileSync(join(root, 'bin', 'gh.exe'), '')
  const named = { ...config, cli: join(root, 'bin', 'gh.exe') }
  await expect(writeEnvironment(odd, named, 'win32', { PATH: '' })).rejects.toMatchObject({
    code: 'environmentFailed',
  })
})
