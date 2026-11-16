/**
 * The agent's environment set up as the deployment guide does it, next to an operator home with its own git identity,
 * credential helper and `gh`, for the real-daemon tests. The agent's GitHub CLI is a `gh-agent` wrapper with its own
 * configuration directory; the `gh` it runs is the scripted fake, which answers the account and repository checks for
 * the agent, answers `gh auth git-credential get` with the agent's credential, and logs the configuration directory
 * it ran with. The daemon starts as usual: the operator's HOME and PATH.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerGitConfig } from '../../src/infra/worker-paths.js'
import { credentialHelper, type EnvironmentConfig, writeEnvironment } from '../../src/runtime/environment.js'
import { fakeGhCommand } from '../fixtures/commands.js'
import { gitEnv } from '../fixtures/git.js'
import { AGENT_CREDENTIAL, makeHomes } from '../fixtures/homes.js'

export const AGENT_LOGIN = 'agent-bot'
export const AGENT_ID = 42
export const AGENT_EMAIL = `${AGENT_ID}+${AGENT_LOGIN}@users.noreply.github.com`

/**
 * Writes the `gh-agent` wrapper under `root`: `GH_CONFIG_DIR` is its own directory, as in the guide, and the `gh` it
 * runs is the scripted fake. `repository` is the one the account checks answer for.
 */
export function writeGhAgent(root: string, repository = 'acme/app') {
  const dir = join(root, 'agent-cli')
  const configDir = join(root, 'agent-config', 'gh-agent')
  mkdirSync(dir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const ghLog = join(dir, 'fake-gh.log')
  const runsLog = join(dir, 'runs.log')
  const script = join(dir, 'script.json')
  writeFileSync(
    script,
    JSON.stringify({
      login: AGENT_LOGIN,
      banner: 'AGENT-GH',
      rules: [
        { args: ['api', 'user', '--jq', '.login'], stdout: `${AGENT_LOGIN}\n` },
        { args: ['api', 'user'], stdout: `{"login":"${AGENT_LOGIN}","id":${AGENT_ID}}\n` },
        { args: ['api', `repos/${repository}`], stdout: `{"name":"${repository}","push":true}\n` },
        {
          args: ['auth', 'git-credential', 'get'],
          stdout: `username=${AGENT_CREDENTIAL.user}\npassword=${AGENT_CREDENTIAL.password}\n`,
        },
        { args: ['auth', 'git-credential'] },
      ],
    }),
  )
  // Its own configuration directory, as in the guide, and a line per run with whether a GitHub token reached it.
  const cli = fakeGhCommand(join(dir, 'gh-agent'), {
    script,
    log: ghLog,
    before: [
      "import { appendFileSync } from 'node:fs'",
      `process.env.GH_CONFIG_DIR = ${JSON.stringify(configDir)}`,
      `appendFileSync(${JSON.stringify(runsLog)}, \`\${process.env.GH_CONFIG_DIR} token=\${process.env.GH_TOKEN ?? 'unset'}\\n\`)`,
    ].join('\n'),
  })
  return {
    cli,
    configDir,
    ghCalls: (): string[][] =>
      existsSync(ghLog)
        ? readFileSync(ghLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
        : [],
    /** Each run of the wrapper: the configuration directory and whether a GitHub token reached it. */
    runs: (): string[] =>
      existsSync(runsLog) ? readFileSync(runsLog, 'utf8').split('\n').filter(Boolean) : [],
  }
}

/**
 * The test remote is not github.com, so its credential context gets the same agent helper the written configuration
 * gives github.com, appended to it. The next `writeEnvironment` replaces the file; apply this again after it.
 */
export function trustRemote(stateDir: string, cli: string, remoteUrl: string): void {
  execFileSync(
    'git',
    [
      'config',
      '--file',
      workerGitConfig(stateDir),
      '--add',
      `credential.${new URL(remoteUrl).origin}.helper`,
      credentialHelper(cli),
    ],
    { env: gitEnv() as NodeJS.ProcessEnv },
  )
}

export async function prepareAgentEnvironment(root: string, remoteUrl: string) {
  const homes = makeHomes(join(root, 'homes'))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const agent = writeGhAgent(root)
  const config: EnvironmentConfig = {
    login: AGENT_LOGIN,
    email: AGENT_EMAIL,
    blocked: ['curl'],
    cli: agent.cli,
  }
  const write = async (dir = stateDir, cfg = config) => {
    await writeEnvironment(dir, cfg)
    trustRemote(dir, agent.cli, remoteUrl)
  }
  await write()
  const url = new URL(remoteUrl)
  url.username = AGENT_CREDENTIAL.user
  url.password = AGENT_CREDENTIAL.password
  return {
    homes,
    stateDir,
    config,
    write,
    agent,
    /** The daemon's environment, started as usual: the operator's HOME, and a PATH that reaches the operator's `gh`. */
    home: homes.operatorHome,
    path: `${homes.operatorBin}:${process.env.PATH ?? ''}`,
    /** The remote with the agent's credential in it, for a session that has no agent environment of its own. */
    agentUrl: url.toString(),
  }
}
