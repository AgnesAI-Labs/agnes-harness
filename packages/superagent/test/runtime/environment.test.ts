import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCommand } from '../../src/app/subprocess.js'
import {
  agentCommandVariables,
  agentSessionEnvironment,
  credentialHelper,
  verifyDirectory,
  verifyEnvironment,
  withEnvironment,
  writeEnvironment,
} from '../../src/runtime/environment.js'
import { SetupError } from '../../src/setup.js'
import { commandPath, nodeCommand } from '../fixtures/commands.js'
import { hostFloor } from '../fixtures/daemon-harness.js'
import { gitEnv } from '../fixtures/git.js'

const windows = process.platform === 'win32'
/** A path written into a git configuration file: Git for Windows reads forward slashes, and a backslash escapes. */
const gitPath = (path: string) => path.replaceAll('\\', '/')

const LOGIN = 'agent-bot'
const EMAIL = '1+agent-bot@users.noreply.github.com'

interface Run {
  code: number
  stdout: string
  stderr: string
}
/**
 * Runs `argv` with exactly `env`, the program found on its PATH as a shell finds it (a `.cmd` shim on Windows too);
 * `input` is its standard input.
 */
function run(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  input?: string,
): Promise<Run> {
  const exact = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return runCommand(argv, {
    cwd,
    env: exact,
    replaceEnv: true,
    ...(input === undefined ? {} : { input }),
    signal: new AbortController().signal,
    timeoutMs: 60_000,
  })
}

let root: string
let stateDir: string
let shims: string
let gitconfig: string
let operatorHome: string
/** The agent's login, kept apart from the operator's: the `gh-agent` wrapper's own configuration directory. */
let agentConfig: string
/** The operator's `gh`: it acts as the agent only with the agent's configuration directory, and logs what it saw. */
let realBin: string
/** The `gh-agent` wrapper the operator made, as the deployment guide shows: it runs `gh` by name. */
let cli: string
let cliLog: string
/** What the operator's `gh` answers to `auth status`, when the test writes it: `{ stdout, stderr, code }`. */
let authStatus: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-env-')))
  stateDir = join(root, 'state')
  shims = join(stateDir, 'worker-bin')
  gitconfig = join(stateDir, 'worker-gitconfig')
  operatorHome = join(root, 'operator-home')
  agentConfig = join(root, 'config', 'gh-agent')
  realBin = join(root, 'bin')
  cliLog = join(root, 'gh.log')
  authStatus = join(root, 'auth-status.json')
  for (const dir of [stateDir, operatorHome, agentConfig, realBin]) mkdirSync(dir, { recursive: true })
  // The operator's own git: an identity and a credential helper that must never answer for the agent.
  writeFileSync(
    join(operatorHome, '.gitconfig'),
    `[user]\n\tname = OPERATOR\n\temail = operator@example.invalid\n[credential]\n\thelper = !echo OPERATOR >> '${gitPath(join(root, 'operator.log'))}'\n`,
  )
  // The operator's real `gh`, which logs each run and acts as the agent only with the agent's configuration directory.
  nodeCommand(
    join(realBin, 'gh'),
    [
      "import { appendFileSync, existsSync, readFileSync } from 'node:fs'",
      'const args = process.argv.slice(2)',
      'const env = process.env',
      `appendFileSync(${JSON.stringify(cliLog)}, \`config=\${env.GH_CONFIG_DIR} token=\${env.GH_TOKEN ?? 'unset'} github=\${env.GITHUB_TOKEN ?? 'unset'} args=\${args.join(' ')}\\n\`)`,
      "if (args.slice(0, 2).join(' ') === 'api user')",
      `  console.log(env.GH_CONFIG_DIR === ${JSON.stringify(agentConfig)} ? ${JSON.stringify(LOGIN)} : 'operator-login')`,
      "else if (args.slice(0, 3).join(' ') === 'auth git-credential get') console.log('username=agent-user\\npassword=agent-pass')",
      `else if (args.slice(0, 2).join(' ') === 'auth status' && existsSync(${JSON.stringify(authStatus)})) {`,
      `  const reply = JSON.parse(readFileSync(${JSON.stringify(authStatus)}, 'utf8'))`,
      '  process.stdout.write(reply.stdout)',
      '  process.stderr.write(reply.stderr)',
      '  process.exitCode = reply.code',
      '}',
      '',
    ].join('\n'),
  )
  // The `gh-agent` wrapper the guide shows: the agent's configuration directory, then `gh` by name.
  mkdirSync(join(root, 'local-bin'))
  cli = commandPath(join(root, 'local-bin', 'gh-agent'))
  if (windows) writeFileSync(cli, `@set "GH_CONFIG_DIR=${agentConfig}"\r\n@gh %*\r\n`)
  else {
    writeFileSync(cli, `#!/bin/sh\nGH_CONFIG_DIR='${agentConfig}' exec gh "$@"\n`)
    chmodSync(cli, 0o755)
  }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const config = (blocked: readonly string[] = ['curl', 'git', 'gh']) => ({
  login: LOGIN,
  email: EMAIL,
  blocked,
  cli,
})
/** The daemon's own environment, started as usual: the operator's HOME and PATH, which reaches the real `gh`. */
const daemonEnv = (extra: Record<string, string> = {}) => ({
  ...hostFloor(operatorHome),
  HOME: operatorHome,
  PATH: [realBin, ...(windows ? [process.env.PATH ?? ''] : ['/usr/bin', '/bin'])].join(delimiter),
  ...extra,
})
/** What a Superagent session's command gets: the platform's floor of the daemon's environment, then the agent's. */
const sessionEnv = (extra: Record<string, string> = {}) =>
  withEnvironment({ ...daemonEnv(), ...extra }, agentSessionEnvironment(stateDir))
const gitAsWorker = (args: string[], cwd = stateDir) => run(['git', ...args], sessionEnv(), cwd)

it('opens sessions with the shims first on PATH, the agent git configuration, no prompts and no GitHub tokens', () => {
  expect(agentSessionEnvironment('/srv/superagent')).toEqual({
    pathPrepend: [join('/srv/superagent', 'worker-bin')],
    set: {
      GIT_CONFIG_GLOBAL: join('/srv/superagent', 'worker-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    },
    unset: ['GH_TOKEN', 'GITHUB_TOKEN'],
  })
  // As on POSIX, where PATH entries are separated by colons.
  expect(
    withEnvironment(
      { PATH: '/usr/bin', HOME: '/srv/operator', GH_TOKEN: 'x', GITHUB_TOKEN: 'y' },
      agentSessionEnvironment('/s'),
      'linux',
    ),
  ).toEqual({
    PATH: `${join('/s', 'worker-bin')}:/usr/bin`,
    HOME: '/srv/operator',
    GIT_CONFIG_GLOBAL: join('/s', 'worker-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
  })
  expect(agentCommandVariables('/s', '/usr/bin', 'linux')).toMatchObject({
    PATH: `${join('/s', 'worker-bin')}:/usr/bin`,
    GIT_CONFIG_GLOBAL: join('/s', 'worker-gitconfig'),
  })
})

describe('the agent git configuration', () => {
  it('names the agent, resets every credential helper before the agent CLI for github.com, rewrites SSH and turns askPass off', async () => {
    await writeEnvironment(stateDir, config())
    const list = await run(['git', 'config', '--file', gitconfig, '-z', '--list'], gitEnv(), root)
    const entries = list.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf('\n')
        return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)]
      })
    const keys = entries.map(([key]) => key)
    expect(Object.fromEntries(entries.filter(([key]) => key!.startsWith('user.')))).toEqual({
      'user.name': LOGIN,
      'user.email': EMAIL,
      'user.useconfigonly': 'true',
    })
    expect(entries.filter(([key]) => key!.startsWith('credential.'))).toEqual([
      ['credential.helper', ''],
      ['credential.https://github.com.helper', credentialHelper(cli)],
    ])
    expect(credentialHelper(cli)).toBe(`!'${gitPath(cli)}' auth git-credential`)
    expect(entries.filter(([key]) => key === 'url.https://github.com/.insteadof').map(([, v]) => v)).toEqual([
      'git@github.com:',
      'ssh://git@github.com/',
    ])
    expect(entries.find(([key]) => key === 'core.askpass')?.[1]).toBe('')
    expect(keys).toContain('filter.lfs.process')

    // As a session's git sees it, with the operator's HOME: the agent's identity, only the agent CLI for github.com.
    expect((await gitAsWorker(['var', 'GIT_AUTHOR_IDENT'])).stdout).toContain(`${LOGIN} <${EMAIL}>`)
    const repo = join(root, 'repo')
    await run(['git', 'init', '-q', repo], gitEnv(), root)
    await gitAsWorker(['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'])
    expect((await gitAsWorker(['-C', repo, 'remote', 'get-url', '--push', 'origin'])).stdout.trim()).toBe(
      'https://github.com/acme/widgets.git',
    )
    const fill = await run(
      ['git', 'credential', 'fill'],
      sessionEnv({ GH_TOKEN: 'leaked' }),
      stateDir,
      'protocol=https\nhost=github.com\n\n',
    )
    expect(fill.stdout).toContain('username=agent-user')
    expect(readFileSync(cliLog, 'utf8')).toContain(`config=${agentConfig} token=unset`)
    expect(existsSync(join(root, 'operator.log')), "the operator's helper never ran").toBe(false)
  })

  it('refuses a worker-gitconfig it did not write and leaves it unchanged', async () => {
    writeFileSync(gitconfig, '[user]\n\tname = OPERATOR\n')
    const error = await writeEnvironment(stateDir, config()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SetupError)
    expect(error).toMatchObject({ code: 'foreignFile', values: { file: gitconfig } })
    expect(readFileSync(gitconfig, 'utf8')).toBe('[user]\n\tname = OPERATOR\n')
  })
})

describe('the shims directory', () => {
  it('holds gh and one shim per blocked command, never git or a second gh', async () => {
    await writeEnvironment(stateDir, config(['curl', 'wget', 'git', 'gh', 'curl']))
    expect(readdirSync(shims).sort()).toEqual(
      ['curl', 'gh', 'wget'].map((name) => (windows ? `${name}.cmd` : name)),
    )
    const blocked = await run(['curl', 'https://example.com'], sessionEnv(), stateDir)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain(`curl is blocked in this installation; use gh, which acts as ${LOGIN}.`)
  })

  it('runs the agent CLI without ambient tokens, and the wrapper reaches the real gh, not the shim again', async () => {
    await writeEnvironment(stateDir, config())
    const result = await run(
      ['gh', 'api', 'user', '--jq', '.login'],
      sessionEnv({ GH_TOKEN: 'leaked', GITHUB_TOKEN: 'leaked' }),
      stateDir,
    )
    expect(result).toMatchObject({ code: 0, stdout: `${LOGIN}\n` })
    expect(readFileSync(cliLog, 'utf8').trim()).toBe(
      `config=${agentConfig} token=unset github=unset args=api user --jq .login`,
    )
  })

  it('refuses a file it did not write and writes nothing', async () => {
    mkdirSync(shims)
    writeFileSync(join(shims, 'notes'), 'operator notes\n')
    await expect(writeEnvironment(stateDir, config())).rejects.toMatchObject({
      code: 'foreignFile',
      values: { file: join(shims, 'notes') },
    })
    expect(readdirSync(shims)).toEqual(['notes'])
    expect(existsSync(gitconfig)).toBe(false)
  })

  it('removes the shims of commands no longer blocked and rewrites its own files', async () => {
    await writeEnvironment(stateDir, config(['curl', 'wget']))
    await writeEnvironment(stateDir, config(['wget']))
    expect(readdirSync(shims).sort()).toEqual(['gh', 'wget'].map((name) => (windows ? `${name}.cmd` : name)))
  })

  it('fails as setup when the agent CLI is not an executable', async () => {
    await expect(
      writeEnvironment(stateDir, { ...config(), cli: join(root, 'missing', 'gh') }),
    ).rejects.toMatchObject({ code: 'agentCliMissing' })
  })

  it('refuses an agent CLI inside the shims directory, whose gh shim would run itself forever', async () => {
    await writeEnvironment(stateDir, config())
    const shim = commandPath(join(shims, 'gh'))
    // Named by its path, as pasted from `command -v gh` under the earlier PATH setup, or through a link to it.
    const link = commandPath(join(root, 'local-bin', 'gh-shim'))
    symlinkSync(shim, link)
    for (const named of [shim, link])
      await expect(writeEnvironment(stateDir, { ...config(), cli: named }), named).rejects.toMatchObject({
        code: 'agentCliInShims',
        values: { cli: named, shims },
      })
    // A command name that PATH resolves to a link into the shims is refused too.
    await expect(
      verifyEnvironment(
        stateDir,
        { login: LOGIN, cli: 'gh-shim' },
        daemonEnv({ PATH: [join(root, 'local-bin'), daemonEnv().PATH].join(delimiter) }),
      ),
    ).rejects.toMatchObject({ code: 'agentCliInShims', values: { cli: 'gh-shim' } })
    // So is the shim's path before Superagent ever wrote it, on a fresh state directory.
    const fresh = join(root, 'fresh-state')
    await expect(
      writeEnvironment(fresh, { ...config(), cli: commandPath(join(fresh, 'worker-bin', 'gh')) }),
    ).rejects.toMatchObject({ code: 'agentCliInShims' })
    // The shims the refused writes found are untouched: the gh shim still runs the agent CLI.
    expect(readFileSync(shim, 'utf8')).toContain(cli)
  })
})

describe('the setup self-check', () => {
  const check = (login = LOGIN, env = daemonEnv(), cliPath = cli) =>
    verifyEnvironment(stateDir, { login, cli: cliPath }, env)

  it('passes for a daemon started as usual: the operator HOME and PATH, with their own git and gh', async () => {
    await writeEnvironment(stateDir, config())
    await expect(check()).resolves.toBeUndefined()
    // A GitHub token in the daemon's environment does not reach the agent CLI.
    await expect(check(LOGIN, daemonEnv({ GH_TOKEN: 'operator-token' }))).resolves.toBeUndefined()
  })

  it('fails when git would ask another credential helper for github.com, before or after the agent one', async () => {
    await writeEnvironment(stateDir, config())
    const original = readFileSync(gitconfig, 'utf8')
    await run(
      ['git', 'config', '--file', gitconfig, '--add', 'credential.helper', 'osxkeychain'],
      gitEnv(),
      root,
    )
    await expect(check()).rejects.toMatchObject({
      code: 'agentCredentialMixed',
      values: { helpers: expect.stringContaining('osxkeychain') },
    })
    writeFileSync(gitconfig, `${original}[credential "https://github.com/acme"]\n\thelper = store\n`)
    await expect(check()).rejects.toMatchObject({
      code: 'agentCredentialMixed',
      values: { helpers: expect.stringContaining('store') },
    })
  })

  it('fails when the helper git resolves is not the agent CLI', async () => {
    await writeEnvironment(stateDir, config())
    await expect(check(LOGIN, daemonEnv(), commandPath(join(realBin, 'gh')))).rejects.toMatchObject({
      code: 'agentCredentialMixed',
      values: { helpers: expect.stringContaining(gitPath(cli)) },
    })
  })

  it('fails when gh does not act as the agent login', async () => {
    await writeEnvironment(stateDir, config())
    await expect(check('someone-else')).rejects.toMatchObject({
      code: 'agentLoginMismatch',
      values: { account: LOGIN, login: 'someone-else' },
    })
  })

  it("fails when a .netrc in the sessions' HOME would sign git in to github.com before the agent CLI", async () => {
    await writeEnvironment(stateDir, config())
    // Another host's entry is not git's business here.
    writeFileSync(join(operatorHome, '.netrc'), 'machine example.com login op password other-host\n')
    await expect(check()).resolves.toBeUndefined()
    for (const [name, text] of [
      [
        '.netrc',
        '# the operator\nmachine example.com login op password x\nmachine GitHub.com login op password tok\n',
      ],
      ['.netrc', 'default login op password tok\n'],
      ['_netrc', 'machine github.com\n  login op\n  password tok\n'],
    ] as const) {
      rmSync(join(operatorHome, '.netrc'), { force: true })
      writeFileSync(join(operatorHome, name), text)
      await expect(check(), text).rejects.toMatchObject({
        code: 'agentNetrc',
        values: { file: join(operatorHome, name) },
      })
      rmSync(join(operatorHome, name))
    }
  })

  // The sessions' macOS sandbox cannot reach the keychain: gh there acts signed out, while this check, unconfined, reads
  // the token. The check asks gh where its token is; it never asks for the token.
  it.skipIf(windows)(
    "on macOS, fails when the agent's token is in the keychain, where sessions cannot read it",
    async () => {
      await writeEnvironment(stateDir, config())
      const answer = (stdout: string, code = 0, stderr = '') =>
        writeFileSync(authStatus, JSON.stringify({ stdout, stderr, code }))
      const hosts = (...entries: [tokenSource: string, active: boolean][]) =>
        JSON.stringify({
          hosts: {
            'github.com': entries.map(([tokenSource, active]) => ({
              state: 'success',
              active,
              host: 'github.com',
              login: LOGIN,
              tokenSource,
              gitProtocol: 'https',
            })),
          },
        })
      const on = (platform: string) =>
        verifyEnvironment(stateDir, { login: LOGIN, cli }, daemonEnv(), undefined, platform)
      const asked = () =>
        readFileSync(cliLog, 'utf8')
          .split('\n')
          .filter((line) => line.includes('auth status'))
      answer(hosts(['keyring', true]))
      await expect(on('darwin')).rejects.toMatchObject({
        code: 'agentTokenInKeychain',
        values: { account: LOGIN },
      })
      expect(asked()).toEqual([
        expect.stringContaining('args=auth status --hostname github.com --json hosts'),
      ])
      // Elsewhere there is no keychain sandbox to miss it.
      await expect(on('linux')).resolves.toBeUndefined()
      expect(asked()).toHaveLength(1)
      // A token in the wrapper's configuration directory passes, beside a keychain one of an account gh does not use.
      answer(hosts([join(agentConfig, 'hosts.yml'), true], ['keyring', false]))
      await expect(on('darwin')).resolves.toBeUndefined()
      // A gh without `auth status --json` cannot say where its token is; the check passes over it.
      answer('', 1, 'unknown flag: --json\n')
      await expect(on('darwin')).resolves.toBeUndefined()
      expect(readFileSync(cliLog, 'utf8')).not.toMatch(/show-token|auth token/)
    },
  )

  it('ignores GIT_CONFIG_* variables of its own process, which sessions do not get', async () => {
    await writeEnvironment(stateDir, config())
    await expect(
      check(
        LOGIN,
        daemonEnv({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: 'leak',
        }),
      ),
    ).resolves.toBeUndefined()
  })
})

describe('the ticket repository check', () => {
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
