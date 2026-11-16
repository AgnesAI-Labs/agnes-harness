import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeEnvironment } from '../../src/runtime/environment.js'

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
const config = { login: 'agent-bot', email: '1+agent-bot@users.noreply.github.com', blocked: ['curl'], cli: '' }

it('writes the POSIX shims and the git configuration byte for byte as before', async () => {
  await writeEnvironment(stateDir, { ...config, cli })
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
