import { execFile } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  agentPaths,
  credentialHelper,
  verifyDirectory,
  verifyEnvironment,
  writeEnvironment,
} from '../../src/runtime/environment.js'
import { SetupError } from '../../src/setup.js'
import { gitEnv } from '../fixtures/git.js'
import { posixDescribe } from '../fixtures/posix.js'

const LOGIN = 'agent-bot'
const EMAIL = '1+agent-bot@users.noreply.github.com'

interface Run {
  code: number
  stdout: string
  stderr: string
}
function run(argv: string[], env: Record<string, string | undefined>, cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { env, cwd }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

let root: string
let home: string
let shims: string
let ghConfigDir: string
/** A stand-in for the real `gh`: it acts as the agent only with the agent's config directory, and logs what it saw. */
let cli: string
let cliLog: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sa-env-'))
  home = join(root, 'agent-home')
  shims = join(root, 'shims')
  ghConfigDir = join(home, '.config', 'gh')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(root, 'bin'))
  cli = join(root, 'bin', 'gh')
  cliLog = join(root, 'gh.log')
  writeFileSync(
    cli,
    `#!/bin/sh
echo "config=$GH_CONFIG_DIR token=\${GH_TOKEN-unset} github=\${GITHUB_TOKEN-unset} args=$*" >> '${cliLog}'
if [ "$1 $2" = "api user" ]; then
  if [ "$GH_CONFIG_DIR" = '${ghConfigDir}' ]; then echo ${LOGIN}; else echo operator-login; fi
  exit 0
fi
if [ "$1 $2 $3" = "auth git-credential get" ]; then echo username=agent-user; echo password=agent-pass; exit 0; fi
exit 0
`,
  )
  chmodSync(cli, 0o755)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const config = (blocked: readonly string[] = ['curl', 'git', 'gh']) => ({
  login: LOGIN,
  email: EMAIL,
  ghConfigDir,
  blocked,
  cli,
})
/** What an execution session's shell inherits from the daemon: HOME, and PATH with the shims first. */
const sessionEnv = (extra: Record<string, string> = {}) => ({
  HOME: home,
  PATH: `${shims}:${join(root, 'bin')}:/usr/bin:/bin`,
  ...extra,
})
const gitAsWorker = (args: string[], cwd = home) =>
  run(['git', ...args], { ...gitEnv(), GIT_CONFIG_NOSYSTEM: undefined, ...sessionEnv() }, cwd)

it('puts the agent HOME, its gh login and the shims at the places the daemon launch names in the state directory', () => {
  expect(agentPaths('/srv/superagent')).toEqual({
    home: '/srv/superagent/home',
    shimsDir: '/srv/superagent/worker-bin',
    ghConfigDir: '/srv/superagent/home/.config/gh',
  })
})

posixDescribe('the agent home git configuration', () => {
  it('names the agent, resets every credential helper before the agent one for github.com, rewrites SSH and turns askPass off', async () => {
    await writeEnvironment(home, shims, config())
    const file = join(home, '.gitconfig')
    const list = await run(['git', 'config', '--file', file, '-z', '--list'], gitEnv(), root)
    const entries = list.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf('\n')
        return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)]
      })
    const keys = entries.map(([key]) => key)
    expect(Object.fromEntries(entries.filter(([key]) => key!.startsWith('user.')))).toMatchObject({
      'user.name': LOGIN,
      'user.email': EMAIL,
    })
    const credential = entries.filter(([key]) => key!.startsWith('credential.'))
    expect(credential).toEqual([
      ['credential.helper', ''],
      ['credential.https://github.com.helper', credentialHelper(shims)],
    ])
    expect(credentialHelper(shims)).toBe(`!'${join(shims, 'gh')}' auth git-credential`)
    expect(entries.filter(([key]) => key === 'url.https://github.com/.insteadof').map(([, v]) => v)).toEqual([
      'git@github.com:',
      'ssh://git@github.com/',
    ])
    expect(keys).toContain('core.askpass')
    expect(entries.find(([key]) => key === 'core.askpass')?.[1]).toBe('')
    // The helper reset comes before the agent's helper, so a system helper such as osxkeychain is dropped.
    expect(keys.indexOf('credential.helper')).toBeLessThan(
      keys.indexOf('credential.https://github.com.helper'),
    )

    // As the worker's git sees it: the agent's identity and only the agent's helper for github.com.
    expect((await gitAsWorker(['var', 'GIT_AUTHOR_IDENT'])).stdout).toContain(`${LOGIN} <${EMAIL}>`)
    const repo = join(root, 'repo')
    await run(['git', 'init', '-q', repo], gitEnv(), root)
    await gitAsWorker(['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'])
    expect((await gitAsWorker(['-C', repo, 'remote', 'get-url', '--push', 'origin'])).stdout.trim()).toBe(
      'https://github.com/acme/widgets.git',
    )
    const fill = await run(
      ['sh', '-c', 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill'],
      { ...sessionEnv(), GIT_TERMINAL_PROMPT: '0' },
      home,
    )
    expect(fill.stdout).toContain('username=agent-user')
    expect(readFileSync(cliLog, 'utf8')).toContain(`config=${ghConfigDir}`)
  })

  it('creates the gh configuration directory for the agent login', async () => {
    await writeEnvironment(home, shims, config())
    expect(existsSync(ghConfigDir)).toBe(true)
  })

  it('refuses a .gitconfig it did not write and leaves it unchanged', async () => {
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = OPERATOR\n')
    const error = await writeEnvironment(home, shims, config()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SetupError)
    expect(error).toMatchObject({ code: 'foreignFile', values: { file: join(home, '.gitconfig') } })
    expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toBe('[user]\n\tname = OPERATOR\n')
  })
})

posixDescribe('the shims directory', () => {
  it('holds gh and one shim per blocked command, never git or a second gh', async () => {
    await writeEnvironment(home, shims, config(['curl', 'wget', 'git', 'gh', 'curl']))
    expect(readdirSync(shims).sort()).toEqual(['curl', 'gh', 'wget'])
    const blocked = await run(['curl', 'https://example.com'], sessionEnv(), home)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain(`curl is blocked in this installation; use gh, which acts as ${LOGIN}.`)
  })

  it('runs the agent gh with its own config directory, without ambient tokens and without reaching the shim again', async () => {
    await writeEnvironment(home, shims, config())
    const result = await run(
      ['gh', 'api', 'user', '--jq', '.login'],
      sessionEnv({ GH_TOKEN: 'leaked', GITHUB_TOKEN: 'leaked' }),
      home,
    )
    expect(result).toMatchObject({ code: 0, stdout: `${LOGIN}\n` })
    expect(readFileSync(cliLog, 'utf8').trim()).toBe(
      `config=${ghConfigDir} token=unset github=unset args=api user --jq .login`,
    )
  })

  it('refuses a file it did not write and writes nothing', async () => {
    mkdirSync(shims)
    writeFileSync(join(shims, 'notes'), 'operator notes\n')
    await expect(writeEnvironment(home, shims, config())).rejects.toMatchObject({
      code: 'foreignFile',
      values: { file: join(shims, 'notes') },
    })
    expect(readdirSync(shims)).toEqual(['notes'])
    expect(existsSync(join(home, '.gitconfig'))).toBe(false)
  })

  it('removes the shims of commands no longer blocked and rewrites its own files', async () => {
    await writeEnvironment(home, shims, config(['curl', 'wget']))
    await writeEnvironment(home, shims, config(['wget']))
    expect(readdirSync(shims).sort()).toEqual(['gh', 'wget'])
  })

  it('fails as setup when the agent CLI is not an executable', async () => {
    await expect(
      writeEnvironment(home, shims, { ...config(), cli: join(root, 'missing', 'gh') }),
    ).rejects.toMatchObject({ code: 'agentCliMissing' })
  })
})

posixDescribe('the setup self-check', () => {
  const env = (extra: Record<string, string> = {}) => ({ ...sessionEnv(), ...extra })

  it('passes when sessions resolve gh to the shim, only the agent helper for github.com and the agent login', async () => {
    await writeEnvironment(home, shims, config())
    await expect(verifyEnvironment(home, shims, { login: LOGIN }, env())).resolves.toBeUndefined()
  })

  it('fails when the daemon HOME is not the agent home', async () => {
    await writeEnvironment(home, shims, config())
    await expect(verifyEnvironment(home, shims, { login: LOGIN }, env({ HOME: root }))).rejects.toMatchObject(
      { code: 'agentHomeMismatch' },
    )
  })

  it('fails when the daemon PATH does not put the shims before another gh', async () => {
    await writeEnvironment(home, shims, config())
    await expect(
      verifyEnvironment(
        home,
        shims,
        { login: LOGIN },
        env({ PATH: `${join(root, 'bin')}:${shims}:/usr/bin:/bin` }),
      ),
    ).rejects.toMatchObject({ code: 'agentGhNotShim' })
  })

  it('fails when another credential helper for github.com comes before or after the agent one', async () => {
    await writeEnvironment(home, shims, config())
    const original = readFileSync(join(home, '.gitconfig'), 'utf8')
    // After the reset, before the agent's helper.
    await run(
      ['git', 'config', '--file', join(home, '.gitconfig'), '--add', 'credential.helper', 'osxkeychain'],
      gitEnv(),
      root,
    )
    await expect(verifyEnvironment(home, shims, { login: LOGIN }, env())).rejects.toMatchObject({
      code: 'agentCredentialMixed',
      values: { helpers: expect.stringContaining('osxkeychain') },
    })
    // After the agent's helper, for a github.com URL.
    writeFileSync(
      join(home, '.gitconfig'),
      `${original}[credential "https://github.com/acme"]\n\thelper = store\n`,
    )
    await expect(verifyEnvironment(home, shims, { login: LOGIN }, env())).rejects.toMatchObject({
      code: 'agentCredentialMixed',
      values: { helpers: expect.stringContaining('store') },
    })
  })

  it('fails when gh does not act as the agent login', async () => {
    await writeEnvironment(home, shims, config())
    await expect(verifyEnvironment(home, shims, { login: 'someone-else' }, env())).rejects.toMatchObject({
      code: 'agentLoginMismatch',
      values: { account: LOGIN, login: 'someone-else' },
    })
  })

  it('ignores GIT_CONFIG_* variables of its own process, which sessions do not inherit', async () => {
    await writeEnvironment(home, shims, config())
    await expect(
      verifyEnvironment(
        home,
        shims,
        { login: LOGIN },
        env({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'leak' }),
      ),
    ).resolves.toBeUndefined()
  })
})

posixDescribe('the ticket repository check', () => {
  it('passes a repository whose own configuration adds no credentials', async () => {
    const repo = join(root, 'ticket', 'repo')
    await run(['git', 'init', '-q', repo], gitEnv(), root)
    await expect(verifyDirectory(join(root, 'ticket'))).resolves.toBeUndefined()
    await expect(verifyDirectory(repo)).resolves.toBeUndefined()
  })

  it('fails a ticket whose repository adds a credential helper or an extra header in its local configuration', async () => {
    const repo = join(root, 'ticket', 'repo')
    await run(['git', 'init', '-q', repo], gitEnv(), root)
    await run(['git', '-C', repo, 'config', 'credential.helper', 'store'], gitEnv(), root)
    await run(
      ['git', '-C', repo, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x'],
      gitEnv(),
      root,
    )
    await expect(verifyDirectory(repo)).rejects.toThrow(
      /sets credential\.helper, http\.https:\/\/github\.com\/\.extraheader/,
    )
    // The ticket directory holds the repository in repo/, so its check reads the repository there.
    await expect(verifyDirectory(join(root, 'ticket'))).rejects.toThrow(/credential\.helper/)
  })
})
