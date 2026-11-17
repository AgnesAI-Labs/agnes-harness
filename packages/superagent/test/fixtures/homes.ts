import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fakeGhCommand, printCommand } from './commands.js'

export const OPERATOR_CREDENTIAL = { user: 'operator-user', password: 'operator-pass' } as const
export const AGENT_CREDENTIAL = { user: 'agent-user', password: 'agent-pass' } as const

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** A path git reads from its configuration on every platform: Git for Windows takes forward slashes. */
const gitPath = (path: string) => path.replaceAll('\\', '/')

/** A `#!/bin/sh` script git runs through its own shell, which Git for Windows brings too. */
function executable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

/** A git credential helper that records `<WHO> <operation>` and answers a `get` with the fixed credential. */
function helper(who: string, credential: { user: string; password: string }, markerFile: string): string {
  return `#!/bin/sh
cat >/dev/null
echo "${who} $1" >> ${quote(markerFile)}
if [ "$1" = get ]; then echo username=${credential.user}; echo password=${credential.password}; fi
`
}

/**
 * Two homes with different identities and the `gh` each one resolves, under `root`.
 *
 * - `operatorHome`: git identity OPERATOR, a credential helper that writes `OPERATOR get|store` to `markers()`;
 *   `operatorBin/gh` prints `OPERATOR-GH`.
 * - `agentHome`: git identity AGENT, the credential helper list reset (empty `credential.helper =`), and a helper
 *   that writes `AGENT get|store` only for the remote passed to `trustRemote`; `shimsDir/gh` is the scripted fake
 *   `gh` (script `ghScript`, calls `ghLog`), a bare `gh` prints `AGENT-GH`.
 *
 * The session shell inherits only PATH and HOME, so the fake `gh` carries its script and log paths itself.
 */
export function makeHomes(root: string) {
  const operatorHome = join(root, 'operator-home')
  const agentHome = join(root, 'agent-home')
  const shimsDir = join(root, 'shims')
  const operatorBin = join(root, 'operator-bin')
  const tools = join(root, 'tools')
  const ghScript = join(tools, 'fake-gh-script.json')
  const ghLog = join(tools, 'fake-gh.log')
  const markerFile = join(tools, 'credential.log')
  for (const directory of [operatorHome, agentHome, shimsDir, operatorBin, tools])
    mkdirSync(directory, { recursive: true })

  const operatorHelper = join(tools, 'operator-helper.sh')
  const agentHelper = join(tools, 'agent-helper.sh')
  executable(operatorHelper, helper('OPERATOR', OPERATOR_CREDENTIAL, markerFile))
  executable(agentHelper, helper('AGENT', AGENT_CREDENTIAL, markerFile))
  writeFileSync(
    join(operatorHome, '.gitconfig'),
    `[user]\n\tname = OPERATOR\n\temail = operator@example.invalid\n[credential]\n\thelper =\n\thelper = ${gitPath(operatorHelper)}\n`,
  )
  writeFileSync(
    join(agentHome, '.gitconfig'),
    '[user]\n\tname = AGENT\n\temail = agent@example.invalid\n[credential]\n\thelper =\n[core]\n\taskPass =\n',
  )
  printCommand(join(operatorBin, 'gh'), 'OPERATOR-GH')
  writeFileSync(ghScript, JSON.stringify({ login: 'agent-bot', banner: 'AGENT-GH', rules: [] }))
  fakeGhCommand(join(shimsDir, 'gh'), { script: ghScript, log: ghLog })

  return {
    operatorHome,
    agentHome,
    shimsDir,
    operatorBin,
    ghScript,
    ghLog,
    /** The agent's credential helper answers for this remote only. */
    trustRemote(remoteUrl: string): void {
      appendFileSync(
        join(agentHome, '.gitconfig'),
        `[credential "${new URL(remoteUrl).origin}"]\n\thelper = ${gitPath(agentHelper)}\n`,
      )
    },
    /** Replace the fake `gh` script (see `fake-gh.mjs`). */
    writeGhScript(script: unknown): void {
      writeFileSync(ghScript, JSON.stringify(script))
      rmSync(`${ghLog}.usage`, { force: true })
    },
    /** The credential-helper calls so far, in order. */
    markers(): string[] {
      return existsSync(markerFile) ? readFileSync(markerFile, 'utf8').split('\n').filter(Boolean) : []
    },
    /** The fake `gh` calls so far. */
    ghCalls(): { argv: string[]; matched: boolean }[] {
      return existsSync(ghLog)
        ? readFileSync(ghLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    },
  }
}
