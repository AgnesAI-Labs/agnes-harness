/**
 * An agent environment written by `writeEnvironment` next to an operator home with its own git identity, credential
 * helper and `gh`, for the real-daemon tests. The agent's real `gh` is the scripted fake: it answers `gh api user` with
 * the agent login and `gh auth git-credential get` with the agent's credential, and logs the configuration directory
 * it ran with.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentPaths,
  credentialHelper,
  type EnvironmentConfig,
  writeEnvironment,
} from '../../src/runtime/environment.js'
import { gitEnv } from '../fixtures/git.js'
import { AGENT_CREDENTIAL, makeHomes } from '../fixtures/homes.js'

const FAKE_GH = fileURLToPath(new URL('../fixtures/fake-gh.mjs', import.meta.url))
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const AGENT_LOGIN = 'agent-bot'
export const AGENT_EMAIL = 'agent-bot@example.invalid'

export async function prepareAgentEnvironment(root: string, remoteUrl: string) {
  const homes = makeHomes(join(root, 'homes'))
  // The places a deployment uses: `<state directory>/home` and `<state directory>/worker-bin`.
  const stateDir = join(root, 'state')
  const { home: agentHome, shimsDir: shims, ghConfigDir } = agentPaths(stateDir)
  const cliDir = join(root, 'agent-cli')
  const ghLog = join(cliDir, 'fake-gh.log')
  const configDirs = join(cliDir, 'config-dirs.log')
  mkdirSync(agentHome, { recursive: true })
  mkdirSync(cliDir, { recursive: true })
  const script = join(cliDir, 'script.json')
  writeFileSync(
    script,
    JSON.stringify({
      login: AGENT_LOGIN,
      banner: 'AGENT-GH',
      rules: [
        {
          args: ['auth', 'git-credential', 'get'],
          stdout: `username=${AGENT_CREDENTIAL.user}\npassword=${AGENT_CREDENTIAL.password}\n`,
        },
        { args: ['auth', 'git-credential'] },
      ],
    }),
  )
  const cli = join(cliDir, 'gh')
  writeFileSync(
    cli,
    `#!/bin/sh\necho "$GH_CONFIG_DIR" >> ${quote(configDirs)}\nFAKE_GH_SCRIPT=${quote(script)} FAKE_GH_LOG=${quote(ghLog)} exec ${quote(process.execPath)} ${quote(FAKE_GH)} "$@"\n`,
  )
  chmodSync(cli, 0o755)
  const config: EnvironmentConfig = {
    login: AGENT_LOGIN,
    email: AGENT_EMAIL,
    ghConfigDir,
    blocked: ['curl'],
    cli,
  }
  /**
   * The test remote is not github.com, so its credential context gets the same agent helper `writeEnvironment` gives
   * github.com. Appended after the written file; the next `writeEnvironment` replaces the file and this is applied again.
   */
  const trustRemote = () =>
    execFileSync(
      'git',
      [
        'config',
        '--file',
        join(agentHome, '.gitconfig'),
        '--add',
        `credential.${new URL(remoteUrl).origin}.helper`,
        credentialHelper(shims),
      ],
      { env: gitEnv() as NodeJS.ProcessEnv },
    )
  const write = async (home = agentHome, dir = shims, cfg = config) => {
    await writeEnvironment(home, dir, cfg)
    trustRemote()
  }
  await write()
  return {
    homes,
    stateDir,
    agentHome,
    shims,
    config,
    write,
    /** The PATH the daemon starts with: the shims first, then the operator's `gh`, then the rest. */
    path: `${shims}:${homes.operatorBin}:${process.env.PATH ?? ''}`,
    ghCalls: (): string[][] =>
      existsSync(ghLog)
        ? readFileSync(ghLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
        : [],
    configDirs: (): string[] =>
      existsSync(configDirs) ? readFileSync(configDirs, 'utf8').split('\n').filter(Boolean) : [],
  }
}
